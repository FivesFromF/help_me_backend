package repository

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	ddbtypes "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/aws/aws-sdk-go-v2/service/eventbridge"
	ebtypes "github.com/aws/aws-sdk-go-v2/service/eventbridge/types"
)

type CloudRepository struct {
	dbClient         *dynamodb.Client
	ebClient         *eventbridge.Client
	tableName        string
	systemBusName    string
	emergencyBusName string
}

type SessionRecord struct {
	SessionID string `dynamodbav:"session_id"`
	ExpiresAt int64  `dynamodbav:"expires_at"`
}

func NewCloudRepository(ctx context.Context, tableName, systemBus, emergencyBus string) (*CloudRepository, error) {
	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		return nil, fmt.Errorf("unable to load AWS config: %w", err)
	}

	return &CloudRepository{
		dbClient:         dynamodb.NewFromConfig(cfg),
		ebClient:         eventbridge.NewFromConfig(cfg),
		tableName:        tableName,
		systemBusName:    systemBus,
		emergencyBusName: emergencyBus,
	}, nil
}

// Session Management (DynamoDB)
func (r *CloudRepository) CreateAccessSession(ctx context.Context, staffID, citizenID string) error {
	sessionID := fmt.Sprintf("%s#%s", staffID, citizenID)
	expiresAt := time.Now().Add(24 * time.Hour).Unix()

	item := SessionRecord{
		SessionID: sessionID,
		ExpiresAt: expiresAt,
	}

	av, err := attributevalue.MarshalMap(item)
	if err != nil {
		return err
	}

	_, err = r.dbClient.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(r.tableName),
		Item:      av,
	})
	return err
}

func (r *CloudRepository) CheckAccessSession(ctx context.Context, staffID, citizenID string) (bool, error) {
	sessionID := fmt.Sprintf("%s#%s", staffID, citizenID)

	result, err := r.dbClient.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(r.tableName),
		Key: map[string]ddbtypes.AttributeValue{
			"session_id": &ddbtypes.AttributeValueMemberS{Value: sessionID},
		},
	})
	if err != nil {
		return false, err
	}

	if result.Item == nil {
		return false, nil
	}

	var record SessionRecord
	err = attributevalue.UnmarshalMap(result.Item, &record)
	if err != nil {
		return false, err
	}

	// Double check expiration just in case TTL hasn't run yet
	return record.ExpiresAt > time.Now().Unix(), nil
}

// Event Publishing (EventBridge) - System Bus
func (r *CloudRepository) PublishSystemEvent(ctx context.Context, detailType string, detail interface{}) error {
	return r.publishToBus(ctx, r.systemBusName, detailType, detail)
}

// Event Publishing (EventBridge) - Emergency Bus
func (r *CloudRepository) PublishEmergencyEvent(ctx context.Context, detailType string, detail interface{}) error {
	return r.publishToBus(ctx, r.emergencyBusName, detailType, detail)
}

func (r *CloudRepository) publishToBus(ctx context.Context, busName, detailType string, detail interface{}) error {
	detailJSON, err := json.Marshal(detail)
	if err != nil {
		return err
	}

	_, err = r.ebClient.PutEvents(ctx, &eventbridge.PutEventsInput{
		Entries: []ebtypes.PutEventsRequestEntry{
			{
				Source:       aws.String("helpme.backend"),
				DetailType:   aws.String(detailType),
				Detail:       aws.String(string(detailJSON)),
				EventBusName: aws.String(busName),
			},
		},
	})
	return err
}

// Deprecated: Use PublishSystemEvent or PublishEmergencyEvent
func (r *CloudRepository) PublishEvent(ctx context.Context, detailType string, detail interface{}) error {
	return r.PublishSystemEvent(ctx, detailType, detail)
}

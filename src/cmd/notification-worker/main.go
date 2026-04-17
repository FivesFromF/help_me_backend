package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/sns"
)

var snsClient *sns.Client
var snsTopicArn = os.Getenv("SNS_TOPIC_ARN")

func init() {
	ctx := context.Background()
	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		log.Fatalf("unable to load SDK config, %v", err)
	}
	snsClient = sns.NewFromConfig(cfg)
}

func HandleRequest(ctx context.Context, event events.CloudWatchEvent) error {
	fmt.Printf("Processing identification event for victim: %s\n", event.DetailType)

	var detail map[string]string
	if err := json.Unmarshal(event.Detail, &detail); err != nil {
		return fmt.Errorf("failed to unmarshal event detail: %w", err)
	}

	victimName := detail["full_name"]
	citizenID := detail["citizen_id"]

	// In a real scenario, we would query RDS here to find emergency contacts for citizenID.
	// For MVP, we send an alert to the system topic.
	
	message := fmt.Sprintf("EMERGENCY ALERT: Victim %s (ID: %s) has been identified by medical staff. Emergency contacts are being notified.", victimName, citizenID)

	_, err := snsClient.Publish(ctx, &sns.PublishInput{
		Message:  aws.String(message),
		TopicArn: aws.String(snsTopicArn),
		Subject:  aws.String(fmt.Sprintf("HelpMe Emergency Alert: %s identified", victimName)),
	})

	if err != nil {
		fmt.Printf("Error sending SNS alert: %v\n", err)
		return err
	}

	fmt.Printf("Emergency notification sent successfully for victim %s\n", victimName)
	return nil
}

func main() {
	lambda.Start(HandleRequest)
}

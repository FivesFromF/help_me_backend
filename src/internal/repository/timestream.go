package repository

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/timestreamwrite"
	"github.com/aws/aws-sdk-go-v2/service/timestreamwrite/types"
)

type TimestreamStore struct {
	client   *timestreamwrite.Client
	database string
	table    string
}

func NewTimestreamStore(ctx context.Context, database, table string) (*TimestreamStore, error) {
	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		return nil, fmt.Errorf("unable to load AWS config: %w", err)
	}

	client := timestreamwrite.NewFromConfig(cfg)
	return &TimestreamStore{
		client:   client,
		database: database,
		table:    table,
	}, nil
}

func (s *TimestreamStore) WriteAuditLog(
	ctx context.Context,
	staffID string,
	citizenID string,
	accessType string,
	reason string,
	serviceName string,
) error {
	currentTime := strconv.FormatInt(time.Now().UnixMilli(), 10)

	dimensions := []types.Dimension{
		{Name: ptr("StaffId"), Value: ptr(staffID)},
		{Name: ptr("CitizenId"), Value: ptr(citizenID)},
		{Name: ptr("AccessType"), Value: ptr(accessType)},
		{Name: ptr("Service"), Value: ptr(serviceName)},
	}

	record := types.Record{
		Dimensions:       dimensions,
		MeasureName:      ptr("AuditAction"),
		MeasureValue:     ptr(reason),
		MeasureValueType: types.MeasureValueTypeVarchar,
		Time:             ptr(currentTime),
		TimeUnit:         types.TimeUnitMilliseconds,
	}

	_, err := s.client.WriteRecords(ctx, &timestreamwrite.WriteRecordsInput{
		DatabaseName: ptr(s.database),
		TableName:    ptr(s.table),
		Records:      []types.Record{record},
	})

	if err != nil {
		return fmt.Errorf("failed to write record to Timestream: %w", err)
	}

	return nil
}

func ptr(s string) *string {
	return &s
}

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	"github.com/fivesfromf/helpme/internal/repository"
)

var tsStore *repository.TimestreamStore

func init() {
	ctx := context.Background()
	dbName := os.Getenv("TIMESTREAM_DATABASE")
	tableName := os.Getenv("TIMESTREAM_TABLE")

	var err error
	tsStore, err = repository.NewTimestreamStore(ctx, dbName, tableName)
	if err != nil {
		log.Fatalf("Failed to initialize Timestream store: %v", err)
	}
}

func HandleRequest(ctx context.Context, event events.CloudWatchEvent) error {
	fmt.Printf("Processing event: %s from source: %s\n", event.DetailType, event.Source)

	var detail map[string]string
	if err := json.Unmarshal(event.Detail, &detail); err != nil {
		return fmt.Errorf("failed to unmarshal event detail: %w", err)
	}

	// Extract standard auditing fields
	staffID := detail["staff_id"]
	citizenID := detail["citizen_id"]
	action := detail["action"]
	if action == "" {
		action = event.DetailType
	}
	reason := detail["reason"]
	if reason == "" {
		reason = "System Event"
	}
	service := event.Source

	// Write to Timestream
	err := tsStore.WriteAuditLog(ctx, staffID, citizenID, action, reason, service)
	if err != nil {
		fmt.Printf("Error writing to Timestream: %v\n", err)
		return err
	}

	return nil
}

func main() {
	lambda.Start(HandleRequest)
}

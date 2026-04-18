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

var cloudRepo *repository.CloudRepository

func init() {
	ctx := context.Background()
	ddbTable := os.Getenv("ACCESS_SESSIONS_TABLE")

	var err error
	// We only need the DynamoDB part of CloudRepository here
	cloudRepo, err = repository.NewCloudRepository(ctx, ddbTable, "dummy-system-bus", "dummy-emergency-bus")
	if err != nil {
		log.Fatalf("Failed to initialize Cloud repository: %v", err)
	}
}

func HandleRequest(ctx context.Context, event events.CloudWatchEvent) error {
	fmt.Printf("Granting permission for event: %s\n", event.DetailType)

	var detail map[string]string
	if err := json.Unmarshal(event.Detail, &detail); err != nil {
		return fmt.Errorf("failed to unmarshal identification detail: %w", err)
	}

	staffID := detail["staff_id"]
	citizenID := detail["citizen_id"]

	if staffID == "" || citizenID == "" {
		return fmt.Errorf("missing staff_id or citizen_id in event detail")
	}

	fmt.Printf("Creating 24h session for Staff: %s, Citizen: %s\n", staffID, citizenID)

	// Create the 24h Access Session in DynamoDB
	err := cloudRepo.CreateAccessSession(ctx, staffID, citizenID)
	if err != nil {
		fmt.Printf("Error creating access session: %v\n", err)
		return err
	}

	fmt.Println("Access session successfully created in DynamoDB")
	return nil
}

func main() {
	lambda.Start(HandleRequest)
}

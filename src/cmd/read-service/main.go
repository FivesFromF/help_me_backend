package main

import (
	"context"
	"fmt"
	"net/http"
	"os"

	"github.com/aws/aws-lambda-go/lambda"
	"github.com/awslabs/aws-lambda-go-api-proxy/httpadapter"

	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/cognitoidentityprovider"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/fivesfromf/helpme/internal/ai"
	"github.com/fivesfromf/helpme/internal/repository"
	"github.com/fivesfromf/helpme/internal/services"
	"github.com/fivesfromf/helpme/internal/utils"
)

func main() {
	ctx := context.Background()

	// Initialize Database Store
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		fmt.Println("DATABASE_URL must be set")
		os.Exit(1)
	}

	store, err := repository.NewStore(ctx, dbURL)
	if err != nil {
		fmt.Printf("Failed to connect to database: %v\n", err)
		os.Exit(1)
	}
	defer store.Close()

	// Initialize Cloud Repository (DynamoDB & EventBridge)
	systemBus := os.Getenv("CORE_SYSTEM_BUS_NAME")
	emergencyBus := os.Getenv("EMERGENCY_BUS_NAME")
	ddbTable := os.Getenv("ACCESS_SESSIONS_TABLE")
	if systemBus == "" || emergencyBus == "" || ddbTable == "" {
		fmt.Println("CORE_SYSTEM_BUS_NAME, EMERGENCY_BUS_NAME and ACCESS_SESSIONS_TABLE must be set")
		os.Exit(1)
	}
	cloudRepo, err := repository.NewCloudRepository(ctx, ddbTable, systemBus, emergencyBus)
	if err != nil {
		fmt.Printf("Failed to connect to AWS Cloud services: %v\n", err)
		os.Exit(1)
	}

	// Cognito Configuration
	userPoolID := os.Getenv("COGNITO_USER_POOL_ID")
	clientID := os.Getenv("COGNITO_CLIENT_ID")
	if userPoolID == "" || clientID == "" {
		fmt.Println("COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID must be set")
		os.Exit(1)
	}

	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		fmt.Printf("Failed to load AWS config: %v\n", err)
		os.Exit(1)
	}
	cognitoClient := cognitoidentityprovider.NewFromConfig(cfg)
	s3Client := s3.NewFromConfig(cfg)

	// S3 Configuration
	s3Bucket := os.Getenv("AWS_S3_BUCKET")
	if s3Bucket == "" {
		fmt.Println("AWS_S3_BUCKET must be set")
		os.Exit(1)
	}
	s3Service := utils.NewS3Service(s3Client, s3Bucket)

	// System Secret for NFC/QR Hashing
	systemSecret := os.Getenv("SYSTEM_SECRET")
	if systemSecret == "" {
		fmt.Println("SYSTEM_SECRET must be set")
		os.Exit(1)
	}

	// Initialize AI Client
	aiServerURL := os.Getenv("AI_SERVER_URL")
	if aiServerURL == "" {
		aiServerURL = "http://ai.helpme.local:8000" // Default internal DNS
	}
	aiInternalSecret := os.Getenv("AI_INTERNAL_SECRET")
	aiClient := ai.NewClient(aiServerURL, aiInternalSecret)

	// Initialize Servers
	CitizenService := services.NewCitizenService(store, cloudRepo, aiClient, cognitoClient, userPoolID, systemSecret, s3Service)
	HealthcareService := services.NewHealthcareService(store, cloudRepo)

	mux := http.NewServeMux()

	// Register Read operations
	mux.HandleFunc("GET /user/profile", CitizenService.GetProfile)
	mux.HandleFunc("GET /user/medical-record", CitizenService.GetMedicalRecord)
	mux.HandleFunc("POST /user/verify", CitizenService.VerifyIdentity)
	mux.HandleFunc("POST /user/search", CitizenService.SearchByFace)
	mux.HandleFunc("GET /user/nfc", CitizenService.ListMyNFCTags)
	mux.HandleFunc("GET /user/qr", CitizenService.ListMyQRCodes)

	// Since getting emergency history is not implemented, we omit or keep a placeholder
	// mux.HandleFunc("POST /emergency/history", EmergencyService.GetEmergencyHistory)

	mux.HandleFunc("POST /healthcare/data", HealthcareService.GetData)
	// LogAccess is handled natively inside GetData but exists as an endpoint
	// mux.HandleFunc("POST /healthcare/log", HealthcareService.LogAccess)
	
	// Health Check
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("OK"))
	})

	// --- Execution Logic ---
	// Running exclusively as AWS Lambda
	fmt.Println("HelpMe Read Service starting as AWS Lambda...")
	adapter := httpadapter.New(mux)
	lambda.Start(adapter.ProxyWithContext)
}

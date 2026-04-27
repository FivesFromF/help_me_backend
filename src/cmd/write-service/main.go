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
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/s3"

	"github.com/fivesfromf/helpme/internal/ai"
	"github.com/fivesfromf/helpme/internal/repository"
	"github.com/fivesfromf/helpme/internal/services"
	"github.com/fivesfromf/helpme/internal/utils"
	"github.com/joho/godotenv"
)

func main() {
	// Load .env file if present (for local development)
	_ = godotenv.Load()

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

	// Auto-Migrate Schema
	if err := store.Migrate(ctx, "api/schema/schema.sql"); err != nil {
		fmt.Printf("Warning: Database migration failed: %v\n", err)
		// Non-blocking in case extensions already exist or minor errors, 
		// but critical errors will still cause failure later.
	}

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
	auditTable := os.Getenv("AUDIT_LOGS_TABLE")
	if userPoolID == "" || clientID == "" || auditTable == "" {
		fmt.Println("COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID, and AUDIT_LOGS_TABLE must be set")
		os.Exit(1)
	}

	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		fmt.Printf("Failed to load AWS config: %v\n", err)
		os.Exit(1)
	}
	cognitoClient := cognitoidentityprovider.NewFromConfig(cfg)
	dynamicClient := dynamodb.NewFromConfig(cfg)
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
	EmergencyService := services.NewEmergencyService(store)
	AuthService := services.NewAuthService(store, cognitoClient, s3Service)
	AdminService := services.NewAdminService(store, cognitoClient, dynamicClient, auditTable, userPoolID, s3Service)

	mux := http.NewServeMux()

	// REST Route Definitions
	// 1. Auth & Sign In
	mux.HandleFunc("POST /signin", AuthService.SignIn)

	// 2. User Operations (Citizens)
	mux.HandleFunc("POST /user/register", CitizenService.Register)
	mux.HandleFunc("PUT /user/profile", CitizenService.UpdateProfile)
	mux.HandleFunc("POST /user/nfc/link", CitizenService.LinkNFCTag)
	mux.HandleFunc("PATCH /user/nfc/{id}/status", CitizenService.UpdateNFCTagStatus)
	mux.HandleFunc("DELETE /user/nfc/{id}", CitizenService.DeleteNFCTag)
	mux.HandleFunc("POST /user/qr/create", CitizenService.CreateQRCode)
	mux.HandleFunc("PATCH /user/qr/{id}/status", CitizenService.UpdateQRCodeStatus)
	mux.HandleFunc("DELETE /user/qr/{id}", CitizenService.DeleteQRCode)

	// 3. Emergency Operations
	mux.HandleFunc("POST /emergency/report", EmergencyService.ReportEmergency)

	// 4. Admin Operations
	mux.HandleFunc("POST /admin/stats", AdminService.GetSystemStats)
	mux.HandleFunc("POST /admin/logs", AdminService.ListAuditLogs)
	mux.HandleFunc("POST /admin/staff/register", AdminService.RegisterStaff)
	mux.HandleFunc("POST /admin/staff/manage", AdminService.ManageStaff)
	
	// 5. Health Check
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("OK"))
	})

	// Running exclusively as AWS Lambda
	fmt.Println("HelpMe Write Service starting as AWS Lambda...")
	adapter := httpadapter.New(mux)
	lambda.Start(adapter.ProxyWithContext)
}

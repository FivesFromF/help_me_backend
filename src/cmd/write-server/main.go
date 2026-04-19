package main

import (
	"context"
	"fmt"
	"net/http"
	"os"

	"golang.org/x/net/http2"
	"golang.org/x/net/http2/h2c"

	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/cognitoidentityprovider"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"

	"github.com/fivesfromf/helpme/internal/repository"
	"github.com/fivesfromf/helpme/internal/services"
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

	// System Secret for NFC/QR Hashing
	systemSecret := os.Getenv("SYSTEM_SECRET")
	if systemSecret == "" {
		fmt.Println("SYSTEM_SECRET must be set")
		os.Exit(1)
	}

	// Initialize Servers
	citizenServer := services.NewCitizenServer(store, cloudRepo, systemSecret)
	emergencyServer := services.NewEmergencyServer(store)
	authServer := services.NewAuthServer(store)
	adminServer := services.NewAdminServer(store, cognitoClient, dynamicClient, auditTable, userPoolID)

	mux := http.NewServeMux()

	// REST Route Definitions
	// 1. Auth & Sign In
	mux.HandleFunc("POST /signin", authServer.SignIn)

	// 2. User Operations (Citizens)
	mux.HandleFunc("POST /user/register", citizenServer.Register)
	mux.HandleFunc("POST /user/verify", citizenServer.VerifyIdentity)
	mux.HandleFunc("POST /user/search", citizenServer.SearchByFace)

	// 3. Emergency Operations
	mux.HandleFunc("POST /emergency/report", emergencyServer.ReportEmergency)

	// 4. Admin Operations
	mux.HandleFunc("POST /admin/stats", adminServer.GetSystemStats)
	mux.HandleFunc("POST /admin/logs", adminServer.ListAuditLogs)
	mux.HandleFunc("POST /admin/staff/register", adminServer.RegisterStaff)
	mux.HandleFunc("POST /admin/staff/manage", adminServer.ManageStaff)

	fmt.Println("HelpMe WRITE Service (Refined + Cloud) starting on :8080...")
	http.ListenAndServe(
		":8080",
		h2c.NewHandler(mux, &http2.Server{}),
	)
}

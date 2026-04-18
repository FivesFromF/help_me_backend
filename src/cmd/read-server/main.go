package main

import (
	"context"
	"fmt"
	"net/http"
	"os"

	"golang.org/x/net/http2"
	"golang.org/x/net/http2/h2c"

	"github.com/fivesfromf/helpme/internal/gen/v1/helpmev1connect"
	"github.com/fivesfromf/helpme/internal/repository"
	"github.com/fivesfromf/helpme/internal/services"
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

	// System Secret for NFC/QR Hashing
	systemSecret := os.Getenv("SYSTEM_SECRET")
	if systemSecret == "" {
		fmt.Println("SYSTEM_SECRET must be set")
		os.Exit(1)
	}

	// Initialize Servers
	citizenServer := services.NewCitizenServer(store, cloudRepo, systemSecret)
	emergencyServer := services.NewEmergencyServer(store)
	healthcareServer := services.NewHealthcareServer(store, cloudRepo)
	
	mux := http.NewServeMux()
	
	// Register Read operations
	mux.Handle(helpmev1connect.NewCitizenServiceHandler(citizenServer))
	mux.Handle(helpmev1connect.NewEmergencyServiceHandler(emergencyServer))
	mux.Handle(helpmev1connect.NewHealthcareServiceHandler(healthcareServer))

	fmt.Println("HelpMe READ Service (Refined + Cloud) starting on :8080...")
	http.ListenAndServe(
		":8080",
		h2c.NewHandler(mux, &http2.Server{}),
	)
}

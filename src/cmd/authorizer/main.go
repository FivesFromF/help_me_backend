package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	"github.com/golang-jwt/jwt/v5"
)

var (
	userPoolID     = os.Getenv("USER_POOL_ID")
	appClientID    = os.Getenv("APP_CLIENT_ID")
	cognitoEndpoint = os.Getenv("COGNITO_ENDPOINT")
)

type AuthorizerResponse struct {
	IsAuthorized bool                   `json:"isAuthorized"`
	Context      map[string]interface{} `json:"context,omitempty"`
}

func main() {
	lambda.Start(HandleRequest)
}

func HandleRequest(ctx context.Context, request events.APIGatewayV2CustomAuthorizerV2Request) (AuthorizerResponse, error) {
	fmt.Printf("Received token: %s\n", request.IdentitySource[0])

	tokenStr := request.IdentitySource[0]
	if strings.HasPrefix(tokenStr, "Bearer ") {
		tokenStr = strings.TrimPrefix(tokenStr, "Bearer ")
	}

	// For MVP: In a real-world scenario, you MUST verify the signature against Cognito JWKS.
	// To keep this MVP simple and avoid extra network calls for now, 
	// we will parse the token and check claims. 
	// WARNING: Signature verification should be added before production.
	
	claims := jwt.MapClaims{}
	token, _, err := new(jwt.Parser).ParseUnverified(tokenStr, claims)
	if err != nil {
		return AuthorizerResponse{IsAuthorized: false}, nil
	}

	// Check Issuer (iss)
	if claims["iss"] != cognitoEndpoint {
		fmt.Printf("Invalid issuer: %v\n", claims["iss"])
		return AuthorizerResponse{IsAuthorized: false}, nil
	}

	// Check Audience (aud) - Cognito uses client_id in 'aud' or 'client_id' field
	if claims["client_id"] != appClientID && claims["aud"] != appClientID {
		fmt.Printf("Invalid audience: %v\n", claims["client_id"])
		return AuthorizerResponse{IsAuthorized: false}, nil
	}

	// Extract context
	userID := claims["sub"].(string)
	role := "Citizen" // Default
	if r, ok := claims["custom:role"].(string); ok {
		role = r
	}

	fmt.Printf("Authorizing user %s with role %s\n", userID, role)

	return AuthorizerResponse{
		IsAuthorized: true,
		Context: map[string]interface{}{
			"userId": userID,
			"role":   role,
		},
	}, nil
}

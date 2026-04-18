package main

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	"github.com/golang-jwt/jwt/v5"
)

var (
	appClientID     = os.Getenv("APP_CLIENT_ID")
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
	// 1. Path-based Whitelist Bypass (REST Updates)
	// We use HasSuffix to handle API Gateway stage prefixes or service prefixes.
	reqPath := request.RequestContext.HTTP.Path

	publicPaths := []string{
		"/request-otp",
		"/verify-otp",
		"/staff/sign-in",
		"/admin/sign-in",
		"/citizen/verify",
	}

	for _, p := range publicPaths {
		if strings.HasSuffix(reqPath, p) {
			fmt.Printf("Authorizer: Whitelist bypass for path: %s (matched %s)\n", reqPath, p)
			return AuthorizerResponse{IsAuthorized: true}, nil
		}
	}

	fmt.Printf("Authorizer: Evaluating protected path: %s\n", reqPath)

	// 2. Check for missing authentication header
	if len(request.IdentitySource) == 0 || request.IdentitySource[0] == "" {
		fmt.Printf("Missing Identity Source for protected path: %s\n", reqPath)
		return AuthorizerResponse{IsAuthorized: false}, nil
	}

	tokenStr := request.IdentitySource[0]
	if strings.HasPrefix(tokenStr, "Bearer ") {
		tokenStr = strings.TrimPrefix(tokenStr, "Bearer ")
	}

	// For MVP: Signature verification should be added for production (checking Cognito JWKS).
	claims := jwt.MapClaims{}
	_, _, err := new(jwt.Parser).ParseUnverified(tokenStr, claims)
	if err != nil {
		return AuthorizerResponse{IsAuthorized: false}, nil
	}

	// Check Issuer (iss)
	if claims["iss"] != cognitoEndpoint {
		fmt.Printf("Invalid issuer: %v\n", claims["iss"])
		return AuthorizerResponse{IsAuthorized: false}, nil
	}

	// Check Audience (aud) or client_id
	if claims["client_id"] != appClientID && claims["aud"] != appClientID {
		fmt.Printf("Invalid audience: %v\n", claims["client_id"])
		return AuthorizerResponse{IsAuthorized: false}, nil
	}

	// Extract standard identity
	userID := claims["sub"].(string)

	// Role resolution priority:
	// 1. Check "cognito:groups" for "Admins"
	// 2. Check "custom:role" attribute
	// 3. Default to "Citizen"

	role := "Citizen"

	// Check Groups (array)
	if groups, ok := claims["cognito:groups"].([]interface{}); ok {
		for _, g := range groups {
			if g == "Admins" {
				role = "Admin"
				break
			} else if g == "Staff" && role != "Admin" {
				role = "Staff"
			}
		}
	}

	// Override if custom:role is more specific/different
	if role == "Citizen" {
		if r, ok := claims["custom:role"].(string); ok {
			role = r
		}
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

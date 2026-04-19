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
	reqPath := request.RequestContext.HTTP.Path

	// Public paths — no token needed
	publicPaths := []string{
		"/signin",
		"/user/verify",
		"/user/search",
	}
	for _, p := range publicPaths {
		if strings.HasSuffix(reqPath, p) {
			fmt.Printf("Authorizer: Whitelist bypass for: %s\n", p)
			return AuthorizerResponse{IsAuthorized: true}, nil
		}
	}

	// Token required for all other paths
	if len(request.IdentitySource) == 0 || request.IdentitySource[0] == "" {
		fmt.Printf("Authorizer: No token for protected path: %s\n", reqPath)
		return AuthorizerResponse{IsAuthorized: false}, nil
	}

	tokenStr := strings.TrimPrefix(request.IdentitySource[0], "Bearer ")

	claims := jwt.MapClaims{}
	_, _, err := new(jwt.Parser).ParseUnverified(tokenStr, claims)
	if err != nil {
		return AuthorizerResponse{IsAuthorized: false}, nil
	}

	if claims["iss"] != cognitoEndpoint {
		fmt.Printf("Authorizer: Invalid issuer: %v\n", claims["iss"])
		return AuthorizerResponse{IsAuthorized: false}, nil
	}

	if claims["client_id"] != appClientID && claims["aud"] != appClientID {
		fmt.Printf("Authorizer: Invalid audience: %v\n", claims["client_id"])
		return AuthorizerResponse{IsAuthorized: false}, nil
	}

	userID := fmt.Sprintf("%v", claims["sub"])

	// Extract role from Cognito Groups (Group precedence: admin > staff > citizen)
	role := "citizen"
	if groups, ok := claims["cognito:groups"].([]interface{}); ok {
		for _, g := range groups {
			gStr := strings.ToLower(fmt.Sprintf("%v", g))
			if gStr == "admin" || gStr == "admins" {
				role = "admin"
				break
			} else if gStr == "staff" {
				role = "staff"
			}
		}
	}

	fmt.Printf("Authorizer: user=%s role=%s path=%s\n", userID, role, reqPath)

	return AuthorizerResponse{
		IsAuthorized: true,
		Context: map[string]interface{}{
			"userId": userID,
			"role":   role,
		},
	}, nil
}

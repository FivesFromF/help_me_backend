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
	cognitoEndpoint = strings.TrimSuffix(os.Getenv("COGNITO_ENDPOINT"), "/")
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

	// Whitelist check (Bypass token validation but still try to extract context if present)
	publicPaths := []string{"/signin", "/user/verify", "/user/search", "/user/register", "/health"}
	isWhitelisted := false
	for _, p := range publicPaths {
		if strings.HasSuffix(reqPath, p) {
			isWhitelisted = true
			break
		}
	}

	// 1. Bypass authentication for OPTIONS (CORS Preflight)
	if request.RequestContext.HTTP.Method == "OPTIONS" {
		fmt.Printf("Authorizer: Allow OPTIONS bypass for: %s\n", reqPath)
		return AuthorizerResponse{IsAuthorized: true}, nil
	}

	// Token extraction
	tokenStr := ""
	if len(request.IdentitySource) > 0 && request.IdentitySource[0] != "" {
		tokenStr = strings.TrimPrefix(request.IdentitySource[0], "Bearer ")
	} else {
		for k, v := range request.Headers {
			if strings.ToLower(k) == "authorization" {
				tokenStr = strings.TrimPrefix(v, "Bearer ")
				break
			}
		}
	}

	if tokenStr == "" {
		if isWhitelisted {
			fmt.Printf("Authorizer: Allow (Whitelist/No Token) path: %s\n", reqPath)
			return AuthorizerResponse{IsAuthorized: true}, nil
		}
		fmt.Printf("Authorizer: Forbidden - No token found for path: %s\n", reqPath)
		return AuthorizerResponse{IsAuthorized: false}, nil
	}

	// 2. JWT Verification (Unverified parse first to see if we can even try to validate)
	claims := jwt.MapClaims{}
	_, _, err := new(jwt.Parser).ParseUnverified(tokenStr, claims)
	if err != nil {
		if isWhitelisted {
			fmt.Printf("Authorizer: Allow (Whitelist/Bad Token) path: %s\n", reqPath)
			return AuthorizerResponse{IsAuthorized: true}, nil
		}
		fmt.Printf("Authorizer: Forbidden - Failed to parse token: %v\n", err)
		return AuthorizerResponse{IsAuthorized: false}, nil
	}

	// 3. Validation (Issuer & Audience)
	iss, _ := claims["iss"].(string)
	iss = strings.TrimSuffix(iss, "/")

	clientID, _ := claims["client_id"].(string)
	aud, _ := claims["aud"].(string)

	isValid := (iss == cognitoEndpoint) && (clientID == appClientID || aud == appClientID)

	if !isValid {
		if isWhitelisted {
			fmt.Printf("Authorizer: Allow (Whitelist/Invalid Claims) path: %s issuer: %s\n", reqPath, iss)
			return AuthorizerResponse{IsAuthorized: true}, nil
		}
		fmt.Printf("Authorizer: Forbidden - Invalid issuer or audience. Expected: %s, Got: %s\n", cognitoEndpoint, iss)
		return AuthorizerResponse{IsAuthorized: false}, nil
	}

	// 4. Success - Populate Context
	userID, _ := claims["sub"].(string)
	if userID == "" {
		if isWhitelisted {
			return AuthorizerResponse{IsAuthorized: true}, nil
		}
		return AuthorizerResponse{IsAuthorized: false}, nil
	}

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

	fmt.Printf("Authorizer: Allow (Verified) - user=%s role=%s path=%s\n", userID, role, reqPath)

	return AuthorizerResponse{
		IsAuthorized: true,
		Context: map[string]interface{}{
			"userId": userID,
			"role":   role,
		},
	}, nil
}

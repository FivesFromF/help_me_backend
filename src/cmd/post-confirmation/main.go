package main

import (
	"context"
	"fmt"
	"strings"

	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/cognitoidentityprovider"
)

// CognitoPostConfirmationEvent is the event structure passed by Cognito
// after a user successfully confirms their account (including Google/SSO).
type CognitoPostConfirmationEvent struct {
	Version       string            `json:"version"`
	TriggerSource string            `json:"triggerSource"`
	Region        string            `json:"region"`
	UserPoolID    string            `json:"userPoolId"`
	UserName      string            `json:"userName"`
	Request       map[string]interface{} `json:"request"`
	Response      map[string]interface{} `json:"response"`
}

var cognitoClient *cognitoidentityprovider.Client

func init() {
	cfg, err := config.LoadDefaultConfig(context.Background())
	if err != nil {
		panic(fmt.Sprintf("failed to load AWS config: %v", err))
	}
	cognitoClient = cognitoidentityprovider.NewFromConfig(cfg)
}

func HandleRequest(ctx context.Context, event CognitoPostConfirmationEvent) (CognitoPostConfirmationEvent, error) {
	userPoolID := event.UserPoolID
	username := event.UserName

	fmt.Printf("Post Confirmation: user=%s pool=%s trigger=%s\n", username, userPoolID, event.TriggerSource)

	// Check if user already belongs to a higher-priority group (staff/admin).
	// This happens when Admin pre-creates a Staff account before their first login.
	groupsOut, err := cognitoClient.AdminListGroupsForUser(ctx, &cognitoidentityprovider.AdminListGroupsForUserInput{
		UserPoolId: aws.String(userPoolID),
		Username:   aws.String(username),
	})
	if err != nil {
		// Log but don't block the confirmation flow
		fmt.Printf("Warning: failed to list groups for user %s: %v\n", username, err)
		return event, nil
	}

	for _, group := range groupsOut.Groups {
		name := strings.ToLower(aws.ToString(group.GroupName))
		if name == "admin" || name == "admins" || name == "staff" {
			fmt.Printf("User %s already in group '%s' — skipping citizen assignment\n", username, name)
			// Must return event to continue the Cognito flow
			return event, nil
		}
	}

	// Default: add to 'citizen' group
	_, err = cognitoClient.AdminAddUserToGroup(ctx, &cognitoidentityprovider.AdminAddUserToGroupInput{
		UserPoolId: aws.String(userPoolID),
		Username:   aws.String(username),
		GroupName:  aws.String("citizen"),
	})
	if err != nil {
		fmt.Printf("Warning: failed to add user %s to citizen group: %v\n", username, err)
		// Still don't block — let the user sign up successfully
		return event, nil
	}

	fmt.Printf("Successfully added user '%s' to group 'citizen'\n", username)

	// Must return the event object for Cognito to continue the flow
	return event, nil
}

func main() {
	lambda.Start(HandleRequest)
}

package main

import (
	"context"
	"strings"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
)

func handler(ctx context.Context, event events.CognitoEventUserPoolsDefineAuthChallenge) (events.CognitoEventUserPoolsDefineAuthChallenge, error) {
	session := event.Request.Session
	isStaff := strings.Contains(event.UserName, "@")

	// 1. Check if we should issue tokens (Last challenge succeeded)
	if len(session) > 0 {
		lastAttempt := session[len(session)-1]
		if lastAttempt.ChallengeName == "CUSTOM_CHALLENGE" && lastAttempt.ChallengeResult == true {
			event.Response.IssueTokens = true
			event.Response.FailAuthentication = false
			return event, nil
		}
	}

	// 2. Check for failures (Too many failed attempts)
	if len(session) >= 4 {
		event.Response.IssueTokens = false
		event.Response.FailAuthentication = true
		return event, nil
	}

	// 3. Determine next challenge
	if isStaff {
		// Staff Flow: Password -> OTP
		if len(session) == 0 {
			// First step: Password
			event.Response.ChallengeName = "PASSWORD_VERIFIER"
		} else {
			lastAttempt := session[len(session)-1]
			if lastAttempt.ChallengeName == "PASSWORD_VERIFIER" && lastAttempt.ChallengeResult == true {
				// Password passed, now OTP
				event.Response.ChallengeName = "CUSTOM_CHALLENGE"
			} else if lastAttempt.ChallengeName == "PASSWORD_VERIFIER" && lastAttempt.ChallengeResult == false {
				// Password failed
				event.Response.FailAuthentication = true
			} else {
				// Continue with OTP
				event.Response.ChallengeName = "CUSTOM_CHALLENGE"
			}
		}
	} else {
		// Citizen Flow: Just OTP
		event.Response.ChallengeName = "CUSTOM_CHALLENGE"
	}

	event.Response.IssueTokens = false
	event.Response.FailAuthentication = false
	return event, nil
}

func main() {
	lambda.Start(handler)
}

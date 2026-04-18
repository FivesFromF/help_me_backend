package main

import (
	"context"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
)

func handler(ctx context.Context, event events.CognitoEventUserPoolsVerifyAuthChallenge) (events.CognitoEventUserPoolsVerifyAuthChallenge, error) {
	expectedAnswer := event.Request.PrivateChallengeParameters["answer"]
	if event.Request.ChallengeAnswer == expectedAnswer {
		event.Response.AnswerCorrect = true
	} else {
		event.Response.AnswerCorrect = false
	}

	return event, nil
}

func main() {
	lambda.Start(handler)
}

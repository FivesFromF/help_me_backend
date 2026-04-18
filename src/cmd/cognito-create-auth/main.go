package main

import (
	"context"
	"crypto/rand"
	"fmt"
	"math/big"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/sns"
)

func handler(ctx context.Context, event events.CognitoEventUserPoolsCreateAuthChallenge) (events.CognitoEventUserPoolsCreateAuthChallenge, error) {
	// Only create a challenge if the requested challenge is CUSTOM_CHALLENGE
	if event.Request.ChallengeName != "CUSTOM_CHALLENGE" {
		return event, nil
	}

	var otpCode string

	// New challenge attempt (or retry), always generate a fresh code for security

	// New challenge attempt (or retry), always generate a fresh code for security
	code, _ := generateOTP(6)
	otpCode = code

	// Send SMS via SNS
	// Note: userAttributes should contain phone_number for both Citizens and Staff
	phone := event.Request.UserAttributes["phone_number"]
	if phone != "" {
		msg := fmt.Sprintf("Ma xac thuc HelpMe cua ban la: %s", otpCode)
		err := sendSMS(ctx, phone, msg)
		if err != nil {
			fmt.Printf("Failed to send SMS to %s: %v\n", phone, err)
		}
	} else {
		fmt.Printf("Warning: user %s has no phone_number attribute\n", event.UserName)
	}

	event.Response.PublicChallengeParameters = map[string]string{
		"phone": event.Request.UserAttributes["phone_number"],
	}
	event.Response.PrivateChallengeParameters = map[string]string{
		"answer": otpCode,
	}

	return event, nil
}

func generateOTP(length int) (string, error) {
	const digits = "0123456789"
	result := make([]byte, length)
	for i := 0; i < length; i++ {
		num, _ := rand.Int(rand.Reader, big.NewInt(int64(len(digits))))
		result[i] = digits[num.Int64()]
	}
	return string(result), nil
}

func sendSMS(ctx context.Context, phone string, message string) error {
	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		return err
	}
	client := sns.NewFromConfig(cfg)

	_, err = client.Publish(ctx, &sns.PublishInput{
		Message:     aws.String(message),
		PhoneNumber: aws.String(phone),
	})
	return err
}

func main() {
	lambda.Start(handler)
}

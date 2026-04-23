package utils

import (
	"bytes"
	"context"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

type S3Service struct {
	client     *s3.Client
	presigner  *s3.PresignClient
	bucketName string
}

func NewS3Service(client *s3.Client, bucketName string) *S3Service {
	return &S3Service{
		client:     client,
		presigner:  s3.NewPresignClient(client),
		bucketName: bucketName,
	}
}

func (s *S3Service) UploadImage(ctx context.Context, key string, data []byte) (string, error) {
	_, err := s.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(s.bucketName),
		Key:         aws.String(key),
		Body:        bytes.NewReader(data),
		ContentType: aws.String("image/jpeg"),
	})
	if err != nil {
		return "", fmt.Errorf("failed to upload to s3: %w", err)
	}
	return key, nil
}

func (s *S3Service) GeneratePresignedURL(ctx context.Context, key string, expires time.Duration) (string, error) {
	request, err := s.presigner.PresignGetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.bucketName),
		Key:    aws.String(key),
	}, func(opts *s3.PresignOptions) {
		opts.Expires = expires
	})
	if err != nil {
		return "", fmt.Errorf("failed to presign s3 url: %w", err)
	}
	return request.URL, nil
}

func (s *S3Service) ResolveAvatarURL(ctx context.Context, avatarUrl string) string {
	if avatarUrl == "" {
		return ""
	}
	// If it's already a full URL, return it
	if len(avatarUrl) > 4 && avatarUrl[:4] == "http" {
		return avatarUrl
	}
	// Otherwise treat it as an S3 key and presign it
	url, err := s.GeneratePresignedURL(ctx, avatarUrl, 15*time.Minute)
	if err != nil {
		fmt.Printf("S3: Failed to presign avatar key %s: %v\n", avatarUrl, err)
		return ""
	}
	return url
}

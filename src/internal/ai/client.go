package ai

import (
	"bytes"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"time"
)

type Client struct {
	BaseURL    string
	HTTPClient *http.Client
}

type ExtractResponse struct {
	Success   bool      `json:"success"`
	Message   string    `json:"message"`
	Embedding []float32 `json:"embedding"`
}

func NewClient(baseURL string) *Client {
	return &Client{
		BaseURL: baseURL,
		HTTPClient: &http.Client{
			Timeout: 15 * time.Second,
		},
	}
}

// ExtractEmbedding sends image bytes to the AI server and returns the 512-d vector.
func (c *Client) ExtractEmbedding(imageBytes []byte) ([]float32, error) {
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)

	// Create form file field
	part, err := writer.CreateFormFile("image", "input.jpg")
	if err != nil {
		return nil, fmt.Errorf("failed to create form file: %w", err)
	}

	if _, err := part.Write(imageBytes); err != nil {
		return nil, fmt.Errorf("failed to write image bytes: %w", err)
	}

	writer.Close()

	req, err := http.NewRequest("POST", c.BaseURL+"/extract-embedding", body)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", writer.FormDataContentType())

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to call AI server: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("AI server returned status: %d", resp.StatusCode)
	}

	var result ExtractResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode AI response: %w", err)
	}

	if !result.Success {
		return nil, fmt.Errorf("AI processing failed: %s", result.Message)
	}

	if len(result.Embedding) == 0 {
		return nil, fmt.Errorf("AI returned empty embedding")
	}

	return result.Embedding, nil
}

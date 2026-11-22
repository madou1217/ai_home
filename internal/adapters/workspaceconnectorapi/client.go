// Package workspaceconnectorapi is the outbound management adapter for the
// Workspace Connector enrollment and inventory API.
package workspaceconnectorapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/remoteconnector"
	"github.com/madou1217/ai_home/internal/runtime/workspaceconnector"
)

const maxResponseBytes = 2 * 1024 * 1024

var ErrInvalidConfig = errors.New("workspace connector API configuration is invalid")

type HTTPClient interface {
	Do(*http.Request) (*http.Response, error)
}

type Config struct {
	BaseURL       string
	ManagementKey string
}

type Client struct {
	httpClient    HTTPClient
	baseURL       string
	managementKey string
}

type RemoteError struct {
	StatusCode int
	Code       string
	Message    string
}

func (err RemoteError) Error() string {
	code := err.Code
	if code == "" {
		code = "workspace_connector_request_failed"
	}
	message := err.Message
	if message == "" {
		message = "workspace connector request failed"
	}
	return fmt.Sprintf("%s: %s", code, message)
}

type Enrollment struct {
	ID           string                       `json:"id"`
	Code         string                       `json:"code,omitempty"`
	Label        string                       `json:"label"`
	ExpiresAt    int64                        `json:"expiresAt"`
	Capabilities remoteconnector.Capabilities `json:"capabilities"`
}

type WorkspaceView struct {
	workspaceconnector.Workspace
	Transport      string `json:"transport"`
	State          string `json:"state"`
	Online         bool   `json:"online"`
	SessionID      string `json:"sessionId,omitempty"`
	ConnectedAt    int64  `json:"connectedAt,omitempty"`
	LiveLastSeenAt int64  `json:"liveLastSeenAt,omitempty"`
}

type ListResponse struct {
	OK         bool            `json:"ok"`
	ServerID   string          `json:"serverId,omitempty"`
	Count      int             `json:"count"`
	Workspaces []WorkspaceView `json:"workspaces"`
}

type enrollmentResponse struct {
	OK         bool       `json:"ok"`
	Enrollment Enrollment `json:"enrollment"`
}

type errorResponse struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}

func New(httpClient HTTPClient, config Config) (*Client, error) {
	baseURL, err := normalizeBaseURL(config.BaseURL)
	key := strings.TrimSpace(config.ManagementKey)
	if httpClient == nil || err != nil || key == "" || strings.ContainsAny(key, "\r\n\x00") {
		return nil, ErrInvalidConfig
	}
	return &Client{httpClient: httpClient, baseURL: baseURL, managementKey: key}, nil
}

func (client *Client) CreateEnrollment(ctx context.Context, label string, ttl time.Duration) (Enrollment, error) {
	body := map[string]any{"label": strings.TrimSpace(label)}
	if ttl > 0 {
		body["ttlSeconds"] = int(ttl / time.Second)
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		return Enrollment{}, err
	}
	var response enrollmentResponse
	err = client.doJSON(ctx, http.MethodPost, remoteconnector.EnrollmentsPath, encoded, &response)
	return response.Enrollment, err
}

func (client *Client) List(ctx context.Context) (ListResponse, error) {
	var response ListResponse
	err := client.doJSON(ctx, http.MethodGet, remoteconnector.ManagementPath, nil, &response)
	return response, err
}

func (client *Client) Revoke(ctx context.Context, workspaceID string) error {
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return errors.New("workspace id is required")
	}
	return client.doJSON(ctx, http.MethodDelete, remoteconnector.ManagementPath+"/"+url.PathEscape(workspaceID), nil, nil)
}

func (client *Client) doJSON(ctx context.Context, method, path string, body []byte, destination any) error {
	if client == nil || client.httpClient == nil || client.baseURL == "" || client.managementKey == "" {
		return ErrInvalidConfig
	}
	if ctx == nil {
		ctx = context.Background()
	}
	requestURL := client.baseURL + path
	request, err := http.NewRequestWithContext(ctx, method, requestURL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+client.managementKey)
	if len(body) > 0 {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := client.httpClient.Do(request)
	if err != nil {
		return fmt.Errorf("execute workspace connector request: %w", err)
	}
	if response == nil || response.Body == nil {
		return errors.New("workspace connector server returned no response")
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil {
		return fmt.Errorf("read workspace connector response: %w", err)
	}
	if len(raw) > maxResponseBytes {
		return errors.New("workspace connector response is too large")
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return decodeRemoteError(response.StatusCode, raw)
	}
	if destination == nil {
		return nil
	}
	if err := json.Unmarshal(raw, destination); err != nil {
		return fmt.Errorf("decode workspace connector response: %w", err)
	}
	return nil
}

func decodeRemoteError(statusCode int, body []byte) error {
	var envelope errorResponse
	if err := json.Unmarshal(body, &envelope); err != nil || strings.TrimSpace(envelope.Error) == "" {
		return RemoteError{StatusCode: statusCode, Code: "workspace_connector_request_failed", Message: "workspace connector server returned an invalid error response"}
	}
	return RemoteError{
		StatusCode: statusCode,
		Code:       boundedText(envelope.Error, 128),
		Message:    boundedText(envelope.Message, 1024),
	}
}

func normalizeBaseURL(value string) (string, error) {
	value = strings.TrimRight(strings.TrimSpace(value), "/")
	if value == "" || strings.ContainsAny(value, "\r\n\x00") {
		return "", ErrInvalidConfig
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return "", ErrInvalidConfig
	}
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return strings.TrimRight(parsed.String(), "/"), nil
}

func boundedText(value string, max int) string {
	value = strings.TrimSpace(value)
	if len(value) > max {
		return value[:max]
	}
	return value
}

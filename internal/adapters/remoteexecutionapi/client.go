// Package remoteexecutionapi is the outbound adapter for the read-only remote
// execution target management contract.
package remoteexecutionapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/madou1217/ai_home/internal/remoteexecution"
)

const maxResponseBytes = 4 * 1024 * 1024

var (
	ErrInvalidConfig   = errors.New("remote execution API configuration is invalid")
	ErrInvalidResponse = errors.New("remote execution API response is invalid")
)

// HTTPClient is the minimal transport port used by the adapter.
type HTTPClient interface {
	Do(*http.Request) (*http.Response, error)
}

// Config contains only the remote endpoint and its management credential.
// The credential is intentionally not included in String or Error values.
type Config struct {
	BaseURL       string
	ManagementKey string
}

// Client reads remote target candidates and resolved preflight reports.
type Client struct {
	httpClient    HTTPClient
	baseURL       string
	managementKey string
}

// RemoteError is a bounded, machine-readable remote failure.
type RemoteError struct {
	StatusCode int
	Code       string
	Message    string
	Field      string
}

func (err RemoteError) Error() string {
	code := strings.TrimSpace(err.Code)
	if code == "" {
		code = "remote_target_request_failed"
	}
	message := strings.TrimSpace(err.Message)
	if message == "" {
		message = "remote target request failed"
	}
	if err.StatusCode > 0 {
		return fmt.Sprintf("remote target API returned %d %s: %s", err.StatusCode, code, message)
	}
	return fmt.Sprintf("%s: %s", code, message)
}

// TargetSelector is re-exported for callers that only need the adapter.
type TargetSelector = remoteexecution.TargetSelector

// ListResponse is the stable list response shared by CLI and completion.
type ListResponse struct {
	OK         bool                              `json:"ok"`
	ServerID   string                            `json:"serverId"`
	Candidates []remoteexecution.TargetCandidate `json:"candidates"`
	Warnings   []string                          `json:"warnings,omitempty"`
}

// ResolutionResponse is the stable resolve/preflight response.
type ResolutionResponse struct {
	OK         bool                       `json:"ok"`
	Resolution remoteexecution.Resolution `json:"resolution"`
}

// ErrorResponse is used when the server cannot resolve a target.
type ErrorResponse struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
	Field   string `json:"field,omitempty"`
}

// New creates a client with a validated HTTP(S) endpoint and non-empty key.
func New(httpClient HTTPClient, config Config) (*Client, error) {
	baseURL, err := normalizeBaseURL(config.BaseURL)
	key := strings.TrimSpace(config.ManagementKey)
	if httpClient == nil || err != nil || key == "" || strings.ContainsAny(key, "\r\n\x00") {
		return nil, ErrInvalidConfig
	}
	return &Client{httpClient: httpClient, baseURL: baseURL, managementKey: key}, nil
}

// List returns safe target candidates. It never attempts local discovery.
func (client *Client) List(ctx context.Context, selector TargetSelector) (ListResponse, error) {
	var response ListResponse
	err := client.getJSON(ctx, "/v1/management/webui/remote-targets", selector, &response)
	return response, err
}

// Resolve resolves one explicit or unambiguous target.
func (client *Client) Resolve(ctx context.Context, selector TargetSelector) (ResolutionResponse, error) {
	var response ResolutionResponse
	err := client.getJSON(ctx, "/v1/management/webui/remote-targets/resolve", selector, &response)
	return response, err
}

// Preflight returns the same resolved target plus its observable stage report.
func (client *Client) Preflight(ctx context.Context, selector TargetSelector) (ResolutionResponse, error) {
	var response ResolutionResponse
	err := client.getJSON(ctx, "/v1/management/webui/remote-targets/preflight", selector, &response)
	return response, err
}

func (client *Client) getJSON(ctx context.Context, path string, selector TargetSelector, destination any) error {
	if client == nil || client.httpClient == nil || strings.TrimSpace(client.baseURL) == "" || strings.TrimSpace(client.managementKey) == "" {
		return ErrInvalidConfig
	}
	if ctx == nil {
		return ErrInvalidResponse
	}
	requestURL, err := client.requestURL(path, selector)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL, nil)
	if err != nil {
		return fmt.Errorf("create remote target request: %w", err)
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+client.managementKey)
	response, err := client.httpClient.Do(request)
	if err != nil {
		return fmt.Errorf("execute remote target request: %w", err)
	}
	if response == nil || response.Body == nil {
		return ErrInvalidResponse
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil {
		return fmt.Errorf("read remote target response: %w", err)
	}
	if len(body) > maxResponseBytes {
		return ErrInvalidResponse
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return decodeRemoteError(response.StatusCode, body)
	}
	if err := json.Unmarshal(body, destination); err != nil {
		return errors.Join(ErrInvalidResponse, err)
	}
	return nil
}

func (client *Client) requestURL(path string, selector TargetSelector) (string, error) {
	parsed, err := url.Parse(client.baseURL + path)
	if err != nil {
		return "", fmt.Errorf("build remote target URL: %w", err)
	}
	query := parsed.Query()
	setQuery(query, "serverProfileId", selector.ServerProfileID)
	setQuery(query, "serverId", selector.ServerID)
	setQuery(query, "workspaceId", selector.WorkspaceID)
	setQuery(query, "connectionId", selector.ConnectionID)
	setQuery(query, "harness", selector.Harness)
	setQuery(query, "provider", selector.Provider)
	setQuery(query, "accountRef", selector.AccountRef)
	setQuery(query, "model", selector.Model)
	parsed.RawQuery = query.Encode()
	return parsed.String(), nil
}

func setQuery(query url.Values, key, value string) {
	if value = strings.TrimSpace(value); value != "" {
		query.Set(key, value)
	}
}

func decodeRemoteError(statusCode int, body []byte) error {
	var response ErrorResponse
	if json.Unmarshal(body, &response) == nil {
		return RemoteError{
			StatusCode: statusCode,
			Code:       boundedText(response.Error, 128),
			Message:    boundedText(response.Message, 1024),
			Field:      boundedText(response.Field, 128),
		}
	}
	return RemoteError{StatusCode: statusCode, Code: "remote_target_request_failed", Message: "remote target server returned an invalid error response"}
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

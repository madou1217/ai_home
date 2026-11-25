package acpclient

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// ToolResult is the provider-facing result of one Workspace Connector tool.
// The HTTP bridge returns MCP-shaped content; keeping this small type separates
// transport from the ACP mapping.
type ToolResult struct {
	Text    string
	IsError bool
}

type ToolClient interface {
	Call(ctx context.Context, name string, arguments map[string]any) (ToolResult, error)
}

// HTTPToolClient calls the Server's workspace tool endpoint with a
// session-scoped tool token. The token is never placed in argv or logs.
type HTTPToolClient struct {
	url    string
	token  string
	client *http.Client
}

func NewHTTPToolClient(url, token string, client *http.Client) *HTTPToolClient {
	if client == nil {
		client = &http.Client{Timeout: 35 * time.Minute}
	}
	return &HTTPToolClient{url: strings.TrimSpace(url), token: strings.TrimSpace(token), client: client}
}

func (client *HTTPToolClient) Call(ctx context.Context, name string, arguments map[string]any) (ToolResult, error) {
	if client.url == "" {
		return ToolResult{}, fmt.Errorf("workspace tool URL is not configured")
	}
	body, err := json.Marshal(map[string]any{"name": name, "arguments": arguments})
	if err != nil {
		return ToolResult{}, fmt.Errorf("marshal tool call: %w", err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, client.url, bytes.NewReader(body))
	if err != nil {
		return ToolResult{}, fmt.Errorf("create tool request: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-AIH-Remote-Tools-Token", client.token)
	response, err := client.client.Do(request)
	if err != nil {
		return ToolResult{}, fmt.Errorf("call workspace tool: %w", err)
	}
	defer func() { _ = response.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 32*1024*1024))
	if err != nil {
		return ToolResult{}, fmt.Errorf("read workspace tool response: %w", err)
	}
	if response.StatusCode != http.StatusOK {
		return ToolResult{}, fmt.Errorf("workspace tool HTTP %d: %s", response.StatusCode, strings.TrimSpace(string(raw)))
	}
	var parsed struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		IsError bool `json:"isError"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return ToolResult{}, fmt.Errorf("decode workspace tool response: %w", err)
	}
	var text strings.Builder
	for _, item := range parsed.Content {
		if item.Type == "text" {
			text.WriteString(item.Text)
		}
	}
	return ToolResult{Text: text.String(), IsError: parsed.IsError}, nil
}

package requirementruntime

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/madou1217/ai_home/application/requirements"
)

// GatewayModelClient 通过进程内 AIH 网关调用 /v1/chat/completions。
// Provider/账号由请求头显式提示，模型仍然走网关的账号池与路由规则。
type GatewayModelClient struct {
	Client    *http.Client
	BaseURL   string
	ClientKey func() string
}

// Complete 发起一次非流式模型补全。
func (client *GatewayModelClient) Complete(ctx context.Context, request requirements.ModelRequest) (string, error) {
	if client == nil || client.Client == nil {
		return "", fmt.Errorf("requirements_model_client_unavailable")
	}
	model := strings.TrimSpace(request.Model)
	if model == "" {
		return "", fmt.Errorf("requirements_model_required")
	}
	payload := map[string]any{
		"model":       model,
		"messages":    []map[string]string{{"role": "system", "content": request.System}, {"role": "user", "content": request.Prompt}},
		"temperature": 0.2,
		"stream":      false,
		"max_tokens":  4096,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	base := strings.TrimRight(strings.TrimSpace(client.BaseURL), "/")
	if base == "" {
		base = "http://aih-gateway.internal"
	}
	httpRequest, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/v1/chat/completions", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	httpRequest.Header.Set("Content-Type", "application/json")
	httpRequest.Header.Set("Accept", "application/json")
	if key := strings.TrimSpace(client.clientKey()); key != "" {
		httpRequest.Header.Set("Authorization", "Bearer "+key)
	}
	if provider := strings.TrimSpace(request.Provider); provider != "" {
		httpRequest.Header.Set("X-Provider", provider)
	}
	if accountRef := strings.TrimSpace(request.AccountRef); accountRef != "" {
		httpRequest.Header.Set("X-Account-Ref", accountRef)
	}
	response, err := client.Client.Do(httpRequest)
	if err != nil {
		return "", fmt.Errorf("需求优化请求失败: %w", err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 4<<20))
	if err != nil {
		return "", fmt.Errorf("读取模型响应失败: %w", err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", fmt.Errorf("需求优化失败: HTTP %d: %s", response.StatusCode, clip(string(raw), 400))
	}
	var decoded struct {
		Choices []struct {
			Message struct {
				Content any `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Error any `json:"error"`
	}
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return "", fmt.Errorf("模型响应不是 JSON: %w", err)
	}
	if len(decoded.Choices) == 0 {
		return "", fmt.Errorf("模型没有返回内容: %s", clip(string(raw), 400))
	}
	return contentText(decoded.Choices[0].Message.Content), nil
}

func (client *GatewayModelClient) clientKey() string {
	if client.ClientKey == nil {
		return ""
	}
	return client.ClientKey()
}

func contentText(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case []any:
		var builder strings.Builder
		for _, item := range typed {
			if object, ok := item.(map[string]any); ok {
				if text, ok := object["text"].(string); ok {
					builder.WriteString(text)
				}
			}
		}
		return builder.String()
	default:
		return fmt.Sprintf("%v", value)
	}
}

func clip(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit]) + "…"
}

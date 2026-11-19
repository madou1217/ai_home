// Package modelcatalog 执行插件 Provider 声明为 generic-models-probe 的目录探测。
//
// 插件描述符只提供数据（base URL / 认证形态来自账号凭据）；真正出网的是宿主侧
// 通用 OpenAI 兼容 /models 探测。没有这个实现，插件 Provider 的模型目录就只能
// 留在 Node 缓存里。
package modelcatalog

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
)

const (
	maxResponseBytes = 2 << 20
	defaultTimeout   = 15 * time.Second
)

// Discoverer 是插件 Provider 的通用 /models 探测器。
type Discoverer struct {
	Client  HTTPClient
	Timeout time.Duration
}

// HTTPClient 是最小 HTTP 端口。
type HTTPClient interface {
	Do(request *http.Request) (*http.Response, error)
}

type apiKeyCredential interface{ APIKey() string }
type baseURLCredential interface{ BaseURL() string }
type authKindCredential interface{ AuthKind() string }

// DiscoverModels 读取账号可见的模型 ID 集合。
func (discoverer *Discoverer) DiscoverModels(
	ctx context.Context,
	credential accountapp.Credential,
	descriptor accountapp.PluginProviderDescriptor,
) ([]string, error) {
	if discoverer == nil || ctx == nil || credential == nil {
		return nil, errors.New("plugin model discovery unavailable")
	}
	if len(descriptor.Modes) > 0 {
		if kind, ok := credential.(authKindCredential); ok {
			matched := false
			for _, mode := range descriptor.Modes {
				if strings.EqualFold(strings.TrimSpace(mode), strings.TrimSpace(kind.AuthKind())) {
					matched = true
					break
				}
			}
			if !matched {
				return nil, fmt.Errorf("plugin model discovery not applicable to auth kind %q", kind.AuthKind())
			}
		}
	}
	baseURL := ""
	if value, ok := credential.(baseURLCredential); ok {
		baseURL = strings.TrimRight(strings.TrimSpace(value.BaseURL()), "/")
	}
	if baseURL == "" {
		return nil, errors.New("plugin provider has no base url")
	}
	apiKey := ""
	if value, ok := credential.(apiKeyCredential); ok {
		apiKey = strings.TrimSpace(value.APIKey())
	}
	client := discoverer.Client
	timeout := discoverer.Timeout
	if timeout <= 0 {
		timeout = defaultTimeout
	}
	if client == nil {
		client = &http.Client{Timeout: timeout}
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	// 先探测 <base>/models，再回退 <base>/v1/models；返回值是模型 ID 列表。
	modelIDs, err := probeModels(ctx, client, baseURL+"/models", apiKey)
	if err == nil && len(modelIDs) > 0 {
		return modelIDs, nil
	}
	if !strings.HasSuffix(baseURL, "/v1") {
		if fallbackIDs, fallbackErr := probeModels(ctx, client, baseURL+"/v1/models", apiKey); fallbackErr == nil && len(fallbackIDs) > 0 {
			return fallbackIDs, nil
		}
	}
	if err != nil {
		return nil, err
	}
	return []string{}, nil
}

func probeModels(ctx context.Context, client HTTPClient, endpoint string, apiKey string) ([]string, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/json")
	if apiKey != "" {
		request.Header.Set("Authorization", "Bearer "+apiKey)
		request.Header.Set("x-api-key", apiKey)
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64*1024))
		return nil, fmt.Errorf("models endpoint status %d", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil {
		return nil, err
	}
	if len(body) > maxResponseBytes {
		return nil, errors.New("models response too large")
	}
	var payload struct {
		Data   []map[string]any `json:"data"`
		Models []map[string]any `json:"models"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, err
	}
	entries := payload.Data
	if len(entries) == 0 {
		entries = payload.Models
	}
	ids := make([]string, 0, len(entries))
	seen := map[string]bool{}
	for _, entry := range entries {
		id := strings.TrimSpace(fmt.Sprint(entry["id"]))
		if id == "" || id == "<nil>" {
			id = strings.TrimSpace(fmt.Sprint(entry["name"]))
		}
		if id == "" || id == "<nil>" || seen[id] {
			continue
		}
		seen[id] = true
		ids = append(ids, id)
	}
	return ids, nil
}

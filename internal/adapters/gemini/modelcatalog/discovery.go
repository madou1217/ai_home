// Package modelcatalog 发现 Gemini 账号可用的模型目录。
//
// gemini 有两种账号形态：
//   - Vertex 占位/网关号（*gemini.VertexAuth）：base_url 指向兼容网关，直接读
//     网关的 /v1/models（OpenAI 风格）或 /models（Gemini 风格）。
//   - 登录态账号（code-assist）：需要 loadCodeAssist/fetchAvailableModels 预检，
//     不在本包范围（返回 ErrUnsupportedCredential，由调用方保留原目录）。
package modelcatalog

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/core/accounts/gemini"
)

const (
	providerID       = "gemini"
	maxResponseBytes = 1 << 20
)

var (
	ErrInvalidDependencies   = errors.New("gemini 模型目录源依赖无效")
	ErrUnsupportedCredential = errors.New("gemini 模型目录源凭据形态不支持")
	ErrEmptyCatalog          = errors.New("gemini 模型目录为空")
)

// HTTPClient 是最小传输端口。
type HTTPClient interface {
	Do(*http.Request) (*http.Response, error)
}

// Source 是 gemini 的模型发现策略。
type Source struct{ client HTTPClient }

var _ accountapp.ProviderModelDiscoverer = (*Source)(nil)

// New 创建目录源。
func New(client HTTPClient) (*Source, error) {
	if client == nil {
		return nil, ErrInvalidDependencies
	}
	return &Source{client: client}, nil
}

// ProviderID 返回 gemini。
func (source *Source) ProviderID() string { return providerID }

// DiscoverModels 读取 Vertex 占位/网关号的模型目录。
func (source *Source) DiscoverModels(
	ctx context.Context,
	credential accountapp.Credential,
) ([]string, error) {
	if source == nil || source.client == nil || ctx == nil || credential == nil {
		return nil, ErrInvalidDependencies
	}
	if credential.ProviderID() != providerID {
		return nil, ErrUnsupportedCredential
	}
	vertex, ok := credential.(*gemini.VertexAuth)
	if !ok || vertex == nil {
		return nil, ErrUnsupportedCredential
	}
	base := strings.TrimRight(strings.TrimSpace(vertex.BaseURL()), "/")
	token := strings.TrimSpace(vertex.APIKey())
	if base == "" || token == "" {
		return nil, ErrUnsupportedCredential
	}
	for _, endpoint := range []string{base + "/v1/models", base + "/models"} {
		models, err := source.fetch(ctx, endpoint, token)
		if err != nil {
			if ctxErr := ctx.Err(); ctxErr != nil {
				return nil, ctxErr
			}
			continue
		}
		return models, nil
	}
	return nil, ErrEmptyCatalog
}

func (source *Source) fetch(ctx context.Context, endpoint string, token string) ([]string, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, ErrInvalidDependencies
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+token)
	response, err := source.client.Do(request)
	if err != nil {
		return nil, err
	}
	defer func() {
		_ = response.Body.Close()
	}()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return nil, fmt.Errorf("gemini 模型清单请求失败: HTTP %d", response.StatusCode)
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil {
		return nil, err
	}
	if len(payload) > maxResponseBytes {
		return nil, ErrEmptyCatalog
	}
	return parseModels(payload), nil
}

// parseModels 同时接受 OpenAI 风格 [{id}] 与 Gemini 风格 [{name:"models/x"}]。
func parseModels(payload []byte) []string {
	var document struct {
		Data []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"data"`
		Models []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"models"`
	}
	if json.Unmarshal(payload, &document) != nil {
		return nil
	}
	entries := document.Data
	if len(entries) == 0 {
		entries = document.Models
	}
	seen := make(map[string]struct{}, len(entries))
	models := make([]string, 0, len(entries))
	for _, entry := range entries {
		id := strings.TrimSpace(firstNonEmpty(entry.ID, entry.Name))
		if id == "" {
			continue
		}
		if strings.HasPrefix(strings.ToLower(id), "models/") {
			id = id[len("models/"):]
		}
		if id == "" {
			continue
		}
		key := strings.ToLower(id)
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		models = append(models, id)
	}
	sort.Strings(models)
	return models
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

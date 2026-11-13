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
	"net"
	"net/http"
	"net/url"
	"runtime"
	"sort"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
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
type Source struct {
	client HTTPClient
	// allowLoopback 仅供测试：生产必须拒绝指向本机网关的 base_url。
	allowLoopback bool
}

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
	if native, ok := credential.(*accountcore.NativeCredential); ok && native != nil &&
		native.ProviderID() == providerID {
		token, tokenOK := geminiOAuthToken(native.Payload())
		if !tokenOK {
			return nil, ErrUnsupportedCredential
		}
		return source.discoverCodeAssist(ctx, token)
	}
	vertex, ok := credential.(*gemini.VertexAuth)
	if !ok || vertex == nil {
		return nil, ErrUnsupportedCredential
	}
	// 占位账号没有可路由的上游：它的 base_url 是本机网关，刷新会把整份网关目录
	// 灌进 account_models。语义上直接拒绝，不依赖 enabled=0 的约定。
	if vertex.Placeholder() {
		return nil, ErrUnsupportedCredential
	}
	base := strings.TrimRight(strings.TrimSpace(vertex.BaseURL()), "/")
	token := strings.TrimSpace(vertex.APIKey())
	if base == "" || token == "" {
		return nil, ErrUnsupportedCredential
	}
	if !source.allowLoopback && isLoopbackBase(base) {
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

// isLoopbackBase 拒绝把本机网关当成上游（Node 的 infinite_loop_detected 同款保护）。
//
// 不能只比对字面主机名：localhost.、[::1]、[::ffff:127.0.0.1]、
// [0:0:0:0:0:0:0:1] 都是同一个本机地址，必须按 IP 语义判定。
func isLoopbackBase(baseURL string) bool {
	parsed, err := url.Parse(baseURL)
	if err != nil {
		return false
	}
	host := strings.ToLower(strings.TrimSuffix(parsed.Hostname(), "."))
	if host == "" {
		return false
	}
	if host == "localhost" {
		return true
	}
	if address := net.ParseIP(host); address != nil {
		return address.IsLoopback() || address.IsUnspecified()
	}
	return false
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

// geminiOAuthToken 从 native_auth_json 的 oauthCreds 读取 access token。
func geminiOAuthToken(payload []byte) (string, bool) {
	var document map[string]any
	if err := json.Unmarshal(payload, &document); err != nil {
		return "", false
	}
	oauth := geminiObject(document["oauthCreds"])
	if oauth == nil {
		oauth = geminiObject(document["oauth_creds"])
	}
	if oauth == nil {
		if credentials := geminiObject(document["credentials"]); credentials != nil {
			oauth = geminiObject(credentials["oauthCreds"])
			if oauth == nil {
				oauth = geminiObject(credentials["oauth_creds"])
			}
		}
	}
	if oauth == nil {
		return "", false
	}
	token := strings.TrimSpace(geminiString(oauth["access_token"]))
	if token == "" {
		token = strings.TrimSpace(geminiString(oauth["accessToken"]))
	}
	return token, token != ""
}

// discoverCodeAssist 用 loadCodeAssist/fetchAvailableModels 读取 OAuth 账号目录。
func (source *Source) discoverCodeAssist(ctx context.Context, token string) ([]string, error) {
	project := ""
	loadBody := map[string]any{
		"metadata": map[string]string{
			"ideType":    "GEMINI",
			"platform":   "PLATFORM_UNSPECIFIED",
			"pluginType": "GEMINI",
		},
	}
	if payload, err := json.Marshal(loadBody); err == nil {
		if response, requestErr := source.postGemini(ctx, "loadCodeAssist", token, payload); requestErr == nil {
			var document struct {
				Project string `json:"cloudaicompanionProject"`
			}
			if json.Unmarshal(response, &document) == nil {
				project = strings.TrimSpace(document.Project)
			}
		}
	}
	modelsBody := map[string]any{"requestId": "aih-model-discovery"}
	if project != "" {
		modelsBody["project"] = project
	}
	payload, err := json.Marshal(modelsBody)
	if err != nil {
		return nil, ErrInvalidDependencies
	}
	response, err := source.postGemini(ctx, "fetchAvailableModels", token, payload)
	if err != nil {
		return nil, err
	}
	var document struct {
		Models map[string]json.RawMessage `json:"models"`
	}
	if err := json.Unmarshal(response, &document); err != nil {
		return nil, ErrEmptyCatalog
	}
	seen := make(map[string]struct{}, len(document.Models))
	models := make([]string, 0, len(document.Models))
	for id := range document.Models {
		trimmed := strings.TrimSpace(id)
		if trimmed == "" {
			continue
		}
		key := strings.ToLower(trimmed)
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		models = append(models, trimmed)
	}
	if len(models) == 0 {
		return nil, ErrEmptyCatalog
	}
	sort.Strings(models)
	return models, nil
}

func (source *Source) postGemini(
	ctx context.Context,
	method string,
	token string,
	body []byte,
) ([]byte, error) {
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		"https://cloudcode-pa.googleapis.com/v1internal:"+method,
		strings.NewReader(string(body)),
	)
	if err != nil {
		return nil, ErrInvalidDependencies
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", geminiCatalogUserAgent())
	response, err := source.client.Do(request)
	if err != nil {
		return nil, err
	}
	if response == nil || response.Body == nil {
		return nil, ErrEmptyCatalog
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return nil, fmt.Errorf("gemini 模型清单请求失败: HTTP %d", response.StatusCode)
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil || len(payload) == 0 || len(payload) > maxResponseBytes {
		return nil, ErrEmptyCatalog
	}
	return payload, nil
}

func geminiCatalogUserAgent() string {
	platform := runtime.GOOS
	if platform == "windows" {
		platform = "win32"
	}
	arch := runtime.GOARCH
	if arch == "amd64" {
		arch = "x64"
	}
	return "GeminiCLI-cli-command/0.42.0/unknown (" + platform + "; " + arch + "; terminal)"
}

func geminiObject(value any) map[string]any {
	object, _ := value.(map[string]any)
	return object
}

func geminiString(value any) string {
	text, _ := value.(string)
	return text
}

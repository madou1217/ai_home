package harnessrun

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/serverconfig"
	"github.com/madou1217/ai_home/internal/transport/http/webuiserverconfigapi"
)

const (
	defaultServerHost = "127.0.0.1"
	defaultServerPort = 9527
	catalogTimeout    = 15 * time.Second
)

// gatewayConnection 与 Node lib/server/codex-gateway-connection.js 的连接契约一致：
// URL、网关认证和账号绑定必须来自同一份配置。
type gatewayConnection struct {
	BaseURL    string
	APIKey     string
	AccountRef string
}

// readGatewayConnection 读取 config:server 并构造 <baseUrl>/v1。
func readGatewayConnection(
	ctx context.Context,
	aiHomeDir string,
	lookupEnv func(string) (string, bool),
	accountRef string,
) (gatewayConnection, error) {
	config, err := webuiserverconfigapi.ReadFullConfig(ctx, aiHomeDir)
	if err != nil {
		return gatewayConnection{}, err
	}
	apiKey := strings.TrimSpace(config.APIKey)
	if apiKey == "" {
		apiKey = firstEnvValue(lookupEnv, "AIH_GATEWAY_API_KEY", "AIH_SERVER_API_KEY")
	}
	return gatewayConnection{
		BaseURL:    buildServerBaseURL(config.Host, config.Port),
		APIKey:     apiKey,
		AccountRef: strings.TrimSpace(accountRef),
	}, nil
}

// buildServerBaseURL 复刻 Node server-defaults 的 buildServerUrl(config, '/v1')。
//
// 归一规则（主机回落、IPv6 方括号、端口越界回落）只在 application/serverconfig 定义一次。
func buildServerBaseURL(host string, port int) string {
	return serverconfig.BaseURL(host, port, "/v1")
}

func firstEnvValue(lookupEnv func(string) (string, bool), keys ...string) string {
	if lookupEnv == nil {
		return ""
	}
	for _, key := range keys {
		if value, ok := lookupEnv(key); ok {
			if trimmed := strings.TrimSpace(value); trimmed != "" {
				return trimmed
			}
		}
	}
	return ""
}

// modelModalities 是网关 /v1/models 行的归一化模态。
type modelModalities struct {
	Input  []string
	Output []string
}

// gatewayModel 是 /v1/models 的一行（只保留 harness 需要的事实）。
type gatewayModel struct {
	ID               string
	Modalities       *modelModalities
	ReasoningEfforts []string
}

type gatewayModelRow struct {
	ID                 string          `json:"id"`
	Modalities         json.RawMessage `json:"modalities"`
	AIHModalities      json.RawMessage `json:"aih_modalities"`
	AIHReasoningEffort []any           `json:"aih_reasoning_efforts"`
}

// fetchGatewayModelCatalog 复刻 Node fetchGatewayModelCatalog：
//   - GET <baseUrl>/models，Bearer API key；accountRef 合法时带 x-account-ref；
//   - 去重、过滤「输出只有图片」的生图模型；
//   - 原样保留 aih_reasoning_efforts。
func fetchGatewayModelCatalog(
	ctx context.Context,
	baseURL string,
	apiKey string,
	accountRef string,
) ([]gatewayModel, error) {
	if strings.TrimSpace(baseURL) == "" {
		return nil, fmt.Errorf("gateway_base_url_missing")
	}
	if strings.TrimSpace(apiKey) == "" {
		return nil, fmt.Errorf("gateway_api_key_missing")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(baseURL, "/")+"/models", nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+apiKey)
	request.Header.Set("Accept", "application/json")
	if isAccountRef(accountRef) {
		request.Header.Set("x-account-ref", strings.TrimSpace(accountRef))
	}
	client := &http.Client{Timeout: catalogTimeout}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return nil, fmt.Errorf("gateway_models_http_%d", response.StatusCode)
	}
	var payload struct {
		Data []gatewayModelRow `json:"data"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return nil, err
	}
	models := make([]gatewayModel, 0, len(payload.Data))
	seen := make(map[string]bool)
	for _, row := range payload.Data {
		id := strings.TrimSpace(row.ID)
		if id == "" || seen[id] {
			continue
		}
		modalities := normalizeModalities(firstNonEmptyRaw(row.AIHModalities, row.Modalities))
		if modalities != nil && len(modalities.Output) > 0 && !containsString(modalities.Output, "text") {
			// 纯生图模型不能进 harness 选择器：选中后每一轮都会失败。
			continue
		}
		entry := gatewayModel{ID: id, Modalities: modalities}
		if len(row.AIHReasoningEffort) > 0 {
			entry.ReasoningEfforts = stringList(row.AIHReasoningEffort)
		}
		seen[id] = true
		models = append(models, entry)
	}
	return models, nil
}

func firstNonEmptyRaw(primary json.RawMessage, fallback json.RawMessage) json.RawMessage {
	if len(primary) > 0 && string(primary) != "null" {
		return primary
	}
	return fallback
}

// normalizeModalities 返回 nil 表示不是对象（Node normalizeModalities 的 null）。
func normalizeModalities(raw json.RawMessage) *modelModalities {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var value map[string]any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil
	}
	return &modelModalities{
		Input:  stringList(value["input"]),
		Output: stringList(value["output"]),
	}
}

func stringList(value any) []string {
	items, ok := value.([]any)
	if !ok {
		return []string{}
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		text := strings.ToLower(strings.TrimSpace(jsTextValue(item)))
		if text != "" {
			out = append(out, text)
		}
	}
	return out
}

func containsString(items []string, value string) bool {
	for _, item := range items {
		if item == value {
			return true
		}
	}
	return false
}

// Package webuiserverconfigapi 提供 WebUI server 配置的只读公开视图。
//
// 唯一持久化位置是 Node app-state.db 的 config:server。写入口仍在 Node
// （POST /v0/webui/server-config）；本包只读，并复刻 Node sanitizeServerConfig 的
// 默认值/夹取/归一化规则，最后按 toPublicServerConfig 隐藏 apiKey/managementKey。
//
// 与 Node 的对拍夹具在 test/fixtures/server-config-sanitize-cases.json：
// Node 与 Go 两侧测试都读同一份用例，改规则必须同时过两边。
package webuiserverconfigapi

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/madou1217/ai_home/application/serverconfig"
	"math"
	"net/http"
	"strconv"
	"strings"

	corepolicy "github.com/madou1217/ai_home/core/upstreamretry"
)

const (
	// Path 是 server 配置的只读管理契约。
	Path = "/v1/management/webui/server-config"

	// 监听主机与端口的归一规则只在 application/serverconfig 定义一次。
	defaultServerHost = serverconfig.DefaultHost
	defaultServerPort = serverconfig.DefaultPort

	defaultModelsProbeAccounts = 2
	defaultWindowIntervalMs    = 3600000 // 1h
	minWindowIntervalMs        = 60000   // 1m
	minLargePasteChars         = 50
	maxLargePasteChars         = 100000
	maxEgressEvidenceTTLMs     = 31536000000
	minEgressEvidenceTTLMs     = 60000
)

// ErrInvalidDependencies 表示 Handler 缺少必需端口。
var ErrInvalidDependencies = errors.New("server 配置接口依赖无效")

// Authorizer 校验管理密钥。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Store 读写 Node 的 config:server 原文。
type Store interface {
	ReadServerConfig(ctx context.Context) (string, bool, error)
	// UpdateServerConfig 在立即事务里读改写 config:server。
	UpdateServerConfig(ctx context.Context, mutate func(current string, found bool) (string, error)) error
}

// Dependencies 汇总只读依赖。
type Dependencies struct {
	Authorizer Authorizer
	Store      Store
	// OnSaved 在 config:server 成功落库后收到归一化配置，供运行时立即刷新热快照（可选）。
	OnSaved func(ConfigView)
}

// Handler 处理 server 配置读取。
type Handler struct {
	authorizer Authorizer
	store      Store
	onSaved    func(ConfigView)
}

// NewHandler 创建默认失败关闭的 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Store == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		authorizer: dependencies.Authorizer,
		store:      dependencies.Store,
		onSaved:    dependencies.OnSaved,
	}, nil
}

// ConfigView 是 Node toPublicServerConfig 的响应形状。
type ConfigView struct {
	Host                              string                  `json:"host"`
	Port                              int                     `json:"port"`
	APIKey                            string                  `json:"apiKey"`
	ManagementKey                     string                  `json:"managementKey"`
	OpenNetwork                       bool                    `json:"openNetwork"`
	ProxyURL                          string                  `json:"proxyUrl"`
	NoProxy                           string                  `json:"noProxy"`
	ModelsProbeAccounts               float64                 `json:"modelsProbeAccounts"`
	ModelCacheSync                    string                  `json:"modelCacheSync"`
	WindowActivation                  bool                    `json:"windowActivation"`
	WindowActivationDefaultIntervalMs float64                 `json:"windowActivationDefaultIntervalMs"`
	WindowActivationMinIntervalMs     float64                 `json:"windowActivationMinIntervalMs"`
	GoCoreEnabled                     bool                    `json:"goCoreEnabled"`
	GoCoreRoutes                      []string                `json:"goCoreRoutes"`
	UpstreamErrorRuleProviders        []string                `json:"upstreamErrorRuleProviders"`
	RelayUDP                          string                  `json:"relayUdp"`
	RelayUDPAdvertiseHost             string                  `json:"relayUdpAdvertiseHost"`
	RelayUDPAdvertisePort             float64                 `json:"relayUdpAdvertisePort"`
	RelayPortMode                     string                  `json:"relayPortMode"`
	RelayListenHost                   string                  `json:"relayListenHost"`
	MaxAttempts                       float64                 `json:"maxAttempts"`
	EgressEvidenceTTLMs               float64                 `json:"egressEvidenceTtlMs"`
	LargePasteChars                   int                     `json:"largePasteChars"`
	Upstream429Retry                  corepolicy.GlobalPolicy `json:"upstream429Retry"`
	APIKeyConfigured                  bool                    `json:"apiKeyConfigured"`
	ManagementKeyConfigured           bool                    `json:"managementKeyConfigured"`
}

type responseView struct {
	OK     bool       `json:"ok"`
	Config ConfigView `json:"config"`
}

type errorView struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}

// ServeHTTP 接受 GET/POST：GET 读公开视图，POST 合并并写回 config:server。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.store == nil {
		writeError(response, http.StatusServiceUnavailable, "server_config_unavailable", "server 配置服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	if request.Method != http.MethodGet && request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodGet+", "+http.MethodPost)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 GET/POST")
		return
	}
	if request.Method == http.MethodPost {
		handler.writeConfig(response, request)
		return
	}
	raw, found, err := handler.store.ReadServerConfig(request.Context())
	if err != nil {
		writeError(response, http.StatusInternalServerError, "get_server_config_failed", "")
		return
	}
	config, err := sanitizeServerConfigFromJSON(raw, found)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "get_server_config_failed", "config:server 不是合法 JSON")
		return
	}
	writeJSON(response, http.StatusOK, responseView{OK: true, Config: config})
}

func sanitizeServerConfigFromJSON(raw string, found bool) (ConfigView, error) {
	config, err := sanitizeFullServerConfigFromJSON(raw, found)
	if err != nil {
		return ConfigView{}, err
	}
	return publicServerConfig(config), nil
}

// sanitizeFullServerConfigFromJSON 是写路径用的完整配置（保留密钥，不设 configured 标志）。
func sanitizeFullServerConfigFromJSON(raw string, found bool) (ConfigView, error) {
	input := map[string]any{}
	if found && strings.TrimSpace(raw) != "" {
		var decoded any
		if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
			return ConfigView{}, err
		}
		if object, ok := decoded.(map[string]any); ok {
			input = object
		}
	}
	return sanitizeServerConfig(input), nil
}

// sanitizeServerConfig 使用 application/serverconfig 的共享 schema 归一化。
// 字段默认值、范围、枚举与「历史字段」判定都只在那里定义，WebUI 与 CLI 不再各存一份。
func sanitizeServerConfig(input map[string]any) ConfigView {
	return configViewFromValues(serverconfig.Sanitize(input))
}

// SanitizeView 供重启接口等复用同一套归一化，避免再造一份 sanitize 副本。
func SanitizeView(input map[string]any) ConfigView {
	return configViewFromValues(serverconfig.Sanitize(input))
}

func configViewFromValues(values map[string]any) ConfigView {
	view := ConfigView{
		Host:                              jsString(values["host"]),
		Port:                              int(numberOr(values["port"], float64(serverconfig.DefaultPort))),
		APIKey:                            jsString(values["apiKey"]),
		ManagementKey:                     jsString(values["managementKey"]),
		OpenNetwork:                       values["openNetwork"] == true,
		ProxyURL:                          jsString(values["proxyUrl"]),
		NoProxy:                           jsString(values["noProxy"]),
		ModelsProbeAccounts:               numberOr(values["modelsProbeAccounts"], 2),
		ModelCacheSync:                    jsString(values["modelCacheSync"]),
		WindowActivation:                  values["windowActivation"] == true,
		WindowActivationDefaultIntervalMs: numberOr(values["windowActivationDefaultIntervalMs"], float64(3600000)),
		WindowActivationMinIntervalMs:     numberOr(values["windowActivationMinIntervalMs"], float64(3600000)),
		GoCoreEnabled:                     values["goCoreEnabled"] == true,
		GoCoreRoutes:                      stringList(values["goCoreRoutes"]),
		UpstreamErrorRuleProviders:        stringList(values["upstreamErrorRuleProviders"]),
		RelayUDP:                          jsString(values["relayUdp"]),
		RelayUDPAdvertiseHost:             jsString(values["relayUdpAdvertiseHost"]),
		RelayUDPAdvertisePort:             numberOr(values["relayUdpAdvertisePort"], 0),
		RelayPortMode:                     jsString(values["relayPortMode"]),
		RelayListenHost:                   jsString(values["relayListenHost"]),
		MaxAttempts:                       numberOr(values["maxAttempts"], 0),
		EgressEvidenceTTLMs:               numberOr(values["egressEvidenceTtlMs"], 0),
		LargePasteChars:                   int(numberOr(values["largePasteChars"], 0)),
	}
	if retry, ok := values["upstream429Retry"].(corepolicy.GlobalPolicy); ok {
		view.Upstream429Retry = retry
	} else {
		view.Upstream429Retry = corepolicy.SanitizeGlobalRaw(values["upstream429Retry"])
	}
	return view
}

func stringList(value any) []string {
	if items, ok := value.([]string); ok {
		return items
	}
	return nil
}

func normalizeServerPort(value any) int {
	return serverconfig.NormalizePort(value)
}

func normalizeLargePasteChars(value any) int {
	number := math.Round(numberOr(value, 0))
	if number <= 0 {
		return 0
	}
	if number < minLargePasteChars {
		return minLargePasteChars
	}
	if number > maxLargePasteChars {
		return maxLargePasteChars
	}
	return int(number)
}

func clampNumber(value any, min float64, max float64, fallback float64) float64 {
	number := numberOr(value, fallback)
	if number < min {
		return min
	}
	if number > max {
		return max
	}
	return number
}

// normalizeStringList 复刻 Node：数组逐项 String 后去空白、去重（Set 保序）；
// 非数组按 String(value || ”).split(',')。
func normalizeStringList(value any, lowercase bool) []string {
	items := make([]string, 0)
	if list, ok := value.([]any); ok {
		for _, item := range list {
			items = append(items, jsString(item))
		}
	} else {
		text := ""
		if value != nil && jsBool(value) {
			text = jsString(value)
		}
		if text != "" {
			items = strings.Split(text, ",")
		}
	}
	seen := map[string]struct{}{}
	result := make([]string, 0, len(items))
	for _, item := range items {
		normalized := strings.TrimSpace(item)
		if lowercase {
			normalized = strings.ToLower(normalized)
		}
		if normalized == "" {
			continue
		}
		if _, exists := seen[normalized]; exists {
			continue
		}
		seen[normalized] = struct{}{}
		result = append(result, normalized)
	}
	return result
}

func valueOrNil(value any) any {
	if value == nil {
		return nil
	}
	return value
}

// numberOr 对齐 Node 的 `Number(value) || fallback`。
func numberOr(value any, fallback float64) float64 {
	number := jsNumber(value)
	if math.IsNaN(number) || number == 0 {
		return fallback
	}
	return number
}

func jsNumber(value any) float64 {
	switch typed := value.(type) {
	case nil:
		return 0
	case float64:
		return typed
	case bool:
		if typed {
			return 1
		}
		return math.NaN()
	case string:
		text := strings.TrimSpace(typed)
		if text == "" {
			return 0
		}
		parsed, err := strconv.ParseFloat(text, 64)
		if err != nil {
			return math.NaN()
		}
		return parsed
	default:
		return math.NaN()
	}
}

func jsBool(value any) bool {
	switch typed := value.(type) {
	case nil:
		return false
	case bool:
		return typed
	case string:
		return typed != ""
	case float64:
		return typed != 0 && !math.IsNaN(typed)
	default:
		return true
	}
}

func jsString(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case bool:
		if typed {
			return "true"
		}
		return "false"
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	default:
		return "[object Object]"
	}
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code string, message string) {
	writeJSON(response, status, errorView{OK: false, Error: code, Message: message})
}

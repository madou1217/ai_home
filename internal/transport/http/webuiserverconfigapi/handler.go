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
	"math"
	"net/http"
	"strconv"
	"strings"
)

const (
	// Path 是 server 配置的只读管理契约。
	Path = "/v1/management/webui/server-config"

	defaultServerHost = "127.0.0.1"
	defaultServerPort = 9527

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

// Store 读取 Node 的 config:server 原文。
type Store interface {
	ReadServerConfig(ctx context.Context) (string, bool, error)
}

// Dependencies 汇总只读依赖。
type Dependencies struct {
	Authorizer Authorizer
	Store      Store
}

// Handler 处理 server 配置读取。
type Handler struct {
	authorizer Authorizer
	store      Store
}

// NewHandler 创建默认失败关闭的 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Store == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{authorizer: dependencies.Authorizer, store: dependencies.Store}, nil
}

// ConfigView 是 Node toPublicServerConfig 的响应形状。
type ConfigView struct {
	Host                              string   `json:"host"`
	Port                              int      `json:"port"`
	APIKey                            string   `json:"apiKey"`
	ManagementKey                     string   `json:"managementKey"`
	OpenNetwork                       bool     `json:"openNetwork"`
	ProxyURL                          string   `json:"proxyUrl"`
	NoProxy                           string   `json:"noProxy"`
	ModelsProbeAccounts               float64  `json:"modelsProbeAccounts"`
	ModelCacheSync                    string   `json:"modelCacheSync"`
	WindowActivation                  bool     `json:"windowActivation"`
	WindowActivationDefaultIntervalMs float64  `json:"windowActivationDefaultIntervalMs"`
	WindowActivationMinIntervalMs     float64  `json:"windowActivationMinIntervalMs"`
	GoCoreEnabled                     bool     `json:"goCoreEnabled"`
	GoCoreRoutes                      []string `json:"goCoreRoutes"`
	UpstreamErrorRuleProviders        []string `json:"upstreamErrorRuleProviders"`
	RelayUDP                          string   `json:"relayUdp"`
	RelayUDPAdvertiseHost             string   `json:"relayUdpAdvertiseHost"`
	RelayUDPAdvertisePort             float64  `json:"relayUdpAdvertisePort"`
	RelayPortMode                     string   `json:"relayPortMode"`
	RelayListenHost                   string   `json:"relayListenHost"`
	MaxAttempts                       float64  `json:"maxAttempts"`
	EgressEvidenceTTLMs               float64  `json:"egressEvidenceTtlMs"`
	LargePasteChars                   int      `json:"largePasteChars"`
	APIKeyConfigured                  bool     `json:"apiKeyConfigured"`
	ManagementKeyConfigured           bool     `json:"managementKeyConfigured"`
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

// ServeHTTP 只接受 GET。
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
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 GET")
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

// sanitizeServerConfig 复刻 Node sanitizeServerConfig + toPublicServerConfig。
func sanitizeServerConfig(input map[string]any) ConfigView {
	requestedHost := defaultServerHost
	if value, ok := input["host"]; ok && value != nil {
		requestedHost = strings.TrimSpace(jsString(value))
	}
	host := defaultServerHost
	if requestedHost != "" && requestedHost != "0.0.0.0" {
		host = requestedHost
	}
	openNetwork := jsBool(input["openNetwork"]) || requestedHost == "0.0.0.0"

	apiKey := strings.TrimSpace(jsString(valueOrNil(input["apiKey"])))
	managementKey := strings.TrimSpace(jsString(valueOrNil(input["managementKey"])))
	if openNetwork {
		host = "0.0.0.0"
	}

	minInterval := math.Max(
		minWindowIntervalMs,
		numberOr(input["windowActivationMinIntervalMs"], defaultWindowIntervalMs),
	)
	defaultInterval := math.Max(
		minInterval,
		numberOr(input["windowActivationDefaultIntervalMs"], defaultWindowIntervalMs),
	)

	relayUDPRaw := "default"
	if value, ok := input["relayUdp"]; ok && value != nil {
		relayUDPRaw = strings.ToLower(strings.TrimSpace(jsString(value)))
	}
	relayUDP := "default"
	if relayUDPRaw == "on" || relayUDPRaw == "off" {
		relayUDP = relayUDPRaw
	}

	relayPortModeRaw := "default"
	if value, ok := input["relayPortMode"]; ok && value != nil {
		relayPortModeRaw = strings.ToLower(strings.TrimSpace(jsString(value)))
	}
	relayPortMode := "default"
	if relayPortModeRaw == "server" || relayPortModeRaw == "dedicated" {
		relayPortMode = relayPortModeRaw
	}

	egressTTL := math.Round(numberOr(input["egressEvidenceTtlMs"], 0))
	if egressTTL < minEgressEvidenceTTLMs {
		egressTTL = 0
	} else if egressTTL > maxEgressEvidenceTTLMs {
		egressTTL = maxEgressEvidenceTTLMs
	}

	config := ConfigView{
		Host:                              host,
		Port:                              normalizeServerPort(input["port"]),
		APIKey:                            "",
		ManagementKey:                     "",
		OpenNetwork:                       openNetwork,
		ProxyURL:                          strings.TrimSpace(jsString(valueOrNil(input["proxyUrl"]))),
		NoProxy:                           strings.TrimSpace(jsString(valueOrNil(input["noProxy"]))),
		ModelsProbeAccounts:               clampNumber(input["modelsProbeAccounts"], 1, 8, defaultModelsProbeAccounts),
		ModelCacheSync:                    "go-batch",
		WindowActivation:                  input["windowActivation"] == true,
		WindowActivationDefaultIntervalMs: defaultInterval,
		WindowActivationMinIntervalMs:     minInterval,
		GoCoreEnabled:                     input["goCoreEnabled"] == true,
		GoCoreRoutes:                      normalizeStringList(input["goCoreRoutes"], false),
		UpstreamErrorRuleProviders:        normalizeStringList(input["upstreamErrorRuleProviders"], true),
		RelayUDP:                          relayUDP,
		RelayUDPAdvertiseHost:             strings.TrimSpace(jsString(valueOrNil(input["relayUdpAdvertiseHost"]))),
		RelayUDPAdvertisePort:             clampNumber(input["relayUdpAdvertisePort"], 0, 65535, 0),
		RelayPortMode:                     relayPortMode,
		RelayListenHost:                   strings.TrimSpace(jsString(valueOrNil(input["relayListenHost"]))),
		MaxAttempts:                       clampNumber(input["maxAttempts"], 0, 32, 0),
		EgressEvidenceTTLMs:               egressTTL,
		LargePasteChars:                   normalizeLargePasteChars(input["largePasteChars"]),
		APIKeyConfigured:                  apiKey != "",
		ManagementKeyConfigured:           managementKey != "",
	}
	if value, ok := input["modelCacheSync"]; ok && value == "scheduler" {
		config.ModelCacheSync = "scheduler"
	}
	return config
}

func normalizeServerPort(value any) int {
	port := jsNumber(value)
	if !math.IsNaN(port) && port > 0 && port <= 65535 && port == math.Trunc(port) {
		return int(port)
	}
	return defaultServerPort
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

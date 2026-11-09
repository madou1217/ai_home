// Package webuiusageconfigapi 提供 WebUI 全局用量配置的只读模型。
//
// 唯一持久化位置是 Node app-state.db 的 config:usage（与 aih 的自动换号配置同键）。
// 写入口仍在 Node（POST /v0/webui/config）；本包只读，并复刻 Node normalizeConfig
// 的默认值/夹取规则，保证设置页与运行时看到同一份数值。
package webuiusageconfigapi

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
	// Path 是用量配置的只读管理契约。
	Path = "/v1/management/webui/config"

	defaultActiveInterval     = "1m"
	defaultBackgroundInterval = "1h"
	defaultThresholdPct       = 95
)

// ErrInvalidDependencies 表示 Handler 缺少必需端口。
var ErrInvalidDependencies = errors.New("用量配置接口依赖无效")

// Authorizer 校验管理密钥。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Store 读取 Node 的 config:usage 原文。
type Store interface {
	ReadUsageConfig(ctx context.Context) (string, bool, error)
}

// Dependencies 汇总只读依赖。
type Dependencies struct {
	Authorizer Authorizer
	Store      Store
}

// Handler 处理用量配置读取。
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

// ConfigView 与 Node getUsageConfig 的响应字段完全同名。
type ConfigView struct {
	ActiveRefreshInterval     string `json:"active_refresh_interval"`
	BackgroundRefreshInterval string `json:"background_refresh_interval"`
	ThresholdPct              int    `json:"threshold_pct"`
	AutoSwitch                bool   `json:"auto_switch"`
	AutoSwitchRemainingPct    *int   `json:"auto_switch_remaining_pct"`
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
		writeError(response, http.StatusServiceUnavailable, "usage_config_unavailable", "用量配置服务不可用")
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
	raw, found, err := handler.store.ReadUsageConfig(request.Context())
	if err != nil {
		writeError(response, http.StatusInternalServerError, "get_config_failed", "")
		return
	}
	config, err := normalizeConfig(raw, found)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "get_config_failed", "config:usage 不是合法 JSON")
		return
	}
	writeJSON(response, http.StatusOK, responseView{OK: true, Config: config})
}

func defaultConfig() ConfigView {
	return ConfigView{
		ActiveRefreshInterval:     defaultActiveInterval,
		BackgroundRefreshInterval: defaultBackgroundInterval,
		ThresholdPct:              defaultThresholdPct,
		AutoSwitch:                false,
		AutoSwitchRemainingPct:    nil,
	}
}

// normalizeConfig 复刻 Node lib/usage/config-store.js 的 normalizeConfig。
func normalizeConfig(raw string, found bool) (ConfigView, error) {
	config := defaultConfig()
	if !found || strings.TrimSpace(raw) == "" {
		return config, nil
	}
	var input map[string]any
	if err := json.Unmarshal([]byte(raw), &input); err != nil {
		return ConfigView{}, err
	}
	if input == nil {
		return config, nil
	}
	active := firstValue(input, "active_refresh_interval", "activeRefreshInterval")
	config.ActiveRefreshInterval = normalizeInterval(active, map[string]string{"1m": "1m", "3m": "3m"}, defaultActiveInterval)
	background := firstValue(input, "background_refresh_interval", "backgroundRefreshInterval")
	config.BackgroundRefreshInterval = normalizeInterval(background, map[string]string{"1h": "1h", "hourly": "1h"}, defaultBackgroundInterval)
	if value, ok := firstValueOK(input, "threshold_pct", "thresholdPct"); ok {
		config.ThresholdPct = normalizeThreshold(value)
	}
	if value, ok := firstValueOK(input, "auto_switch", "autoSwitch"); ok {
		config.AutoSwitch = normalizeAutoSwitch(value)
	}
	if value, ok := firstValueOK(input, "auto_switch_remaining_pct", "autoSwitchRemainingPct"); ok {
		config.AutoSwitchRemainingPct = normalizeRemaining(value)
	}
	return config, nil
}

// firstValue 对齐 Node 的 `a || b`：先取真值，再取另一个。
func firstValue(input map[string]any, keys ...string) any {
	for _, key := range keys {
		if value, ok := input[key]; ok && truthy(value) {
			return value
		}
	}
	for _, key := range keys {
		if value, ok := input[key]; ok {
			return value
		}
	}
	return nil
}

// firstValueOK 对齐 Node 的 `??`：只要有定义（含 null）就使用。
func firstValueOK(input map[string]any, keys ...string) (any, bool) {
	for _, key := range keys {
		if value, ok := input[key]; ok {
			return value, true
		}
	}
	return nil, false
}

func truthy(value any) bool {
	switch typed := value.(type) {
	case nil:
		return false
	case bool:
		return typed
	case string:
		return strings.TrimSpace(typed) != ""
	case float64:
		return typed != 0
	default:
		return true
	}
}

func normalizeInterval(value any, allowed map[string]string, fallback string) string {
	text := strings.ToLower(strings.TrimSpace(toString(value)))
	if text == "" {
		return fallback
	}
	if normalized, ok := allowed[text]; ok {
		return normalized
	}
	return fallback
}

func normalizeThreshold(value any) int {
	number := toNumber(value)
	if math.IsNaN(number) || math.IsInf(number, 0) {
		return defaultThresholdPct
	}
	if number < 1 {
		return 1
	}
	if number > 100 {
		return 100
	}
	return int(math.Round(number))
}

func normalizeAutoSwitch(value any) bool {
	if boolean, ok := value.(bool); ok {
		return boolean
	}
	if number, ok := value.(float64); ok {
		return number == 1
	}
	text := strings.ToLower(strings.TrimSpace(toString(value)))
	return text == "1" || text == "true" || text == "on" || text == "yes"
}

// normalizeRemaining 对齐 Node：null/undefined/空串 = 跟随 threshold_pct；
// 非数字也是 null；其余夹到 0..100 并四舍五入。显式 0 必须保留。
func normalizeRemaining(value any) *int {
	if value == nil {
		return nil
	}
	if text, ok := value.(string); ok && strings.TrimSpace(text) == "" {
		return nil
	}
	number := toNumber(value)
	if math.IsNaN(number) || math.IsInf(number, 0) {
		return nil
	}
	if number < 0 {
		number = 0
	}
	if number > 100 {
		number = 100
	}
	rounded := int(math.Round(number))
	return &rounded
}

func toNumber(value any) float64 {
	switch typed := value.(type) {
	case float64:
		return typed
	case int:
		return float64(typed)
	case string:
		text := strings.TrimSpace(typed)
		if text == "" {
			return math.NaN()
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

func toString(value any) string {
	if value == nil {
		return ""
	}
	if text, ok := value.(string); ok {
		return text
	}
	return ""
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code string, message string) {
	writeJSON(response, status, errorView{OK: false, Error: code, Message: message})
}

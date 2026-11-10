// Package webuichatpasteapi 提供 WebUI「大段粘贴转文本附件」阈值的只读设置。
//
// 唯一持久化位置是 Node app-state.db 的 config:server（与 CLI
// `aih server config set --large-paste-chars` 同一个键）。写入口仍在 Node
// （POST /v0/webui/chat/paste-settings），本包只读。
//
// 默认值/上下限与 contracts/chat-attachments.json 的 largePasteChars 同源；
// 这里保留常量是 Go 侧唯一可用的口径，改动契约时必须同步本文件（单测锁住数值）。
package webuichatpasteapi

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
	// Path 是粘贴设置的只读管理契约。
	Path = "/v1/management/webui/chat/paste-settings"

	defaultLargePasteChars = 200
	minLargePasteChars     = 50
	maxLargePasteChars     = 100000
)

// ErrInvalidDependencies 表示 Handler 缺少必需端口。
var ErrInvalidDependencies = errors.New("粘贴设置接口依赖无效")

// Authorizer 校验管理密钥。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Store 读写 Node 的 server 配置原文（app_kv config:server）。
type Store interface {
	ReadServerConfig(ctx context.Context) (string, bool, error)
	// UpdateServerConfig 在立即事务里读改写 config:server。
	UpdateServerConfig(ctx context.Context, mutate func(current string, found bool) (string, error)) error
}

// Dependencies 汇总只读依赖。
type Dependencies struct {
	Authorizer Authorizer
	Store      Store
}

// Handler 处理粘贴设置读取。
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

type limitsView struct {
	Default int `json:"default"`
	Min     int `json:"min"`
	Max     int `json:"max"`
}

type responseView struct {
	OK              bool       `json:"ok"`
	LargePasteChars int        `json:"largePasteChars"`
	Custom          bool       `json:"custom"`
	Limits          limitsView `json:"limits"`
}

type errorView struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}

// ServeHTTP 只接受 GET。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.store == nil {
		writeError(response, http.StatusServiceUnavailable, "chat_paste_settings_unavailable", "粘贴设置服务不可用")
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
		handler.writeSettings(response, request)
		return
	}
	raw, found, err := handler.store.ReadServerConfig(request.Context())
	if err != nil {
		writeError(response, http.StatusInternalServerError, "chat_paste_settings_read_failed", "")
		return
	}
	chars, custom, err := resolveLargePasteChars(raw, found)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "chat_paste_settings_invalid", "server 配置不是合法 JSON")
		return
	}
	writeJSON(response, http.StatusOK, responseView{
		OK:              true,
		LargePasteChars: chars,
		Custom:          custom,
		Limits:          limitsView{Default: defaultLargePasteChars, Min: minLargePasteChars, Max: maxLargePasteChars},
	})
}

// writeSettings 处理 POST：只改 config:server 的 largePasteChars，其它字段原样保留。
func (handler *Handler) writeSettings(response http.ResponseWriter, request *http.Request) {
	var payload any
	decoder := json.NewDecoder(http.MaxBytesReader(response, request.Body, 4*1024))
	if err := decoder.Decode(&payload); err != nil {
		writeError(response, http.StatusBadRequest, "invalid_json", "")
		return
	}
	object, ok := payload.(map[string]any)
	if !ok || object == nil {
		writeError(response, http.StatusBadRequest, "invalid_json", "")
		return
	}
	rawValue := object["largePasteChars"]
	reset := rawValue == nil
	if number, isNumber := rawValue.(float64); isNumber && number == 0 {
		reset = true
	}
	value := 0
	if !reset {
		number := toNumber(rawValue)
		if math.IsNaN(number) || number != math.Trunc(number) || number < minLargePasteChars || number > maxLargePasteChars {
			writeJSON(response, http.StatusBadRequest, map[string]any{
				"ok": false, "error": "invalid_large_paste_chars",
				"message": "粘贴阈值只接受 50..100000 的整数",
				"limits":  limitsView{Default: defaultLargePasteChars, Min: minLargePasteChars, Max: maxLargePasteChars},
			})
			return
		}
		value = int(number)
	}
	err := handler.store.UpdateServerConfig(request.Context(), func(current string, found bool) (string, error) {
		config := map[string]any{}
		if found && strings.TrimSpace(current) != "" {
			if err := json.Unmarshal([]byte(current), &config); err != nil {
				return "", err
			}
		}
		config["largePasteChars"] = value
		encoded, err := json.Marshal(config)
		if err != nil {
			return "", err
		}
		return string(encoded), nil
	})
	if err != nil {
		writeError(response, http.StatusInternalServerError, "chat_paste_settings_write_failed", "")
		return
	}
	resolved := value
	custom := value > 0
	if !custom {
		resolved = defaultLargePasteChars
	}
	writeJSON(response, http.StatusOK, responseView{
		OK:              true,
		LargePasteChars: resolved,
		Custom:          custom,
		Limits:          limitsView{Default: defaultLargePasteChars, Min: minLargePasteChars, Max: maxLargePasteChars},
	})
}

// resolveLargePasteChars 复刻 Node normalizeLargePasteChars + resolveLargePasteChars：
// 0 / 非法 / 缺省 = 默认值；正数四舍五入后夹到 [min, max]；只有存了正数才算 custom。
func resolveLargePasteChars(raw string, found bool) (int, bool, error) {
	if !found || strings.TrimSpace(raw) == "" {
		return defaultLargePasteChars, false, nil
	}
	var config struct {
		LargePasteChars any `json:"largePasteChars"`
	}
	if err := json.Unmarshal([]byte(raw), &config); err != nil {
		return 0, false, err
	}
	number := toNumber(config.LargePasteChars)
	if number <= 0 {
		return defaultLargePasteChars, false, nil
	}
	number = math.Round(number)
	if number < minLargePasteChars {
		number = minLargePasteChars
	}
	if number > maxLargePasteChars {
		number = maxLargePasteChars
	}
	return int(number), true, nil
}

// toNumber 对齐 JS 的 Number(value) || 0：数字/数字字符串可用，其它一律 0。
func toNumber(value any) float64 {
	switch typed := value.(type) {
	case float64:
		return typed
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(typed), 64)
		if err != nil {
			return 0
		}
		return parsed
	default:
		return 0
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

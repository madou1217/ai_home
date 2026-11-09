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

// Store 读取 Node 的 server 配置原文（app_kv config:server）。
type Store interface {
	ReadServerConfig(ctx context.Context) (string, bool, error)
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
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 GET")
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

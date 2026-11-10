// Package webuiwindowactivationapi 提供账号「窗口激活」设置的写入入口。
//
// 读路径与调度器状态仍在 Node（GET 需要运行中的 scheduler 视图）；本包只把
// account:window-activation:<ref> 的持久化收敛到 Go：Node 校验完 provider/账号/
// 间隔后调用这里，随后再读回本地配置组装响应。
package webuiwindowactivationapi

import (
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

const (
	// Path 是窗口激活设置的管理契约前缀。
	//
	//	POST /v1/management/webui/accounts/{provider}/{accountRef}/window-activation
	Path = "/v1/management/webui/accounts"

	minIntervalMs = 60 * 60 * 1000
	maxIntervalMs = 365 * 24 * 60 * 60 * 1000
	keyPrefix     = "account:window-activation:"
)

// ErrInvalidDependencies 表示 Handler 缺少必需端口。
var ErrInvalidDependencies = errors.New("窗口激活写入接口依赖无效")

// Authorizer 校验管理密钥。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 汇总写入依赖。
type Dependencies struct {
	Authorizer Authorizer
	AIHomeDir  string
}

// Handler 处理窗口激活设置写入。
type Handler struct {
	authorizer Authorizer
	aiHomeDir  string
}

// NewHandler 创建默认失败关闭的 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || strings.TrimSpace(dependencies.AIHomeDir) == "" {
		return nil, ErrInvalidDependencies
	}
	return &Handler{authorizer: dependencies.Authorizer, aiHomeDir: strings.TrimSpace(dependencies.AIHomeDir)}, nil
}

type errorView struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}

// ServeHTTP 只接受 POST。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil {
		writeError(response, http.StatusServiceUnavailable, "window_activation_unavailable", "窗口激活服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 POST")
		return
	}
	provider := strings.ToLower(strings.TrimSpace(request.PathValue("provider")))
	accountRef := strings.TrimSpace(request.PathValue("accountRef"))
	if provider == "" || accountRef == "" {
		writeError(response, http.StatusBadRequest, "invalid_account_path", "")
		return
	}
	ctx := request.Context()
	databasePath, err := appstate.DatabasePath(handler.aiHomeDir)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "window_activation_write_failed", err.Error())
		return
	}
	owner, found, err := appstate.LookupAccountProvider(ctx, databasePath, accountRef)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "window_activation_write_failed", err.Error())
		return
	}
	if !found {
		writeError(response, http.StatusNotFound, "account_not_found", "")
		return
	}
	if strings.ToLower(strings.TrimSpace(owner)) != provider {
		writeError(response, http.StatusConflict, "account_provider_mismatch", "")
		return
	}

	var payload any
	decoder := json.NewDecoder(http.MaxBytesReader(response, request.Body, 16*1024))
	if err := decoder.Decode(&payload); err != nil {
		writeError(response, http.StatusBadRequest, "invalid_json_body", "")
		return
	}
	object, ok := payload.(map[string]any)
	if !ok || object == nil {
		writeError(response, http.StatusBadRequest, "invalid_request_body", "")
		return
	}
	enabled := object["enabled"] == true
	floor := resolveMinInterval(object["minIntervalMs"])
	interval, valid := normalizeInterval(object["intervalMs"], floor)
	if !valid {
		writeJSON(response, http.StatusBadRequest, map[string]any{
			"ok": false, "error": "invalid_interval_ms", "minIntervalMs": floor,
		})
		return
	}

	now := time.Now().UnixMilli()
	record := map[string]any{"enabled": enabled, "intervalMs": interval, "updatedAt": now}
	encoded, err := json.Marshal(record)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "window_activation_write_failed", err.Error())
		return
	}
	if err := appstate.WriteKV(ctx, databasePath, keyPrefix+accountRef, string(encoded), now); err != nil {
		writeError(response, http.StatusInternalServerError, "window_activation_write_failed", err.Error())
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true})
}

// resolveMinInterval 对齐 Node：优先用运行态上报的 minIntervalMs，缺省 1h。
func resolveMinInterval(value any) float64 {
	number := jsNumber(value)
	if math.IsNaN(number) || number < minIntervalMs {
		return minIntervalMs
	}
	return math.Floor(number)
}

// normalizeInterval 对齐 Node：null/缺省/空串 = 跟随全局默认；其余必须是
// [minIntervalMs, 365d] 的有限数并向下取整。
func normalizeInterval(value any, floor float64) (any, bool) {
	switch typed := value.(type) {
	case nil:
		return nil, true
	case string:
		if strings.TrimSpace(typed) == "" {
			return nil, true
		}
	}
	number := jsNumber(value)
	if math.IsNaN(number) || number < floor || number > maxIntervalMs {
		return nil, false
	}
	return math.Floor(number), true
}

func jsNumber(value any) float64 {
	switch typed := value.(type) {
	case float64:
		return typed
	case int:
		return float64(typed)
	case int64:
		return float64(typed)
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(typed), 64)
		if err != nil {
			return math.NaN()
		}
		return parsed
	default:
		return math.NaN()
	}
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	encoder := json.NewEncoder(response)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code string, message string) {
	writeJSON(response, status, errorView{OK: false, Error: code, Message: message})
}

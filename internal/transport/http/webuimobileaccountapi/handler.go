// Package webuimobileaccountapi 提供 Codex App 账号绑定的写接口。
//
// 契约（管理面）：
//
//	POST /v1/management/webui/accounts/{provider}/{accountRef}/set-mobile
//	POST /v1/management/webui/accounts/{provider}/{accountRef}/clear-mobile
//
// 状态真相是 $AI_HOME/run/codex/desktop-hook-state.json 的 desktopAccountRef。
// 本包只读改写这一个键：其它键（version/enabled/路径/未知扩展）原样保留；
// 目标值与当前值一致时不落盘，changed 明确为 false。
package webuimobileaccountapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

const (
	// Path 是账号管理契约前缀。
	Path = "/v1/management/webui/accounts"
	// SetMobilePath 是绑定 Codex App 账号的路由模式。
	SetMobilePath = Path + "/{provider}/{accountRef}/set-mobile"
	// ClearMobilePath 是解绑 Codex App 账号的路由模式。
	ClearMobilePath = Path + "/{provider}/{accountRef}/clear-mobile"

	codexProvider = "codex"
)

// ErrInvalidDependencies 表示 Handler 缺少必需端口。
var ErrInvalidDependencies = errors.New("Codex App 账号接口依赖无效")

// Authorizer 校验管理密钥（与其它 /v1/management 接口同一权限域）。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 汇总 Handler 依赖。
type Dependencies struct {
	Authorizer Authorizer
	AIHomeDir  string
	// Now 是测试时钟；nil 时使用 time.Now。
	Now func() time.Time
}

type action string

const (
	actionSetMobile   action = "set-mobile"
	actionClearMobile action = "clear-mobile"
)

// Handler 处理 set-mobile 或 clear-mobile 中的一种动作。
type Handler struct {
	authorizer Authorizer
	aiHomeDir  string
	action     action
	now        func() time.Time
}

// NewSetMobileHandler 创建绑定 Codex App 账号的 Handler。
func NewSetMobileHandler(dependencies Dependencies) (*Handler, error) {
	return newHandler(actionSetMobile, dependencies)
}

// NewClearMobileHandler 创建解绑 Codex App 账号的 Handler。
func NewClearMobileHandler(dependencies Dependencies) (*Handler, error) {
	return newHandler(actionClearMobile, dependencies)
}

func newHandler(next action, dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || strings.TrimSpace(dependencies.AIHomeDir) == "" {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		authorizer: dependencies.Authorizer,
		aiHomeDir:  strings.TrimSpace(dependencies.AIHomeDir),
		action:     next,
		now:        dependencies.Now,
	}, nil
}

type successResponse struct {
	OK                bool   `json:"ok"`
	Provider          string `json:"provider"`
	AccountRef        string `json:"accountRef"`
	DesktopAccountRef string `json:"desktopAccountRef"`
	Changed           bool   `json:"changed"`
}

type errorResponse struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Code    string `json:"code,omitempty"`
	Reason  string `json:"reason,omitempty"`
	Message string `json:"message,omitempty"`
}

// ServeHTTP 只接受 POST。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.aiHomeDir == "" {
		writeError(response, http.StatusServiceUnavailable,
			"mobile_account_unavailable", "", "", "Codex App 账号服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "", "", "需要管理密钥")
		return
	}
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "", "", "仅支持 POST")
		return
	}
	writeNoStoreHeaders(response)

	provider := strings.ToLower(strings.TrimSpace(request.PathValue("provider")))
	rawRef := strings.TrimSpace(request.PathValue("accountRef"))
	accountRef, err := accountcore.ParseAccountRef(rawRef)
	if provider == "" || err != nil {
		writeError(response, http.StatusBadRequest, "invalid_account_path", "", "", "无效的账号路径")
		return
	}
	// Codex App 是 Codex 专有能力；其它 Provider 在查询数据前就直接拒绝。
	if provider != codexProvider {
		writeError(response, http.StatusBadRequest, "mobile_account_unsupported", "", "", "")
		return
	}

	storedProvider, nativeAuth, found, err := readStoredCodexCredential(
		request.Context(), handler.aiHomeDir, accountRef.String(),
	)
	if err != nil {
		writeError(response, http.StatusInternalServerError,
			handler.failureCode(), "", "credential_lookup_failed", "")
		return
	}
	if !found || storedProvider != provider {
		writeError(response, http.StatusNotFound, "account_not_found", "", "", "未找到 "+provider+" 账号 "+accountRef.String())
		return
	}

	store := &hookStateStore{path: HookStatePath(handler.aiHomeDir), now: handler.now}
	var result hookStateResult
	if handler.action == actionSetMobile {
		if !hasCodexOAuthTokens(nativeAuth) {
			writeError(response, http.StatusBadRequest, "mobile_account_invalid",
				"missing_codex_desktop_oauth", "", "Codex App 账号需要可用的 ChatGPT OAuth 授权。")
			return
		}
		result, err = store.setDesktopAccountRef(accountRef.String())
	} else {
		result, err = store.clearDesktopAccountRef(accountRef.String())
	}
	if err != nil {
		reason := "state_write_failed"
		if errors.Is(err, errHookStateInvalid) {
			reason = "state_file_invalid"
		}
		writeError(response, http.StatusInternalServerError, handler.failureCode(), "", reason, "")
		return
	}

	writeJSON(response, http.StatusOK, successResponse{
		OK:                true,
		Provider:          provider,
		AccountRef:        accountRef.String(),
		DesktopAccountRef: result.DesktopAccountRef,
		Changed:           result.Changed,
	})
}

func (handler *Handler) failureCode() string {
	if handler.action == actionSetMobile {
		return "set_mobile_failed"
	}
	return "clear_mobile_failed"
}

func writeNoStoreHeaders(response http.ResponseWriter) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Pragma", "no-cache")
	response.Header().Set("Referrer-Policy", "no-referrer")
	response.Header().Set("X-Content-Type-Options", "nosniff")
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code string, detailCode string, reason string, message string) {
	writeJSON(response, status, errorResponse{
		OK:      false,
		Error:   code,
		Code:    detailCode,
		Reason:  reason,
		Message: message,
	})
}

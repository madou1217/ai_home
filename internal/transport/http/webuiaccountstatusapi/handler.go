// Package webuiaccountstatusapi 提供账号启用/停用（accounts.enabled）的管理写入口。
//
// 路由（由共享 wiring 注册，本包只导出模式常量）：
//
//	POST /v1/management/webui/accounts/{provider}/{accountRef}/status
//
// 请求体与 Node 的 handleUpdateAccountStatusRequest 对齐：{"status":"up"|"down"}，
// up 写 enabled=true，down 写 enabled=false。启停真值是 Go 的 accounts 表，由
// *sqliteaccount.Store.SetEnabled 以 compare-and-swap 原子更新并同步路由索引。
//
// account_state 展示投影目前只有 Node 侧实现：Go 的 account_runtime_states 是
// Node 运行态文档的副本，不携带用户启停语义，直接改它会伪造状态。因此本切片只写
// accounts.enabled，响应显式标记 partial，并列出 Node 仍需补齐的字段。
package webuiaccountstatusapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

const (
	// Path 是账号管理契约前缀。
	Path = "/v1/management/webui/accounts"
	// RouteSuffix 由共享 wiring 拼在 Path 之后，构成管理路由模式。
	//
	//	POST /v1/management/webui/accounts/{provider}/{accountRef}/status
	RouteSuffix = "/{provider}/{accountRef}/status"

	// maxBodyBytes 与 Node 的 readRequestBody({maxBytes: 64 * 1024}) 一致。
	maxBodyBytes = 64 * 1024

	// accountStateProjectionPending 表示 account_state 展示投影仍归 Node 所有。
	accountStateProjectionPending = "pending"
)

// ErrInvalidDependencies 表示 Handler 缺少必需端口。
var ErrInvalidDependencies = errors.New("账号启停接口依赖无效")

// unfilledFields 是 Node 仍负责、Go 本切片不产出的响应字段。
var unfilledFields = []string{
	"account",
	"accountStateProjection",
	"hostGrantRevoke",
}

// Authorizer 校验管理密钥（与其它 /v1/management 接口同一权限域）。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 汇总写入依赖。Accounts 由 *sqliteaccount.Store 实现。
type Dependencies struct {
	Authorizer Authorizer
	Accounts   accountapp.AccountLifecycleStore
	// Now 是测试时钟；nil 时使用 time.Now。
	Now func() time.Time
}

// Handler 处理账号启用/停用。
type Handler struct {
	authorizer Authorizer
	accounts   accountapp.AccountLifecycleStore
	now        func() time.Time
}

// NewHandler 创建默认失败关闭的 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Accounts == nil {
		return nil, ErrInvalidDependencies
	}
	now := dependencies.Now
	if now == nil {
		now = time.Now
	}
	return &Handler{
		authorizer: dependencies.Authorizer,
		accounts:   dependencies.Accounts,
		now:        now,
	}, nil
}

type statusView struct {
	OK                     bool     `json:"ok"`
	Provider               string   `json:"provider"`
	AccountRef             string   `json:"accountRef"`
	Status                 string   `json:"status"`
	Enabled                bool     `json:"enabled"`
	UpdatedAtMS            int64    `json:"updatedAt"`
	Partial                bool     `json:"partial"`
	AccountStateProjection string   `json:"accountStateProjection"`
	UnfilledFields         []string `json:"unfilledFields"`
}

type errorView struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}

type statusRequest struct {
	Status string `json:"status"`
}

// ServeHTTP 只接受 POST。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.accounts == nil {
		writeError(response, http.StatusServiceUnavailable, "account_status_unavailable", "账号启停服务不可用")
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
	rawAccountRef := strings.TrimSpace(request.PathValue("accountRef"))
	if provider == "" || rawAccountRef == "" {
		writeError(response, http.StatusBadRequest, "invalid_account_path", "")
		return
	}
	accountRef, err := accountcore.ParseAccountRef(rawAccountRef)
	if err != nil {
		writeError(response, http.StatusBadRequest, "invalid_account_ref", "")
		return
	}

	status, ok := readStatus(request)
	if !ok {
		writeError(response, http.StatusBadRequest, "invalid_status", "")
		return
	}
	enabled := status == "up"

	ctx := request.Context()
	account, err := handler.accounts.GetByRef(ctx, accountRef)
	if err != nil {
		if errors.Is(err, accountapp.ErrAccountNotFound) {
			writeError(response, http.StatusNotFound, "account_not_found", "")
			return
		}
		writeError(response, http.StatusInternalServerError, "account_status_read_failed", err.Error())
		return
	}
	if account.ProviderID() != provider {
		writeError(response, http.StatusConflict, "account_provider_mismatch", "")
		return
	}

	updated, err := handler.accounts.SetEnabled(ctx, accountRef, enabled, handler.now())
	if err != nil {
		writeError(response, http.StatusBadGateway, "go_account_status_update_failed",
			"Go Core 更新账号启停失败，账号未被修改。")
		return
	}

	writeJSON(response, http.StatusOK, statusView{
		OK:                     true,
		Provider:               updated.ProviderID(),
		AccountRef:             updated.Ref().String(),
		Status:                 statusOf(updated.Enabled()),
		Enabled:                updated.Enabled(),
		UpdatedAtMS:            updated.UpdatedAt().UnixMilli(),
		Partial:                true,
		AccountStateProjection: accountStateProjectionPending,
		UnfilledFields:         append([]string(nil), unfilledFields...),
	})
}

// readStatus 读取并校验请求体；与 Node 一致，解析失败和未知值都归为 invalid_status。
func readStatus(request *http.Request) (string, bool) {
	if request.Body == nil {
		return "", false
	}
	body, err := io.ReadAll(io.LimitReader(request.Body, maxBodyBytes+1))
	if err != nil || len(body) > maxBodyBytes {
		return "", false
	}
	var payload statusRequest
	if err := json.Unmarshal(body, &payload); err != nil {
		return "", false
	}
	status := strings.ToLower(strings.TrimSpace(payload.Status))
	if status != "up" && status != "down" {
		return "", false
	}
	return status, true
}

func statusOf(enabled bool) string {
	if enabled {
		return "up"
	}
	return "down"
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

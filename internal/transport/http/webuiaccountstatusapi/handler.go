// Package webuiaccountstatusapi 提供账号启用/停用（accounts.enabled）的 WebUI 写入口。
//
// 路由（由共享 wiring 注册，本包只导出模式常量）：
//
//	POST /v1/management/webui/accounts/{provider}/{accountRef}/status
//
// 请求体与 Node 的 handleUpdateAccountStatusRequest 对齐：{"status":"up"|"down"}。
// 本包是这条路径的唯一权威实现：用 *sqliteaccount.Store.SetEnabled 以
// compare-and-swap 原子更新 accounts.enabled 并同步路由索引；停用 codex 账号时
// 一并回收宿主直连授权。账号状态直接由 enabled 派生（up/down），不再维护
// account_state 展示投影——投影是旧 Node 台账留下的第二份真值，已随身份重解析
// 一并移除。
package webuiaccountstatusapi

import (
	"context"
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

	// reasonHostGrantRevokeFailed 与 Node 的 revokeHostGrantHook 失败原因一致。
	reasonHostGrantRevokeFailed = "host_grant_revoke_failed"
)

// ErrInvalidDependencies 表示 Handler 缺少必需端口。
var ErrInvalidDependencies = errors.New("账号启停接口依赖无效")

// Authorizer 校验管理密钥（与其它 /v1/management 接口同一权限域）。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// HostGrantRevoker 回收账号在宿主上遗留的直连授权（当前只有 codex 声明了这个钩子）。
type HostGrantRevoker interface {
	SupportsHostGrant(providerID string) bool
	RevokeHostGrant(
		ctx context.Context,
		account accountcore.Account,
	) (accountapp.GrantRevocation, error)
}

// Dependencies 汇总写入依赖。Accounts 由 *sqliteaccount.Store 实现。
type Dependencies struct {
	Authorizer Authorizer
	Accounts   accountapp.AccountLifecycleStore

	// HostGrant 为 nil 或 Provider 没有钩子时跳过宿主授权回收。
	HostGrant HostGrantRevoker

	// Now 是测试时钟；nil 时使用 time.Now。
	Now func() time.Time
}

// Handler 处理账号启用/停用。
type Handler struct {
	authorizer Authorizer
	accounts   accountapp.AccountLifecycleStore
	hostGrant  HostGrantRevoker
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
		hostGrant:  dependencies.HostGrant,
		now:        now,
	}, nil
}

// accountView 与 Node 启停响应里的 account 同形；只保留账号页合并需要的字段。
//
// 刻意不返回 displayName / updatedAt：它们不是启停事实，回空值会把前端已有的
// 展示字段覆盖掉。accountRef 使用调用方路径里的引用，前端按自己的键合并。
type accountView struct {
	AccountRef string `json:"accountRef"`
	Provider   string `json:"provider"`
	Status     string `json:"status"`
	Configured bool   `json:"configured"`
}

type statusView struct {
	OK              bool                        `json:"ok"`
	Account         accountView                 `json:"account"`
	Provider        string                      `json:"provider"`
	AccountRef      string                      `json:"accountRef"`
	Status          string                      `json:"status"`
	Enabled         bool                        `json:"enabled"`
	UpdatedAtMS     int64                       `json:"updatedAt"`
	HostGrantRevoke *accountapp.GrantRevocation `json:"hostGrantRevoke,omitempty"`
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

	updated, err := handler.accounts.SetEnabled(ctx, accountRef, status == "up", handler.now())
	if err != nil {
		writeError(response, http.StatusBadGateway, "go_account_status_update_failed",
			"Go Core 更新账号启停失败，账号未被修改。")
		return
	}

	var hostGrantRevoke *accountapp.GrantRevocation
	if !updated.Enabled() {
		hostGrantRevoke = handler.revokeHostGrant(ctx, updated)
	}

	enabled := updated.Enabled()
	writeJSON(response, http.StatusOK, statusView{
		OK: true,
		Account: accountView{
			AccountRef: accountRef.String(),
			Provider:   updated.ProviderID(),
			Status:     statusOf(enabled),
			Configured: true,
		},
		Provider:        updated.ProviderID(),
		AccountRef:      accountRef.String(),
		Status:          statusOf(enabled),
		Enabled:         enabled,
		UpdatedAtMS:     updated.UpdatedAt().UnixMilli(),
		HostGrantRevoke: hostGrantRevoke,
	})
}

// revokeHostGrant 只在 Provider 声明了回收钩子且本次是停用时执行。
//
// 回收失败不回滚启停：账号已经从路由门里移除，宿主残留授权是独立的安全问题；
// Node 旧实现同样把失败放在响应里而不是把启停判成失败。
func (handler *Handler) revokeHostGrant(
	ctx context.Context,
	account accountcore.Account,
) *accountapp.GrantRevocation {
	if handler.hostGrant == nil || !handler.hostGrant.SupportsHostGrant(account.ProviderID()) {
		return nil
	}
	revocation, err := handler.hostGrant.RevokeHostGrant(ctx, account)
	if err != nil {
		return &accountapp.GrantRevocation{
			OK:      false,
			Revoked: false,
			Reason:  reasonHostGrantRevokeFailed,
			Message: err.Error(),
		}
	}
	return &revocation
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

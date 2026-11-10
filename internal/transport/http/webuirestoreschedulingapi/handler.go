// Package webuirestoreschedulingapi 提供账号「强制恢复调度」的写入口。
//
// 语义与 Node 的 account-runtime-gate.forceRecover 对齐：人工覆盖，把目标账号的
// 运行态门禁整体归零（不只是某一个恢复事件）。真正的领域动作在
// internal/adapters/accountruntime/inmemory 的 RestoreScheduling；本包只做管理鉴权、
// 账号归属校验和错误映射，避免把运行态细节泄漏到 HTTP 层。
package webuirestoreschedulingapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

const (
	// Path 是账号管理契约前缀。
	Path = "/v1/management/webui/accounts"
	// RouteSuffix 由共享 wiring 拼在 Path 之后，构成管理路由模式。
	//
	//	POST /v1/management/webui/accounts/{provider}/{accountRef}/restore-scheduling
	RouteSuffix = "/{provider}/{accountRef}/restore-scheduling"
)

// ErrInvalidDependencies 表示 Handler 缺少必需端口。
var ErrInvalidDependencies = errors.New("恢复调度写入接口依赖无效")

// Authorizer 校验管理密钥（与其它 /v1/management 接口同一权限域）。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// RuntimeRestorer 是账号运行态的人工覆盖端口。只暴露一个窄方法：
// 路由需要的全部运行态能力就是「把这个账号的调度阻塞清空」。
type RuntimeRestorer interface {
	RestoreScheduling(ctx context.Context, accountRef accountcore.AccountRef) error
}

// Dependencies 汇总写入依赖。
type Dependencies struct {
	Authorizer Authorizer
	AIHomeDir  string
	Runtime    RuntimeRestorer
}

// Handler 处理账号强制恢复调度。
type Handler struct {
	authorizer Authorizer
	aiHomeDir  string
	runtime    RuntimeRestorer
}

// NewHandler 创建默认失败关闭的 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil ||
		dependencies.Runtime == nil ||
		strings.TrimSpace(dependencies.AIHomeDir) == "" {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		authorizer: dependencies.Authorizer,
		aiHomeDir:  strings.TrimSpace(dependencies.AIHomeDir),
		runtime:    dependencies.Runtime,
	}, nil
}

type successView struct {
	OK bool `json:"ok"`
}

type errorView struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}

// ServeHTTP 只接受 POST。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.runtime == nil {
		writeError(response, http.StatusServiceUnavailable, "restore_scheduling_unavailable", "恢复调度服务不可用")
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

	ctx := request.Context()
	databasePath, err := appstate.DatabasePath(handler.aiHomeDir)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "restore_scheduling_failed", err.Error())
		return
	}
	owner, found, err := appstate.LookupAccountProvider(ctx, databasePath, accountRef.String())
	if err != nil {
		writeError(response, http.StatusInternalServerError, "restore_scheduling_failed", err.Error())
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

	if err := handler.runtime.RestoreScheduling(ctx, accountRef); err != nil {
		writeError(response, http.StatusInternalServerError, "restore_scheduling_failed", err.Error())
		return
	}
	writeJSON(response, http.StatusOK, successView{OK: true})
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

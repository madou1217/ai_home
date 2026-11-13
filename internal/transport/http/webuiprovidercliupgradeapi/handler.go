// Package webuiprovidercliupgradeapi 提供 provider CLI 自动升级状态与调度器遥测的只读 HTTP 投影。
package webuiprovidercliupgradeapi

import (
	"errors"
	"net/http"
	"strings"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/runtime/providercliupgrade"
)

const (
	// Path 是 provider CLI 升级状态的管理契约。
	Path = "/v1/management/webui/provider-cli-upgrade"
)

// ErrInvalidDependencies 表示 Handler 缺少必需端口。
var ErrInvalidDependencies = errors.New("provider CLI 升级接口依赖无效")

// Authorizer 校验管理密钥。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 汇总只读依赖。
type Dependencies struct {
	Authorizer Authorizer
	AIHomeDir  string
	Catalog    *providers.Catalog
	// Scheduler 可选：注入后响应会附带运行中调度器态与各 provider 最近一轮 tick 结论。
	Scheduler *providercliupgrade.Scheduler
}

// Handler 处理升级状态读取。
type Handler struct {
	authorizer Authorizer
	aiHomeDir  string
	catalog    *providers.Catalog
	scheduler  *providercliupgrade.Scheduler
}

// NewHandler 创建默认失败关闭的 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || strings.TrimSpace(dependencies.AIHomeDir) == "" || dependencies.Catalog == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		authorizer: dependencies.Authorizer,
		aiHomeDir:  strings.TrimSpace(dependencies.AIHomeDir),
		catalog:    dependencies.Catalog,
		scheduler:  dependencies.Scheduler,
	}, nil
}

type errorView struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}

// ServeHTTP 只接受 GET。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil {
		writeError(response, http.StatusServiceUnavailable, "provider_cli_upgrade_unavailable", "升级状态服务不可用")
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
	writeJSON(response, http.StatusOK, SnapshotWithScheduler(handler.aiHomeDir, handler.catalog, handler.scheduler))
}

// Snapshot 返回仅基于账本文件的只读投影（无运行中调度器实例时使用）。
func Snapshot(aiHomeDir string, catalog *providers.Catalog) map[string]any {
	return SnapshotWithScheduler(aiHomeDir, catalog, nil)
}

// SnapshotWithScheduler 返回与 GET 完全一致的账本 + 调度器实时投影。
//
// 解除熔断接口会把它原样嵌进响应的 status 字段；两处必须同一份投影。
func SnapshotWithScheduler(
	aiHomeDir string,
	catalog *providers.Catalog,
	scheduler *providercliupgrade.Scheduler,
) map[string]any {
	var schedulerState *providercliupgrade.SchedulerState
	if scheduler != nil {
		state := scheduler.State()
		schedulerState = &state
	}
	return providercliupgrade.ProjectStatus(aiHomeDir, catalog, schedulerState)
}

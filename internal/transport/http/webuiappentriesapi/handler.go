// Package webuiappentriesapi 提供「宿主机实测的 Provider 桌面 / CLI 入口可用性」只读契约。
//
// 数据边界：
//   - entries 与 capabilities 的键来自 Go 的 Provider 合同（clients / cli.desktopClient），
//     值是本次在宿主机上探测到的事实：CLI 走 LookPath + 安装落点 stat，桌面 App 走
//     manifest 声明的安装路径（macOS 为 .app bundle）。只做存在性与可执行性判断，
//     不启动进程、不打开 App。
//   - runningAccounts / runningAccountPids / runningCliAccounts / runningCliAccountPids
//     需要扫描宿主进程并与账号记录关联，Go 侧没有对应事实源，整块不填，键名列入
//     unfilledFields，绝不用空数组冒充「没有运行中的账号」。
//   - capabilities.crossProviderHarness 依赖 Node 的 CLI relay profile 注册表，
//     Go 没有等价声明，同样列入 unfilledFields。
//   - entries 里 Node 额外包含外部 harness（pi / dsh / dsh-tui），它们不在 Go 的
//     Provider 合同内，因此本响应不含这些键，由 externalHarnessEntries 标注。
//
// 缓存边界：探测结果进程级缓存 30 秒，响应带 probedAtMs / expiresAtMs / cached，
// 调用方据此自行缓存，避免每次渲染都触发扫盘；refresh=1 强制重新探测。
package webuiappentriesapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/madou1217/ai_home/core/providers"
)

// Path 是入口可用性只读契约的管理面路径。
//
//	GET /v1/management/webui/app-entries
const Path = "/v1/management/webui/app-entries"

// ErrInvalidDependencies 表示 Handler 缺少鉴权策略或 Provider 合同。
var ErrInvalidDependencies = errors.New("入口探测接口依赖无效")

// Authorizer 是管理面请求的鉴权策略（与其它 WebUI 契约共用同一个 Bearer 实现）。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 汇总入口探测的依赖。
type Dependencies struct {
	Authorizer Authorizer
	// HostHomeDir 是宿主 HOME：展开桌面安装路径里的 {hostHomeDir}，并作为
	// $HOME/.local/bin 安装落点的根。空值表示不参与这两类候选。
	HostHomeDir string
	// LookPath 解析 PATH 上的可执行文件；为 nil 时使用 exec.LookPath。
	// 注入以便测试，无需依赖真实宿主安装。
	LookPath func(string) (string, error)
	// Providers 是可选的 Provider 合同来源；零值时使用 Go 内置合同。
	Providers ProviderCatalog
	// Now 允许测试注入时钟，用于验证缓存与单 Provider 探测预算。
	Now func() time.Time
}

// entryView 是单个 Provider 的入口可用性，字段名与 Node /v0/webui/app-entries 一致。
type entryView struct {
	Desktop bool `json:"desktop"`
	CLI     bool `json:"cli"`
}

// capabilityView 是 Provider 声明的客户端能力（与探测结果分开：这里回答「能不能有」）。
//
// crossProviderHarness 不在此结构中：Go 没有 CLI relay profile 注册表，写入 false
// 会把 claude/codex 等真实可跨 Provider 的 harness 说成不支持。
type capabilityView struct {
	Desktop         bool   `json:"desktop"`
	CLI             bool   `json:"cli"`
	Label           string `json:"label"`
	ExternalHarness bool   `json:"externalHarness"`
}

// responseView 是成功响应。
type responseView struct {
	OK            bool                      `json:"ok"`
	Entries       map[string]entryView      `json:"entries"`
	Capabilities  map[string]capabilityView `json:"capabilities"`
	ServerRuntime bool                      `json:"serverRuntime"`
	ProbedAtMS    int64                     `json:"probedAtMs"`
	ExpiresAtMS   int64                     `json:"expiresAtMs"`
	Cached        bool                      `json:"cached"`
	// BudgetExceededProviders 列出探测预算耗尽、结论可能不完整的 Provider。
	BudgetExceededProviders []string `json:"budgetExceededProviders"`
	// UnfilledFields 列出 Node 响应有、而本契约没有可信来源的键。
	UnfilledFields []string `json:"unfilledFields"`
}

type errorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type errorResponse struct {
	OK    bool      `json:"ok"`
	Error errorBody `json:"error"`
}

// Handler 是入口可用性探测的 HTTP 入站适配器。
type Handler struct {
	authorizer Authorizer
	detector   *detector
}

// NewHandler 校验依赖并创建 Handler。
func NewHandler(dependencies Dependencies) (http.Handler, error) {
	if dependencies.Authorizer == nil {
		return nil, ErrInvalidDependencies
	}
	catalog := dependencies.Providers
	if catalog == nil {
		builtin, err := providers.NewCatalog(providers.BuiltinManifest())
		if err != nil {
			return nil, errors.Join(ErrInvalidDependencies, err)
		}
		catalog = builtin
	}
	return &Handler{
		authorizer: dependencies.Authorizer,
		detector:   newDetector(dependencies, catalog),
	}, nil
}

func (handler *Handler) ServeHTTP(responseWriter http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.detector == nil {
		writeError(responseWriter, http.StatusServiceUnavailable, "app_entries_unavailable", "入口探测不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		responseWriter.Header().Set("WWW-Authenticate", "Bearer")
		writeError(responseWriter, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	if request.Method != http.MethodGet {
		responseWriter.Header().Set("Allow", http.MethodGet)
		writeError(responseWriter, http.StatusMethodNotAllowed, "method_not_allowed", "只支持读取入口探测")
		return
	}
	refresh := request.URL.Query().Get("refresh") == "1"
	current, cached := handler.detector.detect(refresh)
	writeJSON(responseWriter, http.StatusOK, responseView{
		OK:                      true,
		Entries:                 current.entries,
		Capabilities:            current.capabilities,
		ServerRuntime:           !isDesktopHost(handler.detector.platform),
		ProbedAtMS:              current.probedAt.UnixMilli(),
		ExpiresAtMS:             current.probedAt.Add(entriesCacheTTL).UnixMilli(),
		Cached:                  cached,
		BudgetExceededProviders: current.budgetExceeded,
		UnfilledFields:          unfilledFields(),
	})
}

// unfilledFields 每次返回新切片，避免调用方改写共享状态。
func unfilledFields() []string {
	return []string{
		"runningAccounts",
		"runningAccountPids",
		"runningCliAccounts",
		"runningCliAccountPids",
		"externalHarnessEntries",
		"capabilities.crossProviderHarness",
	}
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code, message string) {
	writeJSON(response, status, errorResponse{OK: false, Error: errorBody{Code: code, Message: message}})
}

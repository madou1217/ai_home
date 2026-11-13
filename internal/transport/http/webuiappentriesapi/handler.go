// Package webuiappentriesapi 提供「宿主机实测的 Provider 桌面 / CLI 入口可用性」只读契约。
//
// 数据边界：
//   - entries 与 capabilities 的键来自 Go 的 Provider 合同（clients / cli.desktopClient）
//     与外部 harness 注册表（core/harnesses），值是本次在宿主机上探测到的事实：CLI 走
//     LookPath + 安装落点 stat，桌面 App 走 manifest 声明的安装路径（macOS 为 .app
//     bundle）。只做存在性与可执行性判断，不启动进程、不打开 App。
//   - runningAccounts / runningAccountPids / runningCliAccounts / runningCliAccountPids
//     由宿主进程扫描（internal/adapters/hostapps）与账号台账匹配得出：桌面实例按
//     --user-data-dir / 改写过的应用名识别，CLI 实例按启动标记识别。扫描失败按空清单
//     降级，与 Node 的容错口径一致。
//   - capabilities.crossProviderHarness 来自同一份注册表（原生 relay profile 白名单 +
//     外部 harness 自身声明），不再依赖 Node。
//
// 缓存边界：探测结果进程级缓存 30 秒，响应带 probedAtMs / expiresAtMs / cached，
// 调用方据此自行缓存，避免每次渲染都触发扫盘；refresh=1 强制重新探测。
package webuiappentriesapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/hostapps"
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
	// AIHomeDir 是 AIH 数据根：账号投影目录（run/auth-projections）的基准，
	// 运行态匹配用它把进程 user-data 目录对回账号。
	AIHomeDir string
	// LookPath 解析 PATH 上的可执行文件；为 nil 时使用 exec.LookPath。
	// 注入以便测试，无需依赖真实宿主安装。
	LookPath func(string) (string, error)
	// Providers 是可选的 Provider 合同来源；零值时使用 Go 内置合同。
	Providers ProviderCatalog
	// Now 允许测试注入时钟，用于验证缓存与单 Provider 探测预算。
	Now func() time.Time
	// Accounts 提供运行态匹配所需的账号台账；为 nil 时运行态字段留空并列入
	// unfilledFields（不用空数组冒充「没有运行中的账号」）。
	Accounts HostAccounts
	// Scanner 可替换宿主进程扫描器（测试用）；零值时按 runtime.GOOS 构造。
	Scanner *hostapps.Scanner
}

// HostAccounts 是运行态匹配所需的账号台账读端口。
type HostAccounts interface {
	ListAccounts(ctx context.Context) ([]hostapps.Account, error)
	ListCLIAliases(ctx context.Context) (map[string]string, error)
}

// entryView 是单个 Provider 的入口可用性，字段名与 Node /v0/webui/app-entries 一致。
type entryView struct {
	Desktop bool `json:"desktop"`
	CLI     bool `json:"cli"`
}

// capabilityView 是客户端能力声明（与探测结果分开：这里回答「能不能有」）。
//
// crossProviderHarness 对原生 harness 来自 relay profile 注册表，对外部 harness
// 来自自身声明；两者都收在 core/harnesses，派发点不再按 Provider 名猜测。
type capabilityView struct {
	Desktop              bool   `json:"desktop"`
	CLI                  bool   `json:"cli"`
	Label                string `json:"label"`
	ExternalHarness      bool   `json:"externalHarness"`
	CrossProviderHarness bool   `json:"crossProviderHarness"`
	InteractiveKind      string `json:"interactiveKind,omitempty"`
	ManagedAppID         string `json:"managedAppId,omitempty"`
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
	// RunningAccounts 是当前桌面实例在跑的账号引用（稳定排序）。
	RunningAccounts []string `json:"runningAccounts"`
	// RunningAccountPids 是账号引用 → 桌面主进程 pid。
	RunningAccountPids map[string][]int `json:"runningAccountPids"`
	// RunningCLIAccounts 是当前 aih CLI 进程对应的账号引用（稳定排序）。
	RunningCLIAccounts []string `json:"runningCliAccounts"`
	// RunningCLIAccountPids 是账号引用 → CLI 进程 pid。
	RunningCLIAccountPids map[string][]int `json:"runningCliAccountPids"`
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
	running := handler.detector.running(request.Context())
	writeJSON(responseWriter, http.StatusOK, responseView{
		OK:                      true,
		Entries:                 current.entries,
		Capabilities:            current.capabilities,
		ServerRuntime:           !isDesktopHost(handler.detector.platform),
		ProbedAtMS:              current.probedAt.UnixMilli(),
		ExpiresAtMS:             current.probedAt.Add(entriesCacheTTL).UnixMilli(),
		Cached:                  cached,
		RunningAccounts:         running.DesktopAccounts,
		RunningAccountPids:      running.DesktopPIDs,
		RunningCLIAccounts:      running.CLIAccounts,
		RunningCLIAccountPids:   running.CLIPIDs,
		BudgetExceededProviders: current.budgetExceeded,
		UnfilledFields:          handler.detector.unfilledFields(),
	})
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

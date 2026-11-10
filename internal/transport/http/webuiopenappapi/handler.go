// Package webuiopenappapi 提供「按账号打开桌面 App / CLI 终端」的管理面写入口。
//
// 路由（由共享 wiring 注册，本包只导出模式常量）：
//
//	POST /v1/management/webui/accounts/{provider}/{accountRef}/open-app
//
// 职责边界：本包只做判定——校验 Provider 与账号身份，把请求体归一成一份启动计划
// （身份 Provider / harness / kind / action / transport / sessionKey / 可执行入口），
// 再交给注入的 Launcher 真正拉起进程。Handler 自身不 exec 宿主 App、不开 PTY、
// 不写出口设置：这些动作需要宿主进程句柄以及 Node 侧的出口与安装器事实。
//
// 与 Node /v0/webui/accounts/:provider/:accountRef/open-app 的对应关系：
//   - 请求体字段（kind / action / terminalId / workdir / harness / model /
//     transport / sessionKey）同名同义，空体与损坏 JSON 都按「没带参数」处理；
//   - 成功响应保留 Node 的字段（status / pid / terminalId / sessionKey /
//     launchMode / executable / pids），并额外返回 plan，说明 Go 依据什么判定；
//   - 错误码沿用 Node：unsupported_provider / unsupported_kind /
//     unsupported_action / desktop_not_supported / cli_not_supported /
//     desktop_unavailable_on_server / account_not_found / install_required。
package webuiopenappapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os/exec"
	"runtime"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
)

const (
	// Path 是账号管理契约前缀。
	Path = "/v1/management/webui/accounts"
	// OpenAppSuffix 由共享 wiring 拼在 Path 之后，构成管理路由模式。
	//
	//	POST /v1/management/webui/accounts/{provider}/{accountRef}/open-app
	OpenAppSuffix = "/{provider}/{accountRef}/open-app"

	// maxBodyBytes 与 Node 的 readRequestBody({maxBytes: 64 * 1024}) 一致。
	maxBodyBytes = 64 * 1024
)

// ErrInvalidDependencies 表示 Handler 缺少鉴权策略或账号读端口。
var ErrInvalidDependencies = errors.New("打开应用接口依赖无效")

// Authorizer 是管理面请求的鉴权策略（与其它 WebUI 契约共用同一个 Bearer 实现）。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// AccountReader 是账号身份读端口（由 *sqliteaccount.Store 实现）。
//
// 只用来确认「账号引用存在且属于该 Provider」；账号是否已配置、凭据是否失效
// 属于资格判定，由 Launcher 按 Node 的同一口径决定。
type AccountReader interface {
	GetByRef(ctx context.Context, accountRef accountcore.AccountRef) (accountcore.Account, error)
}

// ProviderCatalog 是 Provider 合同来源（生产由 *providers.Catalog 实现）。
type ProviderCatalog interface {
	Get(id string) (providers.Definition, bool)
}

// Request 是交给 Launcher 的启动请求：字段即启动计划，不含任何 HTTP 细节。
type Request struct {
	// Provider 是账号所属的规范 Provider ID（身份来源）。
	Provider string
	// AccountRef 是 Go 的稳定账号引用。
	AccountRef string
	// Kind 是 desktop 或 cli。
	Kind string
	// Action 是 open 或 close。
	Action string
	// Harness 是实际执行的 harness，缺省等于 Provider。
	Harness string
	// HarnessKind 当前恒为 native：Go 合同不包含外部 harness。
	HarnessKind string
	// CrossProvider 表示 harness 与身份 Provider 不同（走本地网关）。
	CrossProvider bool
	// ManagedAppID 是安装器目标标识（Node 的 managedAppId 同义）。
	ManagedAppID string
	// BinaryName 是 harness 需要的可执行文件名。
	BinaryName string
	// Executable 是本机解析到的可执行入口；空表示未找到（不代表不可启动）。
	Executable string
	// Model / TerminalID / Workdir 是透传的启动选项。
	Model      string
	TerminalID string
	Workdir    string
	// Transport 是 CLI 的承载方式：native 或 webui。
	Transport string
	// SessionKey 是 Web Terminal 会话键（transport=webui 时非空）。
	SessionKey string
	// AIHomeDir / HostHomeDir 让 Launcher 定位账号投影与宿主安装落点，
	// 不必再自行解析一遍服务根目录。
	AIHomeDir   string
	HostHomeDir string
}

// Result 是 Launcher 的执行结果，字段与 Node launchAccountApp 的返回同义。
//
// OK=false 表示业务失败（例如账号未配置、桌面端未安装），由 Handler 翻译成
// Node 对应的状态码；error 返回值只用于传输/实现层面的意外故障。
type Result struct {
	OK             bool
	Status         string
	PID            *int
	TerminalID     string
	SessionKey     string
	LaunchMode     string
	Executable     string
	PIDs           []int
	Error          string
	Message        string
	Reason         string
	RequiredAction string
	EgressError    string
	EgressWarning  string
}

// Launcher 是进程启动端口。
//
// 生产实现负责宿主 App / 原生终端 / Web PTY 的真实拉起；为 nil 时 Handler
// 仍可完成判定并返回 501 launch_unavailable 与启动计划。
type Launcher interface {
	Launch(ctx context.Context, request Request) (Result, error)
}

// Dependencies 汇总打开应用的依赖。
type Dependencies struct {
	Authorizer Authorizer
	// Accounts 是账号身份读端口；未知账号返回 404。
	Accounts AccountReader
	// AIHomeDir 是 AIH 数据根，透传给 Launcher 定位账号投影。
	AIHomeDir string
	// HostHomeDir 是宿主 HOME：展开桌面安装路径里的 {hostHomeDir}，
	// 并作为 ~/.local/bin 安装落点的根。
	HostHomeDir string
	// Launcher 为 nil 时返回 501 与启动计划（只判定、不启动）。
	Launcher Launcher
	// LookPath 解析 PATH 上的可执行文件；为 nil 时使用 exec.LookPath。
	LookPath func(string) (string, error)
	// Providers 是可选的 Provider 合同来源；零值时使用 Go 内置合同。
	Providers ProviderCatalog
	// DesktopHost 允许注入宿主桌面判定（测试用）；零值时按平台与 GUI 会话信号判定。
	DesktopHost func() bool
}

// Handler 是打开应用的管理面入站适配器。
type Handler struct {
	authorizer  Authorizer
	accounts    AccountReader
	catalog     ProviderCatalog
	aiHomeDir   string
	hostHomeDir string
	launcher    Launcher
	lookPath    func(string) (string, error)
	desktopHost func() bool
	platform    string
}

// NewHandler 校验依赖并创建 Handler。
//
// Launcher 允许为空：那是「只判定不启动」的降级形态，由 ServeHTTP 返回 501。
func NewHandler(dependencies Dependencies) (http.Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Accounts == nil {
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
	lookPath := dependencies.LookPath
	if lookPath == nil {
		lookPath = exec.LookPath
	}
	desktopHost := dependencies.DesktopHost
	if desktopHost == nil {
		desktopHost = defaultDesktopHost
	}
	return &Handler{
		authorizer:  dependencies.Authorizer,
		accounts:    dependencies.Accounts,
		catalog:     catalog,
		aiHomeDir:   strings.TrimSpace(dependencies.AIHomeDir),
		hostHomeDir: strings.TrimSpace(dependencies.HostHomeDir),
		launcher:    dependencies.Launcher,
		lookPath:    lookPath,
		desktopHost: desktopHost,
		platform:    resolvePlatformKey(runtime.GOOS),
	}, nil
}

// requestPayload 是 Node handleOpenAccountAppRequest 读取的请求体字段。
type requestPayload struct {
	Kind       string `json:"kind"`
	Action     string `json:"action"`
	TerminalID string `json:"terminalId"`
	Workdir    string `json:"workdir"`
	Harness    string `json:"harness"`
	Model      string `json:"model"`
	Transport  string `json:"transport"`
	SessionKey string `json:"sessionKey"`
}

// planView 是启动计划在响应里的投影（camelCase 与 Node 的 launch-plan 词表一致）。
type planView struct {
	IdentityProvider string `json:"identityProvider"`
	AccountRef       string `json:"accountRef"`
	HarnessID        string `json:"harnessId"`
	HarnessKind      string `json:"harnessKind"`
	CrossProvider    bool   `json:"crossProvider"`
	ManagedAppID     string `json:"managedAppId"`
	BinaryName       string `json:"binaryName"`
	Kind             string `json:"kind"`
	Action           string `json:"action"`
	Model            string `json:"model"`
	TerminalID       string `json:"terminalId"`
	Workdir          string `json:"workdir"`
	Transport        string `json:"transport"`
	SessionKey       string `json:"sessionKey"`
	Executable       string `json:"executable"`
	Installed        bool   `json:"installed"`
}

// successView 是成功响应：Node 的字段全部保留，另加 plan 与未填字段清单。
type successView struct {
	OK            bool     `json:"ok"`
	Provider      string   `json:"provider"`
	AccountRef    string   `json:"accountRef"`
	Kind          string   `json:"kind"`
	Action        string   `json:"action"`
	Status        string   `json:"status"`
	PID           *int     `json:"pid"`
	TerminalID    string   `json:"terminalId"`
	SessionKey    string   `json:"sessionKey"`
	LaunchMode    string   `json:"launchMode"`
	Executable    string   `json:"executable"`
	PIDs          []int    `json:"pids"`
	EgressWarning string   `json:"egressWarning,omitempty"`
	Plan          planView `json:"plan"`
	Partial       bool     `json:"partial"`
	// UnfilledFields 列出 Node 有、而本切片没有可信来源的键。
	UnfilledFields []string `json:"unfilledFields"`
}

// installTargetView 是 428 install_required 的安装目标（与 Node 同形状）。
type installTargetView struct {
	Provider string `json:"provider"`
	Kind     string `json:"kind"`
	AppID    string `json:"appId"`
}

// errorView 覆盖 Node 的全部错误字段：只有实际存在的键才输出。
type errorView struct {
	OK               bool               `json:"ok"`
	Error            string             `json:"error"`
	Message          string             `json:"message,omitempty"`
	Provider         string             `json:"provider,omitempty"`
	AccountRef       string             `json:"accountRef,omitempty"`
	Plan             *planView          `json:"plan,omitempty"`
	PIDs             []int              `json:"pids,omitempty"`
	Reason           string             `json:"reason,omitempty"`
	RequiredAction   string             `json:"requiredAction,omitempty"`
	EgressError      string             `json:"egressError,omitempty"`
	EgressWarning    string             `json:"egressWarning,omitempty"`
	InstallRequired  bool               `json:"installRequired,omitempty"`
	InstallTarget    *installTargetView `json:"installTarget,omitempty"`
	InstallAvailable *bool              `json:"installAvailable,omitempty"`
}

func (handler *Handler) ServeHTTP(responseWriter http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.accounts == nil {
		writeError(responseWriter, http.StatusServiceUnavailable, errorView{
			Error: "webui_open_app_unavailable", Message: "打开应用接口不可用",
		})
		return
	}
	if !handler.authorizer.Authorized(request) {
		responseWriter.Header().Set("WWW-Authenticate", "Bearer")
		writeError(responseWriter, http.StatusUnauthorized, errorView{
			Error: "unauthorized", Message: "需要管理密钥",
		})
		return
	}
	if request.Method != http.MethodPost {
		responseWriter.Header().Set("Allow", http.MethodPost)
		writeError(responseWriter, http.StatusMethodNotAllowed, errorView{
			Error: "method_not_allowed", Message: "仅支持 POST",
		})
		return
	}

	provider := strings.ToLower(strings.TrimSpace(request.PathValue("provider")))
	rawAccountRef := strings.TrimSpace(request.PathValue("accountRef"))
	if provider == "" || rawAccountRef == "" {
		writeError(responseWriter, http.StatusBadRequest, errorView{
			Error: "invalid_account_path", Message: "账号路径不完整",
		})
		return
	}
	accountRef, err := accountcore.ParseAccountRef(rawAccountRef)
	if err != nil {
		writeError(responseWriter, http.StatusBadRequest, errorView{
			Error: "invalid_account_ref", Message: "账号引用格式无效",
		})
		return
	}
	definition, found := handler.catalog.Get(provider)
	if !found {
		writeError(responseWriter, http.StatusBadRequest, errorView{
			Error: "unsupported_provider", Message: "该 Provider 未注册",
		})
		return
	}
	provider = definition.ID

	payload := decodePayload(request)
	desktopHost := handler.desktopHost()
	kind := strings.ToLower(strings.TrimSpace(payload.Kind))
	if kind == "" {
		kind = inferKind(definition, desktopHost)
	}
	action := strings.ToLower(strings.TrimSpace(payload.Action))
	if action == "" {
		action = actionOpen
	}
	harness := strings.ToLower(strings.TrimSpace(payload.Harness))
	model := strings.TrimSpace(payload.Model)
	workdir := strings.TrimSpace(payload.Workdir)
	terminalID := strings.ToLower(strings.TrimSpace(payload.TerminalID))
	requestedTransport := strings.ToLower(strings.TrimSpace(payload.Transport))
	sessionKey := strings.TrimSpace(payload.SessionKey)

	// CLI 的承载方式由 Server 决定；sessionKey 在降级到 Web Terminal 时补默认值。
	transport := requestedTransport
	if kind == kindCLI {
		transport = resolveTerminalTransport(request, requestedTransport, desktopHost)
		if transport == transportWebUI && sessionKey == "" {
			sessionKey = defaultWebTerminalSessionKey(accountRef.String(), harness, model, workdir)
		}
	}

	plan, planErr := resolvePlan(planInput{
		catalog:    handler.catalog,
		definition: definition,
		provider:   provider,
		accountRef: accountRef.String(),
		kind:       kind,
		action:     action,
		harness:    harness,
		model:      model,
		terminalID: terminalID,
		workdir:    workdir,
		transport:  transport,
		sessionKey: sessionKey,
	})
	if planErr != nil {
		writeError(responseWriter, planErr.status, errorView{
			Error: planErr.code, Message: planErr.message,
			Provider: provider, AccountRef: accountRef.String(),
		})
		return
	}
	if plan.Kind == kindDesktop && !desktopHost {
		writeError(responseWriter, http.StatusBadRequest, errorView{
			Error:      "desktop_unavailable_on_server",
			Message:    "当前 AIH Server 没有桌面会话；请使用 Web 虚拟终端或 SSH 开发机。",
			Provider:   provider,
			AccountRef: accountRef.String(),
		})
		return
	}
	plan.AIHomeDir = handler.aiHomeDir
	plan.HostHomeDir = handler.hostHomeDir
	plan.Executable = handler.resolveExecutable(definition, plan)

	account, err := handler.accounts.GetByRef(request.Context(), accountRef)
	if err != nil {
		if errors.Is(err, accountapp.ErrAccountNotFound) {
			writeError(responseWriter, http.StatusNotFound, errorView{
				Error: "account_not_found", Provider: provider, AccountRef: accountRef.String(),
			})
			return
		}
		writeError(responseWriter, http.StatusInternalServerError, errorView{
			Error: "account_read_failed", Message: "读取账号失败",
		})
		return
	}
	// 账号引用存在但属于别的 Provider：与 Node 的启动器同口径，按不存在处理。
	if account.ProviderID() != provider {
		writeError(responseWriter, http.StatusNotFound, errorView{
			Error: "account_not_found", Provider: provider, AccountRef: accountRef.String(),
		})
		return
	}

	if handler.launcher == nil {
		view := newPlanView(plan)
		writeError(responseWriter, http.StatusNotImplemented, errorView{
			Error:      "launch_unavailable",
			Message:    "未接入进程启动器（Launcher），本次只返回启动计划，未启动任何进程。",
			Provider:   provider,
			AccountRef: accountRef.String(),
			Plan:       &view,
		})
		return
	}

	result, err := handler.launcher.Launch(request.Context(), plan)
	if err != nil {
		writeError(responseWriter, http.StatusInternalServerError, errorView{
			Error:      "launch_failed",
			Message:    "启动器执行失败：" + err.Error(),
			Provider:   provider,
			AccountRef: accountRef.String(),
		})
		return
	}
	if !result.OK {
		writeLaunchFailure(responseWriter, plan, result)
		return
	}

	sessionKey = firstNonEmpty(result.SessionKey, plan.SessionKey)
	executable := firstNonEmpty(result.Executable, plan.Executable)
	pids := result.PIDs
	if pids == nil {
		pids = []int{}
	}
	writeJSON(responseWriter, http.StatusOK, successView{
		OK:             true,
		Provider:       plan.Provider,
		AccountRef:     plan.AccountRef,
		Kind:           plan.Kind,
		Action:         plan.Action,
		Status:         result.Status,
		PID:            result.PID,
		TerminalID:     result.TerminalID,
		SessionKey:     sessionKey,
		LaunchMode:     result.LaunchMode,
		Executable:     executable,
		PIDs:           pids,
		EgressWarning:  result.EgressWarning,
		Plan:           newPlanView(plan),
		Partial:        true,
		UnfilledFields: unfilledFields(),
	})
}

// writeLaunchFailure 把 Launcher 的业务失败翻译成 Node 的状态码与字段。
func writeLaunchFailure(responseWriter http.ResponseWriter, plan Request, result Result) {
	// 缺安装是「可修复的前置条件」，Node 用 428 让前端弹安装确认；
	// transport=webui 时不需要本机二进制，不走这条分支。
	if plan.Action == actionOpen && plan.Transport != transportWebUI &&
		(result.Error == "desktop_not_installed" || result.Error == "cli_not_installed") {
		writeInstallRequired(responseWriter, plan)
		return
	}
	message := strings.TrimSpace(result.Message)
	if message == "" {
		message = launchErrorMessage(result.Error)
	}
	view := errorView{
		Error:          result.Error,
		Message:        message,
		Provider:       plan.Provider,
		AccountRef:     plan.AccountRef,
		PIDs:           result.PIDs,
		Reason:         result.Reason,
		RequiredAction: result.RequiredAction,
		EgressError:    result.EgressError,
		EgressWarning:  result.EgressWarning,
	}
	writeError(responseWriter, launchErrorStatus(result.Error), view)
}

// writeInstallRequired 输出 428：Go 没有安装器端口，installAvailable 恒为 false。
func writeInstallRequired(responseWriter http.ResponseWriter, plan Request) {
	installProvider := plan.Provider
	if plan.Kind == kindCLI && plan.Harness != "" {
		installProvider = plan.Harness
	}
	appID := installProvider
	if plan.Kind == kindDesktop {
		appID = plan.Provider + "-desktop"
	}
	available := false
	message := "当前 Provider 没有可用的自动安装器，请手动安装原生 CLI 后重试。"
	if plan.Kind == kindDesktop {
		message = "当前平台没有可用的自动安装器，请手动安装官方 Desktop 应用后重试。"
	}
	writeJSON(responseWriter, http.StatusPreconditionRequired, errorView{
		Error:            "install_required",
		Message:          message,
		Provider:         plan.Provider,
		AccountRef:       plan.AccountRef,
		InstallRequired:  true,
		InstallTarget:    &installTargetView{Provider: installProvider, Kind: plan.Kind, AppID: appID},
		InstallAvailable: &available,
	})
}

// launchErrorStatus 与 Node 的 resolveAccountAppErrorStatus 同表。
func launchErrorStatus(code string) int {
	switch code {
	case "account_not_found":
		return http.StatusNotFound
	case "account_unconfigured", "account_auth_invalid",
		"agy_desktop_keychain_conflict", "agy_desktop_restart_required",
		"agy_desktop_auth_unavailable", "kimi_desktop_session_required",
		"kimi_desktop_session_seed_failed", "kimi_desktop_restart_failed",
		"zcode_native_proxy_marker_unrecognized":
		return http.StatusConflict
	case "agy_desktop_process_probe_failed", "codebuddy_desktop_keychain_unavailable",
		"account_egress_unavailable", "zcode_egress_unavailable":
		return http.StatusServiceUnavailable
	case "zcode_native_proxy_settings_failed",
		"account_egress_binding_unavailable", "zcode_egress_binding_unavailable":
		return http.StatusInternalServerError
	}
	return http.StatusBadRequest
}

// launchErrorMessages 只收录本切片与资格判定会出现的稳定错误码；
// Launcher 自带 message 时优先用它的措辞。
var launchErrorMessages = map[string]string{
	"account_unconfigured":  "该账号尚未完成配置，未启动应用。",
	"account_auth_invalid":  "该账号的授权已失效，请重新授权后再打开。",
	"desktop_not_installed": "未检测到 Desktop 应用。",
	"cli_not_installed":     "未检测到原生 CLI。",
	"terminal_not_found":    "未找到可用的终端。",
	"workdir_not_found":     "所选项目目录不存在或不是文件夹，未启动 CLI。",
}

func launchErrorMessage(code string) string {
	if message, found := launchErrorMessages[code]; found {
		return message
	}
	return code
}

// unfilledFields 列出 Node 有、而本切片没有可信来源的键。
func unfilledFields() []string {
	return []string{
		"accountEligibility",
		"appInstallManager",
		"externalHarnessRegistry",
	}
}

func newPlanView(plan Request) planView {
	return planView{
		IdentityProvider: plan.Provider,
		AccountRef:       plan.AccountRef,
		HarnessID:        plan.Harness,
		HarnessKind:      plan.HarnessKind,
		CrossProvider:    plan.CrossProvider,
		ManagedAppID:     plan.ManagedAppID,
		BinaryName:       plan.BinaryName,
		Kind:             plan.Kind,
		Action:           plan.Action,
		Model:            plan.Model,
		TerminalID:       plan.TerminalID,
		Workdir:          plan.Workdir,
		Transport:        plan.Transport,
		SessionKey:       plan.SessionKey,
		Executable:       plan.Executable,
		Installed:        plan.Executable != "",
	}
}

// decodePayload 与 Node 的 readRequestBody + JSON.parse 同语义：空体、损坏 JSON、
// 超限都按「没带参数」处理，由后续校验给出稳定错误码，而不是单独发明解析错误。
func decodePayload(request *http.Request) requestPayload {
	if request == nil || request.Body == nil {
		return requestPayload{}
	}
	body, err := io.ReadAll(io.LimitReader(request.Body, maxBodyBytes+1))
	if err != nil || len(body) > maxBodyBytes {
		return requestPayload{}
	}
	var payload requestPayload
	if err := json.Unmarshal(body, &payload); err != nil {
		return requestPayload{}
	}
	return payload
}

func firstNonEmpty(primary string, fallback string) string {
	if strings.TrimSpace(primary) != "" {
		return primary
	}
	return fallback
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	encoder := json.NewEncoder(response)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(payload)
}

func writeError(response http.ResponseWriter, status int, payload errorView) {
	payload.OK = false
	writeJSON(response, status, payload)
}

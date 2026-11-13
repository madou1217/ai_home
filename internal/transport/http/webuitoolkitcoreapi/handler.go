// Package webuitoolkitcoreapi 提供 WebUI 工具箱核心能力的 Go HTTP/SSE 接口：
// 镜像测速与切换、代理与连通性、受管网络工具及后台服务控制、客户端终端、
// 受管应用列表/配置/Hook/打开以及 CLI/Desktop 安装生命周期作业。
package webuitoolkitcoreapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/hostexec"
	"github.com/madou1217/ai_home/internal/runtime/toolkit/apps"
	"github.com/madou1217/ai_home/internal/runtime/toolkit/configedit"
	"github.com/madou1217/ai_home/internal/runtime/toolkit/environment"
	"github.com/madou1217/ai_home/internal/runtime/toolkit/mirrors"
	"github.com/madou1217/ai_home/internal/runtime/toolkit/network"
	"github.com/madou1217/ai_home/internal/runtime/toolkit/terminals"
	"github.com/madou1217/ai_home/internal/runtime/toolkit/tools"
	"github.com/madou1217/ai_home/internal/transport/http/webuiopenappapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiserverconfigapi"
)

const (
	// 镜像、代理与连通性路由。
	MirrorsPath      = "/v1/management/webui/toolkit/mirrors"
	MirrorsSetPath   = "/v1/management/webui/toolkit/mirrors/set"
	MirrorsPingPath  = "/v1/management/webui/toolkit/mirrors/ping"
	ProxyPath        = "/v1/management/webui/toolkit/proxy"
	ProxySetPath     = "/v1/management/webui/toolkit/proxy/set"
	ConnectivityPath = "/v1/management/webui/toolkit/connectivity"

	// 受管网络工具与服务控制路由。
	ToolsPath               = "/v1/management/webui/toolkit/tools"
	ToolsPlanPath           = "/v1/management/webui/toolkit/tools/plan"
	ToolsExecutePath        = "/v1/management/webui/toolkit/tools/execute"
	ToolsJobsPath           = "/v1/management/webui/toolkit/tools/jobs"
	ToolsJobsWatchPath      = "/v1/management/webui/toolkit/tools/jobs-watch"
	ToolsSubtreePath        = "/v1/management/webui/toolkit/tools/{rest...}"

	// 客户端终端路由。
	TerminalsRootPath      = "/v1/management/webui/terminals"
	ToolkitTerminalsPath   = "/v1/management/webui/toolkit/terminals"
	TerminalsPlanPath      = "/v1/management/webui/toolkit/terminals/plan"
	TerminalsExecutePath   = "/v1/management/webui/toolkit/terminals/execute"
	TerminalsOpenPath      = "/v1/management/webui/toolkit/terminals/open"
	TerminalsJobsWatchPath = "/v1/management/webui/toolkit/terminals/jobs-watch"
	TerminalsJobPath       = "/v1/management/webui/toolkit/terminals/jobs/{jobId}"
	TerminalsJobWatchPath  = "/v1/management/webui/toolkit/terminals/jobs/{jobId}/watch"

	// 受管应用与统一安装任务路由。
	AppsPath                = "/v1/management/webui/toolkit/apps"
	AppConfigPath           = "/v1/management/webui/toolkit/apps/{appId}/config"
	AppCheckUpdatePath      = "/v1/management/webui/toolkit/apps/{appId}/check-update"
	AppOpenPath             = "/v1/management/webui/toolkit/apps/{appId}/open"
	AppsInstallPath         = "/v1/management/webui/toolkit/apps/install"
	AppsPlanPath            = "/v1/management/webui/toolkit/apps/plan"
	AppsHooksPath           = "/v1/management/webui/toolkit/apps/hooks"
	AppInstallPath          = "/v1/management/webui/app-install"
	AppInstallJobsPath      = "/v1/management/webui/app-install/jobs"
	AppInstallJobsWatchPath = "/v1/management/webui/app-install/jobs-watch"
	AppInstallJobPath       = "/v1/management/webui/app-install/jobs/{jobId}"
	AppInstallJobWatchPath  = "/v1/management/webui/app-install/jobs/{jobId}/watch"
	AppInstallJobCancelPath = "/v1/management/webui/app-install/jobs/{jobId}/cancel"

	smallBodyMaxBytes  = 64 * 1024
	configBodyMaxBytes = 3 * 1024 * 1024
	toolsCacheTTL      = 3 * time.Second
	toolsCacheMaxStale = 10 * time.Minute
)

// ErrInvalidDependencies 表示缺少鉴权依赖。
var ErrInvalidDependencies = errors.New("工具箱核心接口依赖无效")

// Authorizer 校验 WebUI 管理面权限。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// DefaultAccountResolver 读取指定 Provider 的默认账号引用，空值表示未配置默认账号。
type DefaultAccountResolver func(ctx context.Context, provider string) string

// Dependencies 汇总工具箱核心 HTTP Handler 依赖。
type Dependencies struct {
	Authorizer             Authorizer
	AIHomeDir              string
	HostHomeDir            string
	Catalog                *providers.Catalog
	DefaultAccountResolver DefaultAccountResolver
	AppLauncher            webuiopenappapi.Launcher

	Platform     string
	Arch         string
	NodeVersion  string
	NodeExecPath string
	Env          map[string]string
	Executor     environment.Executor
	LookPath     func(string) (string, error)
	PathExists   func(string) bool
	HTTPClient   *http.Client
	ServerConfig network.ServerConfigReader
	Now          func() time.Time

	MirrorsManager *mirrors.Manager
	NetworkManager *network.Manager
	AppsManager    *apps.Manager
	AppInstallJobs *apps.JobManager
	ToolServices   *tools.ServiceManager
	ToolJobs       *tools.JobManager
	TerminalJobs   *terminals.JobManager
	ToolsBaseOpts  *tools.Options
	TerminalsOpts  *terminals.Options
	AppsBaseOpts   *apps.Options
}

type toolsListCache struct {
	mu               sync.Mutex
	hasEntry         bool
	at               time.Time
	value            tools.ListResult
	refreshScheduled bool
	generation       uint64
}

// Handler 实现全部工具箱核心路由与后台作业生命周期管理。
type Handler struct {
	mux            *http.ServeMux
	authorizer     Authorizer
	aiHomeDir      string
	hostHomeDir    string
	catalog        *providers.Catalog
	defaultAccount DefaultAccountResolver
	appLauncher    webuiopenappapi.Launcher
	executor       environment.Executor
	now            func() time.Time

	mirrorsMgr     *mirrors.Manager
	networkMgr     *network.Manager
	appsMgr        *apps.Manager
	appInstallJobs *apps.JobManager
	toolServices   *tools.ServiceManager
	toolJobs       *tools.JobManager
	terminalJobs   *terminals.JobManager

	toolsOpts     tools.Options
	terminalsOpts terminals.Options
	appsOpts      apps.Options

	toolsCache          toolsListCache
	toolJobCacheInvalid atomic.Bool
}

type appStateServerConfigReader struct {
	source *webuiserverconfigapi.Source
}

func (r appStateServerConfigReader) ReadProxyConfig(ctx context.Context) network.ServerProxyConfig {
	if r.source == nil {
		return network.ServerProxyConfig{}
	}
	raw, found, err := r.source.ReadServerConfig(ctx)
	if err != nil || !found || strings.TrimSpace(raw) == "" {
		return network.ServerProxyConfig{}
	}
	var parsed struct {
		ProxyURL string `json:"proxyUrl"`
		NoProxy  string `json:"noProxy"`
	}
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		return network.ServerProxyConfig{}
	}
	return network.ServerProxyConfig{
		ProxyURL: strings.TrimSpace(parsed.ProxyURL),
		NoProxy:  strings.TrimSpace(parsed.NoProxy),
	}
}

// NewHandler 创建工具箱核心 Handler；缺少 Authorizer 时 fail-closed。
func NewHandler(deps Dependencies) (*Handler, error) {
	if deps.Authorizer == nil {
		return nil, ErrInvalidDependencies
	}
	nowFn := deps.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	execImpl := deps.Executor
	if execImpl == nil {
		execImpl = hostexec.Executor{}
	}

	if deps.Catalog == nil {
		if cat, err := providers.NewCatalog(providers.BuiltinManifest()); err == nil {
			deps.Catalog = cat
		}
	}

	var lookupEnv func(string) string
	if deps.Env != nil {
		lookupEnv = func(k string) string { return deps.Env[k] }
	}

	serverCfg := deps.ServerConfig
	if serverCfg == nil && strings.TrimSpace(deps.AIHomeDir) != "" {
		if src, err := webuiserverconfigapi.OpenSource(deps.AIHomeDir); err == nil {
			serverCfg = appStateServerConfigReader{source: src}
		}
	}

	mirrorsMgr := deps.MirrorsManager
	if mirrorsMgr == nil {
		mirrorsMgr = mirrors.NewManager(mirrors.Options{
			Platform: deps.Platform,
			Exec:     execImpl,
			Now:      nowFn,
		})
	}
	networkMgr := deps.NetworkManager
	if networkMgr == nil {
		networkMgr = network.NewManager(network.Options{
			GOOS:         deps.Platform,
			Exec:         execImpl,
			LookupEnv:    lookupEnv,
			ServerConfig: serverCfg,
			Now:          nowFn,
		})
	}

	toolsOpts := tools.Options{
		Platform:           deps.Platform,
		Arch:               deps.Arch,
		AIHomeDir:          deps.AIHomeDir,
		HostHomeDir:        deps.HostHomeDir,
		Exec:               execImpl,
		LookupEnv:          lookupEnv,
		LookPathOverride:   deps.LookPath,
		FileExistsOverride: deps.PathExists,
		Now:                nowFn,
	}
	if deps.HTTPClient != nil {
		toolsOpts.HTTPClient = deps.HTTPClient
	}
	if deps.ToolsBaseOpts != nil {
		toolsOpts = *deps.ToolsBaseOpts
	}

	toolServices := deps.ToolServices
	if toolServices == nil {
		toolServices = tools.NewServiceManager(toolsOpts)
	}
	toolJobs := deps.ToolJobs
	if toolJobs == nil {
		toolJobs = tools.NewJobManager(toolsOpts)
	}

	terminalsOpts := terminals.Options{
		Platform:    deps.Platform,
		Arch:        deps.Arch,
		HostHomeDir: deps.HostHomeDir,
		Env:         deps.Env,
		LookupEnv:   lookupEnv,
		PathExists:  deps.PathExists,
		Exec:        execImpl,
		Now:         func() int64 { return nowFn().UnixMilli() },
	}
	if deps.TerminalsOpts != nil {
		terminalsOpts = *deps.TerminalsOpts
	}
	terminalJobs := deps.TerminalJobs
	if terminalJobs == nil {
		terminalJobs = terminals.NewJobManager(terminalsOpts)
	}

	appsOpts := apps.Options{
		Catalog:      deps.Catalog,
		AIHomeDir:    deps.AIHomeDir,
		HostHomeDir:  deps.HostHomeDir,
		Platform:     deps.Platform,
		Arch:         deps.Arch,
		NodeVersion:  deps.NodeVersion,
		NodeExecPath: deps.NodeExecPath,
		Env:          deps.Env,
		Executor:     execImpl,
		LookPath:     deps.LookPath,
		HTTPClient:   deps.HTTPClient,
		Now:          nowFn,
		// 安装计划跟随工具箱的 npm 镜像设置（见 apps.effectiveNPMRegistry）。
		NPMRegistry: func() string { return mirrorsMgr.NPMRegistry(context.Background()) },
	}
	if deps.AppsBaseOpts != nil {
		appsOpts = *deps.AppsBaseOpts
	}
	appsMgr := deps.AppsManager
	if appsMgr == nil {
		appsMgr = apps.NewManager()
	}
	appInstallJobs := deps.AppInstallJobs
	if appInstallJobs == nil {
		appInstallJobs = apps.NewJobManager(appsMgr, appsOpts)
	}

	h := &Handler{
		mux:            http.NewServeMux(),
		authorizer:     deps.Authorizer,
		aiHomeDir:      strings.TrimSpace(deps.AIHomeDir),
		hostHomeDir:    strings.TrimSpace(deps.HostHomeDir),
		catalog:        deps.Catalog,
		defaultAccount: deps.DefaultAccountResolver,
		appLauncher:    deps.AppLauncher,
		executor:       execImpl,
		now:            nowFn,
		mirrorsMgr:     mirrorsMgr,
		networkMgr:     networkMgr,
		appsMgr:        appsMgr,
		appInstallJobs: appInstallJobs,
		toolServices:   toolServices,
		toolJobs:       toolJobs,
		terminalJobs:   terminalJobs,
		toolsOpts:      toolsOpts,
		terminalsOpts:  terminalsOpts,
		appsOpts:       appsOpts,
	}
	h.registerRoutes()
	return h, nil
}

// ServeHTTP 统一鉴权、写操作失效清单缓存并分发工具箱核心路由。
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !h.authorize(w, r) {
		return
	}
	if r.Method != http.MethodGet && strings.HasPrefix(r.URL.Path, "/v1/management/webui/toolkit/") {
		h.clearReadCaches()
	}
	h.mux.ServeHTTP(w, r)
}

func (h *Handler) registerRoutes() {
	h.mux.HandleFunc(MirrorsPath, h.handleMirrors)
	h.mux.HandleFunc(MirrorsSetPath, h.handleMirrorsSet)
	h.mux.HandleFunc(MirrorsPingPath, h.handleMirrorsPing)
	h.mux.HandleFunc(ProxyPath, h.handleProxy)
	h.mux.HandleFunc(ProxySetPath, h.handleProxySet)
	h.mux.HandleFunc(ConnectivityPath, h.handleConnectivity)

	h.mux.HandleFunc(ToolsPath, h.handleToolsList)
	h.mux.HandleFunc(ToolsPlanPath, h.handleToolsPlan)
	h.mux.HandleFunc(ToolsExecutePath, h.handleToolsExecute)
	h.mux.HandleFunc(ToolsJobsPath, h.handleToolsJobs)
	h.mux.HandleFunc(ToolsJobsWatchPath, h.handleToolsJobsWatch)
	h.mux.HandleFunc(ToolsSubtreePath, h.handleToolsSubtree)

	h.mux.HandleFunc(TerminalsRootPath, h.handleTerminalsList)
	h.mux.HandleFunc(ToolkitTerminalsPath, h.handleTerminalsList)
	h.mux.HandleFunc(TerminalsPlanPath, h.handleTerminalsPlan)
	h.mux.HandleFunc(TerminalsExecutePath, h.handleTerminalsExecute)
	h.mux.HandleFunc(TerminalsOpenPath, h.handleTerminalsOpen)
	h.mux.HandleFunc(TerminalsJobsWatchPath, h.handleTerminalsJobsWatch)
	h.mux.HandleFunc(TerminalsJobPath, h.handleTerminalsJob)
	h.mux.HandleFunc(TerminalsJobWatchPath, h.handleTerminalsJobWatch)

	h.mux.HandleFunc(AppsPath, h.handleAppsList)
	h.mux.HandleFunc(AppConfigPath, h.handleAppConfig)
	h.mux.HandleFunc(AppCheckUpdatePath, h.handleAppCheckUpdate)
	h.mux.HandleFunc(AppOpenPath, h.handleAppOpen)
	h.mux.HandleFunc(AppsInstallPath, h.handleAppsInstall)
	h.mux.HandleFunc(AppsPlanPath, h.handleAppsPlan)
	h.mux.HandleFunc(AppsHooksPath, h.handleAppsHooks)

	h.mux.HandleFunc(AppInstallPath, h.handleAppInstallCreate)
	h.mux.HandleFunc(AppInstallJobsPath, h.handleAppInstallJobs)
	h.mux.HandleFunc(AppInstallJobsWatchPath, h.handleAppInstallJobsWatch)
	h.mux.HandleFunc(AppInstallJobPath, h.handleAppInstallJob)
	h.mux.HandleFunc(AppInstallJobWatchPath, h.handleAppInstallJobWatch)
	h.mux.HandleFunc(AppInstallJobCancelPath, h.handleAppInstallJobCancel)
}

// ToolJobs 返回受管工具生命周期作业管理器（供任务队列或外部监听复用）。
func (h *Handler) ToolJobs() *tools.JobManager { return h.toolJobs }

// TerminalJobs 返回客户端终端作业管理器。
func (h *Handler) TerminalJobs() *terminals.JobManager { return h.terminalJobs }

// AppInstallJobs 返回应用安装生命周期作业管理器。
func (h *Handler) AppInstallJobs() *apps.JobManager { return h.appInstallJobs }

// AppService 返回应用清单与缓存管理器。
func (h *Handler) AppService() *apps.Manager { return h.appsMgr }

func (h *Handler) authorize(w http.ResponseWriter, r *http.Request) bool {
	if h.authorizer.Authorized(r) {
		return true
	}
	writeError(w, http.StatusUnauthorized, "unauthorized", "Unauthorized")
	return false
}

func (h *Handler) clearReadCaches() {
	h.appsMgr.InvalidateCache("")
	h.toolsCache.clear()
}

func (c *toolsListCache) get(now time.Time, load func() tools.ListResult) tools.ListResult {
	c.mu.Lock()
	if c.hasEntry {
		age := now.Sub(c.at)
		if age < toolsCacheTTL {
			val := c.value
			c.mu.Unlock()
			return val
		}
		if age < toolsCacheMaxStale {
			val := c.value
			if !c.refreshScheduled {
				c.refreshScheduled = true
				gen := c.generation
				go func() {
					fresh := load()
					c.mu.Lock()
					c.refreshScheduled = false
					if c.generation == gen {
						c.value = fresh
						c.at = time.Now()
						c.hasEntry = true
					}
					c.mu.Unlock()
				}()
			}
			c.mu.Unlock()
			return val
		}
	}
	c.mu.Unlock()

	fresh := load()
	c.mu.Lock()
	c.value = fresh
	c.at = now
	c.hasEntry = true
	c.generation++
	c.mu.Unlock()
	return fresh
}

func (c *toolsListCache) clear() {
	c.mu.Lock()
	c.hasEntry = false
	c.generation++
	c.mu.Unlock()
}

func decodeJSONBody(w http.ResponseWriter, r *http.Request, maxBytes int64, dst any) (bool, int, string) {
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			return false, http.StatusRequestEntityTooLarge, "Body too large"
		}
		return false, http.StatusBadRequest, "invalid_request_body"
	}
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return true, 0, ""
	}
	if err := json.Unmarshal([]byte(trimmed), dst); err != nil {
		return false, http.StatusBadRequest, "invalid_json"
	}
	return true, 0, ""
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	if message == "" {
		message = code
	}
	writeJSON(w, status, map[string]any{
		"ok":      false,
		"error":   code,
		"message": message,
	})
}

func writeMethodNotAllowed(w http.ResponseWriter, allowed string) {
	w.Header().Set("Allow", allowed)
	writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "Method Not Allowed")
}

func writeConfigError(w http.ResponseWriter, err error) {
	status := configedit.HTTPStatus(err)
	code := "toolkit_request_failed"
	var te *configedit.ToolkitError
	if errors.As(err, &te) && te.Code != "" {
		code = te.Code
	}
	writeError(w, status, code, err.Error())
}

func serviceResultStatus(ok bool, errCode string, exitCode *int) int {
	if ok {
		return http.StatusOK
	}
	if exitCode != nil && *exitCode != 0 {
		return http.StatusBadGateway
	}
	switch errCode {
	case "confirmation_required":
		return http.StatusPreconditionRequired
	case "environment_action_timeout":
		return http.StatusGatewayTimeout
	case "environment_action_failed", "proxy_config_failed":
		return http.StatusBadGateway
	case "interactive_shell_action_unsupported":
		return http.StatusBadRequest
	}
	if strings.HasSuffix(errCode, "config_failed") {
		return http.StatusBadGateway
	}
	if strings.HasPrefix(errCode, "invalid_") || strings.HasPrefix(errCode, "unsupported_") {
		return http.StatusBadRequest
	}
	return http.StatusInternalServerError
}

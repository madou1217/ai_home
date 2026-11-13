package network

import (
	"context"
	"net/url"
	"os"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/hostexec"
	"github.com/madou1217/ai_home/internal/runtime/toolkit/environment"
)

const (
	proxyStatusTTL     = 15 * time.Second
	proxyCmdTimeout    = 4 * time.Second
	winInternetRegPath = `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`
)

// ServerProxyConfig 描述服务端保存的上游出口代理设置。
type ServerProxyConfig struct {
	ProxyURL string
	NoProxy  string
}

// ServerConfigReader 读取服务端当前的出口代理配置。
type ServerConfigReader interface {
	ReadProxyConfig(ctx context.Context) ServerProxyConfig
}

// GatewayProxyReport 描述网关出口代理诊断信息。
type GatewayProxyReport struct {
	Scope       string `json:"scope"`
	Source      string `json:"source"`
	ProbeStatus string `json:"probeStatus"`
	ProxyURL    string `json:"proxyUrl"`
	Redacted    bool   `json:"redacted"`
	NoProxy     string `json:"noProxy"`
}

// EnvProxyReport 描述当前进程环境变量代理配置。
type EnvProxyReport struct {
	Scope       string `json:"scope"`
	Source      string `json:"source"`
	ProbeStatus string `json:"probeStatus"`
	HTTPProxy   string `json:"httpProxy"`
	HTTPSProxy  string `json:"httpsProxy"`
	AllProxy    string `json:"allProxy"`
	NoProxy     string `json:"noProxy"`
}

// SystemProxyReport 描述操作系统级代理设置。
type SystemProxyReport struct {
	Platform    string   `json:"platform"`
	Scope       string   `json:"scope"`
	Source      string   `json:"source"`
	ProbeStatus string   `json:"probeStatus"`
	Enabled     bool     `json:"enabled"`
	HTTPProxy   string   `json:"httpProxy"`
	HTTPSProxy  string   `json:"httpsProxy"`
	SOCKSProxy  string   `json:"socksProxy"`
	BypassList  []string `json:"bypassList"`
}

// ToolTargetSummary 描述可配置的工具代理目标元数据。
type ToolTargetSummary struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	ScopeLabel string `json:"scopeLabel"`
}

// ScopedProxyEntry 描述 git --get-regexp proxy 读取到的条件/全局代理项。
type ScopedProxyEntry struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

// GitProxyReport 描述 Git 全局代理配置。
type GitProxyReport struct {
	Scope         string             `json:"scope"`
	Source        string             `json:"source"`
	ProbeStatus   string             `json:"probeStatus"`
	HTTPProxy     string             `json:"httpProxy"`
	HTTPSProxy    string             `json:"httpsProxy"`
	ScopedProxies []ScopedProxyEntry `json:"scopedProxies"`
}

// NPMProxyReport 描述 npm 用户级代理配置。
type NPMProxyReport struct {
	Scope       string `json:"scope"`
	Source      string `json:"source"`
	ProbeStatus string `json:"probeStatus"`
	HTTPProxy   string `json:"httpProxy"`
	HTTPSProxy  string `json:"httpsProxy"`
}

// ToolProxiesReport 描述所有受管工具的代理读结果。
type ToolProxiesReport struct {
	Git *GitProxyReport `json:"git,omitempty"`
	NPM *NPMProxyReport `json:"npm,omitempty"`
}

// ProxyStatusResponse 是 GET /v1/management/webui/toolkit/proxy 的响应体。
type ProxyStatusResponse struct {
	OK          bool                `json:"ok"`
	Gateway     GatewayProxyReport  `json:"gateway"`
	Env         EnvProxyReport      `json:"env"`
	System      SystemProxyReport   `json:"system"`
	ToolTargets []ToolTargetSummary `json:"toolTargets"`
	Tools       ToolProxiesReport   `json:"tools"`
	Stale       bool                `json:"stale,omitempty"`
}

// ProxyOperation 描述单条写命令的执行情况。
type ProxyOperation struct {
	Key      string `json:"key"`
	OK       bool   `json:"ok"`
	ExitCode *int   `json:"exitCode"`
	Stderr   string `json:"stderr"`
}

// SetToolProxyResult 是 POST /v1/management/webui/toolkit/proxy/set 的响应体。
type SetToolProxyResult struct {
	OK         bool             `json:"ok"`
	Error      *string          `json:"error,omitempty"`
	Message    string           `json:"message,omitempty"`
	Operations []ProxyOperation `json:"operations"`
	Git        *GitProxyReport  `json:"git,omitempty"`
	NPM        *NPMProxyReport  `json:"npm,omitempty"`
}

// Options 配置网络与代理管理器。
type Options struct {
	GOOS                string
	Exec                environment.Executor
	LookupEnv           func(string) string
	ServerConfig        ServerConfigReader
	ConnectivityTargets []ConnectivityTarget
	ConnectivityAdapter ConnectivityRequestAdapter
	ConnectivityTimeout time.Duration
	Now                 func() time.Time
}

// Manager 统一维护系统代理、工具代理、网络层及连通性探测。
type Manager struct {
	goos                string
	clientPlatform      string
	exec                environment.Executor
	lookupEnv           func(string) string
	serverConfig        ServerConfigReader
	connectivityTargets []ConnectivityTarget
	connAdapter         ConnectivityRequestAdapter
	connTimeout         time.Duration
	now                 func() time.Time

	proxyMu       sync.Mutex
	proxyCached   *ProxyStatusResponse
	proxyCachedAt time.Time
	proxyLoading  bool
	proxyCond     *sync.Cond

	layerMu       sync.Mutex
	layerCached   *NetworkLayerReport
	layerCachedAt time.Time
	layerLoading  bool
	layerCond     *sync.Cond

	connMu       sync.Mutex
	connCache    map[string]connectivityCacheEntry
	connInFlight map[string]*connectivityCall
}

// NewManager 创建网络代理管理器。
func NewManager(options Options) *Manager {
	goos := strings.ToLower(strings.TrimSpace(options.GOOS))
	if goos == "" {
		goos = runtime.GOOS
	}
	exec := options.Exec
	if exec == nil {
		exec = hostexec.Executor{}
	}
	lookupEnv := options.LookupEnv
	if lookupEnv == nil {
		lookupEnv = os.Getenv
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	targets := options.ConnectivityTargets
	if len(targets) == 0 {
		targets = DefaultConnectivityTargets
	}
	adapter := options.ConnectivityAdapter
	if adapter == nil {
		adapter = defaultConnectivityRequest
	}
	manager := &Manager{
		goos:                goos,
		clientPlatform:      normalizeClientPlatform(goos),
		exec:                exec,
		lookupEnv:           lookupEnv,
		serverConfig:        options.ServerConfig,
		connectivityTargets: targets,
		connAdapter:         adapter,
		connTimeout:         options.ConnectivityTimeout,
		now:                 now,
		connCache:           make(map[string]connectivityCacheEntry),
		connInFlight:        make(map[string]*connectivityCall),
	}
	manager.proxyCond = sync.NewCond(&manager.proxyMu)
	manager.layerCond = sync.NewCond(&manager.layerMu)
	return manager
}

func normalizeClientPlatform(goos string) string {
	switch goos {
	case "darwin", "macos":
		return "macos"
	case "windows", "win32":
		return "windows"
	default:
		return "linux"
	}
}

// ClearProxyCache 清空代理状态缓存。
func (manager *Manager) ClearProxyCache() {
	manager.proxyMu.Lock()
	defer manager.proxyMu.Unlock()
	manager.proxyCached = nil
	manager.proxyCachedAt = time.Time{}
}

// GetProxyStatus 获取完整的代理诊断视图，支持 15 秒 SWR 缓存。
func (manager *Manager) GetProxyStatus(ctx context.Context, forceRefresh bool) ProxyStatusResponse {
	if forceRefresh {
		return manager.refreshProxyStatus(ctx)
	}
	manager.proxyMu.Lock()
	if manager.proxyCached != nil {
		copyVal := *manager.proxyCached
		stale := manager.now().Sub(manager.proxyCachedAt) >= proxyStatusTTL
		shouldRefresh := stale && !manager.proxyLoading
		manager.proxyMu.Unlock()
		if shouldRefresh {
			go func() {
				bgCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				_ = manager.refreshProxyStatus(bgCtx)
			}()
		}
		if stale {
			copyVal.Stale = true
		}
		return copyVal
	}
	manager.proxyMu.Unlock()
	return manager.refreshProxyStatus(ctx)
}

func (manager *Manager) refreshProxyStatus(ctx context.Context) ProxyStatusResponse {
	manager.proxyMu.Lock()
	if manager.proxyLoading {
		for manager.proxyLoading {
			manager.proxyCond.Wait()
		}
		if manager.proxyCached != nil {
			res := *manager.proxyCached
			manager.proxyMu.Unlock()
			return res
		}
	}
	manager.proxyLoading = true
	manager.proxyMu.Unlock()

	value := manager.buildProxyStatus(ctx)

	manager.proxyMu.Lock()
	manager.proxyCached = &value
	manager.proxyCachedAt = manager.now()
	manager.proxyLoading = false
	manager.proxyCond.Broadcast()
	manager.proxyMu.Unlock()
	return value
}

func (manager *Manager) buildProxyStatus(ctx context.Context) ProxyStatusResponse {
	envReport := manager.buildEnvProxies()
	gatewayReport := manager.buildGatewayProxy(ctx)

	var (
		systemReport SystemProxyReport
		gitReport    GitProxyReport
		npmReport    NPMProxyReport
	)
	var group sync.WaitGroup
	group.Add(3)
	go func() {
		defer group.Done()
		systemReport = manager.DetectSystemProxy(ctx)
	}()
	go func() {
		defer group.Done()
		gitReport = manager.readGitProxy(ctx)
	}()
	go func() {
		defer group.Done()
		npmReport = manager.readNPMProxy(ctx)
	}()
	group.Wait()

	return ProxyStatusResponse{
		OK:      true,
		Gateway: gatewayReport,
		Env:     envReport,
		System:  systemReport,
		ToolTargets: []ToolTargetSummary{
			{ID: "git", Name: "Git", ScopeLabel: "全局 http.proxy / https.proxy"},
			{ID: "npm", Name: "npm", ScopeLabel: "用户级 proxy / https-proxy"},
		},
		Tools: ToolProxiesReport{
			Git: &gitReport,
			NPM: &npmReport,
		},
	}
}

func (manager *Manager) buildGatewayProxy(ctx context.Context) GatewayProxyReport {
	var cfg ServerProxyConfig
	if manager.serverConfig != nil {
		cfg = manager.serverConfig.ReadProxyConfig(ctx)
	}
	raw := strings.TrimSpace(cfg.ProxyURL)
	proxyURL := raw
	redacted := false
	if raw != "" {
		parsed, err := url.Parse(raw)
		if err != nil || parsed.Scheme == "" || parsed.Host == "" {
			proxyURL = "(无法解析的地址)"
			redacted = true
		} else if parsed.User != nil {
			parsed.User = nil
			rebuilt := strings.TrimRight(parsed.String(), "/")
			proxyURL = strings.Replace(rebuilt, "://", "://***@", 1)
			redacted = true
		}
	}
	probeStatus := "unset"
	if raw != "" {
		probeStatus = "available"
	}
	return GatewayProxyReport{
		Scope:       "aih-gateway-upstream",
		Source:      "server-config",
		ProbeStatus: probeStatus,
		ProxyURL:    proxyURL,
		Redacted:    redacted,
		NoProxy:     strings.TrimSpace(cfg.NoProxy),
	}
}

func (manager *Manager) buildEnvProxies() EnvProxyReport {
	httpProxy := firstNonEmpty(manager.lookupEnv("http_proxy"), manager.lookupEnv("HTTP_PROXY"))
	httpsProxy := firstNonEmpty(manager.lookupEnv("https_proxy"), manager.lookupEnv("HTTPS_PROXY"))
	allProxy := firstNonEmpty(manager.lookupEnv("all_proxy"), manager.lookupEnv("ALL_PROXY"))
	noProxy := firstNonEmpty(manager.lookupEnv("no_proxy"), manager.lookupEnv("NO_PROXY"))
	probeStatus := "unset"
	if httpProxy != "" || httpsProxy != "" || allProxy != "" {
		probeStatus = "available"
	}
	return EnvProxyReport{
		Scope:       "aih-server-process",
		Source:      "process.env",
		ProbeStatus: probeStatus,
		HTTPProxy:   httpProxy,
		HTTPSProxy:  httpsProxy,
		AllProxy:    allProxy,
		NoProxy:     noProxy,
	}
}

func (manager *Manager) readGitProxy(ctx context.Context) GitProxyReport {
	var httpRes, httpsRes, allRes environment.RunResult
	var group sync.WaitGroup
	group.Add(3)
	go func() {
		defer group.Done()
		httpRes = manager.exec.Run(ctx, "git", []string{"config", "--global", "http.proxy"}, environment.ExecOptions{Timeout: proxyCmdTimeout})
	}()
	go func() {
		defer group.Done()
		httpsRes = manager.exec.Run(ctx, "git", []string{"config", "--global", "https.proxy"}, environment.ExecOptions{Timeout: proxyCmdTimeout})
	}()
	go func() {
		defer group.Done()
		allRes = manager.exec.Run(ctx, "git", []string{"config", "--global", "--get-regexp", "proxy"}, environment.ExecOptions{Timeout: proxyCmdTimeout})
	}()
	group.Wait()

	globalHTTP := strings.TrimSpace(httpRes.Stdout)
	globalHTTPS := strings.TrimSpace(httpsRes.Stdout)
	scoped := []ScopedProxyEntry{}
	if lines := strings.TrimSpace(allRes.Stdout); lines != "" {
		for _, line := range strings.Split(lines, "\n") {
			fields := strings.Fields(strings.TrimSpace(line))
			if len(fields) >= 2 {
				scoped = append(scoped, ScopedProxyEntry{
					Key:   fields[0],
					Value: strings.Join(fields[1:], " "),
				})
			}
		}
	}
	probeStatus := "unset"
	if globalHTTP != "" || globalHTTPS != "" || len(scoped) > 0 {
		probeStatus = "available"
	}
	return GitProxyReport{
		Scope:         "global",
		Source:        "git-config",
		ProbeStatus:   probeStatus,
		HTTPProxy:     globalHTTP,
		HTTPSProxy:    globalHTTPS,
		ScopedProxies: scoped,
	}
}

func (manager *Manager) readNPMProxy(ctx context.Context) NPMProxyReport {
	var proxyRes, httpsRes environment.RunResult
	var group sync.WaitGroup
	group.Add(2)
	go func() {
		defer group.Done()
		proxyRes = manager.exec.Run(ctx, "npm", []string{"config", "get", "proxy"}, environment.ExecOptions{Timeout: proxyCmdTimeout})
	}()
	go func() {
		defer group.Done()
		httpsRes = manager.exec.Run(ctx, "npm", []string{"config", "get", "https-proxy"}, environment.ExecOptions{Timeout: proxyCmdTimeout})
	}()
	group.Wait()

	httpVal := cleanNPMProxyValue(proxyRes.Stdout)
	httpsVal := cleanNPMProxyValue(httpsRes.Stdout)
	probeStatus := "unset"
	if httpVal != "" || httpsVal != "" {
		probeStatus = "available"
	}
	return NPMProxyReport{
		Scope:       "user-config",
		Source:      "npm-config",
		ProbeStatus: probeStatus,
		HTTPProxy:   httpVal,
		HTTPSProxy:  httpsVal,
	}
}

func cleanNPMProxyValue(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || trimmed == "null" {
		return ""
	}
	return trimmed
}

// SetToolProxy 设置或清除受管工具（git / npm）的代理地址。
func (manager *Manager) SetToolProxy(ctx context.Context, target string, proxyURL string) SetToolProxyResult {
	kind := strings.ToLower(strings.TrimSpace(target))
	if kind != "git" && kind != "npm" {
		errCode := "unsupported_proxy_target"
		return SetToolProxyResult{OK: false, Error: &errCode, Operations: []ProxyOperation{}}
	}
	norm := strings.TrimSpace(proxyURL)
	if norm != "" && ParseProxyURL(norm, false) == nil {
		errCode := "invalid_proxy_url"
		return SetToolProxyResult{OK: false, Error: &errCode, Operations: []ProxyOperation{}}
	}

	type opSpec struct {
		key          string
		args         []string
		allowMissing bool
	}
	var specs []opSpec
	var bin string
	switch kind {
	case "git":
		bin = "git"
		if norm != "" {
			specs = []opSpec{
				{key: "http.proxy", args: []string{"config", "--global", "http.proxy", norm}},
				{key: "https.proxy", args: []string{"config", "--global", "https.proxy", norm}},
			}
		} else {
			specs = []opSpec{
				{key: "http.proxy", args: []string{"config", "--global", "--unset", "http.proxy"}, allowMissing: true},
				{key: "https.proxy", args: []string{"config", "--global", "--unset", "https.proxy"}, allowMissing: true},
			}
		}
	case "npm":
		bin = "npm"
		if norm != "" {
			specs = []opSpec{
				{key: "proxy", args: []string{"config", "set", "proxy", norm}},
				{key: "https-proxy", args: []string{"config", "set", "https-proxy", norm}},
			}
		} else {
			specs = []opSpec{
				{key: "proxy", args: []string{"config", "delete", "proxy"}},
				{key: "https-proxy", args: []string{"config", "delete", "https-proxy"}},
			}
		}
	}

	operations := make([]ProxyOperation, 0, len(specs))
	var failed *ProxyOperation
	for _, spec := range specs {
		res := manager.exec.Run(ctx, bin, spec.args, environment.ExecOptions{Timeout: proxyCmdTimeout})
		ok := res.OK || (spec.allowMissing && res.ExitCode != nil && *res.ExitCode == 5)
		op := ProxyOperation{
			Key:      spec.key,
			OK:       ok,
			ExitCode: res.ExitCode,
			Stderr:   strings.TrimSpace(res.Stderr),
		}
		if !ok && failed == nil {
			opCopy := op
			failed = &opCopy
		}
		operations = append(operations, op)
	}
	manager.ClearProxyCache()

	out := SetToolProxyResult{
		OK:         failed == nil,
		Operations: operations,
	}
	if failed != nil {
		errCode := "proxy_config_failed"
		out.Error = &errCode
		out.Message = failed.Stderr
		if out.Message == "" {
			out.Message = failed.Key + " 配置失败"
		}
	}
	if kind == "git" {
		gitRep := manager.readGitProxy(ctx)
		out.Git = &gitRep
	} else if kind == "npm" {
		if out.OK {
			out.NPM = &NPMProxyReport{HTTPProxy: norm, HTTPSProxy: norm}
		} else {
			npmRep := manager.readNPMProxy(ctx)
			out.NPM = &NPMProxyReport{HTTPProxy: npmRep.HTTPProxy, HTTPSProxy: npmRep.HTTPSProxy}
		}
	}
	return out
}

// DetectSystemProxy 只读探测宿主操作系统的系统代理设置。
func (manager *Manager) DetectSystemProxy(ctx context.Context) SystemProxyReport {
	base := SystemProxyReport{
		Platform:    manager.goos,
		Scope:       "operating-system",
		Source:      "none",
		ProbeStatus: "unsupported",
		BypassList:  []string{},
	}
	switch manager.goos {
	case "darwin":
		return manager.detectMacSystemProxy(ctx, base)
	case "linux":
		return manager.detectLinuxSystemProxy(ctx, base)
	case "windows":
		return manager.detectWindowsSystemProxy(ctx, base)
	default:
		return base
	}
}

var (
	reScutilHTTPEnable   = regexp.MustCompile(`(?i)HTTPEnable\s*:\s*1`)
	reScutilHTTPSEnable  = regexp.MustCompile(`(?i)HTTPSEnable\s*:\s*1`)
	reScutilSOCKSEnable  = regexp.MustCompile(`(?i)SOCKSEnable\s*:\s*1`)
	reScutilHTTPProxy    = regexp.MustCompile(`(?i)HTTPProxy\s*:\s*([^\s\n]+)`)
	reScutilHTTPPort     = regexp.MustCompile(`(?i)HTTPPort\s*:\s*(\d+)`)
	reScutilHTTPSProxy   = regexp.MustCompile(`(?i)HTTPSProxy\s*:\s*([^\s\n]+)`)
	reScutilHTTPSPort    = regexp.MustCompile(`(?i)HTTPSPort\s*:\s*(\d+)`)
	reScutilSOCKSProxy   = regexp.MustCompile(`(?i)SOCKSProxy\s*:\s*([^\s\n]+)`)
	reScutilSOCKSPort    = regexp.MustCompile(`(?i)SOCKSPort\s*:\s*(\d+)`)
	reMacExceptionsBlock = regexp.MustCompile(`(?is)ExceptionsList\s*:\s*<array>\s*\{([\s\S]*?)\}`)
	reMacExceptionItem   = regexp.MustCompile(`(?m)^\s*\d+\s*:\s*(.+?)\s*$`)
	reServiceOrderLine   = regexp.MustCompile(`^\(\d+\)\s+(.+?)\s*$`)
	reServiceDisabled    = regexp.MustCompile(`^\s*\(\*\)\s+(.+?)\s*$`)
	reEnabledYes         = regexp.MustCompile(`(?i)Enabled:\s*Yes`)
	reServerHost         = regexp.MustCompile(`(?i)Server:\s*(\S+)`)
	reServerPort         = regexp.MustCompile(`(?i)Port:\s*(\d+)`)
)

func (manager *Manager) detectMacSystemProxy(ctx context.Context, report SystemProxyReport) SystemProxyReport {
	report.Source = "scutil --proxy"
	var (
		scutilRes  environment.RunResult
		serviceRes *macServiceProxy
	)
	var group sync.WaitGroup
	group.Add(2)
	go func() {
		defer group.Done()
		scutilRes = manager.exec.Run(ctx, "scutil", []string{"--proxy"}, environment.ExecOptions{Timeout: proxyCmdTimeout})
	}()
	go func() {
		defer group.Done()
		serviceRes = manager.detectMacServiceProxy(ctx)
	}()
	group.Wait()

	applyMacScutil(&report, scutilRes)
	if !report.Enabled && serviceRes != nil {
		report.Source = "networksetup -getwebproxy"
		report.Enabled = true
		report.ProbeStatus = "available"
		report.HTTPProxy = serviceRes.HTTPProxy
		report.HTTPSProxy = serviceRes.HTTPSProxy
		report.SOCKSProxy = serviceRes.SOCKSProxy
		report.BypassList = serviceRes.BypassList
	}
	return report
}

func applyMacScutil(report *SystemProxyReport, res environment.RunResult) {
	if res.OK && strings.TrimSpace(res.Stdout) != "" {
		out := res.Stdout
		httpEnabled := reScutilHTTPEnable.MatchString(out)
		httpsEnabled := reScutilHTTPSEnable.MatchString(out)
		socksEnabled := reScutilSOCKSEnable.MatchString(out)
		report.Enabled = httpEnabled || httpsEnabled || socksEnabled
		if report.Enabled {
			report.ProbeStatus = "available"
		} else {
			report.ProbeStatus = "unset"
		}
		if httpEnabled {
			if h, p := match1(reScutilHTTPProxy, out), match1(reScutilHTTPPort, out); h != "" && p != "" {
				report.HTTPProxy = "http://" + h + ":" + p
			}
		}
		if httpsEnabled {
			if h, p := match1(reScutilHTTPSProxy, out), match1(reScutilHTTPSPort, out); h != "" && p != "" {
				report.HTTPSProxy = "http://" + h + ":" + p
			}
		}
		if socksEnabled {
			if h, p := match1(reScutilSOCKSProxy, out), match1(reScutilSOCKSPort, out); h != "" && p != "" {
				report.SOCKSProxy = "socks5://" + h + ":" + p
			}
		}
		report.BypassList = parseMacBypassList(out)
		return
	}
	if res.OK {
		report.ProbeStatus = "unset"
		return
	}
	if isCommandUnavailable(res) {
		report.ProbeStatus = "unsupported"
	} else {
		report.ProbeStatus = "error"
	}
}

func parseMacBypassList(text string) []string {
	block := reMacExceptionsBlock.FindStringSubmatch(text)
	if len(block) < 2 {
		return []string{}
	}
	matches := reMacExceptionItem.FindAllStringSubmatch(block[1], -1)
	out := make([]string, 0, len(matches))
	for _, m := range matches {
		if len(m) >= 2 && strings.TrimSpace(m[1]) != "" {
			out = append(out, strings.TrimSpace(m[1]))
		}
	}
	return out
}

type macServiceProxy struct {
	HTTPProxy  string
	HTTPSProxy string
	SOCKSProxy string
	BypassList []string
}

func (manager *Manager) detectMacServiceProxy(ctx context.Context) *macServiceProxy {
	orderRes := manager.exec.Run(ctx, "networksetup", []string{"-listnetworkserviceorder"}, environment.ExecOptions{Timeout: proxyCmdTimeout})
	if !orderRes.OK || strings.TrimSpace(orderRes.Stdout) == "" {
		return nil
	}
	services := parseMacServiceOrder(orderRes.Stdout)
	if len(services) == 0 {
		return nil
	}
	commands := []string{"-getwebproxy", "-getsecurewebproxy", "-getsocksfirewallproxy", "-getproxybypassdomains"}
	results := make([][]environment.RunResult, len(services))
	var group sync.WaitGroup
	for svcIdx, serviceName := range services {
		results[svcIdx] = make([]environment.RunResult, len(commands))
		for cmdIdx, command := range commands {
			group.Add(1)
			go func(si, ci int, sName, cmd string) {
				defer group.Done()
				results[si][ci] = manager.exec.Run(ctx, "networksetup", []string{cmd, sName}, environment.ExecOptions{Timeout: proxyCmdTimeout})
			}(svcIdx, cmdIdx, serviceName, command)
		}
	}
	group.Wait()

	combined := &macServiceProxy{BypassList: []string{}}
	for svcIdx := range services {
		for cmdIdx, target := range []struct {
			key    *string
			scheme string
		}{
			{&combined.HTTPProxy, "http"},
			{&combined.HTTPSProxy, "http"},
			{&combined.SOCKSProxy, "socks5"},
		} {
			res := results[svcIdx][cmdIdx]
			if !res.OK || !reEnabledYes.MatchString(res.Stdout) || *target.key != "" {
				continue
			}
			host := match1(reServerHost, res.Stdout)
			port := match1(reServerPort, res.Stdout)
			if host != "" && port != "" {
				*target.key = target.scheme + "://" + host + ":" + port
			}
		}
		if len(combined.BypassList) == 0 {
			bypassRes := results[svcIdx][3]
			if bypassRes.OK && strings.TrimSpace(bypassRes.Stdout) != "" &&
				!strings.Contains(strings.ToLower(bypassRes.Stdout), "there aren't any bypass domains") {
				for _, line := range strings.Split(bypassRes.Stdout, "\n") {
					if trimmed := strings.TrimSpace(line); trimmed != "" {
						combined.BypassList = append(combined.BypassList, trimmed)
					}
				}
			}
		}
	}
	if combined.HTTPProxy == "" && combined.HTTPSProxy == "" && combined.SOCKSProxy == "" {
		return nil
	}
	return combined
}

func parseMacServiceOrder(stdout string) []string {
	type svcEntry struct {
		name     string
		disabled bool
	}
	var entries []svcEntry
	for _, line := range strings.Split(stdout, "\n") {
		if m := reServiceOrderLine.FindStringSubmatch(line); len(m) >= 2 {
			entries = append(entries, svcEntry{name: strings.TrimSpace(m[1])})
		} else if reServiceDisabled.MatchString(line) && len(entries) > 0 {
			entries[len(entries)-1].disabled = true
		}
	}
	out := make([]string, 0, len(entries))
	for _, item := range entries {
		if item.name != "" && !item.disabled {
			out = append(out, item.name)
		}
	}
	return out
}

func (manager *Manager) detectLinuxSystemProxy(ctx context.Context, report SystemProxyReport) SystemProxyReport {
	report.Source = "gsettings"
	modeRes := manager.exec.Run(ctx, "gsettings", []string{"get", "org.gnome.system.proxy", "mode"}, environment.ExecOptions{Timeout: proxyCmdTimeout})
	if !modeRes.OK {
		if isCommandUnavailable(modeRes) {
			report.ProbeStatus = "unsupported"
		} else {
			report.ProbeStatus = "error"
		}
		return report
	}
	report.ProbeStatus = "unset"
	if strings.Contains(modeRes.Stdout, "manual") {
		hostRes := manager.exec.Run(ctx, "gsettings", []string{"get", "org.gnome.system.proxy.http", "host"}, environment.ExecOptions{Timeout: proxyCmdTimeout})
		portRes := manager.exec.Run(ctx, "gsettings", []string{"get", "org.gnome.system.proxy.http", "port"}, environment.ExecOptions{Timeout: proxyCmdTimeout})
		if !hostRes.OK || !portRes.OK {
			report.ProbeStatus = "error"
			return report
		}
		host := strings.TrimSpace(strings.ReplaceAll(hostRes.Stdout, "'", ""))
		port := strings.TrimSpace(portRes.Stdout)
		if host != "" && port != "" && port != "0" {
			report.Enabled = true
			report.ProbeStatus = "available"
			report.HTTPProxy = "http://" + host + ":" + port
		}
	}
	return report
}

func (manager *Manager) detectWindowsSystemProxy(ctx context.Context, report SystemProxyReport) SystemProxyReport {
	report.Source = "windows-registry"
	res := manager.exec.Run(ctx, "reg.exe", []string{"query", winInternetRegPath}, environment.ExecOptions{Timeout: proxyCmdTimeout})
	if !res.OK {
		if isCommandUnavailable(res) {
			report.ProbeStatus = "error"
		} else {
			report.ProbeStatus = "unset"
		}
		return report
	}
	enableRaw := parseWindowsRegistryValue(res.Stdout, "ProxyEnable")
	enableNum, err := strconv.ParseInt(strings.TrimPrefix(strings.ToLower(enableRaw), "0x"), 16, 64)
	if err != nil {
		enableNum, _ = strconv.ParseInt(enableRaw, 0, 64)
	}
	if enableNum != 1 {
		report.ProbeStatus = "unset"
		return report
	}
	proxies := parseWindowsProxyServer(parseWindowsRegistryValue(res.Stdout, "ProxyServer"))
	if proxies["HTTP_PROXY"] == "" && proxies["HTTPS_PROXY"] == "" && proxies["ALL_PROXY"] == "" {
		report.ProbeStatus = "unset"
		return report
	}
	report.Enabled = true
	report.ProbeStatus = "available"
	report.HTTPProxy = proxies["HTTP_PROXY"]
	report.HTTPSProxy = proxies["HTTPS_PROXY"]
	report.SOCKSProxy = proxies["ALL_PROXY"]
	return report
}

func parseWindowsRegistryValue(output string, name string) string {
	re := regexp.MustCompile(`(?im)^\s*` + regexp.QuoteMeta(name) + `\s+REG_\w+\s+(.+?)\s*$`)
	match := re.FindStringSubmatch(output)
	if len(match) < 2 {
		return ""
	}
	return strings.TrimSpace(match[1])
}

func normalizeWindowsProxyValue(raw string, scheme string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	if strings.Contains(trimmed, "://") {
		return trimmed
	}
	return scheme + "://" + trimmed
}

func parseWindowsProxyServer(raw string) map[string]string {
	trimmed := strings.TrimSpace(raw)
	out := map[string]string{}
	if trimmed == "" {
		return out
	}
	if !strings.Contains(trimmed, "=") {
		proxyURL := normalizeWindowsProxyValue(trimmed, "http")
		if proxyURL != "" {
			out["HTTP_PROXY"] = proxyURL
			out["HTTPS_PROXY"] = proxyURL
		}
		return out
	}
	for _, seg := range strings.Split(trimmed, ";") {
		idx := strings.IndexByte(seg, '=')
		if idx <= 0 {
			continue
		}
		proto := strings.ToLower(strings.TrimSpace(seg[:idx]))
		addr := strings.TrimSpace(seg[idx+1:])
		if addr == "" {
			continue
		}
		switch proto {
		case "http":
			out["HTTP_PROXY"] = normalizeWindowsProxyValue(addr, "http")
		case "https":
			out["HTTPS_PROXY"] = normalizeWindowsProxyValue(addr, "http")
		case "socks", "socks5":
			out["ALL_PROXY"] = normalizeWindowsProxyValue(addr, "socks5")
		}
	}
	if out["HTTPS_PROXY"] == "" && out["HTTP_PROXY"] != "" {
		out["HTTPS_PROXY"] = out["HTTP_PROXY"]
	}
	return out
}

func match1(re *regexp.Regexp, input string) string {
	m := re.FindStringSubmatch(input)
	if len(m) < 2 {
		return ""
	}
	return strings.TrimSpace(m[1])
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func isCommandUnavailable(res environment.RunResult) bool {
	if res.SpawnFailed || res.ExitCode == nil {
		return true
	}
	if *res.ExitCode == 127 {
		return true
	}
	lower := strings.ToLower(res.Stderr + " " + res.Message)
	return strings.Contains(lower, "not found") ||
		strings.Contains(lower, "not recognized") ||
		strings.Contains(lower, "enoent")
}

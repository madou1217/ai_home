package mirrors

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/hostexec"
	"github.com/madou1217/ai_home/internal/runtime/toolkit/environment"
)

const (
	mirrorsStatusTTL   = 15 * time.Second
	commandTimeout     = 4 * time.Second
	defaultPingTimeout = 3 * time.Second
	minPingTimeout     = 250 * time.Millisecond
	maxPingTimeout     = 15 * time.Second
	maxURLLength       = 2048
)

// MirrorDetail 描述单一软件源插件的当前配置、预置源和命令指南。
type MirrorDetail struct {
	Current string            `json:"current"`
	Presets []Preset          `json:"presets"`
	Guides  MaterializedGuide `json:"guides"`
}

// StatusResponse 是 GET /v1/management/webui/toolkit/mirrors 的返回结构。
type StatusResponse struct {
	OK       bool          `json:"ok"`
	Platform string        `json:"platform"`
	Kinds    []KindSummary `json:"kinds"`
	NPM      *MirrorDetail `json:"npm,omitempty"`
	PIP      *MirrorDetail `json:"pip,omitempty"`
	Stale    bool          `json:"stale,omitempty"`
}

// WriteResult 是 POST /v1/management/webui/toolkit/mirrors/set 的返回结构。
type WriteResult struct {
	OK       bool   `json:"ok"`
	Registry string `json:"registry,omitempty"`
	IndexURL string `json:"indexUrl,omitempty"`
	Error    string `json:"error,omitempty"`
	ExitCode *int   `json:"exitCode,omitempty"`
}

// PingResult 是 POST /v1/management/webui/toolkit/mirrors/ping 的返回结构。
type PingResult struct {
	OK          bool    `json:"ok"`
	LatencyMs   int64   `json:"latencyMs"`
	StatusCode  *int    `json:"statusCode"`
	Measurement string  `json:"measurement"`
	Route       string  `json:"route"`
	Error       *string `json:"error"`
}

// RequestAdapter 允许测试注入 HTTP 探测适配器。
type RequestAdapter func(ctx context.Context, targetURL string, timeout time.Duration) (int, error)

// ResolveHostFunc 允许测试注入 DNS 解析器。
type ResolveHostFunc func(ctx context.Context, host string) ([]string, error)

// Options 配置 Manager 行为。
type Options struct {
	Platform       string
	Exec           environment.Executor
	Now            func() time.Time
	RequestAdapter RequestAdapter
	ResolveHost    ResolveHostFunc
	PingTimeout    time.Duration
}

// Manager 管理软件源读写、缓存和测速探测。
type Manager struct {
	platform       string
	exec           environment.Executor
	now            func() time.Time
	requestAdapter RequestAdapter
	resolveHost    ResolveHostFunc
	pingTimeout    time.Duration

	mu       sync.Mutex
	cached   *StatusResponse
	cachedAt time.Time
	inFlight *sync.Cond
	loading  bool
}

// NewManager 创建软件源管理器。
func NewManager(options Options) *Manager {
	platform := options.Platform
	if platform == "" {
		platform = normalizePlatform(runtime.GOOS)
	} else {
		platform = normalizePlatform(platform)
	}
	exec := options.Exec
	if exec == nil {
		exec = hostexec.Executor{}
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	resolveHost := options.ResolveHost
	if resolveHost == nil {
		resolveHost = defaultResolveHost
	}
	manager := &Manager{
		platform:    platform,
		exec:        exec,
		now:         now,
		resolveHost: resolveHost,
		pingTimeout: options.PingTimeout,
	}
	if options.RequestAdapter != nil {
		manager.requestAdapter = options.RequestAdapter
	} else {
		manager.requestAdapter = manager.defaultRequestAdapter
	}
	manager.inFlight = sync.NewCond(&manager.mu)
	return manager
}

// NPMRegistry 返回当前生效的 npm registry；读不到时返回空串（调用方回落官方源）。
//
// 工具箱的 npm 安装计划会用它替换写死的 registry：镜像设置是宿主网络的一部分，
// 安装计划必须跟随它，否则「镜像已配置」和「安装仍走官方源」会互相矛盾。
func (manager *Manager) NPMRegistry(ctx context.Context) string {
	if manager == nil {
		return ""
	}
	status := manager.GetStatus(ctx, false)
	if status.NPM == nil {
		return ""
	}
	return strings.TrimSpace(status.NPM.Current)
}

// ClearCache 清空 15 秒状态缓存。
func (manager *Manager) ClearCache() {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	manager.cached = nil
	manager.cachedAt = time.Time{}
}

// GetStatus 获取所有软件源配置状态，支持 15 秒 SWR 缓存。
func (manager *Manager) GetStatus(ctx context.Context, forceRefresh bool) StatusResponse {
	if forceRefresh {
		return manager.refreshStatus(ctx)
	}
	manager.mu.Lock()
	if manager.cached != nil {
		copyValue := *manager.cached
		stale := manager.now().Sub(manager.cachedAt) >= mirrorsStatusTTL
		shouldRefresh := stale && !manager.loading
		manager.mu.Unlock()
		if shouldRefresh {
			go func() {
				bgCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				_ = manager.refreshStatus(bgCtx)
			}()
		}
		if stale {
			copyValue.Stale = true
		}
		return copyValue
	}
	manager.mu.Unlock()
	return manager.refreshStatus(ctx)
}

func (manager *Manager) refreshStatus(ctx context.Context) StatusResponse {
	manager.mu.Lock()
	if manager.loading {
		for manager.loading {
			manager.inFlight.Wait()
		}
		if manager.cached != nil {
			res := *manager.cached
			manager.mu.Unlock()
			return res
		}
	}
	manager.loading = true
	manager.mu.Unlock()

	value := manager.buildStatus(ctx)

	manager.mu.Lock()
	manager.cached = &value
	manager.cachedAt = manager.now()
	manager.loading = false
	manager.inFlight.Broadcast()
	manager.mu.Unlock()
	return value
}

func (manager *Manager) buildStatus(ctx context.Context) StatusResponse {
	plugins := make([]PluginDef, 0, len(mirrorPlugins))
	for _, plugin := range mirrorPlugins {
		if containsString(plugin.Platforms, manager.platform) {
			plugins = append(plugins, plugin)
		}
	}
	kinds := make([]KindSummary, len(plugins))
	for index, plugin := range plugins {
		kinds[index] = KindSummary{
			ID:           plugin.ID,
			Name:         plugin.Name,
			Label:        plugin.Label,
			SettingLabel: plugin.SettingLabel,
		}
	}
	currents := make([]string, len(plugins))
	var group sync.WaitGroup
	group.Add(len(plugins))
	for index, plugin := range plugins {
		go func(idx int, id string) {
			defer group.Done()
			currents[idx] = manager.readCurrent(ctx, id)
		}(index, plugin.ID)
	}
	group.Wait()

	response := StatusResponse{
		OK:       true,
		Platform: manager.platform,
		Kinds:    kinds,
	}
	for index, plugin := range plugins {
		detail := describeMirror(plugin, manager.platform, currents[index])
		switch plugin.ID {
		case "npm":
			response.NPM = &detail
		case "pip":
			response.PIP = &detail
		}
	}
	return response
}

func (manager *Manager) readCurrent(ctx context.Context, mirrorID string) string {
	switch mirrorID {
	case "npm":
		res := manager.exec.Run(ctx, "npm", []string{"config", "get", "registry"}, environment.ExecOptions{Timeout: commandTimeout})
		if !res.OK {
			return ""
		}
		return strings.TrimRight(strings.TrimSpace(res.Stdout), "/")
	case "pip":
		res := manager.exec.Run(ctx, "pip", []string{"config", "get", "global.index-url"}, environment.ExecOptions{Timeout: commandTimeout})
		if res.OK && strings.TrimSpace(res.Stdout) != "" {
			return strings.TrimSpace(res.Stdout)
		}
		res3 := manager.exec.Run(ctx, "pip3", []string{"config", "get", "global.index-url"}, environment.ExecOptions{Timeout: commandTimeout})
		if res3.OK {
			return strings.TrimSpace(res3.Stdout)
		}
		return ""
	default:
		return ""
	}
}

// SetMirror 设置指定类型（npm 或 pip）的软件源地址。
func (manager *Manager) SetMirror(ctx context.Context, mirrorType string, rawURL string) WriteResult {
	kind := strings.ToLower(strings.TrimSpace(mirrorType))
	var plugin *PluginDef
	for index := range mirrorPlugins {
		if mirrorPlugins[index].ID == kind && containsString(mirrorPlugins[index].Platforms, manager.platform) {
			plugin = &mirrorPlugins[index]
			break
		}
	}
	if plugin == nil {
		return WriteResult{OK: false, Error: "unsupported_mirror_type"}
	}
	parsed := parseHTTPURL(rawURL)
	if parsed == nil {
		return WriteResult{OK: false, Error: "invalid_url"}
	}
	norm := parsed.String()
	var result WriteResult
	switch kind {
	case "npm":
		res := manager.exec.Run(ctx, "npm", []string{"config", "set", "registry", norm}, environment.ExecOptions{Timeout: commandTimeout})
		if res.OK {
			result = WriteResult{OK: true, Registry: manager.readCurrent(ctx, "npm"), ExitCode: res.ExitCode}
		} else {
			errMsg := firstNonEmpty(res.Stderr, res.Message, "npm_config_failed")
			result = WriteResult{OK: false, Registry: "", Error: errMsg, ExitCode: res.ExitCode}
		}
	case "pip":
		res := manager.exec.Run(ctx, "pip", []string{"config", "set", "global.index-url", norm}, environment.ExecOptions{Timeout: commandTimeout})
		if res.OK {
			result = WriteResult{OK: true, IndexURL: manager.readCurrent(ctx, "pip"), ExitCode: res.ExitCode}
		} else if isCommandUnavailable(res) {
			res3 := manager.exec.Run(ctx, "pip3", []string{"config", "set", "global.index-url", norm}, environment.ExecOptions{Timeout: commandTimeout})
			if res3.OK {
				result = WriteResult{OK: true, IndexURL: manager.readCurrent(ctx, "pip"), ExitCode: res3.ExitCode}
			} else {
				errMsg := firstNonEmpty(res3.Stderr, res3.Message, res.Stderr, res.Message, "pip_config_failed")
				result = WriteResult{OK: false, IndexURL: "", Error: errMsg, ExitCode: res3.ExitCode}
			}
		} else {
			errMsg := firstNonEmpty(res.Stderr, res.Message, "pip_config_failed")
			result = WriteResult{OK: false, IndexURL: "", Error: errMsg, ExitCode: res.ExitCode}
		}
	}
	manager.ClearCache()
	return result
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

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

// Ping 测试镜像源地址的 HEAD 响应延迟，执行前通过 SSRF URL 策略校验。
func (manager *Manager) Ping(ctx context.Context, rawURL string) PingResult {
	parsed := parseHTTPURL(rawURL)
	if parsed == nil {
		msg := "invalid_url"
		return PingResult{
			OK:          false,
			LatencyMs:   -1,
			StatusCode:  nil,
			Measurement: "ttfb",
			Route:       "direct",
			Error:       &msg,
		}
	}
	timeout := manager.pingTimeout
	if timeout <= 0 {
		timeout = defaultPingTimeout
	}
	if timeout < minPingTimeout {
		timeout = minPingTimeout
	}
	if timeout > maxPingTimeout {
		timeout = maxPingTimeout
	}

	start := manager.now()
	probeCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	statusCode, err := manager.requestAdapter(probeCtx, parsed.String(), timeout)
	if err != nil {
		errText := err.Error()
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(probeCtx.Err(), context.DeadlineExceeded) {
			errText = "timeout"
		}
		return PingResult{
			OK:          false,
			LatencyMs:   -1,
			StatusCode:  nil,
			Measurement: "ttfb",
			Route:       "direct",
			Error:       &errText,
		}
	}
	ok := statusCode >= 200 && statusCode < 400
	var codePtr *int
	if statusCode > 0 {
		code := statusCode
		codePtr = &code
	}
	var errPtr *string
	if !ok {
		msg := "http_status_unknown"
		if statusCode > 0 {
			msg = fmt.Sprintf("http_status_%d", statusCode)
		}
		errPtr = &msg
	}
	return PingResult{
		OK:          ok,
		LatencyMs:   manager.now().Sub(start).Milliseconds(),
		StatusCode:  codePtr,
		Measurement: "ttfb",
		Route:       "direct",
		Error:       errPtr,
	}
}

func describeMirror(plugin PluginDef, platform string, current string) MirrorDetail {
	guide := guideForPlatform(plugin.Guide, platform)
	guideURL := plugin.Presets[0].URL
	if parseHTTPURL(current) != nil {
		guideURL = current
	}
	presets := make([]Preset, len(plugin.Presets))
	for index, preset := range plugin.Presets {
		mat := materializeGuide(guide, preset.URL)
		presetCopy := preset
		presetCopy.Active = isActivePreset(current, preset)
		presetCopy.Guides = &mat
		presets[index] = presetCopy
	}
	return MirrorDetail{
		Current: current,
		Presets: presets,
		Guides:  materializeGuide(guide, guideURL),
	}
}

func isActivePreset(current string, preset Preset) bool {
	if current == "" {
		return false
	}
	needle := strings.TrimPrefix(preset.URL, "https://")
	needle = strings.TrimPrefix(needle, "http://")
	needle = strings.TrimSuffix(needle, "/")
	return needle != "" && strings.Contains(current, needle)
}

func guideForPlatform(guide Guide, platform string) Guide {
	commands := make([]GuideCommand, 0, len(guide.Commands))
	for _, cmd := range guide.Commands {
		if platform == "" || len(cmd.Platforms) == 0 || containsString(cmd.Platforms, platform) {
			commands = append(commands, GuideCommand{
				Platform: cmd.Platform,
				Label:    cmd.Label,
				Cmd:      cmd.Cmd,
			})
		}
	}
	return Guide{Title: guide.Title, Commands: commands}
}

func materializeGuide(guide Guide, targetURL string) MaterializedGuide {
	parsed := parseHTTPURL(targetURL)
	if parsed == nil {
		return MaterializedGuide{Title: guide.Title, Commands: []GuideCommand{}}
	}
	raw := parsed.String()
	escapedURL := escapeCommandURL(raw)
	quotedURLBytes, _ := json.Marshal(escapedURL)
	quotedHostBytes, _ := json.Marshal(parsed.Hostname())
	quotedURL := string(quotedURLBytes)
	quotedHost := string(quotedHostBytes)

	commands := make([]GuideCommand, len(guide.Commands))
	for index, cmd := range guide.Commands {
		cmdCopy := cmd
		cmdCopy.Cmd = strings.ReplaceAll(strings.ReplaceAll(cmd.Cmd, "<URL>", quotedURL), "<HOST>", quotedHost)
		commands[index] = cmdCopy
	}
	return MaterializedGuide{
		Title:      guide.Title,
		SourceURL:  raw,
		SourceHost: parsed.Hostname(),
		Commands:   commands,
	}
}

func escapeCommandURL(raw string) string {
	var builder strings.Builder
	builder.Grow(len(raw))
	for _, ch := range raw {
		switch ch {
		case '!', '$', '\'', '(', ')', ';', '`', '|', '<', '>':
			fmt.Fprintf(&builder, "%%%02X", ch)
		default:
			builder.WriteRune(ch)
		}
	}
	return builder.String()
}

func parseHTTPURL(raw string) *url.URL {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || len(trimmed) > maxURLLength {
		return nil
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return nil
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "http" && scheme != "https" {
		return nil
	}
	if parsed.Host == "" || parsed.User != nil {
		return nil
	}
	return parsed
}

var (
	blockedCIDRs = buildBlockedPrefixes()
	fakeIPCIDR   = netip.MustParsePrefix("198.18.0.0/15")
)

func buildBlockedPrefixes() []netip.Prefix {
	cidrs := []string{
		"0.0.0.0/8",
		"10.0.0.0/8",
		"100.64.0.0/10",
		"127.0.0.0/8",
		"169.254.0.0/16",
		"172.16.0.0/12",
		"192.0.0.0/24",
		"192.0.2.0/24",
		"192.88.99.0/24",
		"192.168.0.0/16",
		"198.18.0.0/15",
		"198.51.100.0/24",
		"203.0.113.0/24",
		"224.0.0.0/4",
		"240.0.0.0/4",
		"::/128",
		"::1/128",
		"64:ff9b::/96",
		"100::/64",
		"2001:db8::/32",
		"fc00::/7",
		"fe80::/10",
		"fec0::/10",
		"ff00::/8",
	}
	prefixes := make([]netip.Prefix, 0, len(cidrs))
	for _, item := range cidrs {
		prefixes = append(prefixes, netip.MustParsePrefix(item))
	}
	return prefixes
}

func normalizeHost(value string) string {
	trimmed := strings.TrimSpace(value)
	trimmed = strings.TrimPrefix(trimmed, "[")
	trimmed = strings.TrimSuffix(trimmed, "]")
	if idx := strings.IndexByte(trimmed, '%'); idx >= 0 {
		trimmed = trimmed[:idx]
	}
	return strings.ToLower(trimmed)
}

func isBlockedIP(raw string) bool {
	norm := normalizeHost(raw)
	if strings.HasPrefix(norm, "::ffff:") {
		return true
	}
	addr, err := netip.ParseAddr(norm)
	if err != nil {
		return false
	}
	for _, prefix := range blockedCIDRs {
		if prefix.Contains(addr) {
			return true
		}
	}
	return false
}

func fakeIPOnlyAddresses(hostname string, addresses []string) []string {
	if _, err := netip.ParseAddr(hostname); err == nil {
		return nil
	}
	var ipv4 []string
	for _, item := range addresses {
		addr, err := netip.ParseAddr(item)
		if err != nil || !addr.Is4() {
			continue
		}
		if !fakeIPCIDR.Contains(addr) {
			return nil
		}
		ipv4 = append(ipv4, item)
	}
	if len(ipv4) == 0 {
		return nil
	}
	return ipv4
}

func defaultResolveHost(ctx context.Context, host string) ([]string, error) {
	norm := normalizeHost(host)
	if _, err := netip.ParseAddr(norm); err == nil {
		return []string{norm}, nil
	}
	ips, err := net.DefaultResolver.LookupIPAddr(ctx, norm)
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(ips))
	for _, item := range ips {
		out = append(out, item.IP.String())
	}
	return out, nil
}

func enforceURLPolicy(ctx context.Context, parsed *url.URL, resolveHost ResolveHostFunc) ([]string, error) {
	hostname := normalizeHost(parsed.Hostname())
	if hostname == "metadata.google.internal" || hostname == "metadata.aws.internal" {
		return nil, errors.New("subscription_url_blocked")
	}
	addresses, err := resolveHost(ctx, hostname)
	if err != nil {
		return nil, err
	}
	normalized := make([]string, 0, len(addresses))
	for _, item := range addresses {
		if norm := normalizeHost(item); norm != "" {
			normalized = append(normalized, norm)
		}
	}
	if len(normalized) == 0 {
		return nil, errors.New("subscription_host_resolution_failed")
	}
	allowed := fakeIPOnlyAddresses(hostname, normalized)
	if len(allowed) == 0 {
		if isBlockedIP(hostname) {
			return nil, errors.New("subscription_url_blocked")
		}
		for _, item := range normalized {
			if isBlockedIP(item) {
				return nil, errors.New("subscription_url_blocked")
			}
		}
		allowed = normalized
	}
	return allowed, nil
}

func (manager *Manager) defaultRequestAdapter(ctx context.Context, targetURL string, timeout time.Duration) (int, error) {
	parsed, err := url.Parse(targetURL)
	if err != nil {
		return 0, err
	}
	allowed, err := enforceURLPolicy(ctx, parsed, manager.resolveHost)
	if err != nil {
		return 0, err
	}
	port := parsed.Port()
	if port == "" {
		if strings.EqualFold(parsed.Scheme, "https") {
			port = "443"
		} else {
			port = "80"
		}
	}
	pinnedAddr := net.JoinHostPort(allowed[0], port)
	dialer := &net.Dialer{Timeout: timeout}
	transport := &http.Transport{
		DialContext: func(dialCtx context.Context, network string, _ string) (net.Conn, error) {
			return dialer.DialContext(dialCtx, network, pinnedAddr)
		},
		DisableKeepAlives: true,
	}
	defer transport.CloseIdleConnections()

	client := &http.Client{
		Transport: transport,
		Timeout:   timeout,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, targetURL, nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("User-Agent", "ai-home-toolkit-mirror-probe/1.0")
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	_ = resp.Body.Close()
	return resp.StatusCode, nil
}

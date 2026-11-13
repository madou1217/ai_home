package egress

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	agyegress "github.com/madou1217/ai_home/internal/adapters/agy/egress"
)

const (
	// DefaultMaxProbeHops 与 Node egress-pool-egress-probe.js DEFAULT_MAX_PROBE_HOPS 对齐。
	DefaultMaxProbeHops     = 4
	minProxyProbeTimeout    = 250 * time.Millisecond
	maxProxyProbeTimeout    = 15 * time.Second
	defaultProxyProbeDur    = 5 * time.Second
	syntheticDetectAcctRef  = accountcore.AccountRef("acct_00000000000000000000")
)

// ProxyProbeResult 描述单次中性 204 出口连通性探测结果。
type ProxyProbeResult struct {
	OK     bool   `json:"ok"`
	Error  string `json:"error,omitempty"`
	Reason string `json:"reason,omitempty"`
}

// PoolProbeWithRotationInput 描述出口池保存/应用前带自动节点轮换的连通性探测入参。
type PoolProbeWithRotationInput struct {
	ProxyURL    string
	Probe       func(ctx context.Context, proxyURL string) ProxyProbeResult
	CurrentNode func(ctx context.Context) string
	Rotate      func(ctx context.Context, fromNode string) string
	MaxHops     *int
}

// PoolRotationProbeResult 描述带轮换探测的最终结果与经过的跳数。
type PoolRotationProbeResult struct {
	OK        bool   `json:"ok"`
	ProxyURL  string `json:"proxyUrl"`
	Hops      int    `json:"hops"`
	Reason    string `json:"reason,omitempty"`
	RotatedTo string `json:"rotatedTo,omitempty"`
}

// DesktopInspectResult 描述运行中的桌面客户端探测结果。
type DesktopInspectResult struct {
	OK     bool   `json:"ok"`
	Status string `json:"status"` // "not_running" | "already_running" | "launch_ready"
	PIDs   []int  `json:"pids,omitempty"`
	Error  string `json:"error,omitempty"`
	Reason string `json:"reason,omitempty"`
}

// DesktopRestartResult 描述桌面客户端关闭或重启操作结果。
type DesktopRestartResult struct {
	OK           bool   `json:"ok"`
	Status       string `json:"status"`
	PID          int    `json:"pid,omitempty"`
	PreviousPIDs []int  `json:"previousPids,omitempty"`
	PIDs         []int  `json:"pids,omitempty"`
	Error        string `json:"error,omitempty"`
	Reason       string `json:"reason,omitempty"`
}

// DesktopClientBridge 封装外部桌面客户端（如 ZCode Desktop）运行态探测与重启钩子。
type DesktopClientBridge interface {
	InspectRunning(ctx context.Context, provider string, accountRef string) (DesktopInspectResult, error)
	CloseApp(ctx context.Context, provider string, accountRef string) (DesktopInspectResult, error)
	LaunchApp(ctx context.Context, provider string, accountRef string, egress *EgressResolveResult) (DesktopRestartResult, error)
}

// EgressResolveResult 描述解析并可选探测后的账号出口目标。
type EgressResolveResult struct {
	OK          bool   `json:"ok"`
	Bound       bool   `json:"bound"`
	Source      string `json:"source,omitempty"`
	ProxyServer string `json:"proxyServer,omitempty"`
	Direct      bool   `json:"direct,omitempty"`
	Error       string `json:"error,omitempty"`
	Reason      string `json:"reason,omitempty"`
	Platform    string `json:"platform,omitempty"`
}

// AccountEgressRuntimeResolved 是 WebUI 运行时卡片展示的解析目标摘要（不发探测请求）。
type AccountEgressRuntimeResolved struct {
	OK          bool   `json:"ok"`
	Source      string `json:"source,omitempty"`
	ProxyServer string `json:"proxyServer,omitempty"`
	Direct      bool   `json:"direct,omitempty"`
	Error       string `json:"error,omitempty"`
}

// AccountEgressRuntimeDetail 汇总当前解析态与 Desktop 存活状态。
type AccountEgressRuntimeDetail struct {
	Resolved       *AccountEgressRuntimeResolved `json:"resolved"`
	DesktopRunning bool                          `json:"desktopRunning"`
	DesktopPID     *int                          `json:"desktopPid"`
}

// AccountEgressRuntimeStatus 对齐 Node getAccountEgressRuntimeStatus 返回结构。
type AccountEgressRuntimeStatus struct {
	OK      bool                       `json:"ok"`
	Binding map[string]any             `json:"binding"`
	Runtime AccountEgressRuntimeDetail `json:"runtime"`
	Error   string                     `json:"error,omitempty"`
	Reason  string                     `json:"reason,omitempty"`
}

// ApplyEgressResult 对齐 Node applyStoredAccountEgress 返回结构。
type ApplyEgressResult struct {
	OK            bool   `json:"ok"`
	Applied       bool   `json:"applied"`
	Status        string `json:"status,omitempty"` // "applied" | "cleared" | "restarted"
	Source        string `json:"source,omitempty"`
	ProxyServer   string `json:"proxyServer,omitempty"`
	Direct        bool   `json:"direct,omitempty"`
	Restarted     bool   `json:"restarted,omitempty"`
	PID           *int   `json:"pid,omitempty"`
	PreviousPIDs  []int  `json:"previousPids,omitempty"`
	Error         string `json:"error,omitempty"`
	Reason        string `json:"reason,omitempty"`
	RolledBack    *bool  `json:"rolledBack,omitempty"`
	RollbackError string `json:"rollbackError,omitempty"`
}

// ResolveAccountEgressOptions 配置单账号出口解析与连通性探测。
type ResolveAccountEgressOptions struct {
	Provider        string
	AccountRef      string
	HasExplicit     bool
	ExplicitBinding *agyegress.Binding
	SkipProbe       bool
	Session         bool
	NoAutoStart     bool
	Platform        string
	TargetProbeURL  string
	ProbeTimeout    time.Duration
	ProbeFunc       func(ctx context.Context, proxyURL string) ProxyProbeResult
}

// ApplyAccountEgressOptions 配置应用已保存账号出口绑定的入参。
type ApplyAccountEgressOptions struct {
	Provider        string
	AccountRef      string
	HasExplicit     bool
	ExplicitBinding *agyegress.Binding
	Session         bool
	Platform        string
	TargetProbeURL  string
	ProbeTimeout    time.Duration
	ProbeFunc       func(ctx context.Context, proxyURL string) ProxyProbeResult
	DesktopBridge   DesktopClientBridge
}

// RuntimeStatusOptions 配置查询账号出口运行时状态的入参。
type RuntimeStatusOptions struct {
	Provider        string
	AccountRef      string
	HasExplicit     bool
	ExplicitBinding *agyegress.Binding
	Session         bool
	Platform        string
	DesktopBridge   DesktopClientBridge
}

// ProbeProxy 通过指定代理向中性 204 URL 发起一次无连接复用的 GET 探测。
func ProbeProxy(ctx context.Context, proxyURL string, targetURL string, timeout time.Duration) ProxyProbeResult {
	trimmed := strings.TrimSpace(proxyURL)
	if trimmed == "" {
		return ProxyProbeResult{OK: false, Error: "proxy_probe_failed", Reason: "missing_proxy_url"}
	}
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return ProxyProbeResult{OK: false, Error: "proxy_probe_failed", Reason: "invalid_proxy_url"}
	}
	dialURL := trimmed
	if strings.EqualFold(parsed.Scheme, "socks5h") {
		cp := *parsed
		cp.Scheme = "socks5"
		dialURL = cp.String()
	}
	if strings.TrimSpace(targetURL) == "" {
		targetURL = DefaultProxyProbeURL
	}
	if timeout <= 0 {
		timeout = defaultProxyProbeDur
	}
	if timeout < minProxyProbeTimeout {
		timeout = minProxyProbeTimeout
	}
	if timeout > maxProxyProbeTimeout {
		timeout = maxProxyProbeTimeout
	}
	client, err := NewDirectOrProxiedHTTPClient(dialURL, timeout)
	if err != nil {
		return ProxyProbeResult{OK: false, Error: "proxy_probe_failed", Reason: err.Error()}
	}
	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, targetURL, nil)
	if err != nil {
		return ProxyProbeResult{OK: false, Error: "proxy_probe_failed", Reason: "invalid_target_url"}
	}
	req.Header.Set("Connection", "close")
	req.Close = true
	resp, err := client.Do(req)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || strings.Contains(strings.ToLower(err.Error()), "timeout") {
			return ProxyProbeResult{OK: false, Error: "proxy_probe_failed", Reason: "proxy_probe_timeout"}
		}
		return ProxyProbeResult{OK: false, Error: "proxy_probe_failed", Reason: classifyProbeNetError(err)}
	}
	_ = resp.Body.Close()
	if resp.StatusCode >= 200 && resp.StatusCode < 400 {
		return ProxyProbeResult{OK: true}
	}
	return ProxyProbeResult{OK: false, Error: "proxy_probe_failed", Reason: fmt.Sprintf("http_%d", resp.StatusCode)}
}

// ProbePoolEgressWithRotation 经出口池端口探测，失败时按规则切换下一个可用节点重试（最多 MaxHops 跳）。
func ProbePoolEgressWithRotation(ctx context.Context, input PoolProbeWithRotationInput) PoolRotationProbeResult {
	proxyURL := strings.TrimSpace(input.ProxyURL)
	if input.Probe == nil || proxyURL == "" {
		return PoolRotationProbeResult{OK: false, Hops: 0, ProxyURL: proxyURL, Reason: "egress_pool_probe_unavailable"}
	}
	maxHops := DefaultMaxProbeHops
	if input.MaxHops != nil && *input.MaxHops >= 0 {
		maxHops = *input.MaxHops
	}

	reason := ""
	rotatedTo := ""
	for hop := 0; hop <= maxHops; hop++ {
		if ctx.Err() != nil {
			return PoolRotationProbeResult{OK: false, Hops: hop, ProxyURL: proxyURL, Reason: "proxy_probe_timeout", RotatedTo: rotatedTo}
		}
		res := input.Probe(ctx, proxyURL)
		if res.OK {
			return PoolRotationProbeResult{OK: true, Hops: hop, ProxyURL: proxyURL, RotatedTo: rotatedTo}
		}
		reason = firstNonEmpty(res.Reason, res.Error, "proxy_probe_failed")
		if input.Rotate == nil || hop == maxHops {
			break
		}
		fromNode := ""
		if input.CurrentNode != nil {
			fromNode = strings.TrimSpace(input.CurrentNode(ctx))
		}
		nextNode := strings.TrimSpace(input.Rotate(ctx, fromNode))
		if nextNode == "" {
			break
		}
		rotatedTo = nextNode
	}
	return PoolRotationProbeResult{
		OK:        false,
		Hops:      maxHops,
		ProxyURL:  proxyURL,
		Reason:    reason,
		RotatedTo: rotatedTo,
	}
}

func providerEgressError(provider string, genericErr string, zcodeErr string) string {
	if strings.EqualFold(strings.TrimSpace(provider), "zcode") {
		return zcodeErr
	}
	return genericErr
}

func (m *Manager) isSupportedProvider(provider string) bool {
	p := strings.ToLower(strings.TrimSpace(provider))
	if p == "" {
		return false
	}
	if m != nil && m.catalog != nil {
		_, ok := m.catalog.Get(p)
		return ok
	}
	return true
}

func (m *Manager) supportsDesktopClient(provider string) bool {
	p := strings.ToLower(strings.TrimSpace(provider))
	if p == "" {
		return false
	}
	if m != nil && m.catalog != nil {
		if def, ok := m.catalog.Get(p); ok {
			return def.Clients.Desktop
		}
		return false
	}
	cat, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		return p == "zcode"
	}
	def, ok := cat.Get(p)
	return ok && def.Clients.Desktop
}

func (m *Manager) withAccountMutLock(accountRef string) func() {
	key := strings.TrimSpace(accountRef)
	if key == "" {
		return func() {}
	}
	m.accountMutMu.Lock()
	mu, ok := m.accountMutMap[key]
	if !ok {
		mu = &sync.Mutex{}
		m.accountMutMap[key] = mu
	}
	m.accountMutMu.Unlock()
	mu.Lock()
	return mu.Unlock
}

func (m *Manager) withDesktopLock(provider string, accountRef string) func() {
	key := strings.ToLower(strings.TrimSpace(provider)) + ":" + strings.TrimSpace(accountRef)
	if key == ":" {
		return func() {}
	}
	m.desktopOpMu.Lock()
	mu, ok := m.desktopOpMap[key]
	if !ok {
		mu = &sync.Mutex{}
		m.desktopOpMap[key] = mu
	}
	m.desktopOpMu.Unlock()
	mu.Lock()
	return mu.Unlock
}

func (m *Manager) resolveBindingInput(ctx context.Context, accountRef string, hasExplicit bool, explicit *agyegress.Binding) (*agyegress.Binding, error) {
	if hasExplicit {
		return explicit, nil
	}
	store := agyegress.NewStore(m.aiHomeDir)
	b, found, err := store.Read(ctx, accountRef)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, nil
	}
	return &b, nil
}

func (m *Manager) resolveEgressTarget(ctx context.Context, binding *agyegress.Binding, opts ResolveAccountEgressOptions) EgressResolveResult {
	if binding == nil {
		return EgressResolveResult{OK: true, Bound: false}
	}
	if binding.Retired {
		return EgressResolveResult{
			OK:     false,
			Bound:  true,
			Error:  agyegress.ErrorModeRetired,
			Reason: binding.Mode,
		}
	}
	platform := firstNonEmpty(opts.Platform, m.platform)
	provider := strings.ToLower(strings.TrimSpace(opts.Provider))

	// pool 模式走 Manager 本进程运行时与车道规划；direct/url/system/tun 复用 internal/adapters/agy/egress。
	if binding.Mode == agyegress.ModePool {
		if normPlat := normalizePlatformLabel(platform); normPlat != "" && normPlat != "macos" {
			return EgressResolveResult{OK: false, Bound: true, Error: agyegress.ErrorNotSupported, Platform: normPlat}
		}
		proxyURL := m.CurrentAccountProxyURL(ctx, opts.AccountRef, opts.Session)
		if proxyURL == "" {
			if !opts.NoAutoStart {
				_ = m.EnsurePoolStarted(ctx)
			}
			return EgressResolveResult{
				OK:     false,
				Bound:  true,
				Error:  agyegress.ErrorPoolNotReady,
				Reason: m.DescribePoolUnavailable(ctx, opts.AccountRef),
			}
		}
		return EgressResolveResult{
			OK:          true,
			Bound:       true,
			Source:      agyegress.ModePool,
			ProxyServer: proxyURL,
		}
	}

	if binding.Mode == agyegress.ModeURL {
		if issue := agyegress.ProxyURLIssueForProvider(binding.ProxyURL, provider); issue != "" {
			return EgressResolveResult{
				OK:    false,
				Bound: true,
				Error: issue,
			}
		}
	}

	// 通过合成 Reader 复用 agy/egress 的平台判定、地址归一化、scutil/networksetup 系统代理探测与 utun 探测。
	rawMap := map[string]any{"mode": binding.Mode}
	if binding.ProxyURL != "" {
		rawMap["proxyUrl"] = binding.ProxyURL
	}
	rawBytes, _ := json.Marshal(rawMap)
	resolver := agyegress.NewResolver(agyegress.Options{
		AIHomeDir: m.aiHomeDir,
		Platform:  platform,
		DetectSystemProxy: m.systemProxyDetector,
		DetectTUN:         m.tunDetector,
		PidAlive:          m.pidAlive,
		ReadBinding: func(_ context.Context, _ string) (string, bool, error) {
			return string(rawBytes), true, nil
		},
	})
	decision, err := resolver.Resolve(ctx, syntheticDetectAcctRef)
	if err != nil {
		var egressErr *agyegress.Error
		if errors.As(err, &egressErr) {
			return EgressResolveResult{
				OK:       false,
				Bound:    true,
				Error:    egressErr.Code,
				Reason:   egressErr.Reason,
				Platform: egressErr.Platform,
			}
		}
		return EgressResolveResult{
			OK:     false,
			Bound:  true,
			Error:  "egress_resolve_failed",
			Reason: err.Error(),
		}
	}

	if decision.Target.Direct {
		return EgressResolveResult{
			OK:     true,
			Bound:  true,
			Source: decision.Target.Source,
			Direct: true,
		}
	}

	proxyURL := strings.TrimSpace(decision.Target.ProxyURL)
	if binding.Mode == agyegress.ModeSystem && proxyURL != "" {
		if issue := agyegress.ProxyURLIssueForProvider(proxyURL, provider); issue != "" {
			return EgressResolveResult{
				OK:    false,
				Bound: true,
				Error: agyegress.ErrorSystemProxySchemeUnavailable,
			}
		}
	}
	return EgressResolveResult{
		OK:          true,
		Bound:       true,
		Source:      decision.Target.Source,
		ProxyServer: proxyURL,
	}
}

func normalizePlatformLabel(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "":
		return ""
	case "mac", "macos", "darwin":
		return "macos"
	case "win", "windows", "win32":
		return "windows"
	case "linux", "linux2":
		return "linux"
	default:
		return strings.ToLower(strings.TrimSpace(raw))
	}
}

func (m *Manager) probeFnFor(opts ResolveAccountEgressOptions) func(context.Context, string) ProxyProbeResult {
	if opts.ProbeFunc != nil {
		return opts.ProbeFunc
	}
	if m != nil && m.proxyProbeFunc != nil {
		return m.proxyProbeFunc
	}
	return func(ctx context.Context, proxyURL string) ProxyProbeResult {
		return ProbeProxy(ctx, proxyURL, opts.TargetProbeURL, opts.ProbeTimeout)
	}
}

// ResolveAccountEgress 解析账号出口绑定并在未跳过探测时验证数据面连通性（fail-closed，不回落直连/全局代理）。
func (m *Manager) ResolveAccountEgress(ctx context.Context, opts ResolveAccountEgressOptions) (EgressResolveResult, error) {
	if !m.isSupportedProvider(opts.Provider) {
		return EgressResolveResult{OK: true, Bound: false}, nil
	}
	ref := strings.TrimSpace(opts.AccountRef)
	if m == nil || m.aiHomeDir == "" || ref == "" {
		return EgressResolveResult{OK: false, Error: "egress_context_missing"}, errors.New("egress_context_missing")
	}

	binding, err := m.resolveBindingInput(ctx, ref, opts.HasExplicit, opts.ExplicitBinding)
	if err != nil {
		return EgressResolveResult{
			OK:     false,
			Bound:  true,
			Error:  agyegress.ErrorBindingReadFailed,
			Reason: err.Error(),
		}, err
	}
	if binding == nil {
		return EgressResolveResult{OK: true, Bound: false}, nil
	}

	resolved := m.resolveEgressTarget(ctx, binding, opts)
	if !resolved.OK {
		return resolved, nil
	}
	if resolved.Direct || opts.SkipProbe {
		return resolved, nil
	}

	probeFn := m.probeFnFor(opts)
	if resolved.Source == agyegress.ModePool {
		poolProbe := ProbePoolEgressWithRotation(ctx, PoolProbeWithRotationInput{
			ProxyURL: resolved.ProxyServer,
			Probe:    probeFn,
			CurrentNode: func(c context.Context) string {
				return m.CurrentAccountPoolNode(c, ref)
			},
			Rotate: func(c context.Context, fromNode string) string {
				return m.RotateAccountLane(c, ref, fromNode, "egress_binding_probe")
			},
		})
		if !poolProbe.OK {
			return EgressResolveResult{
				OK:     false,
				Bound:  true,
				Error:  "proxy_unreachable",
				Reason: firstNonEmpty(poolProbe.Reason, "proxy_probe_failed"),
			}, nil
		}
		return resolved, nil
	}

	probe := probeFn(ctx, resolved.ProxyServer)
	if !probe.OK {
		return EgressResolveResult{
			OK:     false,
			Bound:  true,
			Error:  "proxy_unreachable",
			Reason: firstNonEmpty(probe.Reason, probe.Error, "proxy_probe_failed"),
		}, nil
	}
	return resolved, nil
}

// ApplyStoredAccountEgress 串行校验、探测并使已保存的账号出口生效；如有运行中的桌面端则重启使其加载新出口。
func (m *Manager) ApplyStoredAccountEgress(ctx context.Context, opts ApplyAccountEgressOptions) ApplyEgressResult {
	provider := strings.ToLower(strings.TrimSpace(opts.Provider))
	ref := strings.TrimSpace(opts.AccountRef)
	if !m.isSupportedProvider(provider) {
		return ApplyEgressResult{OK: false, Applied: false, Error: "egress_unsupported_provider"}
	}
	if m == nil || m.aiHomeDir == "" || ref == "" {
		return ApplyEgressResult{OK: false, Applied: false, Error: "egress_context_missing"}
	}

	unlock := m.withAccountMutLock(ref)
	defer unlock()

	egressRes, err := m.ResolveAccountEgress(ctx, ResolveAccountEgressOptions{
		Provider:        provider,
		AccountRef:      ref,
		HasExplicit:     opts.HasExplicit,
		ExplicitBinding: opts.ExplicitBinding,
		SkipProbe:       false,
		Session:         opts.Session,
		Platform:        opts.Platform,
		TargetProbeURL:  opts.TargetProbeURL,
		ProbeTimeout:    opts.ProbeTimeout,
		ProbeFunc:       opts.ProbeFunc,
	})
	if err != nil {
		return ApplyEgressResult{
			OK:      false,
			Applied: false,
			Error:   "egress_binding_read_failed",
			Reason:  err.Error(),
		}
	}
	if !egressRes.OK {
		return ApplyEgressResult{
			OK:      false,
			Applied: false,
			Error:   egressRes.Error,
			Reason:  egressRes.Reason,
		}
	}

	bridge := opts.DesktopBridge
	if bridge == nil {
		bridge = m.desktopBridge
	}
	var egressPtr *EgressResolveResult
	if egressRes.Bound {
		copied := egressRes
		egressPtr = &copied
	}

	if m.supportsDesktopClient(provider) && bridge != nil {
		dUnlock := m.withDesktopLock(provider, ref)
		restartRes := m.restartRunningDesktopOnce(ctx, bridge, provider, ref, egressPtr)
		dUnlock()
		if !restartRes.OK {
			return restartRes
		}
		if restartRes.Status == "restarted" {
			restartRes.Source = egressRes.Source
			restartRes.ProxyServer = egressRes.ProxyServer
			restartRes.Direct = egressRes.Direct
			return restartRes
		}
	}

	status := "cleared"
	if egressRes.Bound {
		status = "applied"
	}
	return ApplyEgressResult{
		OK:          true,
		Applied:     true,
		Status:      status,
		Source:      egressRes.Source,
		ProxyServer: egressRes.ProxyServer,
		Direct:      egressRes.Direct,
	}
}

func (m *Manager) restartRunningDesktopOnce(
	ctx context.Context,
	bridge DesktopClientBridge,
	provider string,
	accountRef string,
	egressRes *EgressResolveResult,
) ApplyEgressResult {
	probeFailedErr := providerEgressError(provider, "account_desktop_egress_probe_failed", "zcode_desktop_probe_failed")
	closeFailedErr := providerEgressError(provider, "account_desktop_egress_close_failed", "zcode_desktop_close_failed")

	preflight, err := bridge.InspectRunning(ctx, provider, accountRef)
	if err != nil {
		return ApplyEgressResult{OK: false, Applied: false, Error: probeFailedErr, Reason: err.Error()}
	}
	if preflight.OK && (preflight.Status == "launch_ready" || preflight.Status == "not_running") {
		return ApplyEgressResult{OK: true, Status: "not_running"}
	}
	if !preflight.OK || preflight.Status != "already_running" {
		return ApplyEgressResult{
			OK:      false,
			Applied: false,
			Error:   firstNonEmpty(preflight.Error, probeFailedErr),
			Reason:  preflight.Reason,
		}
	}

	closed, err := bridge.CloseApp(ctx, provider, accountRef)
	if err != nil {
		return ApplyEgressResult{OK: false, Applied: false, Error: closeFailedErr, Reason: err.Error()}
	}
	if !closed.OK || (closed.Status != "closed" && closed.Status != "not_running") {
		return ApplyEgressResult{
			OK:      false,
			Applied: false,
			Error:   firstNonEmpty(closed.Error, closeFailedErr),
			Reason:  closed.Reason,
		}
	}

	launched, err := bridge.LaunchApp(ctx, provider, accountRef, egressRes)
	if err != nil {
		return ApplyEgressResult{OK: false, Applied: false, Error: "launch_failed", Reason: err.Error()}
	}
	if !launched.OK || launched.Status != "launched" {
		return ApplyEgressResult{
			OK:      false,
			Applied: false,
			Error:   firstNonEmpty(launched.Error, "launch_failed"),
			Reason:  launched.Reason,
		}
	}

	var pidPtr *int
	if launched.PID > 0 {
		p := launched.PID
		pidPtr = &p
	}
	prev := append([]int(nil), preflight.PIDs...)
	return ApplyEgressResult{
		OK:           true,
		Applied:      true,
		Status:       "restarted",
		Restarted:    true,
		PID:          pidPtr,
		PreviousPIDs: prev,
	}
}

// GetAccountEgressRuntimeStatus 返回供 WebUI 展示的账号出口实时解析态（不发探测请求）及桌面进程存活状态。
func (m *Manager) GetAccountEgressRuntimeStatus(ctx context.Context, opts RuntimeStatusOptions) AccountEgressRuntimeStatus {
	provider := strings.ToLower(strings.TrimSpace(opts.Provider))
	ref := strings.TrimSpace(opts.AccountRef)
	if !m.isSupportedProvider(provider) {
		return AccountEgressRuntimeStatus{OK: false, Error: "egress_unsupported_provider"}
	}
	if m == nil || m.aiHomeDir == "" || ref == "" {
		return AccountEgressRuntimeStatus{OK: false, Error: "egress_context_missing"}
	}

	binding, err := m.resolveBindingInput(ctx, ref, opts.HasExplicit, opts.ExplicitBinding)
	if err != nil {
		return AccountEgressRuntimeStatus{OK: false, Error: "egress_binding_read_failed", Reason: err.Error()}
	}

	var bindingView map[string]any
	var resolvedView *AccountEgressRuntimeResolved
	if binding != nil {
		bindingView = binding.View()
		target := m.resolveEgressTarget(ctx, binding, ResolveAccountEgressOptions{
			Provider:   provider,
			AccountRef: ref,
			Session:    opts.Session,
			Platform:   opts.Platform,
		})
		if target.OK {
			resolvedView = &AccountEgressRuntimeResolved{
				OK:          true,
				Source:      target.Source,
				ProxyServer: target.ProxyServer,
				Direct:      target.Direct,
			}
		} else {
			resolvedView = &AccountEgressRuntimeResolved{
				OK:    false,
				Error: target.Error,
			}
		}
	}

	bridge := opts.DesktopBridge
	if bridge == nil {
		bridge = m.desktopBridge
	}
	var desktopPID *int
	if bridge != nil && m.supportsDesktopClient(provider) {
		if inspect, err := bridge.InspectRunning(ctx, provider, ref); err == nil && inspect.OK && inspect.Status == "already_running" {
			var validPIDs []int
			for _, pid := range inspect.PIDs {
				if pid > 0 {
					validPIDs = append(validPIDs, pid)
				}
			}
			sort.Ints(validPIDs)
			if len(validPIDs) > 0 {
				p := validPIDs[0]
				desktopPID = &p
			}
		}
	}

	return AccountEgressRuntimeStatus{
		OK:      true,
		Binding: bindingView,
		Runtime: AccountEgressRuntimeDetail{
			Resolved:       resolvedView,
			DesktopRunning: desktopPID != nil,
			DesktopPID:     desktopPID,
		},
	}
}

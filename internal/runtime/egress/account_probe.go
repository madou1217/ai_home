package egress

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	agyegress "github.com/madou1217/ai_home/internal/adapters/agy/egress"
)

// AccountUpstreamProbeResult 描述按账号当前生效出口探测上游的结果。
//
// Exit 是本次使用的网络形态：pool / proxy / system / direct。Node 只在出口池
// 车道里出现；ProxyURL 始终脱敏，避免把代理凭据回传给浏览器。
type AccountUpstreamProbeResult struct {
	OK       bool         `json:"ok"`
	Status   string       `json:"status"`
	Reason   string       `json:"reason,omitempty"`
	Exit     string       `json:"exit,omitempty"`
	ProxyURL string       `json:"proxyUrl,omitempty"`
	Node     string       `json:"node,omitempty"`
	Geo      *GeoLocation `json:"geo,omitempty"`
}

// ProbeUpstreamAccount 按账号当前生效出口向上游发起一次真实连通性探测。
//
// 探测目标与节点矩阵相同：<上游 origin>/v1/models，不携带账号凭据。HTTP 有响应
// 即视为可达；命中上游地区拒绝特征（451 / 拒绝关键词）记为 blocked。结果写入
// 同一份 exitKey 实测缓存，因此面板和网关守卫立刻使用这次结论。
//
// 出口优先级与网关一致：账号显式绑定（pool/url/system/direct/tun）> 服务端
// 默认网络（config:server proxyUrl / 环境代理）。出口池账号从车道取当前节点；
// 车道未就绪时返回 skipped，不能悄悄改用直连。
func (m *Manager) ProbeUpstreamAccount(
	ctx context.Context,
	upstreamID string,
	accountRef string,
) (AccountUpstreamProbeResult, int) {
	upstream, ok := m.findUpstream(ctx, upstreamID)
	if !ok {
		return AccountUpstreamProbeResult{OK: false, Status: "skipped", Reason: "upstream_not_found"}, http.StatusNotFound
	}
	ref := strings.TrimSpace(accountRef)
	if !IsAccountRef(ref) {
		return AccountUpstreamProbeResult{OK: false, Status: "skipped", Reason: "invalid_account_ref"}, http.StatusBadRequest
	}
	if _, found, err := ResolveAccount(ctx, m.aiHomeDir, ref); err != nil || !found {
		return AccountUpstreamProbeResult{OK: false, Status: "skipped", Reason: "account_not_found"}, http.StatusNotFound
	}
	binding, hasBinding, err := agyegress.NewStore(m.aiHomeDir).Read(ctx, ref)
	if err != nil {
		// 绑定损坏必须失败关闭：不能把它当成未绑定而回落到全局网络。
		return AccountUpstreamProbeResult{OK: false, Status: "skipped", Reason: "egress_binding_read_failed"}, http.StatusConflict
	}
	if hasBinding && !binding.Retired && strings.EqualFold(strings.TrimSpace(binding.Mode), agyegress.ModePool) {
		return m.probePoolAccountUpstream(ctx, upstream, ref, binding), http.StatusOK
	}
	return m.probeDirectAccountUpstream(ctx, upstream, binding, hasBinding), http.StatusOK
}

// probePoolAccountUpstream 优先用 mihomo 车道节点；没有车道时回落到 HTTP/SOCKS/
// SSH 直连节点池，仍不可用才明确跳过。
func (m *Manager) probePoolAccountUpstream(
	ctx context.Context,
	upstream *UpstreamInfo,
	accountRef string,
	binding agyegress.Binding,
) AccountUpstreamProbeResult {
	fallback := func(reason string) AccountUpstreamProbeResult {
		if endpoint, endpointErr := SelectEndpointPoolProxy(ctx, m.aiHomeDir, accountRef, &binding); endpointErr == nil && endpoint != nil {
			return m.probeViaProxy(ctx, upstream, endpoint.ProxyURL, "pool", endpoint.NodeName)
		}
		return AccountUpstreamProbeResult{OK: false, Status: "skipped", Reason: reason, Exit: "pool"}
	}
	snap, err := m.loadRuntimeSnapshot(ctx)
	if err != nil || snap == nil || !snap.ready {
		return fallback("egress_pool_not_ready")
	}
	node := ""
	blocked := ""
	for _, lane := range snap.lanes {
		for _, ref := range lane.Accounts {
			if ref != accountRef {
				continue
			}
			node = strings.TrimSpace(lane.ActiveNode)
			blocked = strings.TrimSpace(lane.Blocked)
			break
		}
		if node != "" {
			break
		}
	}
	if node == "" {
		reason := blocked
		if reason == "" {
			reason = "egress_pool_lane_not_ready"
		}
		return fallback(reason)
	}
	geo, _ := m.LookupNodeGeo(ctx, node, false)
	result := m.ProbeUpstreamViaNode(ctx, upstream, node)
	out := AccountUpstreamProbeResult{
		OK:     result.Status != "skipped",
		Status: result.Status,
		Reason: result.Reason,
		Exit:   "pool",
		Node:   node,
		Geo:    geo,
	}
	m.EmitChanged("probe-account")
	return out
}

// probeDirectAccountUpstream 用非池出口（绑定或服务端默认网络）探测。
func (m *Manager) probeDirectAccountUpstream(
	ctx context.Context,
	upstream *UpstreamInfo,
	binding agyegress.Binding,
	hasBinding bool,
) AccountUpstreamProbeResult {
	exit := "direct"
	proxyURL := ""
	bindURL := false
	if hasBinding {
		runtime, ok := strategyRuntimeFor(binding.Mode)
		if !ok {
			return AccountUpstreamProbeResult{
				OK:     false,
				Status: "skipped",
				Reason: "unknown_egress_mode",
				Exit:   strings.ToLower(strings.TrimSpace(binding.Mode)),
			}
		}
		resolved, exitErr := runtime.Launch(ctx, m.aiHomeDir, upstream.Provider, "", &binding)
		if exitErr != nil {
			return AccountUpstreamProbeResult{
				OK:     false,
				Status: "skipped",
				Reason: exitErr.Error(),
				Exit:   strings.ToLower(strings.TrimSpace(binding.Mode)),
			}
		}
		switch resolved.Mode {
		case agyegress.ModeURL:
			exit = "proxy"
			bindURL = true
			proxyURL = resolved.ProxyURL
		case agyegress.ModeSSH:
			exit = "ssh"
			bindURL = true
			proxyURL = resolved.ProxyURL
		case agyegress.ModeSystem:
			// system 绑定必须使用实际探测到的系统代理，不能换成 server proxy；
			// Launch 与 Manager 走同一份探测，无可用代理时上面已报错。
			exit = "system"
			bindURL = true
			proxyURL = resolved.ProxyURL
		default:
			// direct / tun：TUN 由系统透明接管；显式直连不能被 server proxy 顶替。
			exit = "direct"
			bindURL = true
		}
	}
	if !bindURL {
		// 未绑定 / system / direct 都按服务端当前默认网络解析：
		// config:server.proxyUrl > AIH_SERVER_PROXY_URL > HTTPS_PROXY 等环境代理。
		proxyURL = ResolveServerProxyConfig(upstream.BaseURL, ReadServerConfigEgress(ctx, m.aiHomeDir))
		if proxyURL != "" && exit == "direct" {
			exit = "proxy"
		}
	}

	return m.probeViaProxy(ctx, upstream, proxyURL, exit, "")
}

// probeViaProxy 用指定代理（空串=直连）请求一次上游探测 URL 并写入实测。
func (m *Manager) probeViaProxy(
	ctx context.Context,
	upstream *UpstreamInfo,
	proxyURL string,
	exit string,
	node string,
) AccountUpstreamProbeResult {
	targetURL := ProbeURLFor(upstream)
	if targetURL == "" {
		return AccountUpstreamProbeResult{OK: false, Status: "skipped", Reason: "probe_url_invalid", Exit: exit}
	}
	client, err := newAccountProbeClient(proxyURL, m.upstreamProbeTimeout)
	if err != nil {
		return AccountUpstreamProbeResult{OK: false, Status: "skipped", Reason: "probe_client_failed", Exit: exit}
	}

	status, reason := fetchUpstreamProbe(ctx, client, targetURL, upstream)
	if status != "skipped" {
		if exitKey := ExitKeyOf(proxyURL); exitKey != "" {
			RecordUpstreamEvidence(ctx, m.aiHomeDir, upstream.ID, exitKey, UpstreamEvidenceEntry{
				Status: status,
				Reason: reason,
				Source: "probe",
			}, m.nowMS())
		}
	}

	out := AccountUpstreamProbeResult{
		OK:       status != "skipped",
		Status:   status,
		Reason:   reason,
		Exit:     exit,
		Node:     node,
		ProxyURL: RedactProxyURL(proxyURL),
	}
	if status == "reachable" {
		if entry, geoErr := m.geoCache.RefreshExitGeo(ctx, proxyURL); geoErr == nil && entry != nil {
			geo := entry.Geo
			out.Geo = &geo
		}
	}
	m.EmitChanged("probe-account")
	return out
}

// newAccountProbeClient 构造单次探测客户端：非空 proxyURL 走该代理，空串明确直连。
func newAccountProbeClient(proxyURL string, timeout time.Duration) (*http.Client, error) {
	if timeout <= 0 {
		timeout = DefaultUpstreamProbeTimeoutMS * time.Millisecond
	}
	trimmed := strings.TrimSpace(proxyURL)
	if trimmed == "" {
		return NewDirectOrProxiedHTTPClient("", timeout)
	}
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, fmt.Errorf("invalid_proxy_url")
	}
	return NewDirectOrProxiedHTTPClient(trimmed, timeout)
}

// fetchUpstreamProbe 请求一次上游探测 URL 并按地区拒绝特征归类。
func fetchUpstreamProbe(
	ctx context.Context,
	client *http.Client,
	targetURL string,
	upstream *UpstreamInfo,
) (status string, reason string) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, targetURL, nil)
	if err != nil {
		return "skipped", "probe_url_invalid"
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Connection", "close")
	request.Close = true
	response, err := client.Do(request)
	if err != nil {
		return "blocked", "upstream_unreachable:" + classifyProbeNetError(err)
	}
	defer func() { _ = response.Body.Close() }()
	body, _ := io.ReadAll(io.LimitReader(response.Body, 4000))
	if signature := IsRegionDenied(upstream, response.StatusCode, string(body)); signature != "" {
		return "blocked", "region_denied:" + signature
	}
	return "reachable", fmt.Sprintf("http_%d", response.StatusCode)
}

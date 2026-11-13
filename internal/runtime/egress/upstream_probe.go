package egress

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

const (
	// DefaultProxyProbeURL 是出口连通性探测的中性 204 地址（与 Node DEFAULT_PROXY_PROBE_URL 一致）。
	DefaultProxyProbeURL = "https://www.gstatic.com/generate_204"
	// ProbeGroupName 是 mihomo 配置中共享探测入站的组名。
	ProbeGroupName = "AIH-PROBE"
	// DefaultProbeTimeoutMS 是中性节点延迟探测的基础超时。
	DefaultProbeTimeoutMS = 5000
	// DefaultUpstreamProbeTimeoutMS 是经节点请求上游探测的超时。
	DefaultUpstreamProbeTimeoutMS = 10000
	// DefaultProbeConcurrency 是全量探测时的并发数。
	DefaultProbeConcurrency = 8
)

// UpstreamProbeResult 描述单节点探测上游的结果。
type UpstreamProbeResult struct {
	Status  string       `json:"status"`
	Reason  string       `json:"reason"`
	Node    string       `json:"node"`
	ExitKey string       `json:"exitKey,omitempty"`
	Geo     *GeoLocation `json:"geo,omitempty"`
}

// NodeProbeOutcome 描述单节点中性延迟探测结果。
type NodeProbeOutcome struct {
	Name      string `json:"name"`
	OK        bool   `json:"ok"`
	LatencyMS int64  `json:"latencyMs,omitempty"`
	Error     string `json:"error,omitempty"`
}

// ProbeURLFor 返回上游被动探测使用的无凭据端点 URL（<origin>/v1/models）。
func ProbeURLFor(upstream *UpstreamInfo) string {
	if upstream == nil {
		return ""
	}
	base := strings.TrimSpace(upstream.BaseURL)
	if base == "" && strings.TrimSpace(upstream.Host) != "" {
		base = "https://" + strings.TrimSpace(upstream.Host)
	}
	base = strings.TrimRight(base, "/")
	if base == "" {
		return ""
	}
	parsed, err := url.Parse(base)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return ""
	}
	return fmt.Sprintf("%s://%s/v1/models", parsed.Scheme, parsed.Host)
}

func (m *Manager) resolveProbeEndpoint(ctx context.Context) (*ControllerClient, int, error) {
	state, _ := ReadLivePoolState(m.aiHomeDir, m.pidAlive)
	cfg, cfgOK := ReadPoolRuntimeConfig(m.aiHomeDir)

	port := 0
	secret := ""
	probePort := 0
	if state != nil && state.ControllerPort > 0 && state.Secret != "" {
		port = state.ControllerPort
		secret = state.Secret
	} else if cfgOK && cfg != nil && cfg.ControllerPort > 0 && cfg.Secret != "" {
		port = cfg.ControllerPort
		secret = cfg.Secret
	}
	if cfgOK && cfg != nil && cfg.ProbePort > 0 {
		probePort = cfg.ProbePort
	}
	if port <= 0 || secret == "" {
		return nil, 0, fmt.Errorf("egress_pool_not_ready")
	}
	client := NewControllerClient(port, secret, m.httpClient)
	if state == nil {
		ok, err := client.Version(ctx)
		if err != nil || !ok {
			return nil, 0, fmt.Errorf("egress_pool_not_ready")
		}
	}
	return client, probePort, nil
}

// ProbeNode 经 mihomo 控制面探测单个节点的延迟并写回节点健康账本。
func (m *Manager) ProbeNode(ctx context.Context, name string) NodeProbeOutcome {
	nodeName := strings.TrimSpace(name)
	if nodeName == "" {
		return NodeProbeOutcome{Name: nodeName, OK: false, Error: "egress_pool_node_unknown"}
	}
	if err := m.syncHealthBindingsLocked(); err != nil {
		return NodeProbeOutcome{Name: nodeName, OK: false, Error: "egress_pool_not_ready"}
	}
	if _, ok := m.health.NodeInfo(nodeName); !ok {
		return NodeProbeOutcome{Name: nodeName, OK: false, Error: "egress_pool_node_unknown"}
	}
	ctrl, _, err := m.resolveProbeEndpoint(ctx)
	if err != nil {
		return NodeProbeOutcome{Name: nodeName, OK: false, Error: "egress_pool_not_ready"}
	}

	policy := ReadNodePolicy(ctx, m.aiHomeDir)
	timeoutMS := EffectiveProbeTimeoutMS(policy, m.probeTimeoutMS)
	delayMS, probeErr := ctrl.ProbeDelay(ctx, nodeName, m.probeURL, timeoutMS)
	cooling := m.health.IsCooling(nodeName, m.nowMS())
	if probeErr == nil && delayMS > 0 {
		m.health.RecordProbe(nodeName, true, delayMS, "", cooling)
		_ = m.health.Save()
		return NodeProbeOutcome{Name: nodeName, OK: true, LatencyMS: delayMS}
	}
	errCode := "probe_unreachable"
	m.health.RecordProbe(nodeName, false, 0, errCode, cooling)
	_ = m.health.Save()
	return NodeProbeOutcome{Name: nodeName, OK: false, Error: errCode}
}

func (m *Manager) withProbeNode(ctx context.Context, nodeName string, fn func(client *http.Client) error) error {
	m.probeMu.Lock()
	defer m.probeMu.Unlock()

	target := strings.TrimSpace(nodeName)
	ctrl, probePort, err := m.resolveProbeEndpoint(ctx)
	if err != nil || probePort <= 0 {
		return fmt.Errorf("egress_pool_probe_unavailable")
	}
	if _, ok := m.health.NodeInfo(target); !ok {
		return fmt.Errorf("egress_pool_node_unknown")
	}
	if err := ctrl.SelectProxy(ctx, ProbeGroupName, target); err != nil {
		return fmt.Errorf("egress_pool_probe_select_failed")
	}
	proxyURL := fmt.Sprintf("http://127.0.0.1:%d", probePort)
	client, err := NewDirectOrProxiedHTTPClient(proxyURL, m.upstreamProbeTimeout)
	if err != nil {
		return fmt.Errorf("probe_client_failed")
	}
	return fn(client)
}

func (m *Manager) fetchUpstreamViaNode(ctx context.Context, nodeName string, targetURL string) (reached bool, statusCode int, bodyText string, fetchErr string) {
	err := m.withProbeNode(ctx, nodeName, func(client *http.Client) error {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, targetURL, nil)
		if err != nil {
			fetchErr = "probe_url_invalid"
			return nil
		}
		req.Header.Set("Accept", "application/json")
		req.Header.Set("Connection", "close")
		req.Close = true
		resp, err := client.Do(req)
		if err != nil {
			fetchErr = classifyProbeNetError(err)
			return nil
		}
		defer resp.Body.Close()
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4000))
		reached = true
		statusCode = resp.StatusCode
		bodyText = string(raw)
		return nil
	})
	if err != nil {
		return false, 0, "", err.Error()
	}
	return reached, statusCode, bodyText, fetchErr
}

func classifyProbeNetError(err error) string {
	if err == nil {
		return "error"
	}
	lower := strings.ToLower(err.Error())
	switch {
	case strings.Contains(lower, "timeout") || strings.Contains(lower, "deadline"):
		return "TimeoutError"
	case strings.Contains(lower, "econnreset") || strings.Contains(lower, "connection reset"):
		return "ECONNRESET"
	case strings.Contains(lower, "econnrefused") || strings.Contains(lower, "connection refused"):
		return "ECONNREFUSED"
	case strings.Contains(lower, "eof"):
		return "EOF"
	default:
		return "error"
	}
}

// LookupNodeGeo 经指定节点查出口 IP 并结合本地 GeoIP 数据库定位，写入节点账本。
func (m *Manager) LookupNodeGeo(ctx context.Context, name string, force bool) (*GeoLocation, error) {
	nodeName := strings.TrimSpace(name)
	_ = m.syncHealthBindingsLocked()
	if !force {
		if cached := m.health.GeoOf(nodeName); cached != nil && cached.At+m.nodeGeoTTLMS > m.nowMS() {
			return cached, nil
		}
	}
	var geo GeoLocation
	var lookupErr error
	err := m.withProbeNode(ctx, nodeName, func(client *http.Client) error {
		g, gErr := LookupIPGeoWithFallback(ctx, m.aiHomeDir, m.homeDir, "", client, m.nowMS())
		if gErr != nil {
			lookupErr = gErr
			return nil
		}
		geo = g
		return nil
	})
	if err != nil {
		return nil, err
	}
	if lookupErr != nil {
		return nil, lookupErr
	}
	m.health.RecordGeo(nodeName, geo)
	_ = m.health.Save()
	return &geo, nil
}

// ProbeUpstreamViaNode 对单个节点执行「中性延迟探测 → 无凭据上游探测 → 实测入账」。
func (m *Manager) ProbeUpstreamViaNode(ctx context.Context, upstream *UpstreamInfo, nodeName string) UpstreamProbeResult {
	target := strings.TrimSpace(nodeName)
	if upstream == nil || target == "" {
		return UpstreamProbeResult{Status: "skipped", Reason: "probe_context_missing", Node: target}
	}
	probeURL := ProbeURLFor(upstream)
	if probeURL == "" {
		return UpstreamProbeResult{Status: "skipped", Reason: "probe_url_invalid", Node: target}
	}

	neutral := m.ProbeNode(ctx, target)
	if !neutral.OK {
		return UpstreamProbeResult{Status: "skipped", Reason: "node_unreachable", Node: target}
	}

	reached, statusCode, bodyText, netErr := m.fetchUpstreamViaNode(ctx, target, probeURL)
	if !reached && (netErr == "egress_pool_probe_unavailable" || netErr == "egress_pool_node_unknown" || netErr == "egress_pool_probe_select_failed" || netErr == "probe_client_failed") {
		return UpstreamProbeResult{Status: "skipped", Reason: netErr, Node: target}
	}

	status := "reachable"
	reason := fmt.Sprintf("http_%d", statusCode)
	if !reached {
		status = "blocked"
		reason = "upstream_unreachable:" + netErr
	} else if sig := IsRegionDenied(upstream, statusCode, bodyText); sig != "" {
		status = "blocked"
		reason = "region_denied:" + sig
	}

	identity := m.health.IdentityOf(target)
	exitKey := NodeExitKey(identity)
	if exitKey != "" && m.aiHomeDir != "" {
		RecordUpstreamEvidence(ctx, m.aiHomeDir, upstream.ID, exitKey, UpstreamEvidenceEntry{
			Status: status,
			Reason: reason,
			Source: "probe",
		}, m.nowMS())
	}
	return UpstreamProbeResult{
		Status:  status,
		Reason:  reason,
		Node:    target,
		ExitKey: exitKey,
	}
}

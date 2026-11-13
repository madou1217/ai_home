package egress

import (
	"context"
	"fmt"
	"net/url"
	"strings"
	"sync"
)

const (
	defaultContextCacheMS    = 10 * 1000
	defaultDeniedRefsCacheMS = 5 * 1000
)

// ExitKeyOf 将代理地址规范化为缓存键（去掉凭据，缺省或非法记为 "direct"）。
func ExitKeyOf(proxyURL string) string {
	raw := strings.TrimSpace(proxyURL)
	if raw == "" {
		return "direct"
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme == "" || parsed.Hostname() == "" {
		return "direct"
	}
	host := parsed.Hostname()
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	port := parsed.Port()
	if port != "" {
		return fmt.Sprintf("%s://%s:%s", strings.ToLower(parsed.Scheme), strings.ToLower(host), port)
	}
	return fmt.Sprintf("%s://%s:", strings.ToLower(parsed.Scheme), strings.ToLower(host))
}

// DescribeNetworkDenial 生成前端与 CLI 共用的地区拒绝说明文本。
func DescribeNetworkDenial(verdict *NetworkExitVerdict, upstreamID string) string {
	where := "当前出口"
	detail := "地区受限"
	if verdict != nil {
		if strings.TrimSpace(verdict.GeoText) != "" {
			where = verdict.GeoText
		}
		if strings.TrimSpace(verdict.Detail) != "" {
			detail = verdict.Detail
		}
	}
	uid := strings.TrimSpace(upstreamID)
	if uid == "" {
		uid = "该上游"
	}
	return fmt.Sprintf("%s 不接受来自 %s 的请求（%s）。请为该账号设置出口（WebUI 账号 → 出口：出口池 / 代理地址），或开启本地代理 / TUN 后重试。",
		uid, where, detail)
}

// GatewayNetworkDenial 表示非出口池账号在网关尝试前被当前网络守卫拦截。
type GatewayNetworkDenial struct {
	Denied   bool               `json:"denied"`
	Error    string             `json:"error"`
	Reason   string             `json:"reason"`
	Verdict  *NetworkExitVerdict `json:"verdict"`
	Upstream *UpstreamInfo      `json:"upstream"`
}

// GatewayNetworkCheckInput 描述单次网关请求前置检查所需的账号与网络选项。
type GatewayNetworkCheckInput struct {
	Account      AccountRecord
	EgressSource string
	ProxyURL     string
	NoProxy      string
}

type cachedDecisionContext struct {
	ctx *UpstreamDecisionContext
	at  int64
}

// GatewayNetworkGuard 负责对未走出口池的账号校验当前实际出口位置是否被上游地区政策拒绝。
type GatewayNetworkGuard struct {
	mgr      *Manager
	geoTTLMS int64

	mu            sync.Mutex
	contextCache  map[string]cachedDecisionContext
	deniedRefs    map[string]bool
	deniedRefsAt  int64
}

// NewGatewayNetworkGuard 构造挂载到 Manager 上的网络守卫。
func NewGatewayNetworkGuard(mgr *Manager) *GatewayNetworkGuard {
	return &GatewayNetworkGuard{
		mgr:          mgr,
		geoTTLMS:     LocalGeoTTLMS,
		contextCache: make(map[string]cachedDecisionContext),
	}
}

// Invalidate 在上游策略或实测变更后失效守卫缓存。
func (g *GatewayNetworkGuard) Invalidate() {
	if g == nil {
		return
	}
	g.mu.Lock()
	g.contextCache = make(map[string]cachedDecisionContext)
	g.deniedRefs = nil
	g.deniedRefsAt = 0
	g.mu.Unlock()
}

func (g *GatewayNetworkGuard) cachedUpstreamContext(ctx context.Context, upstream *UpstreamInfo) *UpstreamDecisionContext {
	if upstream == nil {
		return nil
	}
	nowMS := g.mgr.nowMS()
	g.mu.Lock()
	hit, ok := g.contextCache[upstream.ID]
	if ok && nowMS-hit.at < defaultContextCacheMS {
		g.mu.Unlock()
		return hit.ctx
	}
	g.mu.Unlock()

	decisionCtx := ReadUpstreamDecisionContext(ctx, g.mgr.aiHomeDir, upstream)
	g.mu.Lock()
	g.contextCache[upstream.ID] = cachedDecisionContext{ctx: decisionCtx, at: nowMS}
	g.mu.Unlock()
	return decisionCtx
}

// ListNetworkDeniedRefs 返回当前缓存出口位置被上游拒绝的非池账号集合（绝不阻塞：缺位置时异步刷新）。
func (g *GatewayNetworkGuard) ListNetworkDeniedRefs(ctx context.Context) map[string]bool {
	out := make(map[string]bool)
	if g == nil || g.mgr == nil {
		return out
	}
	nowMS := g.mgr.nowMS()
	g.mu.Lock()
	if g.deniedRefs != nil && nowMS-g.deniedRefsAt < defaultDeniedRefsCacheMS {
		for k, v := range g.deniedRefs {
			out[k] = v
		}
		g.mu.Unlock()
		return out
	}
	g.mu.Unlock()

	accounts, _ := ListKnownAccounts(ctx, g.mgr.aiHomeDir)
	bindingsList, _ := ReadAccountEgressBindings(ctx, g.mgr.aiHomeDir)
	bindings := make(map[string]AccountBindingRecord, len(bindingsList))
	for _, b := range bindingsList {
		bindings[b.AccountRef] = b
	}
	overrides := ReadServerUpstreamOverrides(ctx, g.mgr.aiHomeDir)
	serverCfg := ReadServerConfigEgress(ctx, g.mgr.aiHomeDir)

	for _, acc := range accounts {
		if b, bound := bindings[acc.AccountRef]; bound && b.Binding.Mode != "tun" {
			continue
		}
		upstream := ResolveAccountUpstream(overrides, acc)
		if upstream == nil {
			continue
		}
		upCtx := g.cachedUpstreamContext(ctx, upstream)
		if upCtx == nil || (len(upCtx.Policy.Rules) == 0 && len(upCtx.Hints) == 0) {
			continue
		}
		proxyURL := ""
		if b, bound := bindings[acc.AccountRef]; !bound || b.Binding.Mode != "tun" {
			proxyURL = ResolveServerProxyConfig(upstream.BaseURL, serverCfg)
		}
		geo := g.mgr.geoCache.PeekExitGeo(proxyURL)
		if (geo == nil || geo.At+g.geoTTLMS <= nowMS) && !g.mgr.disableAutoDirectGeo {
			pURL := proxyURL
			go func() {
				_, _ = g.mgr.geoCache.RefreshExitGeo(context.Background(), pURL)
			}()
		}
		verdict := EvaluateNetworkExit(upCtx, geo, nowMS)
		if verdict != nil && verdict.Status == "denied" {
			out[acc.AccountRef] = true
		}
	}

	g.mu.Lock()
	copied := make(map[string]bool, len(out))
	for k, v := range out {
		copied[k] = v
	}
	g.deniedRefs = copied
	g.deniedRefsAt = nowMS
	g.mu.Unlock()
	return out
}

// CheckGatewayNetwork 在网关发出请求前判定实际出口是否被上游拒绝；放行返回 nil。
func (g *GatewayNetworkGuard) CheckGatewayNetwork(ctx context.Context, input GatewayNetworkCheckInput) *GatewayNetworkDenial {
	if g == nil || g.mgr == nil || input.EgressSource == "pool" {
		return nil
	}
	ref := strings.TrimSpace(input.Account.AccountRef)
	prov := strings.ToLower(strings.TrimSpace(input.Account.Provider))
	if ref == "" || prov == "" {
		return nil
	}
	overrides := ReadServerUpstreamOverrides(ctx, g.mgr.aiHomeDir)
	acc := input.Account
	if stored, found, _ := ResolveAccount(ctx, g.mgr.aiHomeDir, ref); found {
		acc = stored
	}
	upstream := ResolveAccountUpstream(overrides, acc)
	if upstream == nil {
		return nil
	}
	upCtx := g.cachedUpstreamContext(ctx, upstream)
	if upCtx == nil || (len(upCtx.Policy.Rules) == 0 && len(upCtx.Hints) == 0) {
		return nil
	}

	proxyURL := ""
	if strings.TrimSpace(input.NoProxy) != "*" {
		if strings.TrimSpace(input.ProxyURL) != "" {
			proxyURL = strings.TrimSpace(input.ProxyURL)
		} else {
			serverCfg := ReadServerConfigEgress(ctx, g.mgr.aiHomeDir)
			proxyURL = ResolveServerProxyConfig(upstream.BaseURL, serverCfg)
		}
	}

	geo := g.mgr.geoCache.GetExitGeo(ctx, proxyURL, g.geoTTLMS, 4000)
	verdict := EvaluateNetworkExit(upCtx, geo, g.mgr.nowMS())
	if verdict == nil || verdict.Status != "denied" {
		return nil
	}
	return &GatewayNetworkDenial{
		Denied:   true,
		Error:    "egress_region_denied",
		Reason:   DescribeNetworkDenial(verdict, upstream.ID),
		Verdict:  verdict,
		Upstream: upstream,
	}
}

// TrafficEvidenceInput 描述真实流量（成功或地区拒绝）的上报上下文。
type TrafficEvidenceInput struct {
	Account              AccountRecord
	NodeName             string
	NodeID               string
	ExitIP               string
	ModelFamily          string
	CredentialGeneration string
	Reason               string
	RegionSignature      string
	Upstream             *UpstreamInfo
}

// TrafficEvidenceObserver 把真实请求流量写入带作用域的地区实测账本，并在地区拒绝时重排车道。
type TrafficEvidenceObserver struct {
	mgr                     *Manager
	promoteProviderEvidence bool

	mu       sync.Mutex
	recentOK map[string]int64
}

// NewTrafficEvidenceObserver 创建挂接在 Manager 上的流量证据观察器。
func NewTrafficEvidenceObserver(mgr *Manager, promoteProviderEvidence bool) *TrafficEvidenceObserver {
	return &TrafficEvidenceObserver{
		mgr:                     mgr,
		promoteProviderEvidence: promoteProviderEvidence,
		recentOK:                make(map[string]int64),
	}
}

type observerLaneContext struct {
	accountRef           string
	provider             string
	upstream             *UpstreamInfo
	identity             string
	exitIP               string
	modelFamily          string
	credentialGeneration string
}

func (o *TrafficEvidenceObserver) laneContext(ctx context.Context, input TrafficEvidenceInput) *observerLaneContext {
	if o == nil || o.mgr == nil {
		return nil
	}
	ref := strings.TrimSpace(input.Account.AccountRef)
	if ref == "" {
		return nil
	}
	nodeName := strings.TrimSpace(input.NodeName)
	if nodeName == "" {
		nodeName = o.mgr.CurrentAccountPoolNode(ctx, ref)
	}
	if nodeName == "" {
		return nil
	}
	identity := strings.TrimSpace(input.NodeID)
	if identity == "" {
		if info, ok := o.mgr.health.NodeInfo(nodeName); ok {
			identity = firstNonEmpty(info.NodeID, info.Identity)
		}
	}
	if identity == "" {
		identity = o.mgr.health.IdentityOf(nodeName)
	}
	upstream := input.Upstream
	if upstream == nil {
		overrides := ReadServerUpstreamOverrides(ctx, o.mgr.aiHomeDir)
		upstream = ResolveAccountUpstream(overrides, input.Account)
	}
	if identity == "" || upstream == nil {
		return nil
	}
	provider := strings.ToLower(firstNonEmpty(input.Account.Provider, upstream.Provider))
	exitIP := strings.TrimSpace(input.ExitIP)
	if exitIP == "" {
		if g := o.mgr.health.GeoOf(nodeName); g != nil {
			exitIP = g.IP
		}
	}
	modelFamily := strings.ToLower(strings.TrimSpace(input.ModelFamily))
	return &observerLaneContext{
		accountRef:           ref,
		provider:             provider,
		upstream:             upstream,
		identity:             identity,
		exitIP:               exitIP,
		modelFamily:          modelFamily,
		credentialGeneration: strings.TrimSpace(input.CredentialGeneration),
	}
}

func (c *observerLaneContext) recentKey() string {
	return strings.Join([]string{
		c.accountRef, c.provider, c.upstream.ID, c.identity, c.exitIP, c.modelFamily, c.credentialGeneration,
	}, "|")
}

// OnRegionDenied 记录地区拒绝实测并立即重排车道；返回 true 表示出口已兜底处理（不给账号挂冷却）。
func (o *TrafficEvidenceObserver) OnRegionDenied(ctx context.Context, input TrafficEvidenceInput) bool {
	lc := o.laneContext(ctx, input)
	if lc == nil {
		return false
	}
	reason := strings.TrimSpace(input.Reason)
	if reason == "" {
		sig := strings.TrimSpace(input.RegionSignature)
		if sig == "" {
			sig = "region_denied"
		}
		reason = "traffic:" + sig
	}
	nowMS := o.mgr.nowMS()
	o.mgr.evidence.RecordEvidence(ctx, UpstreamEvidenceEntry{
		Scope:                ScopeAccountUpstream,
		Provider:             lc.provider,
		UpstreamID:           lc.upstream.ID,
		NodeID:               lc.identity,
		ExitIP:               lc.exitIP,
		ModelFamily:          lc.modelFamily,
		AccountRef:           lc.accountRef,
		CredentialGeneration: lc.credentialGeneration,
		Status:               "blocked",
		Reason:               reason,
		Source:               "traffic",
		Confidence:           1,
		UsableForBlocking:    true,
		At:                   nowMS,
	})

	o.mu.Lock()
	delete(o.recentOK, lc.recentKey())
	o.mu.Unlock()

	if o.promoteProviderEvidence {
		o.mgr.evidence.RecordEvidence(ctx, UpstreamEvidenceEntry{
			Scope:             ScopeProviderExit,
			Provider:          lc.provider,
			UpstreamID:        lc.upstream.ID,
			NodeID:            lc.identity,
			ExitIP:            lc.exitIP,
			ModelFamily:       lc.modelFamily,
			Status:            "blocked",
			Reason:            reason,
			Source:            "traffic",
			Confidence:        1,
			UsableForBlocking: true,
			At:                nowMS,
		})
	}
	_ = o.mgr.ReconcileLanes(ctx)
	return true
}

// OnSuccess 在实测有效期内去重写入经该节点 × 上游请求成功的证据。
func (o *TrafficEvidenceObserver) OnSuccess(ctx context.Context, input TrafficEvidenceInput) {
	lc := o.laneContext(ctx, input)
	if lc == nil {
		return
	}
	nowMS := o.mgr.nowMS()
	ttlMS := ReadUpstreamPolicy(ctx, o.mgr.aiHomeDir, lc.upstream.ID).EvidenceTTLMS
	if ttlMS <= 0 {
		ttlMS = DefaultEvidenceTTLMS
	}
	key := lc.recentKey()
	o.mu.Lock()
	if last := o.recentOK[key]; last > 0 && nowMS-last < ttlMS/2 {
		o.mu.Unlock()
		return
	}
	o.recentOK[key] = nowMS
	o.mu.Unlock()

	o.mgr.evidence.RecordEvidence(ctx, UpstreamEvidenceEntry{
		Scope:                ScopeAccountUpstream,
		Provider:             lc.provider,
		UpstreamID:           lc.upstream.ID,
		NodeID:               lc.identity,
		ExitIP:               lc.exitIP,
		ModelFamily:          lc.modelFamily,
		AccountRef:           lc.accountRef,
		CredentialGeneration: lc.credentialGeneration,
		Status:               "ok",
		Reason:               "traffic_ok",
		Source:               "traffic",
		Confidence:           1,
		At:                   nowMS,
	})
}

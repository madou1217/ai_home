package egress

import (
	"context"
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"

	agyegress "github.com/madou1217/ai_home/internal/adapters/agy/egress"
)

const (
	// SyncUpstreamProbeLimit 是同步探测节点的数量上限，超过转为后台任务。
	SyncUpstreamProbeLimit = 12
	// MaxUpstreamProbeNodes 是单次探测允许的最大节点数。
	MaxUpstreamProbeNodes = 200
)

var accountRefRegex = regexp.MustCompile(`^acct_[a-f0-9]{20}$`)

// IsAccountRef 校验公开账号引用格式（acct_ + 20 位小写十六进制）。
func IsAccountRef(value string) bool {
	return accountRefRegex.MatchString(strings.TrimSpace(value))
}

// UpstreamPolicyPatch 描述 PUT /egress-upstreams/{id} 的局部更新载荷。
type UpstreamPolicyPatch struct {
	Rules             *[]UpstreamRule `json:"rules,omitempty"`
	EvidenceTTLMS     *int64          `json:"evidenceTtlMs,omitempty"`
	CredentialedProbe *bool           `json:"credentialedProbe,omitempty"`
}

// UpstreamVerdictView 是上游矩阵里单节点判定的展示对象。
type UpstreamVerdictView struct {
	Status string `json:"status"`
	Source string `json:"source"`
	Detail string `json:"detail"`
	Soft   bool   `json:"soft"`
	RuleID string `json:"ruleId"`
}

// UpstreamNodeRowView 是上游视图里的单行节点。
type UpstreamNodeRowView struct {
	Name     string                 `json:"name"`
	Identity string                 `json:"identity"`
	Label    string                 `json:"label"`
	Geo      *GeoLocation           `json:"geo"`
	GeoText  string                 `json:"geoText"`
	Groups   []string               `json:"groups"`
	Verdict  UpstreamVerdictView    `json:"verdict"`
	Evidence *UpstreamEvidenceEntry `json:"evidence"`
}

// UpstreamAccountEgressSummary 是账号绑定的简明摘要。
type UpstreamAccountEgressSummary struct {
	Mode     string               `json:"mode"`
	Retired  bool                 `json:"retired"`
	Scope    *agyegress.PoolScope `json:"scope,omitempty"`
	Strategy string               `json:"strategy,omitempty"`
	ProxyURL string               `json:"proxyUrl,omitempty"`
}

// UpstreamAccountLaneView 是账号在池中的车道现状。
type UpstreamAccountLaneView struct {
	ActiveNode   string `json:"activeNode"`
	ActiveLabel  string `json:"activeLabel,omitempty"`
	Blocked      string `json:"blocked"`
	Strategy     string `json:"strategy,omitempty"`
	AllowedCount int    `json:"allowedCount"`
	ScopeCount   int    `json:"scopeCount"`
}

// UpstreamAccountNetworkView 是非池账号当前网络出口与地区判定。
type UpstreamAccountNetworkView struct {
	Exit     string       `json:"exit"`
	ProxyURL string       `json:"proxyUrl,omitempty"`
	Geo      *GeoLocation `json:"geo,omitempty"`
	GeoText  string       `json:"geoText,omitempty"`
	Stale    bool         `json:"stale,omitempty"`
	Status   string       `json:"status"`
	Source   string       `json:"source"`
	Detail   string       `json:"detail"`
}

// UpstreamAccountItem 是上游卡片下的单个账号状态。
type UpstreamAccountItem struct {
	AccountRef string                        `json:"accountRef"`
	Provider   string                        `json:"provider"`
	Label      string                        `json:"label"`
	Egress     *UpstreamAccountEgressSummary `json:"egress"`
	Lane       *UpstreamAccountLaneView      `json:"lane"`
	Network    *UpstreamAccountNetworkView   `json:"network"`
}

// UpstreamVerdictSummary 汇总节点判决计数。
type UpstreamVerdictSummary struct {
	Allowed int `json:"allowed"`
	Denied  int `json:"denied"`
	Pending int `json:"pending"`
	Unknown int `json:"unknown"`
}

// UpstreamViewItem 是单个上游的完整矩阵与账号视图。
type UpstreamViewItem struct {
	ID             string                  `json:"id"`
	Host           string                  `json:"host"`
	Providers      []string                `json:"providers"`
	Official       bool                    `json:"official"`
	Policy         UpstreamPolicy          `json:"policy"`
	EffectiveTTLMS int64                   `json:"effectiveTtlMs"`
	Hints          []UpstreamRule          `json:"hints"`
	Accounts       []UpstreamAccountItem   `json:"accounts"`
	UnboundCount   int                     `json:"unboundCount"`
	DeniedAccounts int                     `json:"deniedAccounts"`
	Nodes          []UpstreamNodeRowView   `json:"nodes"`
	Summary        UpstreamVerdictSummary  `json:"summary"`
	Evidence       []UpstreamEvidenceEntry `json:"evidence"`
}

// UpstreamGroupSummary 是自建分组摘要。
type UpstreamGroupSummary struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	ProfileName string `json:"profileName"`
	Size        int    `json:"size"`
}

// UpstreamPoolSection 是上游页顶部出口池摘要。
type UpstreamPoolSection struct {
	Ready        bool       `json:"ready"`
	NodeCount    int        `json:"nodeCount"`
	GeoKnown     int        `json:"geoKnown"`
	Lanes        []LaneView `json:"lanes"`
	LaneOverflow []string   `json:"laneOverflow"`
}

// DirectGeoSnapshot 是本机直连出口的地理位置摘要。
type DirectGeoSnapshot struct {
	Geo     GeoLocation `json:"geo"`
	GeoText string      `json:"geoText"`
	At      int64       `json:"at"`
	Stale   bool        `json:"stale"`
}

// NetworkSectionView 承载本机直连网络位置。
type NetworkSectionView struct {
	Direct *DirectGeoSnapshot `json:"direct"`
}

// EgressUpstreamsView 是 GET /egress-upstreams 的完整响应结构。
type EgressUpstreamsView struct {
	OK         bool                   `json:"ok"`
	Upstreams  []UpstreamViewItem     `json:"upstreams"`
	Groups     []UpstreamGroupSummary `json:"groups"`
	Pool       UpstreamPoolSection    `json:"pool"`
	Network    NetworkSectionView     `json:"network"`
	ServerTime int64                  `json:"serverTime"`
	Probing    bool                   `json:"probing"`
}

// UpstreamProbeHTTPResult 是 POST /egress-upstreams/{id}/probe 的响应体。
type UpstreamProbeHTTPResult struct {
	OK             bool                  `json:"ok"`
	Error          string                `json:"error,omitempty"`
	Results        []UpstreamProbeResult `json:"results,omitempty"`
	Background     bool                  `json:"background,omitempty"`
	AlreadyRunning bool                  `json:"alreadyRunning,omitempty"`
	Count          int                   `json:"count,omitempty"`
}

func bindingSummaryFromRecord(b *agyegress.Binding) *UpstreamAccountEgressSummary {
	if b == nil {
		return nil
	}
	out := &UpstreamAccountEgressSummary{
		Mode:    b.Mode,
		Retired: b.Retired,
	}
	if b.Mode == agyegress.ModePool {
		out.Scope = b.PoolScope
		out.Strategy = b.PoolStrategy
	}
	if b.Mode == agyegress.ModeURL {
		out.ProxyURL = RedactProxyURL(b.ProxyURL)
	}
	return out
}

func networkExitFor(binding *agyegress.Binding, upstream *UpstreamInfo, cfg ServerConfigEgress) (kind string, proxyURL string, include bool) {
	if binding != nil {
		switch binding.Mode {
		case agyegress.ModePool:
			return "", "", false
		case agyegress.ModeSystem:
			return "system", "", true
		case agyegress.ModeURL:
			return "proxy", strings.TrimSpace(binding.ProxyURL), true
		case agyegress.ModeTUN, agyegress.ModeDirect:
			return "direct", "", true
		}
	}
	resolved := ResolveServerProxyConfig(upstream.BaseURL, cfg)
	if resolved != "" {
		return "proxy", resolved, true
	}
	return "direct", "", true
}

// BuildUpstreamsView 构建与 Node buildEgressUpstreamView 完全对齐的上游策略与节点判定视图。
func (m *Manager) BuildUpstreamsView(ctx context.Context, accountRefFilter string) (*EgressUpstreamsView, error) {
	snap, err := m.loadRuntimeSnapshot(ctx)
	if err != nil {
		return nil, err
	}
	nowMS := m.nowMS()
	accountsList, _ := ListKnownAccounts(ctx, m.aiHomeDir)
	bindingsList, _ := ReadAccountEgressBindings(ctx, m.aiHomeDir)
	assignmentsList := m.assignments.ListAssignments(ctx)
	overrides := ReadServerUpstreamOverrides(ctx, m.aiHomeDir)
	srvCfg := ReadServerConfigEgress(ctx, m.aiHomeDir)

	accountsByRef := make(map[string]AccountRecord, len(accountsList))
	for _, acc := range accountsList {
		if acc.AccountRef != "" {
			if _, exists := accountsByRef[acc.AccountRef]; !exists {
				accountsByRef[acc.AccountRef] = acc
			}
		}
	}
	bindingsByRef := make(map[string]agyegress.Binding, len(bindingsList))
	for _, rec := range bindingsList {
		if rec.AccountRef != "" {
			bindingsByRef[rec.AccountRef] = rec.Binding
		}
	}

	blockedMap := make(map[string]bool)
	nodeLabelByName := make(map[string]string, len(snap.snapshots))
	for _, s := range snap.snapshots {
		nodeLabelByName[s.Name] = s.Label
		if s.Blocked {
			blockedMap[s.Name] = true
		}
	}
	laneSlots := DefaultLaneSlots
	if snap.cfg != nil && len(snap.cfg.LanePorts) > 0 {
		laneSlots = len(snap.cfg.LanePorts)
	}
	planResult := ComputeEgressPlan(ctx, PlanInput{
		AIHomeDir:   m.aiHomeDir,
		Accounts:    accountsList,
		Overrides:   overrides,
		Nodes:       snap.plannerNode,
		Catalog:     snap.catalog,
		Blocked:     blockedMap,
		LaneSlots:   laneSlots,
		Bindings:    bindingsList,
		Assignments: assignmentsList,
		Evidence:    m.evidence,
		NowMS:       nowMS,
	})

	laneByAccount := make(map[string]LaneView)
	for _, lv := range snap.lanes {
		for _, ref := range lv.Accounts {
			if _, exists := laneByAccount[ref]; !exists {
				laneByAccount[ref] = lv
			}
		}
	}

	upstreams := ListUpstreams(overrides, accountsList)
	filterRef := strings.TrimSpace(accountRefFilter)
	if filterRef != "" {
		filtered := make([]*UpstreamInfo, 0, len(upstreams))
		for _, u := range upstreams {
			for _, ref := range u.Accounts {
				if ref == filterRef {
					filtered = append(filtered, u)
					break
				}
			}
		}
		upstreams = filtered
	}

	viewItems := make([]UpstreamViewItem, 0, len(upstreams))
	for _, upstream := range upstreams {
		dc := ReadUpstreamDecisionContext(ctx, m.aiHomeDir, upstream)
		dc.ScopedEvidence = m.evidence.ListEvidence(ctx, ScopedEvidenceQuery{
			UpstreamID:    upstream.ID,
			IncludeLegacy: false,
		})
		ttlMS := dc.TTLMS
		if ttlMS <= 0 {
			ttlMS = DefaultEvidenceTTLMS
		}
		verdicts := EvaluateNodesForUpstream(dc, upstream, upstream.Provider, "", snap.plannerNode, nowMS)
		nodeRows := make([]UpstreamNodeRowView, 0, len(snap.plannerNode))
		summary := UpstreamVerdictSummary{}

		for _, node := range snap.plannerNode {
			v, ok := verdicts[node.Name]
			if !ok {
				v = ExitVerdict{Status: "unknown", Source: "none"}
			}
			// 位置已知且未命中拒绝规则/实测否定：界面与规划统一显示为「允许（未实测）」。
			if v.Status == "unknown" && !v.GeoPending && node.Geo != nil && strings.TrimSpace(node.Geo.Country) != "" {
				v.Status = "allowed"
				v.Source = "geo"
				v.Soft = true
				v.Detail = "位置未命中拒绝规则（未实测）"
			}
			var evCopy *UpstreamEvidenceEntry
			if rawEv, hasEv := dc.Evidence[NodeExitKey(node.Identity)]; hasEv {
				c := rawEv
				c.Expired = rawEv.At+ttlMS <= nowMS
				evCopy = &c
			}
			displayStatus := v.Status
			detail := v.Detail
			if v.GeoPending {
				displayStatus = "pending"
				detail = "等待查询出口位置"
			}
			switch displayStatus {
			case "allowed":
				summary.Allowed++
			case "denied":
				summary.Denied++
			case "pending":
				summary.Pending++
			default:
				summary.Unknown++
			}
			soft := v.Soft || (v.Evidence != nil && v.Evidence.Status == "reachable")
			groupsList := make([]string, 0, len(node.Groups))
			for gid := range node.Groups {
				groupsList = append(groupsList, gid)
			}
			sort.Strings(groupsList)
			nodeRows = append(nodeRows, UpstreamNodeRowView{
				Name:     node.Name,
				Identity: node.Identity,
				Label:    node.Label,
				Geo:      node.Geo,
				GeoText:  DescribeGeo(node.Geo),
				Groups:   groupsList,
				Verdict: UpstreamVerdictView{
					Status: displayStatus,
					Source: v.Source,
					Detail: detail,
					Soft:   soft,
					RuleID: v.RuleID,
				},
				Evidence: evCopy,
			})
		}

		accountItems := make([]UpstreamAccountItem, 0, len(upstream.Accounts))
		unboundCount := 0
		deniedAccounts := 0
		for _, ref := range upstream.Accounts {
			acc, hasAcc := accountsByRef[ref]
			if !hasAcc {
				acc = AccountRecord{AccountRef: ref}
			}
			var bindingPtr *agyegress.Binding
			if b, hasB := bindingsByRef[ref]; hasB {
				bc := b
				bindingPtr = &bc
			} else {
				unboundCount++
			}
			planInfo := planResult.Accounts[ref]

			var laneView *UpstreamAccountLaneView
			if lv, hasLane := laneByAccount[ref]; hasLane {
				allowedCount := 0
				scopeCount := 0
				if planInfo != nil {
					allowedCount = planInfo.Allowed
					scopeCount = planInfo.InScope
				}
				laneView = &UpstreamAccountLaneView{
					ActiveNode:   lv.ActiveNode,
					ActiveLabel:  nodeLabelByName[lv.ActiveNode],
					Blocked:      lv.Blocked,
					Strategy:     lv.Strategy,
					AllowedCount: allowedCount,
					ScopeCount:   scopeCount,
				}
			} else if planInfo != nil {
				blocked := planInfo.BlockedReason
				if blocked == "" {
					blocked = "egress_pool_lane_not_ready"
				}
				laneView = &UpstreamAccountLaneView{
					ActiveNode:   "",
					Blocked:      blocked,
					AllowedCount: planInfo.Allowed,
					ScopeCount:   planInfo.InScope,
				}
			}

			var netView *UpstreamAccountNetworkView
			exitKind, proxyURL, include := networkExitFor(bindingPtr, upstream, srvCfg)
			if include && exitKind != "system" {
				geoEntry := m.geoCache.PeekExitGeo(proxyURL)
				netVerdict := EvaluateNetworkExit(dc, geoEntry, nowMS)
				var g *GeoLocation
				gText := ""
				stale := false
				if geoEntry != nil {
					gc := geoEntry.Geo
					g = &gc
					gText = DescribeGeo(g)
					stale = geoEntry.Stale
				}
				status := "allowed"
				source := "none"
				detail := "该上游没有地区规则"
				if netVerdict != nil {
					status = netVerdict.Status
					source = netVerdict.Source
					detail = netVerdict.Detail
				}
				if status == "denied" {
					deniedAccounts++
				}
				netView = &UpstreamAccountNetworkView{
					Exit:     exitKind,
					ProxyURL: RedactProxyURL(proxyURL),
					Geo:      g,
					GeoText:  gText,
					Stale:    stale,
					Status:   status,
					Source:   source,
					Detail:   detail,
				}
			} else if include {
				netView = &UpstreamAccountNetworkView{
					Exit:   "system",
					Status: "unknown",
					Source: "none",
					Detail: "系统代理的出口位置在请求时判定",
				}
			}

			accountItems = append(accountItems, UpstreamAccountItem{
				AccountRef: ref,
				Provider:   strings.TrimSpace(acc.Provider),
				Label:      acc.AccountLabel(),
				Egress:     bindingSummaryFromRecord(bindingPtr),
				Lane:       laneView,
				Network:    netView,
			})
		}

		evidenceList := make([]UpstreamEvidenceEntry, 0, len(dc.Evidence))
		for exitKey, entry := range dc.Evidence {
			item := entry
			item.ExitKey = exitKey
			item.Expired = entry.At+ttlMS <= nowMS
			for _, row := range nodeRows {
				if NodeExitKey(row.Identity) == exitKey {
					item.Node = row.Label
					break
				}
			}
			evidenceList = append(evidenceList, item)
		}
		sort.Slice(evidenceList, func(i, j int) bool {
			return evidenceList[i].At > evidenceList[j].At
		})

		providers := upstream.Providers
		if providers == nil {
			providers = []string{}
		}
		hints := dc.Hints
		if hints == nil {
			hints = []UpstreamRule{}
		}

		viewItems = append(viewItems, UpstreamViewItem{
			ID:             upstream.ID,
			Host:           upstream.Host,
			Providers:      providers,
			Official:       upstream.Official,
			Policy:         dc.Policy,
			EffectiveTTLMS: ttlMS,
			Hints:          hints,
			Accounts:       accountItems,
			UnboundCount:   unboundCount,
			DeniedAccounts: deniedAccounts,
			Nodes:          nodeRows,
			Summary:        summary,
			Evidence:       evidenceList,
		})
	}

	groupSummaries := make([]UpstreamGroupSummary, 0, len(snap.catalog))
	for _, g := range snap.catalog {
		groupSummaries = append(groupSummaries, UpstreamGroupSummary{
			ID:          g.ID,
			Name:        g.Name,
			ProfileName: g.ProfileName,
			Size:        len(g.Identities),
		})
	}

	geoKnown := 0
	for _, n := range snap.plannerNode {
		if n.Geo != nil && strings.TrimSpace(n.Geo.Country) != "" {
			geoKnown++
		}
	}

	directEntry := m.geoCache.PeekExitGeo("")
	var directSnap *DirectGeoSnapshot
	if directEntry != nil {
		directSnap = &DirectGeoSnapshot{
			Geo:     directEntry.Geo,
			GeoText: DescribeGeo(&directEntry.Geo),
			At:      directEntry.At,
			Stale:   directEntry.Stale,
		}
	}
	if !m.disableAutoDirectGeo && (directEntry == nil || directEntry.Stale) {
		go func() {
			bgCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			_, _ = m.geoCache.RefreshExitGeo(bgCtx, "")
		}()
	}

	m.probeJobMu.Lock()
	probing := m.backgroundProbe
	m.probeJobMu.Unlock()

	lanesOut := snap.lanes
	if lanesOut == nil {
		lanesOut = []LaneView{}
	}
	overflowOut := snap.overflow
	if overflowOut == nil {
		overflowOut = []string{}
	}

	return &EgressUpstreamsView{
		OK:        true,
		Upstreams: viewItems,
		Groups:    groupSummaries,
		Pool: UpstreamPoolSection{
			Ready:        snap.ready,
			NodeCount:    len(snap.plannerNode),
			GeoKnown:     geoKnown,
			Lanes:        lanesOut,
			LaneOverflow: overflowOut,
		},
		Network:    NetworkSectionView{Direct: directSnap},
		ServerTime: nowMS,
		Probing:    probing,
	}, nil
}

// RefreshDirectNetworkGeo 强制重新查询本机当前出口位置。
func (m *Manager) RefreshDirectNetworkGeo(ctx context.Context) (*NetworkGeoEntry, error) {
	entry, err := m.geoCache.RefreshExitGeo(ctx, "")
	if err != nil {
		return nil, err
	}
	m.EmitChanged("network")
	return entry, nil
}

// UpdateUpstreamPolicy 更新指定上游的地区规则、实测有效期与探测配置。
func (m *Manager) UpdateUpstreamPolicy(ctx context.Context, upstreamID string, patch UpstreamPolicyPatch) (UpstreamPolicy, error) {
	id := NormalizeUpstreamID(upstreamID)
	if id == "" {
		return UpstreamPolicy{}, fmt.Errorf("invalid_upstream_id")
	}
	current := ReadUpstreamPolicy(ctx, m.aiHomeDir, id)
	next := current
	if patch.Rules != nil {
		next.Rules = *patch.Rules
	}
	if patch.EvidenceTTLMS != nil {
		next.EvidenceTTLMS = *patch.EvidenceTTLMS
	}
	if patch.CredentialedProbe != nil {
		next.CredentialedProbe = *patch.CredentialedProbe
	}
	written, err := WriteUpstreamPolicy(ctx, m.aiHomeDir, id, next, m.nowMS())
	if err != nil {
		return UpstreamPolicy{}, err
	}
	_ = m.ReconcileLanes(ctx)
	m.EmitChanged("policy")
	return written, nil
}

func (m *Manager) findUpstream(ctx context.Context, upstreamID string) (*UpstreamInfo, bool) {
	id := NormalizeUpstreamID(upstreamID)
	if id == "" {
		return nil, false
	}
	accounts, _ := ListKnownAccounts(ctx, m.aiHomeDir)
	overrides := ReadServerUpstreamOverrides(ctx, m.aiHomeDir)
	for _, u := range ListUpstreams(overrides, accounts) {
		if u.ID == id {
			return u, true
		}
	}
	return nil, false
}

// ResetUpstreamEvidence 清空指定上游（或指定 exitKeys）的历史实测记录。
func (m *Manager) ResetUpstreamEvidence(ctx context.Context, upstreamID string, exitKeys []string) (int, int, string) {
	upstream, ok := m.findUpstream(ctx, upstreamID)
	if !ok {
		return 0, http.StatusNotFound, "upstream_not_found"
	}
	removed := ResetUpstreamEvidence(ctx, m.aiHomeDir, upstream.ID, exitKeys, m.nowMS())
	_ = m.ReconcileLanes(ctx)
	m.EmitChanged("evidence-reset")
	return removed, http.StatusOK, ""
}

// StartUpstreamProbe 对指定上游启动同步或后台节点探测。
func (m *Manager) StartUpstreamProbe(ctx context.Context, upstreamID string, requestedNodes []string) (UpstreamProbeHTTPResult, int) {
	upstream, ok := m.findUpstream(ctx, upstreamID)
	if !ok {
		return UpstreamProbeHTTPResult{OK: false, Error: "upstream_not_found"}, http.StatusNotFound
	}
	snap, err := m.loadRuntimeSnapshot(ctx)
	if err != nil || !snap.ready {
		return UpstreamProbeHTTPResult{OK: false, Error: "egress_pool_not_ready"}, http.StatusConflict
	}

	knownSet := make(map[string]bool, len(snap.snapshots))
	allNames := make([]string, 0, len(snap.snapshots))
	for _, s := range snap.snapshots {
		knownSet[s.Name] = true
		allNames = append(allNames, s.Name)
	}

	var names []string
	if len(requestedNodes) > 0 {
		for _, raw := range requestedNodes {
			name := strings.TrimSpace(raw)
			if name != "" && knownSet[name] {
				names = append(names, name)
				if len(names) >= MaxUpstreamProbeNodes {
					break
				}
			}
		}
	} else {
		if len(allNames) > MaxUpstreamProbeNodes {
			names = append(names, allNames[:MaxUpstreamProbeNodes]...)
		} else {
			names = allNames
		}
	}

	if len(names) == 0 {
		return UpstreamProbeHTTPResult{OK: false, Error: "no_nodes_to_probe"}, http.StatusBadRequest
	}

	runBatch := func(runCtx context.Context) []UpstreamProbeResult {
		results := make([]UpstreamProbeResult, 0, len(names))
		for _, name := range names {
			geo, _ := m.LookupNodeGeo(runCtx, name, false)
			res := m.ProbeUpstreamViaNode(runCtx, upstream, name)
			res.Geo = geo
			results = append(results, res)
		}
		_ = m.ReconcileLanes(runCtx)
		m.EmitChanged("probe")
		return results
	}

	if len(names) <= SyncUpstreamProbeLimit {
		results := runBatch(ctx)
		return UpstreamProbeHTTPResult{OK: true, Results: results}, http.StatusOK
	}

	m.probeJobMu.Lock()
	if m.backgroundProbe {
		m.probeJobMu.Unlock()
		return UpstreamProbeHTTPResult{
			OK:             true,
			Background:     true,
			AlreadyRunning: true,
			Count:          len(names),
		}, http.StatusAccepted
	}
	m.backgroundProbe = true
	m.probeJobMu.Unlock()

	go func() {
		defer func() {
			m.probeJobMu.Lock()
			m.backgroundProbe = false
			m.probeJobMu.Unlock()
		}()
		bgCtx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		_ = runBatch(bgCtx)
	}()

	return UpstreamProbeHTTPResult{
		OK:         true,
		Background: true,
		Count:      len(names),
	}, http.StatusAccepted
}

// ValidateAccountPath 校验账号级出口 API 的 provider 与 accountRef 路径参数。
func (m *Manager) ValidateAccountPath(ctx context.Context, provider string, accountRef string) (*AccountRecord, int, string) {
	normProvider := strings.ToLower(strings.TrimSpace(provider))
	normRef := strings.TrimSpace(accountRef)
	if normProvider == "" || !IsAccountRef(normRef) {
		return nil, http.StatusBadRequest, "invalid_account_path"
	}
	acc, found, err := ResolveAccount(ctx, m.aiHomeDir, normRef)
	if err != nil || !found {
		return nil, http.StatusNotFound, "account_not_found"
	}
	if strings.ToLower(strings.TrimSpace(acc.Provider)) != normProvider {
		return nil, http.StatusConflict, "account_provider_mismatch"
	}
	acc.AccountRef = normRef
	acc.Provider = normProvider
	return &acc, http.StatusOK, ""
}

// BuildAccountEgressRuntimeView 组装单账号出口运行时与最近实测视图。
func (m *Manager) BuildAccountEgressRuntimeView(ctx context.Context, account AccountRecord) map[string]any {
	assignment, _ := m.assignments.GetAssignment(ctx, account.AccountRef)
	snap, _ := m.loadRuntimeSnapshot(ctx)

	var matchedLane *LaneView
	var nodeInfo map[string]any
	nodeID := ""
	runtimeName := ""
	proxyURL := ""
	if snap != nil {
		for _, lv := range snap.lanes {
			for _, ref := range lv.Accounts {
				if ref == account.AccountRef {
					copyLV := lv
					matchedLane = &copyLV
					break
				}
			}
			if matchedLane != nil {
				break
			}
		}
		if matchedLane != nil {
			runtimeName = strings.TrimSpace(matchedLane.ActiveNode)
			proxyURL = strings.TrimSpace(matchedLane.ProxyURL)
			for _, s := range snap.snapshots {
				if s.Name == runtimeName && runtimeName != "" {
					nodeID = s.NodeID
					nodeInfo = map[string]any{
						"nodeId":      s.NodeID,
						"identity":    s.Identity,
						"name":        s.Name,
						"runtimeName": s.Name,
						"label":       s.Label,
						"protocol":    s.Protocol,
						"server":      s.Server,
						"port":        s.Port,
					}
					break
				}
			}
			if nodeID == "" {
				nodeID = matchedLane.ActiveNodeID
			}
		}
	}

	var lanePayload any = nil
	if matchedLane != nil {
		laneMap := map[string]any{
			"index":        matchedLane.Index,
			"key":          matchedLane.Key,
			"proxyUrl":     matchedLane.ProxyURL,
			"activeNode":   matchedLane.ActiveNode,
			"activeNodeId": matchedLane.ActiveNodeID,
			"allowedCount": matchedLane.AllowedCount,
			"accounts":     matchedLane.Accounts,
			"strategy":     matchedLane.Strategy,
			"upstream":     matchedLane.Upstream,
			"blocked":      matchedLane.Blocked,
			"accountRef":   account.AccountRef,
			"nodeId":       nodeID,
		}
		if matchedLane.SessionSlot != nil {
			laneMap["sessionSlot"] = *matchedLane.SessionSlot
		}
		lanePayload = laneMap
	}

	evidence := m.evidence.ListEvidence(ctx, ScopedEvidenceQuery{
		AccountRef:    account.AccountRef,
		Provider:      account.Provider,
		IncludeLegacy: false,
	})
	if evidence == nil {
		evidence = []UpstreamEvidenceEntry{}
	}
	var verdictPayload any = nil
	if len(evidence) > 0 {
		latest := evidence[len(evidence)-1]
		status := "unknown"
		if latest.Status == "blocked" {
			status = "denied"
		} else if latest.Status == "ok" {
			status = "allowed"
		}
		verdictPayload = map[string]any{
			"status":   status,
			"evidence": latest,
		}
	}

	return map[string]any{
		"accountRef":  account.AccountRef,
		"assignment":  assignment,
		"lane":        lanePayload,
		"node":        nodeInfo,
		"nodeId":      nodeID,
		"runtimeName": runtimeName,
		"proxyUrl":    proxyURL,
		"exitIp":      "",
		"evidence":    evidence,
		"verdict":     verdictPayload,
	}
}

// GetAccountEgressRuntime 返回 GET /accounts/{provider}/{accountRef}/egress-runtime 完整响应体。
func (m *Manager) GetAccountEgressRuntime(ctx context.Context, account AccountRecord) map[string]any {
	view := m.BuildAccountEgressRuntimeView(ctx, account)
	view["ok"] = true
	view["account"] = account
	return view
}

// PutAccountEgressAssignment 校验并写入账号出口池分配方案，同步触发车道重排。
func (m *Manager) PutAccountEgressAssignment(ctx context.Context, account AccountRecord, rawBody map[string]any) (map[string]any, int, string) {
	candidate := make(map[string]any)
	if sub, ok := rawBody["assignment"].(map[string]any); ok {
		for k, v := range sub {
			candidate[k] = v
		}
	} else {
		for k, v := range rawBody {
			candidate[k] = v
		}
	}
	candidate["accountRef"] = account.AccountRef
	assignment, err := NormalizeAccountEgressAssignmentFromMap(candidate)
	if err != nil {
		if code := errorsIsContractCode(err); code != "" {
			return nil, http.StatusBadRequest, code
		}
		return nil, http.StatusBadRequest, "invalid_assignment"
	}

	store := agyegress.NewStore(m.aiHomeDir)
	if _, err := store.Replace(ctx, account.AccountRef, agyegress.ModePool, "", assignment.Scope, assignment.Strategy); err != nil {
		return nil, http.StatusConflict, err.Error()
	}
	_ = m.entities.PutAssignment(ctx, assignment)
	_ = m.ReconcileLanes(ctx)
	m.EmitChanged("assignment")

	current, _ := m.assignments.GetAssignment(ctx, account.AccountRef)
	if current == nil {
		c := assignment
		current = &c
	}
	return map[string]any{
		"ok":         true,
		"assignment": current,
		"runtime":    m.BuildAccountEgressRuntimeView(ctx, account),
		"apply": map[string]any{
			"ok":      true,
			"applied": true,
			"status":  "applied",
		},
	}, http.StatusOK, ""
}

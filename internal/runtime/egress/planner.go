package egress

import (
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	agyegress "github.com/madou1217/ai_home/internal/adapters/agy/egress"
)

const (
	// SessionLaneLimit 与 Node EGRESS_POOL_SESSION_LANES 对齐：单个 session 策略账号最多预留 4 条车道。
	SessionLaneLimit = 4
	// DefaultLaneSlots 与 Node EGRESS_POOL_LANE_SLOTS 对齐：默认共 16 条车道。
	DefaultLaneSlots = 16
)

var plannerGeoFields = []string{"country", "region", "city", "asn", "cidr"}

// PlannerNode 是规划器与上游视图共用的节点视图（含位置与自建分组）。
type PlannerNode struct {
	Name     string
	NodeID   string
	Identity string
	Label    string
	Geo      *GeoLocation
	Groups   map[string]bool
}

// LanePlanSpec 描述一条待分配的出口池车道。
type LanePlanSpec struct {
	Key           string   `json:"key"`
	Accounts      []string `json:"accounts"`
	Allowed       []string `json:"allowed"`
	ScopeNames    []string `json:"scopeNames"`
	AvoidGroup    string   `json:"avoidGroup"`
	Strategy      string   `json:"strategy"`
	Upstream      string   `json:"upstream"`
	BlockedReason string   `json:"blockedReason"`
	SessionSlot   int      `json:"sessionSlot"`
}

// AccountPlanInfo 汇总单个绑定出口池的账号规划结论。
type AccountPlanInfo struct {
	AccountRef          string `json:"accountRef"`
	Provider            string `json:"provider"`
	Upstream            string `json:"upstream"`
	Strategy            string `json:"strategy"`
	Key                 string `json:"key"`
	SharedKey           string `json:"sharedKey"`
	ScopeKind           string `json:"scopeKind"`
	InScope             int    `json:"inScope"`
	Allowed             int    `json:"allowed"`
	Denied              int    `json:"denied"`
	Pending             int    `json:"pending"`
	BlockedCount        int    `json:"blockedCount"`
	BlockedReason       string `json:"blockedReason"`
	SessionLanesReduced bool   `json:"sessionLanesReduced,omitempty"`
	Downgraded          bool   `json:"downgraded,omitempty"`
}

// PlannedEgressResult 是单次车道规划的完整输出。
type PlannedEgressResult struct {
	Plan      []LanePlanSpec
	Accounts  map[string]*AccountPlanInfo
	Nodes     []PlannerNode
	Upstreams map[string]*UpstreamInfo
}

func ruleHasGeoField(rule UpstreamRule) bool {
	m := rule.Match
	return len(m.Country) > 0 || len(m.Region) > 0 || len(m.City) > 0 || len(m.ASN) > 0 || len(m.CIDR) > 0
}

// ScopeKey 计算节点范围的稳定指纹。
func ScopeKey(scope agyegress.PoolScope) string {
	kind := strings.TrimSpace(scope.Kind)
	if kind == "" {
		kind = "all"
	}
	if kind == "all" {
		return "all"
	}
	var src []string
	if kind == "groups" {
		src = scope.Groups
	} else {
		src = scope.Nodes
	}
	items := append([]string(nil), src...)
	sort.Strings(items)
	sum := sha1.Sum([]byte(strings.Join(items, "\n")))
	return fmt.Sprintf("%s-%s", kind, hex.EncodeToString(sum[:])[:10])
}

// SharedLaneKey 生成共享车道的稳定键：同一上游、provider、范围且可用节点集合一致才共享。
func SharedLaneKey(upstreamID string, provider string, scope agyegress.PoolScope, allowed []string) string {
	sorted := make([]string, len(allowed))
	copy(sorted, allowed)
	sort.Strings(sorted)
	encoded, _ := json.Marshal(sorted)
	sum := sha256.Sum256(encoded)
	return fmt.Sprintf("shared:%s:%s:%s:%s",
		strings.TrimSpace(upstreamID),
		strings.ToLower(strings.TrimSpace(provider)),
		ScopeKey(scope),
		hex.EncodeToString(sum[:])[:20],
	)
}

// SessionLaneKey 生成会话独占车道的键。
func SessionLaneKey(accountRef string, slot int) string {
	return fmt.Sprintf("session:%s:%d", strings.TrimSpace(accountRef), slot)
}

// EvaluateNodesForUpstream 评估指定上游下每个节点的放行/拒绝/待定位结论（规划器与 WebUI 共用）。
func EvaluateNodesForUpstream(
	ctx *UpstreamDecisionContext,
	upstream *UpstreamInfo,
	provider string,
	accountRef string,
	nodes []PlannerNode,
	nowMS int64,
) map[string]ExitVerdict {
	out := make(map[string]ExitVerdict, len(nodes))
	if ctx == nil {
		return out
	}
	geoRules := false
	for _, r := range ctx.Policy.Rules {
		if ruleHasGeoField(r) {
			geoRules = true
			break
		}
	}
	if !geoRules {
		for _, h := range ctx.Hints {
			if ruleHasGeoField(h) {
				geoRules = true
				break
			}
		}
	}

	upstreamID := ""
	effectiveProvider := strings.TrimSpace(provider)
	if upstream != nil {
		upstreamID = upstream.ID
		if effectiveProvider == "" {
			effectiveProvider = upstream.Provider
		}
	} else if ctx.Upstream != nil {
		upstreamID = ctx.Upstream.ID
		if effectiveProvider == "" {
			effectiveProvider = ctx.Upstream.Provider
		}
	}

	var filteredScoped []UpstreamEvidenceEntry
	if len(ctx.ScopedEvidence) > 0 {
		for _, entry := range ctx.ScopedEvidence {
			if entry.AccountRef == "" || entry.AccountRef == accountRef {
				filteredScoped = append(filteredScoped, entry)
			}
		}
	}

	for _, node := range nodes {
		verdict := EvaluateExit(ExitEvaluationInput{
			Exit: ExitDescriptor{
				Identity: node.Identity,
				NodeID:   node.NodeID,
				Geo:      node.Geo,
				Groups:   node.Groups,
			},
			Rules:          ctx.Policy.Rules,
			Hints:          ctx.Hints,
			EvidenceMap:    ctx.Evidence,
			ScopedEvidence: filteredScoped,
			AccountRef:     accountRef,
			Provider:       effectiveProvider,
			UpstreamID:     upstreamID,
			NodeID:         node.NodeID,
			ExitKey:        NodeExitKey(node.Identity),
			EvidenceTTLMS:  ctx.TTLMS,
			NowMS:          nowMS,
		})
		// 位置未知 + 上游存在地区规则：只有节点级实测或节点规则能放行，否则先挂起。
		geoKnown := node.Geo != nil && strings.TrimSpace(node.Geo.Country) != ""
		verdict.GeoPending = geoRules && !geoKnown && verdict.Source == "none"
		out[node.Name] = verdict
	}
	return out
}

// PlanInput 描述一次车道规划所需的全部只读输入。
type PlanInput struct {
	AIHomeDir   string
	Accounts    []AccountRecord
	Overrides   ServerUpstreamOverrides
	Nodes       []PlannerNode
	Catalog     []CatalogGroup
	Blocked     map[string]bool
	LaneSlots   int
	Bindings    []AccountBindingRecord
	Assignments []AccountEgressAssignment
	Evidence    *EvidenceStore
	NowMS       int64
}

type planBindingEntry struct {
	accountRef   string
	provider     string
	scope        agyegress.PoolScope
	strategy     string
	pinnedNodeID string
}

// ComputeEgressPlan 计算出口池账号→车道映射表（纯计算 + 只读上下文）。
func ComputeEgressPlan(ctx context.Context, input PlanInput) PlannedEgressResult {
	nowMS := input.NowMS
	if nowMS <= 0 {
		nowMS = currentUnixMS()
	}
	byRef := make(map[string]AccountRecord, len(input.Accounts))
	for _, acc := range input.Accounts {
		ref := strings.TrimSpace(acc.AccountRef)
		if ref != "" {
			if _, ok := byRef[ref]; !ok {
				byRef[ref] = acc
			}
		}
	}

	legacyPoolByRef := make(map[string]AccountBindingRecord)
	var legacyOrder []AccountBindingRecord
	for _, rec := range input.Bindings {
		if rec.Binding.Mode == agyegress.ModePool && !rec.Binding.Retired {
			ref := strings.TrimSpace(rec.AccountRef)
			if ref != "" {
				legacyPoolByRef[ref] = rec
				legacyOrder = append(legacyOrder, rec)
			}
		}
	}

	var effectiveBindings []planBindingEntry
	seenRefs := make(map[string]bool)
	for _, a := range input.Assignments {
		ref := strings.TrimSpace(a.AccountRef)
		if ref == "" || seenRefs[ref] {
			continue
		}
		seenRefs[ref] = true
		provider := strings.TrimSpace(byRef[ref].Provider)
		if provider == "" {
			provider = strings.TrimSpace(legacyPoolByRef[ref].Provider)
		}
		scope := a.Scope
		if scope.Kind == "" {
			scope = agyegress.PoolScope{Kind: "all", Groups: []string{}, Nodes: []string{}}
		}
		effectiveBindings = append(effectiveBindings, planBindingEntry{
			accountRef:   ref,
			provider:     provider,
			scope:        scope,
			strategy:     a.Strategy,
			pinnedNodeID: strings.TrimSpace(a.PinnedNodeID),
		})
	}
	for _, rec := range legacyOrder {
		ref := strings.TrimSpace(rec.AccountRef)
		if ref == "" || seenRefs[ref] {
			continue
		}
		seenRefs[ref] = true
		scope := agyegress.PoolScope{Kind: "all", Groups: []string{}, Nodes: []string{}}
		if rec.Binding.PoolScope != nil {
			scope = *rec.Binding.PoolScope
		}
		effectiveBindings = append(effectiveBindings, planBindingEntry{
			accountRef: ref,
			provider:   strings.TrimSpace(rec.Provider),
			scope:      scope,
			strategy:   rec.Binding.PoolStrategy,
		})
	}

	groupIdentities := make(map[string]map[string]bool, len(input.Catalog))
	for _, g := range input.Catalog {
		set := make(map[string]bool, len(g.Identities))
		for _, id := range g.Identities {
			set[id] = true
		}
		groupIdentities[g.ID] = set
	}

	contexts := make(map[string]*UpstreamDecisionContext)
	verdictCache := make(map[string]map[string]ExitVerdict)
	perAccount := make(map[string]*AccountPlanInfo, len(effectiveBindings))
	lanesMap := make(map[string]*LanePlanSpec)
	var laneOrder []string
	upstreams := make(map[string]*UpstreamInfo)

	readContext := func(upstream *UpstreamInfo) *UpstreamDecisionContext {
		if upstream == nil {
			return nil
		}
		if cached, ok := contexts[upstream.ID]; ok {
			return cached
		}
		dc := ReadUpstreamDecisionContext(ctx, input.AIHomeDir, upstream)
		if input.Evidence != nil {
			dc.ScopedEvidence = input.Evidence.ListEvidence(ctx, ScopedEvidenceQuery{
				UpstreamID:    upstream.ID,
				IncludeLegacy: false,
			})
		}
		contexts[upstream.ID] = dc
		return dc
	}

	for _, entry := range effectiveBindings {
		acc, ok := byRef[entry.accountRef]
		if !ok {
			acc = AccountRecord{AccountRef: entry.accountRef, Provider: entry.provider}
		} else if acc.Provider == "" {
			acc.Provider = entry.provider
		}
		upstream := ResolveAccountUpstream(input.Overrides, acc)
		upstreamID := "unknown"
		if upstream != nil {
			upstreamID = upstream.ID
			upstreams[upstream.ID] = upstream
		}

		var scopeIdentities map[string]bool
		switch entry.scope.Kind {
		case "groups":
			scopeIdentities = make(map[string]bool)
			for _, gid := range entry.scope.Groups {
				for id := range groupIdentities[gid] {
					scopeIdentities[id] = true
				}
			}
		case "nodes":
			scopeIdentities = make(map[string]bool, len(entry.scope.Nodes))
			for _, id := range entry.scope.Nodes {
				scopeIdentities[id] = true
			}
		}

		var inScope []PlannerNode
		for _, node := range input.Nodes {
			if entry.pinnedNodeID != "" {
				if node.NodeID == entry.pinnedNodeID || node.Identity == entry.pinnedNodeID {
					inScope = append(inScope, node)
				}
				continue
			}
			if scopeIdentities == nil || scopeIdentities[node.Identity] || scopeIdentities[node.NodeID] {
				inScope = append(inScope, node)
			}
		}

		dc := readContext(upstream)
		cacheKey := fmt.Sprintf("%s|%s|%s", upstreamID, ScopeKey(entry.scope), entry.accountRef)
		verdicts, cached := verdictCache[cacheKey]
		if !cached {
			if dc != nil {
				verdicts = EvaluateNodesForUpstream(dc, upstream, acc.Provider, entry.accountRef, inScope, nowMS)
			} else {
				verdicts = make(map[string]ExitVerdict)
			}
			verdictCache[cacheKey] = verdicts
		}

		allowed := make([]string, 0, len(inScope))
		scopeNames := make([]string, 0, len(inScope))
		blockedCount := 0
		pending := 0
		denied := 0
		for _, node := range inScope {
			scopeNames = append(scopeNames, node.Name)
			if input.Blocked[node.Name] {
				blockedCount++
				continue
			}
			v, hasV := verdicts[node.Name]
			if hasV && v.GeoPending {
				pending++
				continue
			}
			if hasV && v.Status == "denied" {
				denied++
				continue
			}
			allowed = append(allowed, node.Name)
		}

		strategy := "shared"
		if entry.strategy == "sticky" || entry.strategy == "session" {
			strategy = entry.strategy
		}
		sharedKey := SharedLaneKey(upstreamID, acc.Provider, entry.scope, allowed)
		key := sharedKey
		switch strategy {
		case "sticky":
			key = "sticky:" + entry.accountRef
		case "session":
			key = SessionLaneKey(entry.accountRef, 0)
		}

		blockedReason := ""
		if len(inScope) == 0 {
			blockedReason = "egress_pool_scope_empty"
		} else if len(allowed) == 0 {
			if blockedCount == len(inScope) {
				blockedReason = "egress_pool_all_nodes_blocked"
			} else if pending > 0 {
				blockedReason = "egress_pool_geo_pending"
			} else {
				blockedReason = "egress_region_denied_all_nodes"
			}
		}

		perAccount[entry.accountRef] = &AccountPlanInfo{
			AccountRef:    entry.accountRef,
			Provider:      entry.provider,
			Upstream:      upstreamID,
			Strategy:      strategy,
			Key:           key,
			SharedKey:     sharedKey,
			ScopeKind:     entry.scope.Kind,
			InScope:       len(inScope),
			Allowed:       len(allowed),
			Denied:        denied,
			Pending:       pending,
			BlockedCount:  blockedCount,
			BlockedReason: blockedReason,
		}

		if strategy == "session" {
			count := len(allowed)
			if count < 1 {
				count = 1
			}
			if count > SessionLaneLimit {
				count = SessionLaneLimit
			}
			for slot := 0; slot < count; slot++ {
				slotKey := SessionLaneKey(entry.accountRef, slot)
				lanesMap[slotKey] = &LanePlanSpec{
					Key:           slotKey,
					Accounts:      []string{entry.accountRef},
					Allowed:       append([]string(nil), allowed...),
					ScopeNames:    append([]string(nil), scopeNames...),
					AvoidGroup:    "session:" + entry.accountRef,
					Strategy:      strategy,
					Upstream:      upstreamID,
					BlockedReason: blockedReason,
					SessionSlot:   slot,
				}
				laneOrder = append(laneOrder, slotKey)
			}
			continue
		}

		lane, exists := lanesMap[key]
		if !exists {
			avoidGroup := ""
			if strategy == "sticky" {
				avoidGroup = upstreamID
			}
			lane = &LanePlanSpec{
				Key:           key,
				Accounts:      nil,
				Allowed:       append([]string(nil), allowed...),
				ScopeNames:    append([]string(nil), scopeNames...),
				AvoidGroup:    avoidGroup,
				Strategy:      strategy,
				Upstream:      upstreamID,
				BlockedReason: blockedReason,
				SessionSlot:   -1,
			}
			lanesMap[key] = lane
			laneOrder = append(laneOrder, key)
		}
		lane.Accounts = append(lane.Accounts, entry.accountRef)
	}

	slots := input.LaneSlots
	if slots > 0 && len(lanesMap) > slots {
		var extraSession []*LanePlanSpec
		for _, k := range laneOrder {
			if l, ok := lanesMap[k]; ok && l.Strategy == "session" && l.SessionSlot > 0 {
				extraSession = append(extraSession, l)
			}
		}
		sort.Slice(extraSession, func(i, j int) bool {
			return extraSession[i].SessionSlot > extraSession[j].SessionSlot
		})
		for _, l := range extraSession {
			if len(lanesMap) <= slots {
				break
			}
			delete(lanesMap, l.Key)
			if len(l.Accounts) > 0 {
				if info := perAccount[l.Accounts[0]]; info != nil {
					info.SessionLanesReduced = true
				}
			}
		}
	}

	if slots > 0 && len(lanesMap) > slots {
		for _, k := range laneOrder {
			if len(lanesMap) <= slots {
				break
			}
			l, ok := lanesMap[k]
			if !ok || l.Strategy != "sticky" {
				continue
			}
			delete(lanesMap, l.Key)
			for _, accountRef := range l.Accounts {
				info := perAccount[accountRef]
				if info == nil {
					continue
				}
				shared, exists := lanesMap[info.SharedKey]
				if !exists {
					shared = &LanePlanSpec{
						Key:           info.SharedKey,
						Accounts:      nil,
						Allowed:       append([]string(nil), l.Allowed...),
						ScopeNames:    append([]string(nil), l.ScopeNames...),
						AvoidGroup:    "",
						Strategy:      "shared",
						Upstream:      l.Upstream,
						BlockedReason: l.BlockedReason,
						SessionSlot:   -1,
					}
					lanesMap[info.SharedKey] = shared
					laneOrder = append(laneOrder, info.SharedKey)
				}
				shared.Accounts = append(shared.Accounts, accountRef)
				info.Key = info.SharedKey
				info.Downgraded = true
			}
		}
	}

	plan := make([]LanePlanSpec, 0, len(lanesMap))
	seenKeys := make(map[string]bool, len(lanesMap))
	for _, k := range laneOrder {
		if seenKeys[k] {
			continue
		}
		if l, ok := lanesMap[k]; ok {
			seenKeys[k] = true
			plan = append(plan, *l)
		}
	}

	return PlannedEgressResult{
		Plan:      plan,
		Accounts:  perAccount,
		Nodes:     input.Nodes,
		Upstreams: upstreams,
	}
}

package subaggregator

import (
	"fmt"
	"regexp"
	"strings"
)

// TargetRef 表示策略组或规则指向的目标（node/group/direct/reject）。
type TargetRef struct {
	Kind string `json:"kind"`
	Name string `json:"name"`
}

// RendererCapabilities 声明目标格式对聚合规划的约束。
type RendererCapabilities struct {
	RejectInGroups bool
	Groups         bool
	GroupTypes     []string
	Protocols      []string
	ProxyChain     string
	RuleSetFormat  string
	RelayFallback  bool
	CoreProtocols  []string
	SanitizeName   func(string) string
}

// PlannedGroup 表示编译前的规范化策略组。
type PlannedGroup struct {
	Name      string      `json:"name"`
	Type      string      `json:"type"`
	Members   []TargetRef `json:"members"`
	URL       string      `json:"url,omitempty"`
	Interval  int         `json:"interval,omitempty"`
	Tolerance int         `json:"tolerance,omitempty"`
	Strategy  string      `json:"strategy,omitempty"`
}

// RuleMatch 描述单条分流规则匹配模式。
type RuleMatch struct {
	Type      string `json:"type"`
	Value     string `json:"value"`
	NoResolve bool   `json:"noResolve,omitempty"`
}

// RuleOrigin 记录规则来源（private / preset / custom / final）。
type RuleOrigin struct {
	Kind  string `json:"kind"`
	ID    string `json:"id,omitempty"`
	Name  string `json:"name,omitempty"`
	Index int    `json:"index,omitempty"`
}

// PlannedRule 表示规范化后的单条分流规则。
type PlannedRule struct {
	Origin *RuleOrigin `json:"origin,omitempty"`
	Match  RuleMatch   `json:"match"`
	Target TargetRef   `json:"target"`
}

// PlanStats 描述聚合规划阶段统计。
type PlanStats struct {
	Scoped     int `json:"scoped"`
	Filtered   int `json:"filtered"`
	Duplicates int `json:"duplicates"`
	Selected   int `json:"selected"`
	Groups     int `json:"groups"`
	Regions    int `json:"regions"`
	Rules      int `json:"rules"`
}

// PlannedNode 表示参与输出的聚合节点及其元数据。
type PlannedNode struct {
	Node       ProxyNode `json:"node"`
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	OriginName string    `json:"originName"`
	Protocol   string    `json:"protocol"`
	RegionID   string    `json:"regionId,omitempty"`
	SourceID   string    `json:"sourceId,omitempty"`
	SourceName string    `json:"sourceName,omitempty"`
	Chain      string    `json:"chain,omitempty"`
}

// SelectionResult 保存聚合选点结果与前置过滤统计。
type SelectionResult struct {
	Entries []PlannedNode
	Stats   PlanStats
}

// AggregationPlan 表示聚合配置文件 + 订阅源 + 节点集合的完整中间规划。
type AggregationPlan struct {
	Profile  AggregatorProfile
	Nodes    []PlannedNode
	Groups   []PlannedGroup
	RuleSets []RuleSetRef
	Rules    []PlannedRule
	Final    TargetRef
	Stats    PlanStats
	Warnings []string
}

// SelectAggregatedNodes 按配置文件筛选、去重并命名参与输出的节点列表。
func SelectAggregatedNodes(profile AggregatorProfile, subs []Subscription, rawNodes []ProxyNode) SelectionResult {
	subByID := make(map[string]Subscription, len(subs))
	for _, s := range subs {
		subByID[s.ID] = s
	}

	selectedSubSet := map[string]bool{}
	for _, id := range profile.Sources.SubscriptionIds {
		selectedSubSet[id] = true
	}

	var scoped []ProxyNode
	for _, rawNode := range rawNodes {
		subID := rawNode.Str("subscriptionId")
		if subID == "" {
			if !profile.Sources.IncludeManualNodes {
				continue
			}
		} else {
			sub, exists := subByID[subID]
			if !exists || !sub.Enabled {
				continue
			}
			if !profile.Sources.All && !selectedSubSet[subID] {
				continue
			}
		}
		scoped = append(scoped, rawNode)
	}

	var reInclude, reExclude *regexp.Regexp
	if profile.Filter.Include != "" {
		reInclude, _ = regexp.Compile("(?i:" + profile.Filter.Include + ")")
	}
	if profile.Filter.Exclude != "" {
		reExclude, _ = regexp.Compile("(?i:" + profile.Filter.Exclude + ")")
	}
	protoAllow := map[string]bool{}
	for _, p := range profile.Filter.Protocols {
		protoAllow[NormalizeProtocolAlias(p)] = true
	}

	type renamePair struct {
		re  *regexp.Regexp
		rep string
	}
	var renames []renamePair
	for _, rr := range profile.Naming.Renames {
		if re, err := regexp.Compile(rr.Pattern); err == nil {
			renames = append(renames, renamePair{re: re, rep: rr.Replace})
		}
	}

	var filteredNodes []ProxyNode
	filteredCount := 0
	for _, n := range scoped {
		name := n.Str("name")
		proto := NormalizeProtocolAlias(n.Str("protocol"))
		if len(protoAllow) > 0 && !protoAllow[proto] {
			filteredCount++
			continue
		}
		if reInclude != nil && !reInclude.MatchString(name) {
			filteredCount++
			continue
		}
		if reExclude != nil && reExclude.MatchString(name) {
			filteredCount++
			continue
		}
		filteredNodes = append(filteredNodes, n)
	}

	seenKeys := map[string]bool{}
	duplicates := 0
	usedNames := map[string]bool{}
	plannedNodes := make([]PlannedNode, 0, len(filteredNodes))

	for _, n := range filteredNodes {
		if profile.Dedupe {
			key := BuildProxyNodeConnectionKey(n)
			if seenKeys[key] {
				duplicates++
				continue
			}
			seenKeys[key] = true
		}

		subID := n.Str("subscriptionId")
		subName := "手动节点"
		if subID != "" {
			subName = subByID[subID].Name
		}

		displayName := strings.TrimSpace(n.Str("name"))
		if displayName == "" {
			p, _ := n.Int("port")
			displayName = fmt.Sprintf("%s:%d", n.Str("server"), p)
		}
		for _, rr := range renames {
			displayName = rr.re.ReplaceAllString(displayName, rr.rep)
		}
		displayName = strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(displayName, "\r", " "), "\n", " "))
		if displayName == "" {
			displayName = n.Str("server")
		}
		if profile.Naming.SourcePrefix && subID != "" && subName != "" {
			displayName = "[" + subName + "] " + displayName
		}

		displayName = allocateUniqueName(displayName, usedNames)

		clone := n.Clone()
		clone["name"] = displayName
		regID := ""
		if reg, ok := DetectRegion(displayName); ok {
			regID = reg.ID
		} else if reg, ok := DetectRegion(n.Str("name")); ok {
			regID = reg.ID
		}

		nodeID := n.Str("id")
		if nodeID == "" {
			nodeID = DeterministicNodeID(n, subID)
		}

		plannedNodes = append(plannedNodes, PlannedNode{
			Node:       clone,
			ID:         nodeID,
			Name:       displayName,
			OriginName: n.Str("name"),
			Protocol:   NormalizeProtocolAlias(clone.Str("protocol")),
			RegionID:   regID,
			SourceID:   subID,
			SourceName: subName,
			Chain:      clone.Str("chain"),
		})
	}

	return SelectionResult{
		Entries: plannedNodes,
		Stats: PlanStats{
			Scoped:     len(scoped),
			Filtered:   filteredCount,
			Duplicates: duplicates,
			Selected:   len(plannedNodes),
		},
	}
}

func allocateUniqueName(base string, used map[string]bool) string {
	candidate := strings.TrimSpace(base)
	if candidate == "" {
		candidate = "节点"
	}
	if !used[candidate] {
		used[candidate] = true
		return candidate
	}
	for counter := 2; ; counter++ {
		next := fmt.Sprintf("%s %d", candidate, counter)
		if !used[next] {
			used[next] = true
			return next
		}
	}
}

// SanitizeEntriesForRenderer 按格式要求清洗节点名并再次去重。
func SanitizeEntriesForRenderer(entries []PlannedNode, sanitize func(string) string) []PlannedNode {
	if sanitize == nil {
		return entries
	}
	used := make(map[string]bool, len(entries))
	out := make([]PlannedNode, 0, len(entries))
	for _, entry := range entries {
		cleaned := sanitize(entry.Name)
		if cleaned == "" {
			cleaned = "node"
		}
		unique := allocateUniqueName(cleaned, used)
		updated := entry
		updated.Name = unique
		clone := entry.Node.Clone()
		clone["name"] = unique
		updated.Node = clone
		out = append(out, updated)
	}
	return out
}

// BuildAggregationPlan 将 profile、订阅源及节点集合编译为默认聚合规划。
func BuildAggregationPlan(profile AggregatorProfile, store ProxyPoolStoreData) AggregationPlan {
	return BuildPlanWithCapabilities(profile, store, RendererCapabilities{RejectInGroups: true, Groups: true})
}

// BuildPlanWithCapabilities 根据渲染目标能力构建聚合规划。
func BuildPlanWithCapabilities(profile AggregatorProfile, store ProxyPoolStoreData, caps RendererCapabilities) AggregationPlan {
	sel := SelectAggregatedNodes(profile, store.Subscriptions, store.Nodes)
	entries := SanitizeEntriesForRenderer(sel.Entries, caps.SanitizeName)
	return BuildPlanFromEntries(profile, entries, sel.Stats, caps)
}

// BuildPlanFromEntries 基于已完成编译筛选的节点列表构建策略组与分流规则。
func BuildPlanFromEntries(profile AggregatorProfile, nodes []PlannedNode, stats PlanStats, caps RendererCapabilities) AggregationPlan {
	stats.Selected = len(nodes)
	plan := AggregationPlan{
		Profile:  profile,
		Nodes:    nodes,
		Warnings: []string{},
		Stats:    stats,
	}
	if len(nodes) == 0 {
		plan.Warnings = append(plan.Warnings, "aggregator_no_nodes")
	}

	rejectInGroups := caps.RejectInGroups

	var allowedGroupTypes map[string]bool
	if len(caps.GroupTypes) > 0 {
		allowedGroupTypes = make(map[string]bool, len(caps.GroupTypes))
		for _, gt := range caps.GroupTypes {
			allowedGroupTypes[gt] = true
		}
	}

	nodeRefs := make([]TargetRef, 0, len(nodes))
	nodesByRegion := map[string][]TargetRef{}
	nodesBySource := map[string][]TargetRef{}
	sourceNames := map[string]string{}
	sourceOrder := []string{}

	for _, pn := range nodes {
		ref := TargetRef{Kind: "node", Name: pn.Name}
		nodeRefs = append(nodeRefs, ref)
		if pn.RegionID != "" {
			nodesByRegion[pn.RegionID] = append(nodesByRegion[pn.RegionID], ref)
		}
		if pn.SourceID != "" {
			if _, ok := sourceNames[pn.SourceID]; !ok {
				label := strings.ReplaceAll(pn.SourceName, ",", " ")
				sourceNames[pn.SourceID] = "📦 " + label
				sourceOrder = append(sourceOrder, pn.SourceID)
			}
			nodesBySource[pn.SourceID] = append(nodesBySource[pn.SourceID], ref)
		} else if pn.SourceName != "" && profile.Groups.PerSource {
			sid := "__manual__"
			if _, ok := sourceNames[sid]; !ok {
				label := strings.ReplaceAll(pn.SourceName, ",", " ")
				sourceNames[sid] = "📦 " + label
				sourceOrder = append(sourceOrder, sid)
			}
			nodesBySource[sid] = append(nodesBySource[sid], ref)
		}
	}

	var activeRegions []RegionDef
	regionGroupByID := map[string]PlannedGroup{}
	var regionGroups []PlannedGroup
	enabledRegion := map[string]bool{}
	for _, rid := range profile.Groups.Regions {
		enabledRegion[rid] = true
	}
	for _, r := range Regions {
		if !enabledRegion[r.ID] || len(nodesByRegion[r.ID]) == 0 {
			continue
		}
		activeRegions = append(activeRegions, r)
		g := PlannedGroup{
			Name:      RegionGroupName(r),
			Type:      "url-test",
			Members:   nodesByRegion[r.ID],
			URL:       profile.Groups.TestURL,
			Interval:  profile.Groups.TestIntervalSec,
			Tolerance: 50,
		}
		regionGroupByID[r.ID] = g
		regionGroups = append(regionGroups, g)
	}
	plan.Stats.Regions = len(activeRegions)

	sourceGroupByID := map[string]PlannedGroup{}
	var sourceGroups []PlannedGroup
	if profile.Groups.PerSource {
		for _, sid := range sourceOrder {
			if len(nodesBySource[sid]) == 0 {
				continue
			}
			g := PlannedGroup{
				Name:      sourceNames[sid],
				Type:      "url-test",
				Members:   nodesBySource[sid],
				URL:       profile.Groups.TestURL,
				Interval:  profile.Groups.TestIntervalSec,
				Tolerance: 50,
			}
			sourceGroupByID[sid] = g
			sourceGroups = append(sourceGroups, g)
		}
	}

	var childGroupRefs []TargetRef
	for _, rg := range regionGroups {
		childGroupRefs = append(childGroupRefs, TargetRef{Kind: "group", Name: rg.Name})
	}
	for _, sg := range sourceGroups {
		childGroupRefs = append(childGroupRefs, TargetRef{Kind: "group", Name: sg.Name})
	}

	// 自建策略组（按 ID 解析成员及冲突名避让）
	takenNames := map[string]bool{}
	for _, rg := range regionGroups {
		takenNames[rg.Name] = true
	}
	for _, sg := range sourceGroups {
		takenNames[sg.Name] = true
	}
	for _, pn := range nodes {
		takenNames[pn.Name] = true
	}

	customByID := map[string]CustomGroup{}
	customByName := map[string]CustomGroup{}
	customOutputNames := map[string]string{}
	for _, cg := range profile.Groups.Custom {
		customByID[cg.ID] = cg
		customByName[cg.Name] = cg
		outName := cg.Name
		for counter := 2; takenNames[outName]; counter++ {
			outName = fmt.Sprintf("%s %d", cg.Name, counter)
		}
		takenNames[outName] = true
		if cg.ID != "" {
			customOutputNames[cg.ID] = outName
		}
		customOutputNames[cg.Name] = outName
	}

	proxyDepCache := map[string]bool{}
	var dependsOnProxy func(CustomGroup) bool
	dependsOnProxy = func(g CustomGroup) bool {
		key := g.ID
		if key == "" {
			key = g.Name
		}
		if v, seen := proxyDepCache[key]; seen {
			return v
		}
		proxyDepCache[key] = false
		for _, m := range g.Members {
			if m == PolicyProxy {
				proxyDepCache[key] = true
				return true
			}
			if strings.HasPrefix(m, "group:") {
				refKey := strings.TrimPrefix(m, "group:")
				if target, ok := customByID[refKey]; ok && dependsOnProxy(target) {
					proxyDepCache[key] = true
					return true
				}
				if target, ok := customByName[refKey]; ok && dependsOnProxy(target) {
					proxyDepCache[key] = true
					return true
				}
			}
		}
		return false
	}

	customRefs := make([]TargetRef, 0, len(profile.Groups.Custom))
	proxySafeCustomRefs := make([]TargetRef, 0, len(profile.Groups.Custom))
	for _, cg := range profile.Groups.Custom {
		outName := customOutputNames[cg.Name]
		if cg.ID != "" {
			outName = customOutputNames[cg.ID]
		}
		ref := TargetRef{Kind: "group", Name: outName}
		customRefs = append(customRefs, ref)
		if !dependsOnProxy(cg) {
			proxySafeCustomRefs = append(proxySafeCustomRefs, ref)
		}
	}

	directRef := TargetRef{Kind: "direct", Name: "DIRECT"}
	rejectRef := TargetRef{Kind: "reject", Name: "REJECT"}

	autoMembers := nodeRefs
	if len(autoMembers) == 0 {
		autoMembers = []TargetRef{directRef}
	}
	autoGroup := PlannedGroup{
		Name:      GroupNames[PolicyAuto],
		Type:      "url-test",
		Members:   autoMembers,
		URL:       profile.Groups.TestURL,
		Interval:  profile.Groups.TestIntervalSec,
		Tolerance: 50,
	}

	proxyMembers := uniqueTargetRefs(append(
		append([]TargetRef{{Kind: "group", Name: autoGroup.Name}}, proxySafeCustomRefs...),
		append(childGroupRefs, append([]TargetRef{directRef}, nodeRefs...)...)...,
	))
	proxyGroup := PlannedGroup{
		Name:    GroupNames[PolicyProxy],
		Type:    "select",
		Members: proxyMembers,
	}

	addWarning := func(w string) {
		for _, cur := range plan.Warnings {
			if cur == w {
				return
			}
		}
		plan.Warnings = append(plan.Warnings, w)
	}

	// 仅在启用输出策略组时继续构建自建组、预设组、漏网之鱼及分流规则
	resolveGroupMember := func(member string, groupName string) *TargetRef {
		switch member {
		case PolicyProxy:
			r := TargetRef{Kind: "group", Name: proxyGroup.Name}
			return &r
		case PolicyAuto:
			r := TargetRef{Kind: "group", Name: autoGroup.Name}
			return &r
		case PolicyDirect:
			return &directRef
		case PolicyReject:
			if rejectInGroups {
				return &rejectRef
			}
			return nil
		}
		kind, id, ok := strings.Cut(member, ":")
		if !ok {
			addWarning("aggregator_group_member_missing:" + groupName + ":" + member)
			return nil
		}
		var targetName string
		switch kind {
		case "group":
			targetName = customOutputNames[id]
		case "region":
			if rg, exists := regionGroupByID[id]; exists {
				targetName = rg.Name
			}
		case "source":
			if sg, exists := sourceGroupByID[id]; exists {
				targetName = sg.Name
			}
		}
		if targetName != "" {
			r := TargetRef{Kind: "group", Name: targetName}
			return &r
		}
		addWarning("aggregator_group_member_missing:" + groupName + ":" + member)
		return nil
	}

	customGroupPlans := make([]PlannedGroup, 0, len(profile.Groups.Custom))
	for _, cg := range profile.Groups.Custom {
		outName := customOutputNames[cg.Name]
		if cg.ID != "" {
			outName = customOutputNames[cg.ID]
		}
		var resolved []TargetRef
		for _, m := range cg.Members {
			if ref := resolveGroupMember(m, cg.Name); ref != nil {
				resolved = append(resolved, *ref)
			}
		}
		var incRe, excRe *regexp.Regexp
		if cg.Nodes.Include != "" {
			incRe, _ = regexp.Compile("(?i:" + cg.Nodes.Include + ")")
		}
		if cg.Nodes.Exclude != "" {
			excRe, _ = regexp.Compile("(?i:" + cg.Nodes.Exclude + ")")
		}
		picked := map[string]bool{}
		for _, nn := range cg.Nodes.Names {
			picked[nn] = true
		}
		var nodeMatched []TargetRef
		for _, pn := range nodes {
			if !(picked[pn.Name] || (incRe != nil && incRe.MatchString(pn.Name))) {
				continue
			}
			if excRe != nil && excRe.MatchString(pn.Name) {
				continue
			}
			nodeMatched = append(nodeMatched, TargetRef{Kind: "node", Name: pn.Name})
		}
		members := uniqueTargetRefs(append(resolved, nodeMatched...))
		if len(members) == 0 {
			members = []TargetRef{directRef}
		}
		gType := cg.Type
		if len(allowedGroupTypes) > 0 && !allowedGroupTypes[gType] {
			addWarning("aggregator_group_type_degraded:" + outName + ":" + gType)
			gType = "url-test"
		}
		pg := PlannedGroup{
			Name:    outName,
			Type:    gType,
			Members: members,
		}
		if gType != "select" {
			pg.URL = cg.TestURL
			if pg.URL == "" {
				pg.URL = profile.Groups.TestURL
			}
			pg.Interval = cg.Interval
			if pg.Interval <= 0 {
				pg.Interval = profile.Groups.TestIntervalSec
			}
		}
		if gType == "url-test" {
			if cg.Tolerance != nil {
				pg.Tolerance = *cg.Tolerance
			} else {
				pg.Tolerance = 50
			}
		}
		if gType == "load-balance" {
			pg.Strategy = cg.Strategy
			if pg.Strategy == "" {
				pg.Strategy = LoadBalanceStrategies[0]
			}
		}
		customGroupPlans = append(customGroupPlans, pg)
	}

	presetByID := map[string]PresetRule{}
	for _, pr := range profile.Rules.Presets {
		presetByID[pr.ID] = pr
	}
	var enabledPresets []RulePresetDef
	presetConfig := map[string]PresetRule{}
	for _, def := range RulePresets {
		pr, ok := presetByID[def.ID]
		enabled := def.EnabledByDefault
		pol := def.DefaultPolicy
		if ok {
			enabled = pr.Enabled
			pol = pr.Policy
		}
		if !enabled {
			continue
		}
		enabledPresets = append(enabledPresets, def)
		presetConfig[def.ID] = PresetRule{ID: def.ID, Enabled: true, Policy: pol}
	}

	resolvePolicy := func(policy string, contextLabel string, allowCustomGroup bool) TargetRef {
		switch policy {
		case PolicyProxy:
			return TargetRef{Kind: "group", Name: proxyGroup.Name}
		case PolicyAuto:
			return TargetRef{Kind: "group", Name: autoGroup.Name}
		case PolicyDirect:
			return directRef
		case PolicyReject:
			return rejectRef
		}
		kind, id, ok := strings.Cut(policy, ":")
		if !ok {
			if allowCustomGroup {
				if outName, exists := customOutputNames[policy]; exists {
					return TargetRef{Kind: "group", Name: outName}
				}
			}
			addWarning("aggregator_policy_missing:" + contextLabel + ":" + policy)
			return TargetRef{Kind: "group", Name: proxyGroup.Name}
		}
		var targetName string
		switch kind {
		case "region":
			if rg, exists := regionGroupByID[id]; exists {
				targetName = rg.Name
			}
		case "source":
			if sg, exists := sourceGroupByID[id]; exists {
				targetName = sg.Name
			}
		case "preset":
			if _, ok := presetConfig[id]; ok {
				if def, exists := FindRulePresetByID(id); exists {
					targetName = def.Name
				}
			}
		case "group":
			if allowCustomGroup {
				targetName = customOutputNames[id]
			}
		}
		if targetName != "" {
			return TargetRef{Kind: "group", Name: targetName}
		}
		addWarning("aggregator_policy_missing:" + contextLabel + ":" + policy)
		return TargetRef{Kind: "group", Name: proxyGroup.Name}
	}

	optionRefs := append(
		append([]TargetRef{{Kind: "group", Name: proxyGroup.Name}, {Kind: "group", Name: autoGroup.Name}}, customRefs...),
		append(childGroupRefs, directRef)...,
	)

	presetGroupMap := map[string]PlannedGroup{}
	var presetGroups []PlannedGroup
	for _, def := range enabledPresets {
		pr := presetConfig[def.ID]
		preferred := resolvePolicy(pr.Policy, "preset:"+def.ID, true)
		if preferred.Kind == "reject" && !rejectInGroups {
			continue
		}
		var base []TargetRef
		base = append(base, preferred)
		base = append(base, optionRefs...)
		if rejectInGroups {
			base = append(base, rejectRef)
		}
		g := PlannedGroup{
			Name:    def.Name,
			Type:    "select",
			Members: uniqueTargetRefs(base),
		}
		presetGroupMap[def.ID] = g
		presetGroups = append(presetGroups, g)
	}

	finalMembers := uniqueTargetRefs(append([]TargetRef{resolvePolicy(profile.Rules.FinalPolicy, "final", true)}, optionRefs...))
	finalGroup := PlannedGroup{
		Name:    GroupNames["final"],
		Type:    "select",
		Members: finalMembers,
	}

	var ruleSets []RuleSetRef
	seenRuleSet := map[string]bool{}
	var rules []PlannedRule
	addRuleSetRule := func(rs RuleSetRef, target TargetRef, origin *RuleOrigin) {
		tag := RuleSetTag(rs)
		if !seenRuleSet[tag] {
			seenRuleSet[tag] = true
			rs.Tag = tag
			ruleSets = append(ruleSets, rs)
		}
		rules = append(rules, PlannedRule{
			Origin: origin,
			Match:  RuleMatch{Type: "rule-set", Value: tag, NoResolve: rs.NoResolve || rs.Kind == "geoip"},
			Target: target,
		})
	}

	for _, prs := range PrivateRuleSets {
		addRuleSetRule(prs, directRef, &RuleOrigin{Kind: "private"})
	}

	for idx, cr := range profile.Rules.Custom {
		origin := &RuleOrigin{Kind: "custom", Name: cr.Value, Index: idx}
		rt := strings.ToUpper(cr.Type)
		tgt := resolvePolicy(cr.Policy, fmt.Sprintf("rule:%s,%s", rt, cr.Value), true)
		switch rt {
		case "GEOSITE":
			addRuleSetRule(RuleSetRef{Kind: "geosite", Name: cr.Value}, tgt, origin)
		case "GEOIP":
			addRuleSetRule(RuleSetRef{Kind: "geoip", Name: cr.Value, NoResolve: true}, tgt, origin)
		case "IP-CIDR":
			rules = append(rules, PlannedRule{
				Origin: origin,
				Match:  RuleMatch{Type: "ip-cidr", Value: cr.Value, NoResolve: true},
				Target: tgt,
			})
		default:
			rules = append(rules, PlannedRule{
				Origin: origin,
				Match:  RuleMatch{Type: strings.ToLower(rt), Value: strings.ToLower(cr.Value)},
				Target: tgt,
			})
		}
	}

	for _, def := range enabledPresets {
		pg, hasGroup := presetGroupMap[def.ID]
		tgt := rejectRef
		if hasGroup {
			tgt = TargetRef{Kind: "group", Name: pg.Name}
		}
		for _, rs := range def.RuleSets {
			addRuleSetRule(rs, tgt, &RuleOrigin{Kind: "preset", ID: def.ID, Name: def.Name})
		}
	}

	allGroups := make([]PlannedGroup, 0, 3+len(customGroupPlans)+len(presetGroups)+len(regionGroups)+len(sourceGroups))
	allGroups = append(allGroups, proxyGroup, autoGroup)
	allGroups = append(allGroups, customGroupPlans...)
	allGroups = append(allGroups, presetGroups...)
	allGroups = append(allGroups, finalGroup)
	allGroups = append(allGroups, regionGroups...)
	allGroups = append(allGroups, sourceGroups...)

	if !rejectInGroups {
		for i := range allGroups {
			filtered := make([]TargetRef, 0, len(allGroups[i].Members))
			for _, m := range allGroups[i].Members {
				if m.Kind != "reject" {
					filtered = append(filtered, m)
				}
			}
			allGroups[i].Members = filtered
		}
	}

	plan.Groups = allGroups
	plan.RuleSets = ruleSets
	plan.Rules = rules
	plan.Final = TargetRef{Kind: "group", Name: finalGroup.Name}
	plan.Stats.Groups = len(allGroups)
	plan.Stats.Rules = len(rules) + 1
	return plan
}

func uniqueTargetRefs(refs []TargetRef) []TargetRef {
	seen := make(map[TargetRef]bool, len(refs))
	out := make([]TargetRef, 0, len(refs))
	for _, r := range refs {
		if !seen[r] {
			seen[r] = true
			out = append(out, r)
		}
	}
	return out
}

// FlattenGroupMembers 将嵌套策略组展开为去重后的直接节点 / BUILTIN 引用（供 Surge / Loon / QX 测速组使用）。
func FlattenGroupMembers(groups []PlannedGroup, target PlannedGroup) []TargetRef {
	byName := make(map[string]PlannedGroup, len(groups))
	for _, g := range groups {
		byName[g.Name] = g
	}
	seenRefs := map[TargetRef]bool{}
	seenGroups := map[string]bool{}
	var out []TargetRef
	var visit func(PlannedGroup)
	visit = func(g PlannedGroup) {
		if seenGroups[g.Name] {
			return
		}
		seenGroups[g.Name] = true
		for _, m := range g.Members {
			if m.Kind == "group" {
				if sub, ok := byName[m.Name]; ok {
					visit(sub)
				}
				continue
			}
			if !seenRefs[m] {
				seenRefs[m] = true
				out = append(out, m)
			}
		}
	}
	visit(target)
	return out
}

// PruneGroupsForClient 根据被客户端丢弃或修改的成员裁剪策略组，保持非空且安全引用。
func PruneGroupsForClient(groups []PlannedGroup, keptNodes map[string]bool) []PlannedGroup {
	validGroups := map[string]bool{}
	for _, g := range groups {
		validGroups[g.Name] = true
	}

	current := make([]PlannedGroup, len(groups))
	copy(current, groups)
	for changed := true; changed; {
		changed = false
		nextGroups := make([]PlannedGroup, 0, len(current))
		nextValid := map[string]bool{}
		for _, g := range current {
			var members []TargetRef
			for _, m := range g.Members {
				switch m.Kind {
				case "node":
					if keptNodes[m.Name] {
						members = append(members, m)
					}
				case "group":
					if validGroups[m.Name] {
						members = append(members, m)
					}
				default:
					members = append(members, m)
				}
			}
			if len(members) == 0 {
				changed = true
				continue
			}
			g.Members = members
			nextGroups = append(nextGroups, g)
			nextValid[g.Name] = true
		}
		current = nextGroups
		validGroups = nextValid
	}
	return current
}

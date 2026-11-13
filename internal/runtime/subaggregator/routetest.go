package subaggregator

import (
	"context"
	"net/netip"
	"regexp"
	"strings"
	"sync"
)

const (
	maxRouteTargetLength = 253
	maxRouteMembers      = 24
)

var (
	schemeStripPattern = regexp.MustCompile(`(?i)^[a-z][a-z0-9+.-]*://`)
	pathStripPattern   = regexp.MustCompile(`[/?#].*$`)
	authStripPattern   = regexp.MustCompile(`^[^@]*@`)
	bracketHostPattern = regexp.MustCompile(`^\[([^\]]+)\](?::\d+)?$`)
	portSuffixPattern  = regexp.MustCompile(`:\d+$`)
	routeDomainPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$`)
)

// RouteTarget 表示规则测试解析后的规范目标（domain 或 ip）。
type RouteTarget struct {
	Kind  string `json:"kind"`
	Value string `json:"value"`
}

// RouteRuleInfo 描述命中规则的类型与来源。
type RouteRuleInfo struct {
	Origin *RuleOrigin `json:"origin"`
	Type   string      `json:"type"`
	Value  string      `json:"value"`
}

// RouteGroupHop 描述命中规则后经过的策略组链路。
type RouteGroupHop struct {
	Name        string   `json:"name"`
	Type        string   `json:"type"`
	Members     []string `json:"members"`
	MemberCount int      `json:"memberCount"`
}

// RouteEndTarget 描述最终直连或拒绝终点。
type RouteEndTarget struct {
	Kind string `json:"kind"`
	Name string `json:"name"`
}

// RouteTraceResult 描述路由跟踪的完整结果。
type RouteTraceResult struct {
	Target      RouteTarget     `json:"target"`
	Rule        RouteRuleInfo   `json:"rule"`
	Checked     int             `json:"checked"`
	Unavailable []string        `json:"unavailable"`
	Groups      []RouteGroupHop `json:"groups"`
	End         *RouteEndTarget `json:"end"`
}

// ParseRouteTarget 从 URL、域名或 IP（可带方括号及端口）提取规范路由测试目标。
func ParseRouteTarget(input string) (RouteTarget, error) {
	text := strings.TrimSpace(input)
	text = schemeStripPattern.ReplaceAllString(text, "")
	text = pathStripPattern.ReplaceAllString(text, "")
	text = authStripPattern.ReplaceAllString(text, "")
	if m := bracketHostPattern.FindStringSubmatch(text); len(m) == 2 {
		text = m[1]
	} else if _, err := netip.ParseAddr(text); err != nil {
		text = portSuffixPattern.ReplaceAllString(text, "")
	}
	text = strings.TrimSuffix(strings.ToLower(text), ".")
	if text == "" || len(text) > maxRouteTargetLength {
		return RouteTarget{}, errInvalid("invalid_route_target")
	}
	if addr, err := netip.ParseAddr(text); err == nil {
		return RouteTarget{Kind: "ip", Value: addr.String()}, nil
	}
	if !routeDomainPattern.MatchString(text) {
		return RouteTarget{}, errInvalid("invalid_route_target")
	}
	return RouteTarget{Kind: "domain", Value: text}, nil
}

func domainInIndex(domain string, idx *RuleSetIndex) bool {
	if idx == nil {
		return false
	}
	if idx.Exact[domain] {
		return true
	}
	for cur := domain; cur != ""; {
		if idx.Suffixes[cur] {
			return true
		}
		dot := strings.IndexByte(cur, '.')
		if dot < 0 {
			break
		}
		cur = cur[dot+1:]
	}
	return false
}

func ipInIndex(addr netip.Addr, idx *RuleSetIndex) bool {
	if idx == nil || !addr.IsValid() {
		return false
	}
	for _, p := range idx.Prefixes {
		if p.Contains(addr) {
			return true
		}
	}
	return false
}

func matchesPlainRouteRule(m RuleMatch, target RouteTarget) bool {
	if target.Kind == "domain" {
		switch m.Type {
		case "domain":
			return target.Value == m.Value
		case "domain-suffix":
			return target.Value == m.Value || strings.HasSuffix(target.Value, "."+m.Value)
		case "domain-keyword":
			return strings.Contains(target.Value, m.Value)
		}
		return false
	}
	if m.Type != "ip-cidr" {
		return false
	}
	addr, err := netip.ParseAddr(target.Value)
	if err != nil {
		return false
	}
	if prefix, err := netip.ParsePrefix(m.Value); err == nil {
		return prefix.Contains(addr)
	}
	if single, err := netip.ParseAddr(m.Value); err == nil {
		return single == addr
	}
	return false
}

func routeRefLabel(ref TargetRef) string {
	switch ref.Kind {
	case "direct":
		return "DIRECT"
	case "reject":
		return "REJECT"
	default:
		return ref.Name
	}
}

func followRouteDefaults(plan AggregationPlan, dest TargetRef) ([]RouteGroupHop, *RouteEndTarget) {
	byName := make(map[string]PlannedGroup, len(plan.Groups))
	for _, g := range plan.Groups {
		byName[g.Name] = g
	}
	groups := make([]RouteGroupHop, 0)
	seen := map[string]bool{}
	cur := &dest
	for cur != nil && cur.Kind == "group" && !seen[cur.Name] {
		seen[cur.Name] = true
		g, ok := byName[cur.Name]
		if !ok {
			break
		}
		limit := len(g.Members)
		if limit > maxRouteMembers {
			limit = maxRouteMembers
		}
		members := make([]string, 0, limit)
		for i := 0; i < limit; i++ {
			members = append(members, routeRefLabel(g.Members[i]))
		}
		groups = append(groups, RouteGroupHop{
			Name:        g.Name,
			Type:        g.Type,
			Members:     members,
			MemberCount: len(g.Members),
		})
		if g.Type == "select" && len(g.Members) > 0 {
			nxt := g.Members[0]
			cur = &nxt
		} else {
			cur = nil
		}
	}
	if cur != nil && cur.Kind != "group" {
		return groups, &RouteEndTarget{Kind: cur.Kind, Name: routeRefLabel(*cur)}
	}
	return groups, nil
}

// TraceRoute 在未保存/已保存规划上追踪目标域名或 IP 的规则命中路径。
func TraceRoute(ctx context.Context, plan AggregationPlan, input string, loadFn func(context.Context, RuleSetRef) (*RuleSetIndex, error)) (RouteTraceResult, error) {
	target, err := ParseRouteTarget(input)
	if err != nil {
		return RouteTraceResult{}, err
	}
	rsByTag := make(map[string]RuleSetRef, len(plan.RuleSets))
	for _, rs := range plan.RuleSets {
		rsByTag[rs.Tag] = rs
	}
	wantedKind := "geosite"
	if target.Kind == "ip" {
		wantedKind = "geoip"
	}
	relevant := func(r PlannedRule) bool {
		if r.Match.Type != "rule-set" {
			return true
		}
		rs, ok := rsByTag[r.Match.Value]
		return ok && rs.Kind == wantedKind
	}

	type fetchOutcome struct {
		idx *RuleSetIndex
		err error
	}
	outcomes := make(map[string]fetchOutcome)
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, r := range plan.Rules {
		if r.Match.Type != "rule-set" || !relevant(r) {
			continue
		}
		tag := r.Match.Value
		mu.Lock()
		_, scheduled := outcomes[tag]
		if !scheduled {
			outcomes[tag] = fetchOutcome{}
		}
		mu.Unlock()
		if scheduled {
			continue
		}
		rs := rsByTag[tag]
		wg.Add(1)
		go func(t string, ref RuleSetRef) {
			defer wg.Done()
			idx, lErr := loadFn(ctx, ref)
			mu.Lock()
			outcomes[t] = fetchOutcome{idx: idx, err: lErr}
			mu.Unlock()
		}(tag, rs)
	}
	wg.Wait()

	var targetIP netip.Addr
	if target.Kind == "ip" {
		targetIP, _ = netip.ParseAddr(target.Value)
	}

	unavailable := make([]string, 0)
	seenUnavail := map[string]bool{}
	checked := 0
	for _, r := range plan.Rules {
		if !relevant(r) {
			continue
		}
		checked++
		hit := false
		if r.Match.Type == "rule-set" {
			out := outcomes[r.Match.Value]
			rs := rsByTag[r.Match.Value]
			if out.err != nil {
				key := rs.Kind + ":" + rs.Name
				if !seenUnavail[key] {
					seenUnavail[key] = true
					unavailable = append(unavailable, key)
				}
				continue
			}
			if target.Kind == "ip" {
				hit = ipInIndex(targetIP, out.idx)
			} else {
				hit = domainInIndex(target.Value, out.idx)
			}
		} else {
			hit = matchesPlainRouteRule(r.Match, target)
		}
		if hit {
			var rInfo RouteRuleInfo
			if r.Match.Type != "rule-set" {
				rInfo = RouteRuleInfo{Origin: r.Origin, Type: r.Match.Type, Value: r.Match.Value}
			} else {
				rs := rsByTag[r.Match.Value]
				rInfo = RouteRuleInfo{Origin: r.Origin, Type: rs.Kind, Value: rs.Name}
			}
			groups, end := followRouteDefaults(plan, r.Target)
			return RouteTraceResult{
				Target:      target,
				Rule:        rInfo,
				Checked:     checked,
				Unavailable: unavailable,
				Groups:      groups,
				End:         end,
			}, nil
		}
	}

	groups, end := followRouteDefaults(plan, plan.Final)
	return RouteTraceResult{
		Target:      target,
		Rule:        RouteRuleInfo{Origin: &RuleOrigin{Kind: "final"}, Type: "final", Value: ""},
		Checked:     checked,
		Unavailable: unavailable,
		Groups:      groups,
		End:         end,
	}, nil
}

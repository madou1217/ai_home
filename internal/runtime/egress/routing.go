package egress

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"net/url"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/subaggregator"
)

const (
	// RoutingPolicyKey 是出口池路由/DNS 策略的 app_kv 键。
	RoutingPolicyKey = "egress:routing"
	maxRoutingRules  = 128
	maxDNSServers    = 4
)

// RoutingRule 是出口池的一条例行路由规则。
//
// Type: domain / domain-suffix / domain-keyword / ip-cidr
// Action: proxy（走池的当前节点）/ direct / reject
type RoutingRule struct {
	ID     string `json:"id"`
	Type   string `json:"type"`
	Value  string `json:"value"`
	Action string `json:"action"`
	Note   string `json:"note,omitempty"`
}

// RoutingDNS 是出口池的 DNS 策略。
//
// Mode=default 时保持内核默认；doh/plain 时使用 Servers。
// Route=proxy 时 DNS 查询走出口池，direct 时走直连；默认 proxy。
type RoutingDNS struct {
	Mode    string   `json:"mode"`
	Servers []string `json:"servers"`
	Route   string   `json:"route"`
}

// RoutingPolicy 是出口池的可视化路由与 DNS 策略。
type RoutingPolicy struct {
	Rules     []RoutingRule `json:"rules"`
	DNS       RoutingDNS    `json:"dns"`
	UpdatedAt int64         `json:"updatedAt,omitempty"`
}

// DefaultRoutingPolicy 返回空规则 + 内核默认 DNS。
func DefaultRoutingPolicy() RoutingPolicy {
	return RoutingPolicy{Rules: []RoutingRule{}, DNS: RoutingDNS{Mode: "default", Servers: []string{}, Route: "proxy"}}
}

// ReadRoutingPolicy 读取出口池路由策略；缺失/损坏时返回默认值。
func ReadRoutingPolicy(ctx context.Context, aiHomeDir string) RoutingPolicy {
	var raw RoutingPolicy
	found, err := readJSONKV(ctx, aiHomeDir, RoutingPolicyKey, &raw)
	if err != nil || !found {
		return DefaultRoutingPolicy()
	}
	policy, normalizeErr := NormalizeRoutingPolicy(raw)
	if normalizeErr != nil {
		return DefaultRoutingPolicy()
	}
	return policy
}

// WriteRoutingPolicy 校验并保存策略。
func WriteRoutingPolicy(ctx context.Context, aiHomeDir string, policy RoutingPolicy, nowMS int64) (RoutingPolicy, error) {
	normalized, err := NormalizeRoutingPolicy(policy)
	if err != nil {
		return RoutingPolicy{}, err
	}
	normalized.UpdatedAt = nowMS
	if err := writeJSONKV(ctx, aiHomeDir, RoutingPolicyKey, normalized, nowMS); err != nil {
		return RoutingPolicy{}, err
	}
	return normalized, nil
}

// NormalizeRoutingPolicy 规范化并校验策略。
func NormalizeRoutingPolicy(policy RoutingPolicy) (RoutingPolicy, error) {
	rules := make([]RoutingRule, 0, len(policy.Rules))
	if len(policy.Rules) > maxRoutingRules {
		return RoutingPolicy{}, fmt.Errorf("routing_rules_too_many: 最多 %d 条", maxRoutingRules)
	}
	for index, rule := range policy.Rules {
		normalized, err := normalizeRoutingRule(rule, index)
		if err != nil {
			return RoutingPolicy{}, err
		}
		rules = append(rules, normalized)
	}
	dns, err := normalizeRoutingDNS(policy.DNS)
	if err != nil {
		return RoutingPolicy{}, err
	}
	return RoutingPolicy{Rules: rules, DNS: dns, UpdatedAt: policy.UpdatedAt}, nil
}

func normalizeRoutingRule(rule RoutingRule, index int) (RoutingRule, error) {
	kind := strings.ToLower(strings.TrimSpace(rule.Type))
	action := strings.ToLower(strings.TrimSpace(rule.Action))
	value := strings.TrimSpace(rule.Value)
	switch kind {
	case "domain", "domain-suffix", "domain-keyword":
		value = strings.ToLower(strings.TrimPrefix(value, "."))
		if value == "" || strings.ContainsAny(value, " \t\r\n/") {
			return RoutingRule{}, errors.New("routing_rule_invalid_domain")
		}
	case "ip-cidr":
		if value == "" {
			return RoutingRule{}, errors.New("routing_rule_invalid_ip")
		}
		if addr, err := netip.ParseAddr(value); err == nil {
			bits := 128
			if addr.Is4() {
				bits = 32
			}
			value = netip.PrefixFrom(addr, bits).Masked().String()
		} else {
			prefix, err := netip.ParsePrefix(value)
			if err != nil {
				return RoutingRule{}, errors.New("routing_rule_invalid_ip")
			}
			value = prefix.Masked().String()
		}
	default:
		return RoutingRule{}, errors.New("routing_rule_invalid_type")
	}
	switch action {
	case "proxy", "direct", "reject":
	default:
		return RoutingRule{}, errors.New("routing_rule_invalid_action")
	}
	id := strings.TrimSpace(rule.ID)
	if id == "" {
		id = fmt.Sprintf("r%d", index+1)
	}
	return RoutingRule{
		ID:     id,
		Type:   kind,
		Value:  value,
		Action: action,
		Note:   strings.TrimSpace(rule.Note),
	}, nil
}

func normalizeRoutingDNS(dns RoutingDNS) (RoutingDNS, error) {
	mode := strings.ToLower(strings.TrimSpace(dns.Mode))
	if mode == "" {
		mode = "default"
	}
	route := strings.ToLower(strings.TrimSpace(dns.Route))
	if route == "" {
		route = "proxy"
	}
	if route != "proxy" && route != "direct" {
		return RoutingDNS{}, errors.New("routing_dns_invalid_route")
	}
	if mode == "default" {
		return RoutingDNS{Mode: "default", Servers: []string{}, Route: route}, nil
	}
	if mode != "doh" && mode != "plain" {
		return RoutingDNS{}, errors.New("routing_dns_invalid_mode")
	}
	servers := make([]string, 0, len(dns.Servers))
	seen := map[string]struct{}{}
	for _, raw := range dns.Servers {
		server := strings.TrimSpace(raw)
		if server == "" {
			continue
		}
		if mode == "doh" {
			parsed, err := url.Parse(server)
			if err != nil || !strings.EqualFold(parsed.Scheme, "https") || parsed.Host == "" {
				return RoutingDNS{}, errors.New("routing_dns_invalid_doh_server")
			}
		} else if strings.Contains(server, "://") || strings.ContainsAny(server, " \t\r\n/") {
			return RoutingDNS{}, errors.New("routing_dns_invalid_plain_server")
		}
		if _, dup := seen[server]; dup {
			continue
		}
		seen[server] = struct{}{}
		servers = append(servers, server)
		if len(servers) >= maxDNSServers {
			break
		}
	}
	if len(servers) == 0 {
		return RoutingDNS{}, errors.New("routing_dns_servers_required")
	}
	return RoutingDNS{Mode: mode, Servers: servers, Route: route}, nil
}

// GetRoutingPolicy 返回当前出口池路由/DNS 策略。
func (m *Manager) GetRoutingPolicy(ctx context.Context) RoutingPolicy {
	if m == nil {
		return DefaultRoutingPolicy()
	}
	return ReadRoutingPolicy(ctx, m.aiHomeDir)
}

// SaveRoutingPolicy 保存策略；restart=true 且池正在运行时重启内核使其生效。
//
// 重启失败会返回错误，但已保存的策略保留（下次池启动生效），调用方必须把
// “已保存但未应用”如实展示给用户。
func (m *Manager) SaveRoutingPolicy(ctx context.Context, policy RoutingPolicy, restart bool) (RoutingPolicy, error) {
	if m == nil {
		return RoutingPolicy{}, errors.New("egress_manager_unavailable")
	}
	normalized, err := WriteRoutingPolicy(ctx, m.aiHomeDir, policy, m.nowMS())
	if err != nil {
		return RoutingPolicy{}, err
	}
	if !restart || !m.IsPoolReady() {
		return normalized, nil
	}
	m.StopPool()
	result := m.StartPool(ctx)
	if !result.OK {
		return normalized, fmt.Errorf("pool_restart_failed: %s", result.Error)
	}
	return normalized, nil
}

// RoutingTestResult 描述一次规则测试的命中结果。
type RoutingTestResult struct {
	Target  string `json:"target"`
	Kind    string `json:"kind"`
	Matched bool   `json:"matched"`
	RuleID  string `json:"ruleId,omitempty"`
	Type    string `json:"type,omitempty"`
	Value   string `json:"value,omitempty"`
	Action  string `json:"action"` // proxy/direct/reject；未命中为 proxy
}

// MatchTarget 按顺序评估域名/IP 目标；未命中时落到出口池（proxy）。
func (policy RoutingPolicy) MatchTarget(input string) (RoutingTestResult, error) {
	target, err := subaggregator.ParseRouteTarget(input)
	if err != nil {
		return RoutingTestResult{}, errors.New("routing_target_invalid")
	}
	result := RoutingTestResult{Target: target.Value, Kind: target.Kind, Action: "proxy"}
	addr, _ := netip.ParseAddr(target.Value)
	for _, rule := range policy.Rules {
		matched := false
		switch rule.Type {
		case "domain":
			matched = target.Kind == "domain" && target.Value == rule.Value
		case "domain-suffix":
			matched = target.Kind == "domain" && (target.Value == rule.Value || strings.HasSuffix(target.Value, "."+rule.Value))
		case "domain-keyword":
			matched = target.Kind == "domain" && strings.Contains(target.Value, rule.Value)
		case "ip-cidr":
			prefix, parseErr := netip.ParsePrefix(rule.Value)
			matched = parseErr == nil && addr.IsValid() && prefix.Contains(addr)
		}
		if matched {
			result.Matched = true
			result.RuleID = rule.ID
			result.Type = rule.Type
			result.Value = rule.Value
			result.Action = rule.Action
			return result, nil
		}
	}
	return result, nil
}

// MihomoRoutingRules 生成 mihomo/clash 规则行（含最后 MATCH）。
func (policy RoutingPolicy) MihomoRoutingRules() []string {
	rules := make([]string, 0, len(policy.Rules)+1)
	for _, rule := range policy.Rules {
		action := "GLOBAL"
		switch rule.Action {
		case "direct":
			action = "DIRECT"
		case "reject":
			action = "REJECT"
		}
		switch rule.Type {
		case "domain":
			rules = append(rules, "DOMAIN,"+rule.Value+","+action)
		case "domain-suffix":
			rules = append(rules, "DOMAIN-SUFFIX,"+rule.Value+","+action)
		case "domain-keyword":
			rules = append(rules, "DOMAIN-KEYWORD,"+rule.Value+","+action)
		case "ip-cidr":
			rules = append(rules, "IP-CIDR,"+rule.Value+","+action+",no-resolve")
		}
	}
	return append(rules, "MATCH,GLOBAL")
}

// SingBoxRoutingRule 是 sing-box 规则片段（不含 inbound 条件）。
type SingBoxRoutingRule struct {
	Match    map[string]any
	Action   string
	HasMatch bool
}

// SingBoxRoutingRules 生成 sing-box 规则匹配片段。inbound 条件由编译方按车道补齐。
func (policy RoutingPolicy) SingBoxRoutingRules() []SingBoxRoutingRule {
	out := make([]SingBoxRoutingRule, 0, len(policy.Rules))
	for _, rule := range policy.Rules {
		match := map[string]any{}
		switch rule.Type {
		case "domain":
			match["domain"] = []string{rule.Value}
		case "domain-suffix":
			match["domain_suffix"] = []string{rule.Value}
		case "domain-keyword":
			match["domain_keyword"] = []string{rule.Value}
		case "ip-cidr":
			match["ip_cidr"] = []string{rule.Value}
		}
		if len(match) == 0 {
			continue
		}
		out = append(out, SingBoxRoutingRule{Match: match, Action: rule.Action, HasMatch: true})
	}
	return out
}

// MihomoNameservers 返回 mihomo DNS nameserver 列表；空表示保持默认。
func (policy RoutingPolicy) MihomoNameservers() []string {
	if policy.DNS.Mode == "default" || len(policy.DNS.Servers) == 0 {
		return nil
	}
	return append([]string(nil), policy.DNS.Servers...)
}

// SingBoxDNS 返回 sing-box DNS 段落；nil 表示不覆盖内核默认。
func (policy RoutingPolicy) SingBoxDNS() map[string]any {
	if policy.DNS.Mode == "default" || len(policy.DNS.Servers) == 0 {
		return nil
	}
	detour := "AIH-GLOBAL"
	if policy.DNS.Route == "direct" {
		detour = "direct"
	}
	servers := make([]map[string]any, 0, len(policy.DNS.Servers))
	for index, server := range policy.DNS.Servers {
		entry := map[string]any{
			"tag":    fmt.Sprintf("aih-dns-%d", index),
			"detour": detour,
		}
		if policy.DNS.Mode == "doh" {
			parsed, err := url.Parse(server)
			if err != nil || parsed.Hostname() == "" {
				return nil
			}
			entry["type"] = "https"
			entry["server"] = parsed.Hostname()
			if port := parsed.Port(); port != "" {
				if number, err := strconv.Atoi(port); err == nil {
					entry["server_port"] = number
				}
			}
			path := parsed.Path
			if path == "" {
				path = "/dns-query"
			}
			entry["path"] = path
		} else {
			host := server
			port := 0
			if h, p, err := net.SplitHostPort(server); err == nil {
				host = h
				port, _ = strconv.Atoi(p)
			}
			entry["type"] = "udp"
			entry["server"] = host
			if port > 0 {
				entry["server_port"] = port
			}
		}
		servers = append(servers, entry)
	}
	return map[string]any{
		"servers": servers,
		"final":   "aih-dns-0",
	}
}

//go:build !no_builtin_renderers

package subaggregator

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"regexp"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/application/profilerender"
)

type Renderer struct {
	ID           string
	Name         string
	Note         string
	ContentType  string
	Extension    string
	Capabilities RendererCapabilities
	CompileNode  func(entry PlannedNode, chainName string, ctx RenderContext) (any, error)
	Render       func(plan AggregationPlan, compiled []any, ctx RenderContext) string
}

var allRenderers []Renderer
var rendererByID map[string]Renderer

func init() {
	stashProtos := []string{"shadowsocks", "shadowsocksr", "vmess", "vless", "trojan", "hysteria", "hysteria2", "tuic", "wireguard", "snell", "socks5", "http", "https"}
	surgeProtos := []string{"shadowsocks", "vmess", "trojan", "hysteria2", "tuic", "snell", "anytls", "wireguard", "socks5", "http", "https"}
	surfboardProtos := []string{"shadowsocks", "vmess", "trojan", "snell", "tuic", "hysteria2", "anytls", "wireguard", "socks5", "http", "https"}
	loonProtos := []string{"shadowsocks", "shadowsocksr", "vmess", "vless", "trojan", "hysteria2", "anytls", "wireguard", "socks5", "http", "https"}
	qxProtos := []string{"shadowsocks", "shadowsocksr", "vmess", "vless", "trojan", "anytls", "socks5", "http", "https"}
	egernProtos := []string{"shadowsocks", "vmess", "vless", "trojan", "hysteria2", "tuic", "anytls", "wireguard", "snell", "socks5", "http", "https"}

	allRenderers = []Renderer{
		newClashFamilyRenderer("mihomo", "Clash Meta / mihomo", "", nil, "mihomo", "mrs", []YAMLKV{
			{Key: "unified-delay", Value: true},
			{Key: "tcp-concurrent", Value: true},
		}, "dialer-proxy", false),
		newClashFamilyRenderer("clash-classic", "Clash（YAML 规则集 · 全协议）",
			"输出全部协议；VLESS / Hysteria2 / TUIC / WireGuard 等需 Meta 系内核（Clash Verge Rev、mihomo、FlClash）",
			nil, "clash-yaml", "", nil, "dialer-proxy", true),
		newClashFamilyRenderer("stash", "Stash", "", stashProtos, "clash-yaml", "", nil, "dialer-proxy", false),
		newSingBoxRenderer(),
		newSurgeFamilyRenderer("surge", "Surge", surgeProtos, "surge", ",dns-failed", "underlying-proxy", true,
			func(testURL string) []string {
				return []string{
					"loglevel = notify",
					"ipv6 = false",
					"dns-server = system, 223.5.5.5, 119.29.29.29",
					"skip-proxy = 127.0.0.1, 192.168.0.0/16, 10.0.0.0/8, 172.16.0.0/12, 100.64.0.0/10, localhost, *.local",
					"exclude-simple-hostnames = true",
					"internet-test-url = http://www.apple.com/library/test/success.html",
					"proxy-test-url = " + testURL,
					"test-timeout = 5",
				}
			}),
		newSurgeFamilyRenderer("surfboard", "Surfboard", surfboardProtos, "surfboard", "", "", true,
			func(testURL string) []string {
				return []string{
					"dns-server = system, 223.5.5.5, 119.29.29.29",
					"skip-proxy = 127.0.0.1, 192.168.0.0/16, 10.0.0.0/8, 172.16.0.0/12, 100.64.0.0/10, localhost, *.local",
					"proxy-test-url = " + testURL,
					"internet-test-url = http://www.gstatic.com/generate_204",
					"test-timeout = 5",
				}
			}),
		newLoonRenderer(loonProtos),
		newQuantumultXRenderer(qxProtos),
		newEgernRenderer(egernProtos),
		newBase64Renderer(),
		newURIRenderer(),
		newJSONRenderer(),
	}
	rendererByID = make(map[string]Renderer, len(allRenderers))
	for _, r := range allRenderers {
		rendererByID[r.ID] = r
	}
}

// GetRenderer 根据 format ID 或别名获取渲染器。
func GetRenderer(target string) (Renderer, bool) {
	id := NormalizeTarget(target)
	r, ok := rendererByID[id]
	return r, ok
}

// DetectRendererByUserAgent 按 UA 选择默认渲染器。
func DetectRendererByUserAgent(userAgent string) Renderer {
	c := DetectClient(userAgent)
	if r, ok := GetRenderer(c.Target); ok {
		return r
	}
	return allRenderers[0]
}

// DescribeRenderers 返回 catalog.formats 描述列表。
func DescribeRenderers() []FormatDef {
	out := make([]FormatDef, 0, len(allRenderers))
	for _, r := range allRenderers {
		out = append(out, FormatDef{
			ID:        r.ID,
			Name:      r.Name,
			Extension: r.Extension,
			Groups:    r.Capabilities.Groups,
			Note:      r.Note,
		})
	}
	return out
}

func clashTargetName(ref TargetRef) string {
	switch ref.Kind {
	case "direct":
		return "DIRECT"
	case "reject":
		return "REJECT"
	default:
		return ref.Name
	}
}

func surgePolicyName(ref TargetRef) string {
	switch ref.Kind {
	case "direct":
		return "DIRECT"
	case "reject":
		return "REJECT"
	default:
		return SanitizeSurgeName(ref.Name)
	}
}

func qxPolicyName(ref TargetRef) string {
	switch ref.Kind {
	case "direct":
		return "direct"
	case "reject":
		return "reject"
	default:
		return SanitizeSurgeName(ref.Name)
	}
}

func testURLOfPlan(plan AggregationPlan) string {
	for _, g := range plan.Groups {
		if g.Type == "url-test" && g.URL != "" {
			return g.URL
		}
	}
	return DefaultTestURL
}

func relayEndpointForNode(ctx RenderContext, nodeID string) (RelayEndpoint, bool) {
	if ctx.Relay == nil || len(ctx.Relay.Endpoints) == 0 || nodeID == "" {
		return RelayEndpoint{}, false
	}
	ep, ok := ctx.Relay.Endpoints[nodeID]
	return ep, ok
}

func adaptStashProxy(proxy *YAMLMap, node ProxyNode) {
	pType, _ := proxy.Get("type")
	if pType == "hysteria" {
		if up, ok := node.Float("upMbps"); ok {
			proxy.Set("up-speed", up)
		}
		if down, ok := node.Float("downMbps"); ok {
			proxy.Set("down-speed", down)
		}
		if proto, ok := proxy.Get("protocol"); ok {
			proxy.Set("obfs-protocol", proto)
		}
	}
	if pType == "tuic" {
		if _, hasUUID := proxy.Get("uuid"); hasUUID {
			proxy.Set("version", 5)
		}
	}
}

func newClashFamilyRenderer(id, name, note string, protocols []string, ruleSetFile, ruleSetFormat string, extraConfig []YAMLKV, proxyChain string, relayFallback bool) Renderer {
	var supported map[string]bool
	if protocols != nil {
		supported = make(map[string]bool, len(protocols))
		for _, p := range protocols {
			supported[p] = true
		}
	}
	providerExt := "mrs"
	if ruleSetFile == "clash-yaml" {
		providerExt = "yaml"
	}
	return Renderer{
		ID:          id,
		Name:        name,
		Note:        note,
		ContentType: "text/yaml; charset=utf-8",
		Extension:   "yaml",
		Capabilities: RendererCapabilities{
			RejectInGroups: true,
			Groups:         true,
			Protocols:      protocols,
			ProxyChain:     proxyChain,
			RelayFallback:  relayFallback,
		},
		CompileNode: func(entry PlannedNode, chainName string, ctx RenderContext) (any, error) {
			proto := NormalizeProtocolAlias(entry.Node.Str("protocol"))
			if supported != nil && !supported[proto] {
				return nil, errInvalid("unsupported_proxy_protocol_" + proto)
			}
			if relayFallback {
				if ep, ok := relayEndpointForNode(ctx, entry.Node.Str("id")); ok {
					return compileRelayMihomoEntry(entry.Name, ep), nil
				}
				if ep, ok := relayEndpointForNode(ctx, entry.ID); ok {
					return compileRelayMihomoEntry(entry.Name, ep), nil
				}
			}
			proxy, err := CompileMihomoProxy(entry.Node, entry.Name, id)
			if err != nil {
				return nil, err
			}
			if SupportsUDPRelay(entry.Node) {
				proxy.Set("udp", true)
			}
			if id == "stash" {
				adaptStashProxy(proxy, entry.Node)
			}
			if chainName != "" {
				proxy.Set("dialer-proxy", chainName)
			}
			return proxy, nil
		},
		Render: func(plan AggregationPlan, compiled []any, ctx RenderContext) string {
			if ctx.View == "nodes" {
				root := &YAMLMap{}
				root.Set("proxies", compiled)
				return EmitYAML(root) + "\n"
			}
			ruleProviders := &YAMLMap{}
			for _, rs := range plan.RuleSets {
				behavior := "domain"
				if rs.Kind == "geoip" {
					behavior = "ipcidr"
				}
				rp := &YAMLMap{}
				rp.Set("type", "http")
				rp.Set("behavior", behavior)
				if ruleSetFormat != "" {
					rp.Set("format", ruleSetFormat)
				}
				rp.Set("url", RuleSetURL(rs, ruleSetFile))
				rp.Set("path", fmt.Sprintf("./rule-providers/%s.%s", rs.Tag, providerExt))
				rp.Set("interval", 86400)
				ruleProviders.Set(rs.Tag, rp)
			}
			groups := make([]any, 0, len(plan.Groups))
			for _, g := range plan.Groups {
				gm := &YAMLMap{}
				gm.Set("name", g.Name)
				gm.Set("type", g.Type)
				members := make([]string, 0, len(g.Members))
				for _, m := range g.Members {
					members = append(members, clashTargetName(m))
				}
				gm.Set("proxies", members)
				if g.Type == "url-test" || g.Type == "fallback" || g.Type == "load-balance" {
					gm.Set("url", g.URL)
					gm.Set("interval", g.Interval)
				}
				if g.Type == "url-test" {
					gm.Set("tolerance", g.Tolerance)
				}
				if g.Type == "load-balance" {
					st := g.Strategy
					if st == "" {
						st = "consistent-hashing"
					}
					gm.Set("strategy", st)
				}
				groups = append(groups, gm)
			}
			rules := make([]string, 0, len(plan.Rules)+1)
			for _, r := range plan.Rules {
				tgt := clashTargetName(r.Target)
				switch r.Match.Type {
				case "rule-set":
					nr := ""
					if r.Match.NoResolve {
						nr = ",no-resolve"
					}
					rules = append(rules, fmt.Sprintf("RULE-SET,%s,%s%s", r.Match.Value, tgt, nr))
				case "ip-cidr":
					kw := "IP-CIDR"
					addr, _, _ := strings.Cut(r.Match.Value, "/")
					if ip := net.ParseIP(addr); ip != nil && ip.To4() == nil {
						kw = "IP-CIDR6"
					}
					rules = append(rules, fmt.Sprintf("%s,%s,%s,no-resolve", kw, r.Match.Value, tgt))
				case "domain":
					rules = append(rules, fmt.Sprintf("DOMAIN,%s,%s", r.Match.Value, tgt))
				case "domain-suffix":
					rules = append(rules, fmt.Sprintf("DOMAIN-SUFFIX,%s,%s", r.Match.Value, tgt))
				case "domain-keyword":
					rules = append(rules, fmt.Sprintf("DOMAIN-KEYWORD,%s,%s", r.Match.Value, tgt))
				}
			}
			rules = append(rules, "MATCH,"+clashTargetName(plan.Final))

			dns := &YAMLMap{}
			dns.Set("enable", true)
			dns.Set("ipv6", false)
			dns.Set("enhanced-mode", "fake-ip")
			dns.Set("fake-ip-range", "198.18.0.1/16")
			dns.Set("fake-ip-filter", []string{"*.lan", "+.local", "+.msftconnecttest.com", "+.msftncsi.com"})
			dns.Set("default-nameserver", []string{"223.5.5.5", "119.29.29.29"})
			dns.Set("nameserver", []string{"https://dns.alidns.com/dns-query", "https://doh.pub/dns-query"})

			cfg := &YAMLMap{}
			cfg.Set("mixed-port", 7890)
			cfg.Set("allow-lan", false)
			cfg.Set("mode", "rule")
			cfg.Set("log-level", "info")
			cfg.Set("ipv6", false)
			for _, kv := range extraConfig {
				cfg.Set(kv.Key, kv.Value)
			}
			cfg.Set("dns", dns)
			cfg.Set("proxies", compiled)
			cfg.Set("proxy-groups", groups)
			cfg.Set("rule-providers", ruleProviders)
			cfg.Set("rules", rules)
			return EmitYAML(cfg) + "\n"
		},
	}
}

func newSingBoxRenderer() Renderer {
	sbTag := func(ref TargetRef) string {
		if ref.Kind == "direct" {
			return "direct"
		}
		return ref.Name
	}
	resolveSBChains := func(compiled []any) (outbounds []*YAMLMap, endpoints []*YAMLMap, auxiliaries []*YAMLMap) {
		nodes := make([]SingBoxCompiled, 0, len(compiled))
		usedTags := map[string]bool{}
		for _, item := range compiled {
			sc, ok := item.(SingBoxCompiled)
			if !ok {
				continue
			}
			if t, ok := sc.Item.Get("tag"); ok {
				usedTags[fmt.Sprint(t)] = true
			}
			nodes = append(nodes, sc)
		}

		assignedAux := map[string]string{}
		for i := range nodes {
			for j := range nodes[i].Extras {
				aux := nodes[i].Extras[j]
				origV, _ := aux.Get("tag")
				origTag := fmt.Sprint(origV)
				newTag, exists := assignedAux[origTag]
				if !exists {
					newTag = origTag
					for attempt := 1; usedTags[newTag]; attempt++ {
						newTag = fmt.Sprintf("%s-%d", origTag, attempt)
					}
					usedTags[newTag] = true
					assignedAux[origTag] = newTag
					clonedAux := cloneYAMLMap(aux)
					clonedAux.Set("tag", newTag)
					auxiliaries = append(auxiliaries, clonedAux)
				}
				if d, ok := nodes[i].Item.Get("detour"); ok && fmt.Sprint(d) == origTag {
					nodes[i].Item.Set("detour", newTag)
				}
			}
		}

		auxByTag := make(map[string]*YAMLMap, len(auxiliaries))
		for _, a := range auxiliaries {
			if t, ok := a.Get("tag"); ok {
				auxByTag[fmt.Sprint(t)] = a
			}
		}
		for _, sc := range nodes {
			item := cloneYAMLMap(sc.Item)
			if sc.ChainTag != "" {
				existingDetour := ""
				if d, ok := item.Get("detour"); ok {
					existingDetour = fmt.Sprint(d)
				}
				if existingDetour != "" {
					if aux, ok := auxByTag[existingDetour]; ok {
						aux.Set("detour", sc.ChainTag)
					} else {
						item.Set("detour", sc.ChainTag)
					}
				} else {
					item.Set("detour", sc.ChainTag)
				}
			}
			if sc.IsEndpoint {
				endpoints = append(endpoints, item)
			} else {
				outbounds = append(outbounds, item)
			}
		}
		return outbounds, endpoints, auxiliaries
	}

	return Renderer{
		ID:          "sing-box",
		Name:        "sing-box",
		ContentType: "application/json; charset=utf-8",
		Extension:   "json",
		Capabilities: RendererCapabilities{
			RejectInGroups: false,
			Groups:         true,
			GroupTypes:     []string{"select", "url-test"},
			ProxyChain:     "detour",
		},
		CompileNode: func(entry PlannedNode, chainName string, ctx RenderContext) (any, error) {
			compiled, err := CompileSingBoxOutbound(entry.Node, entry.Name, ctx.Client.SingBoxVersion, ctx.Client.OfficialApp)
			if err != nil {
				return nil, err
			}
			compiled.ChainTag = chainName
			return compiled, nil
		},
		Render: func(plan AggregationPlan, compiled []any, ctx RenderContext) string {
			outbounds, endpoints, auxiliaries := resolveSBChains(compiled)
			if ctx.View == "nodes" {
				allOut := make([]*YAMLMap, 0, len(outbounds)+len(auxiliaries))
				allOut = append(allOut, outbounds...)
				allOut = append(allOut, auxiliaries...)
				if allOut == nil {
					allOut = []*YAMLMap{}
				}
				root := &YAMLMap{}
				root.Set("outbounds", allOut)
				if len(endpoints) > 0 {
					root.Set("endpoints", endpoints)
				}
				return prettyJSONFromYAMLMap(root) + "\n"
			}

			proxyGroupTag := ""
			if len(plan.Groups) > 0 {
				proxyGroupTag = plan.Groups[0].Name
			}
			hasCN := false
			for _, rs := range plan.RuleSets {
				if rs.Tag == "geosite-cn" {
					hasCN = true
					break
				}
			}

			dnsRemote := &YAMLMap{}
			dnsRemote.Set("type", "https")
			dnsRemote.Set("tag", "dns-remote")
			dnsRemote.Set("server", "1.1.1.1")
			if proxyGroupTag != "" {
				dnsRemote.Set("detour", proxyGroupTag)
			}
			dnsDirect := &YAMLMap{}
			dnsDirect.Set("type", "https")
			dnsDirect.Set("tag", "dns-direct")
			dnsDirect.Set("server", "223.5.5.5")
			dnsRules := []*YAMLMap{}
			if hasCN {
				r := &YAMLMap{}
				r.Set("rule_set", []string{"geosite-cn"})
				r.Set("server", "dns-direct")
				dnsRules = append(dnsRules, r)
			}
			dns := &YAMLMap{}
			dns.Set("servers", []*YAMLMap{dnsRemote, dnsDirect})
			dns.Set("rules", dnsRules)
			dns.Set("final", "dns-remote")
			dns.Set("strategy", "ipv4_only")

			inTun := &YAMLMap{}
			inTun.Set("type", "tun")
			inTun.Set("tag", "tun-in")
			inTun.Set("address", []string{"172.19.0.1/30"})
			inTun.Set("auto_route", true)
			inTun.Set("strict_route", true)
			inMixed := &YAMLMap{}
			inMixed.Set("type", "mixed")
			inMixed.Set("tag", "mixed-in")
			inMixed.Set("listen", "127.0.0.1")
			inMixed.Set("listen_port", 2080)

			var groupOutbounds []*YAMLMap
			for _, g := range plan.Groups {
				members := make([]string, 0, len(g.Members))
				for _, m := range g.Members {
					members = append(members, sbTag(m))
				}
				gm := &YAMLMap{}
				if g.Type == "url-test" {
					gm.Set("type", "urltest")
					gm.Set("tag", g.Name)
					gm.Set("outbounds", members)
					gm.Set("url", g.URL)
					gm.Set("interval", fmt.Sprintf("%ds", g.Interval))
					gm.Set("tolerance", g.Tolerance)
				} else {
					gm.Set("type", "selector")
					gm.Set("tag", g.Name)
					gm.Set("outbounds", members)
					if len(members) > 0 {
						gm.Set("default", members[0])
					}
				}
				groupOutbounds = append(groupOutbounds, gm)
			}

			directOut := &YAMLMap{}
			directOut.Set("type", "direct")
			directOut.Set("tag", "direct")

			fullOutbounds := make([]*YAMLMap, 0, len(groupOutbounds)+len(outbounds)+len(auxiliaries)+1)
			fullOutbounds = append(fullOutbounds, groupOutbounds...)
			fullOutbounds = append(fullOutbounds, outbounds...)
			fullOutbounds = append(fullOutbounds, auxiliaries...)
			fullOutbounds = append(fullOutbounds, directOut)

			sniffRule := &YAMLMap{}
			sniffRule.Set("action", "sniff")
			dnsHijackRule := &YAMLMap{}
			dnsHijackRule.Set("protocol", "dns")
			dnsHijackRule.Set("action", "hijack-dns")
			routeRules := []*YAMLMap{sniffRule, dnsHijackRule}
			for _, r := range plan.Rules {
				rm := &YAMLMap{}
				switch r.Match.Type {
				case "rule-set":
					rm.Set("rule_set", []string{r.Match.Value})
				case "domain":
					rm.Set("domain", []string{r.Match.Value})
				case "domain-suffix":
					rm.Set("domain_suffix", []string{r.Match.Value})
				case "domain-keyword":
					rm.Set("domain_keyword", []string{r.Match.Value})
				case "ip-cidr":
					rm.Set("ip_cidr", []string{r.Match.Value})
				}
				if r.Target.Kind == "reject" {
					rm.Set("action", "reject")
				} else {
					rm.Set("outbound", sbTag(r.Target))
				}
				routeRules = append(routeRules, rm)
			}

			ruleSetEntries := make([]*YAMLMap, 0, len(plan.RuleSets))
			for _, rs := range plan.RuleSets {
				rsm := &YAMLMap{}
				rsm.Set("type", "remote")
				rsm.Set("tag", rs.Tag)
				rsm.Set("format", "binary")
				rsm.Set("url", RuleSetURL(rs, "sing-box"))
				rsm.Set("download_detour", "direct")
				ruleSetEntries = append(ruleSetEntries, rsm)
			}

			routeObj := &YAMLMap{}
			routeObj.Set("rules", routeRules)
			routeObj.Set("rule_set", ruleSetEntries)
			routeObj.Set("final", sbTag(plan.Final))
			routeObj.Set("auto_detect_interface", true)
			routeObj.Set("default_domain_resolver", "dns-direct")

			logObj := &YAMLMap{}
			logObj.Set("level", "warn")
			logObj.Set("timestamp", true)

			cacheFile := &YAMLMap{}
			cacheFile.Set("enabled", true)
			expObj := &YAMLMap{}
			expObj.Set("cache_file", cacheFile)

			cfg := &YAMLMap{}
			cfg.Set("log", logObj)
			cfg.Set("dns", dns)
			cfg.Set("inbounds", []*YAMLMap{inTun, inMixed})
			cfg.Set("outbounds", fullOutbounds)
			if len(endpoints) > 0 {
				cfg.Set("endpoints", endpoints)
			}
			cfg.Set("route", routeObj)
			cfg.Set("experimental", expObj)
			return prettyJSONFromYAMLMap(cfg) + "\n"
		},
	}
}

func cloneYAMLMap(m *YAMLMap) *YAMLMap {
	if m == nil {
		return nil
	}
	c := &YAMLMap{Entries: make([]YAMLKV, len(m.Entries))}
	copy(c.Entries, m.Entries)
	return c
}

func prettyJSONFromYAMLMap(v any) string {
	return string(renderPrettyJSON(v, ""))
}

func renderPrettyJSON(v any, indent string) []byte {
	nextIndent := indent + "  "
	switch t := v.(type) {
	case *YAMLMap:
		if t == nil || len(t.Entries) == 0 {
			return []byte("{}")
		}
		var b strings.Builder
		b.WriteString("{\n")
		for i, kv := range t.Entries {
			kb, _ := json.Marshal(kv.Key)
			b.WriteString(nextIndent)
			b.Write(kb)
			b.WriteString(": ")
			b.Write(renderPrettyJSON(kv.Value, nextIndent))
			if i < len(t.Entries)-1 {
				b.WriteByte(',')
			}
			b.WriteByte('\n')
		}
		b.WriteString(indent)
		b.WriteByte('}')
		return []byte(b.String())
	case []*YAMLMap:
		if len(t) == 0 {
			return []byte("[]")
		}
		var b strings.Builder
		b.WriteString("[\n")
		for i, item := range t {
			b.WriteString(nextIndent)
			b.Write(renderPrettyJSON(item, nextIndent))
			if i < len(t)-1 {
				b.WriteByte(',')
			}
			b.WriteByte('\n')
		}
		b.WriteString(indent)
		b.WriteByte(']')
		return []byte(b.String())
	case []string:
		if len(t) == 0 {
			return []byte("[]")
		}
		var b strings.Builder
		b.WriteString("[\n")
		for i, s := range t {
			sb, _ := json.Marshal(s)
			b.WriteString(nextIndent)
			b.Write(sb)
			if i < len(t)-1 {
				b.WriteByte(',')
			}
			b.WriteByte('\n')
		}
		b.WriteString(indent)
		b.WriteByte(']')
		return []byte(b.String())
	case []int:
		if len(t) == 0 {
			return []byte("[]")
		}
		var b strings.Builder
		b.WriteString("[\n")
		for i, n := range t {
			b.WriteString(nextIndent)
			b.WriteString(strconv.Itoa(n))
			if i < len(t)-1 {
				b.WriteByte(',')
			}
			b.WriteByte('\n')
		}
		b.WriteString(indent)
		b.WriteByte(']')
		return []byte(b.String())
	default:
		b, _ := marshalCompactNoEscape(t)
		return b
	}
}

func compileSurgeGroupLine(group PlannedGroup, allGroups []PlannedGroup, dialect string) string {
	tested := group.Type != "select"
	refs := group.Members
	if tested {
		refs = FlattenGroupMembers(allGroups, group)
	}
	names := make([]string, 0, len(refs))
	for _, r := range refs {
		names = append(names, surgePolicyName(r))
	}
	if len(names) == 0 {
		names = []string{"DIRECT"}
	}
	list := strings.Join(names, ", ")
	gName := SanitizeSurgeName(group.Name)
	probe := fmt.Sprintf("url=%s, interval=%d", group.URL, group.Interval)
	switch group.Type {
	case "url-test":
		return fmt.Sprintf("%s = url-test, %s, %s, tolerance=%d", gName, list, probe, group.Tolerance)
	case "fallback":
		if dialect == "loon" {
			return fmt.Sprintf("%s = fallback, %s, %s, max-timeout=3000", gName, list, probe)
		}
		return fmt.Sprintf("%s = fallback, %s, %s, timeout=5", gName, list, probe)
	case "load-balance":
		st := group.Strategy
		if st == "" {
			st = "consistent-hashing"
		}
		if dialect == "loon" {
			alg := "PCC"
			if st == "round-robin" {
				alg = "Round-Robin"
			}
			return fmt.Sprintf("%s = load-balance, %s, %s, algorithm=%s", gName, list, probe, alg)
		}
		pers := ""
		if st == "consistent-hashing" {
			pers = ", persistent=true"
		}
		return fmt.Sprintf("%s = load-balance, %s, %s%s", gName, list, probe, pers)
	default:
		return fmt.Sprintf("%s = select, %s", gName, list)
	}
}

func compileSurgeMatchRule(r PlannedRule) string {
	tgt := surgePolicyName(r.Target)
	switch r.Match.Type {
	case "domain":
		return "DOMAIN," + r.Match.Value + "," + tgt
	case "domain-suffix":
		return "DOMAIN-SUFFIX," + r.Match.Value + "," + tgt
	case "domain-keyword":
		return "DOMAIN-KEYWORD," + r.Match.Value + "," + tgt
	case "ip-cidr":
		kw := "IP-CIDR"
		addr, _, _ := strings.Cut(r.Match.Value, "/")
		if ip := net.ParseIP(addr); ip != nil && ip.To4() == nil {
			kw = "IP-CIDR6"
		}
		return kw + "," + r.Match.Value + "," + tgt + ",no-resolve"
	}
	return ""
}

func toCompiledLineEntries(compiled []any) []CompiledLineEntry {
	out := make([]CompiledLineEntry, 0, len(compiled))
	for _, c := range compiled {
		if le, ok := c.(CompiledLineEntry); ok {
			out = append(out, le)
		}
	}
	return out
}

func newSurgeFamilyRenderer(id, name string, protocols []string, compileTarget, finalSuffix, proxyChain string, relayFallback bool, generalFn func(string) []string) Renderer {
	supported := make(map[string]bool, len(protocols))
	for _, p := range protocols {
		supported[p] = true
	}
	return Renderer{
		ID:          id,
		Name:        name,
		ContentType: "text/plain; charset=utf-8",
		Extension:   "conf",
		Capabilities: RendererCapabilities{
			RejectInGroups: true,
			Groups:         true,
			Protocols:      protocols,
			CoreProtocols:  protocols,
			RelayFallback:  relayFallback,
			RuleSetFormat:  "domain-set",
			SanitizeName:   SanitizeSurgeName,
			ProxyChain:     proxyChain,
		},
		CompileNode: func(entry PlannedNode, chainName string, ctx RenderContext) (any, error) {
			proto := NormalizeProtocolAlias(entry.Node.Str("protocol"))
			if relayFallback {
				if ep, ok := relayEndpointForNode(ctx, entry.Node.Str("id")); ok {
					return compileRelaySurgeEntry(entry.Name, ep), nil
				}
				if ep, ok := relayEndpointForNode(ctx, entry.ID); ok {
					return compileRelaySurgeEntry(entry.Name, ep), nil
				}
			}
			if !supported[proto] {
				return nil, errInvalid("unsupported_proxy_protocol_" + proto)
			}
			return CompileSurgeFamilyEntry(compileTarget, entry.Node, entry.Name, chainName, proxyChain)
		},
		Render: func(plan AggregationPlan, compiled []any, ctx RenderContext) string {
			lines, sections := collectSurgeLines(toCompiledLineEntries(compiled))
			if ctx.View == "nodes" {
				if len(lines) == 0 {
					return ""
				}
				parts := append(append([]string(nil), lines...), "")
				parts = append(parts, sections...)
				return strings.Join(parts, "\n") + "\n"
			}
			rsByTag := make(map[string]RuleSetRef, len(plan.RuleSets))
			for _, rs := range plan.RuleSets {
				rsByTag[rs.Tag] = rs
			}
			var out []string
			if ctx.SubscriptionURL != "" {
				out = append(out, fmt.Sprintf("#!MANAGED-CONFIG %s interval=%d strict=false", ctx.SubscriptionURL, ctx.UpdateIntervalSeconds), "")
			}
			out = append(out, "[General]")
			out = append(out, generalFn(testURLOfPlan(plan))...)
			out = append(out, "", "[Proxy]")
			out = append(out, lines...)
			out = append(out, "")
			out = append(out, sections...)
			out = append(out, "[Proxy Group]")
			for _, g := range plan.Groups {
				out = append(out, compileSurgeGroupLine(g, plan.Groups, "surge"))
			}
			out = append(out, "", "[Rule]")
			for _, r := range plan.Rules {
				if r.Match.Type != "rule-set" {
					if line := compileSurgeMatchRule(r); line != "" {
						out = append(out, line)
					}
					continue
				}
				rs, ok := rsByTag[r.Match.Value]
				if !ok {
					continue
				}
				u := ctx.ruleSetEndpoint(rs)
				if u == "" {
					continue
				}
				tgt := surgePolicyName(r.Target)
				if rs.Kind == "geoip" {
					out = append(out, fmt.Sprintf("RULE-SET,%s,%s,no-resolve", u, tgt))
				} else {
					out = append(out, fmt.Sprintf("DOMAIN-SET,%s,%s", u, tgt))
				}
			}
			out = append(out, fmt.Sprintf("FINAL,%s%s", surgePolicyName(plan.Final), finalSuffix), "")
			return strings.Join(out, "\n")
		},
	}
}

func newLoonRenderer(protocols []string) Renderer {
	supported := make(map[string]bool, len(protocols))
	for _, p := range protocols {
		supported[p] = true
	}
	const bypassTUN = "10.0.0.0/8,100.64.0.0/10,127.0.0.0/8,169.254.0.0/16,172.16.0.0/12,192.168.0.0/16,224.0.0.0/4,255.255.255.255/32"
	return Renderer{
		ID:          "loon",
		Name:        "Loon",
		ContentType: "text/plain; charset=utf-8",
		Extension:   "conf",
		Capabilities: RendererCapabilities{
			RejectInGroups: true,
			Groups:         true,
			Protocols:      protocols,
			RuleSetFormat:  "rule-set",
			SanitizeName:   SanitizeSurgeName,
		},
		CompileNode: func(entry PlannedNode, _ string, _ RenderContext) (any, error) {
			proto := NormalizeProtocolAlias(entry.Node.Str("protocol"))
			if !supported[proto] {
				return nil, errInvalid("unsupported_proxy_protocol_" + proto)
			}
			return CompileSurgeFamilyEntry("loon", entry.Node, entry.Name, "", "")
		},
		Render: func(plan AggregationPlan, compiled []any, ctx RenderContext) string {
			lines, _ := collectSurgeLines(toCompiledLineEntries(compiled))
			if ctx.View == "nodes" {
				if len(lines) == 0 {
					return ""
				}
				return strings.Join(lines, "\n") + "\n"
			}
			rsByTag := make(map[string]RuleSetRef, len(plan.RuleSets))
			for _, rs := range plan.RuleSets {
				rsByTag[rs.Tag] = rs
			}
			var remoteRules, localRules []string
			for _, r := range plan.Rules {
				if r.Match.Type != "rule-set" {
					if line := compileSurgeMatchRule(r); line != "" {
						localRules = append(localRules, line)
					}
					continue
				}
				rs, ok := rsByTag[r.Match.Value]
				if !ok {
					continue
				}
				u := ctx.ruleSetEndpoint(rs)
				if u != "" {
					remoteRules = append(remoteRules, fmt.Sprintf("%s, policy=%s, tag=%s, enabled=true", u, surgePolicyName(r.Target), rs.Tag))
				}
			}
			var out []string
			out = append(out,
				"[General]",
				"ip-mode = dual",
				"dns-server = system,223.5.5.5,119.29.29.29",
				"skip-proxy = 192.168.0.0/16,10.0.0.0/8,172.16.0.0/12,localhost,*.local",
				"bypass-tun = "+bypassTUN,
				"proxy-test-url = "+testURLOfPlan(plan),
				"internet-test-url = http://www.gstatic.com/generate_204",
				"test-timeout = 5",
				"",
				"[Proxy]",
			)
			out = append(out, lines...)
			out = append(out, "", "[Proxy Group]")
			for _, g := range plan.Groups {
				out = append(out, compileSurgeGroupLine(g, plan.Groups, "loon"))
			}
			out = append(out, "", "[Remote Rule]")
			out = append(out, remoteRules...)
			out = append(out, "", "[Rule]")
			out = append(out, localRules...)
			out = append(out, "FINAL,"+surgePolicyName(plan.Final), "")
			return strings.Join(out, "\n")
		},
	}
}

func newQuantumultXRenderer(protocols []string) Renderer {
	supported := make(map[string]bool, len(protocols))
	for _, p := range protocols {
		supported[p] = true
	}
	return Renderer{
		ID:          "quantumult-x",
		Name:        "Quantumult X",
		ContentType: "text/plain; charset=utf-8",
		Extension:   "conf",
		Capabilities: RendererCapabilities{
			RejectInGroups: true,
			Groups:         true,
			Protocols:      protocols,
			RuleSetFormat:  "quantumult-x",
			SanitizeName:   SanitizeSurgeName,
		},
		CompileNode: func(entry PlannedNode, _ string, _ RenderContext) (any, error) {
			proto := NormalizeProtocolAlias(entry.Node.Str("protocol"))
			if !supported[proto] {
				return nil, errInvalid("unsupported_proxy_protocol_" + proto)
			}
			return CompileQuantumultXEntry(entry.Node, entry.Name)
		},
		Render: func(plan AggregationPlan, compiled []any, ctx RenderContext) string {
			lines, _ := collectSurgeLines(toCompiledLineEntries(compiled))
			if ctx.View == "nodes" {
				if len(lines) == 0 {
					return ""
				}
				return strings.Join(lines, "\n") + "\n"
			}
			rsByTag := make(map[string]RuleSetRef, len(plan.RuleSets))
			for _, rs := range plan.RuleSets {
				rsByTag[rs.Tag] = rs
			}
			var remoteRules, localRules []string
			for _, r := range plan.Rules {
				tgt := qxPolicyName(r.Target)
				if r.Match.Type != "rule-set" {
					switch r.Match.Type {
					case "ip-cidr":
						kw := "ip-cidr"
						addr, _, _ := strings.Cut(r.Match.Value, "/")
						if ip := net.ParseIP(addr); ip != nil && ip.To4() == nil {
							kw = "ip6-cidr"
						}
						localRules = append(localRules, fmt.Sprintf("%s, %s, %s, no-resolve", kw, r.Match.Value, tgt))
					case "domain":
						localRules = append(localRules, fmt.Sprintf("host, %s, %s", r.Match.Value, tgt))
					case "domain-suffix":
						localRules = append(localRules, fmt.Sprintf("host-suffix, %s, %s", r.Match.Value, tgt))
					case "domain-keyword":
						localRules = append(localRules, fmt.Sprintf("host-keyword, %s, %s", r.Match.Value, tgt))
					}
					continue
				}
				rs, ok := rsByTag[r.Match.Value]
				if !ok {
					continue
				}
				u := ctx.ruleSetEndpoint(rs)
				if u != "" {
					remoteRules = append(remoteRules, fmt.Sprintf("%s, tag=%s, force-policy=%s, update-interval=86400, opt-parser=false, enabled=true", u, rs.Tag, tgt))
				}
			}
			testURL := testURLOfPlan(plan)
			var out []string
			out = append(out,
				"[general]",
				"network_check_url="+testURL,
				"server_check_url="+testURL,
				"server_check_timeout=3000",
				"excluded_routes=192.168.0.0/16, 172.16.0.0/12, 100.64.0.0/10, 10.0.0.0/8",
				"",
				"[dns]",
				"server=223.5.5.5",
				"server=119.29.29.29",
				"",
				"[policy]",
			)
			for _, g := range plan.Groups {
				gName := SanitizeSurgeName(g.Name)
				if g.Type != "select" {
					flat := FlattenGroupMembers(plan.Groups, g)
					var nodeNames []string
					for _, m := range flat {
						if m.Kind == "node" {
							nodeNames = append(nodeNames, qxPolicyName(m))
						}
					}
					if len(nodeNames) > 0 {
						list := strings.Join(nodeNames, ", ")
						switch g.Type {
						case "url-test":
							out = append(out, fmt.Sprintf("url-latency-benchmark=%s, %s, check-interval=%d, tolerance=%d, alive-checking=false", gName, list, g.Interval, g.Tolerance))
						case "fallback":
							out = append(out, fmt.Sprintf("available=%s, %s", gName, list))
						default:
							kind := "dest-hash"
							if g.Strategy == "round-robin" {
								kind = "round-robin"
							}
							out = append(out, fmt.Sprintf("%s=%s, %s", kind, gName, list))
						}
						continue
					}
				}
				members := make([]string, 0, len(g.Members))
				for _, m := range g.Members {
					members = append(members, qxPolicyName(m))
				}
				if len(members) == 0 {
					members = []string{"direct"}
				}
				out = append(out, fmt.Sprintf("static=%s, %s", gName, strings.Join(members, ", ")))
			}
			out = append(out, "", "[server_local]")
			out = append(out, lines...)
			out = append(out, "", "[filter_remote]")
			out = append(out, remoteRules...)
			out = append(out, "", "[filter_local]")
			out = append(out, localRules...)
			out = append(out, "final, "+qxPolicyName(plan.Final), "")
			return strings.Join(out, "\n")
		},
	}
}

func newEgernRenderer(protocols []string) Renderer {
	return Renderer{
		ID:          "egern",
		Name:        "Egern（实验）",
		ContentType: "text/yaml; charset=utf-8",
		Extension:   "yaml",
		Capabilities: RendererCapabilities{
			RejectInGroups: true,
			Groups:         true,
			Protocols:      protocols,
			RuleSetFormat:  "egern",
		},
		CompileNode: func(entry PlannedNode, _ string, _ RenderContext) (any, error) {
			return CompileEgernProxy(entry.Node, entry.Name)
		},
		Render: func(plan AggregationPlan, compiled []any, ctx RenderContext) string {
			if ctx.View == "nodes" {
				root := &YAMLMap{}
				root.Set("proxies", compiled)
				return EmitYAML(root) + "\n"
			}
			rsByTag := make(map[string]RuleSetRef, len(plan.RuleSets))
			for _, rs := range plan.RuleSets {
				rsByTag[rs.Tag] = rs
			}
			policyGroups := make([]*YAMLMap, 0, len(plan.Groups))
			for _, g := range plan.Groups {
				policies := make([]string, 0, len(g.Members))
				for _, m := range g.Members {
					policies = append(policies, clashTargetName(m))
				}
				if len(policies) == 0 {
					policies = []string{"DIRECT"}
				}
				inner := &YAMLMap{}
				inner.Set("name", g.Name)
				inner.Set("policies", policies)
				wrapper := &YAMLMap{}
				switch g.Type {
				case "url-test":
					inner.Set("interval", g.Interval)
					inner.Set("tolerance", g.Tolerance)
					inner.Set("latency_test_url", g.URL)
					wrapper.Set("auto_test", inner)
				case "fallback":
					inner.Set("interval", g.Interval)
					inner.Set("latency_test_url", g.URL)
					wrapper.Set("fallback", inner)
				case "load-balance":
					alg := "hash"
					if g.Strategy == "round-robin" {
						alg = "round_robin"
					}
					inner.Set("algorithm", alg)
					wrapper.Set("load_balance", inner)
				default:
					wrapper.Set("select", inner)
				}
				policyGroups = append(policyGroups, wrapper)
			}
			var rules []*YAMLMap
			for _, r := range plan.Rules {
				pol := clashTargetName(r.Target)
				wrapper := &YAMLMap{}
				if r.Match.Type == "rule-set" {
					rs, ok := rsByTag[r.Match.Value]
					if !ok {
						continue
					}
					u := ctx.ruleSetEndpoint(rs)
					if u == "" {
						continue
					}
					inner := &YAMLMap{}
					inner.Set("match", u)
					inner.Set("policy", pol)
					inner.Set("update_interval", 86400)
					wrapper.Set("rule_set", inner)
				} else if r.Match.Type == "ip-cidr" {
					kw := "ip_cidr"
					addr, _, _ := strings.Cut(r.Match.Value, "/")
					if ip := net.ParseIP(addr); ip != nil && ip.To4() == nil {
						kw = "ip_cidr6"
					}
					inner := &YAMLMap{}
					inner.Set("match", r.Match.Value)
					inner.Set("policy", pol)
					inner.Set("no_resolve", true)
					wrapper.Set(kw, inner)
				} else {
					kw := strings.ReplaceAll(r.Match.Type, "-", "_")
					inner := &YAMLMap{}
					inner.Set("match", r.Match.Value)
					inner.Set("policy", pol)
					wrapper.Set(kw, inner)
				}
				rules = append(rules, wrapper)
			}
			defInner := &YAMLMap{}
			defInner.Set("policy", clashTargetName(plan.Final))
			defRule := &YAMLMap{}
			defRule.Set("default", defInner)
			rules = append(rules, defRule)

			cfg := &YAMLMap{}
			if ctx.SubscriptionURL != "" {
				au := &YAMLMap{}
				au.Set("url", ctx.SubscriptionURL)
				au.Set("interval", ctx.UpdateIntervalSeconds)
				cfg.Set("auto_update", au)
			}
			cfg.Set("proxy_latency_test_url", testURLOfPlan(plan))
			cfg.Set("proxies", compiled)
			cfg.Set("policy_groups", policyGroups)
			cfg.Set("rules", rules)
			return EmitYAML(cfg) + "\n"
		},
	}
}

func newBase64Renderer() Renderer {
	return Renderer{
		ID:          "base64",
		Name:        "通用 Base64",
		ContentType: "text/plain; charset=utf-8",
		Extension:   "txt",
		Capabilities: RendererCapabilities{
			RejectInGroups: true,
			Groups:         false,
		},
		CompileNode: func(entry PlannedNode, _ string, _ RenderContext) (any, error) {
			clone := entry.Node.Clone()
			clone["name"] = entry.Name
			uri := EncodeProxyURI(clone)
			if uri == "" {
				p := entry.Node.Str("protocol")
				if p == "" {
					p = "empty"
				}
				return nil, errInvalid("unsupported_proxy_uri_export_" + p)
			}
			return uri, nil
		},
		Render: func(_ AggregationPlan, compiled []any, _ RenderContext) string {
			lines := make([]string, 0, len(compiled))
			for _, item := range compiled {
				if s, ok := item.(string); ok {
					lines = append(lines, s)
				}
			}
			return base64.StdEncoding.EncodeToString([]byte(strings.Join(lines, "\n")))
		},
	}
}

func newURIRenderer() Renderer {
	b64 := newBase64Renderer()
	return Renderer{
		ID:           "uri",
		Name:         "分享链接列表",
		ContentType:  "text/plain; charset=utf-8",
		Extension:    "txt",
		Capabilities: b64.Capabilities,
		CompileNode:  b64.CompileNode,
		Render: func(_ AggregationPlan, compiled []any, _ RenderContext) string {
			lines := make([]string, 0, len(compiled))
			for _, item := range compiled {
				if s, ok := item.(string); ok {
					lines = append(lines, s)
				}
			}
			if len(lines) == 0 {
				return ""
			}
			return strings.Join(lines, "\n") + "\n"
		},
	}
}

func newJSONRenderer() Renderer {
	return Renderer{
		ID:          "json",
		Name:        "JSON（节点数据）",
		ContentType: "application/json; charset=utf-8",
		Extension:   "json",
		Capabilities: RendererCapabilities{
			RejectInGroups: true,
			Groups:         false,
			ProxyChain:     "reference",
		},
		CompileNode: func(entry PlannedNode, _ string, _ RenderContext) (any, error) {
			proto := NormalizeProtocolAlias(entry.Node.Str("protocol"))
			meta, ok := protocolRegistry[proto]
			if !ok {
				if proto == "" {
					proto = "empty"
				}
				return nil, errInvalid("unsupported_proxy_protocol_" + proto)
			}
			port, _ := entry.Node.Int("port")
			m := &YAMLMap{}
			m.Set("name", entry.Name)
			m.Set("protocol", proto)
			m.Set("server", entry.Node.Str("server"))
			m.Set("port", port)
			for _, field := range meta.Fields {
				val, exists := entry.Node[field]
				if !exists || val == nil {
					continue
				}
				if s, isStr := val.(string); isStr && s == "" {
					continue
				}
				m.Set(field, val)
			}
			if chain := strings.TrimSpace(entry.Node.Str("chain")); chain != "" {
				m.Set("chain", chain)
			}
			return m, nil
		},
		Render: func(_ AggregationPlan, compiled []any, _ RenderContext) string {
			nodes := make([]*YAMLMap, 0, len(compiled))
			for _, item := range compiled {
				if m, ok := item.(*YAMLMap); ok {
					nodes = append(nodes, m)
				}
			}
			root := &YAMLMap{}
			root.Set("version", 1)
			root.Set("nodes", nodes)
			return prettyJSONFromYAMLMap(root) + "\n"
		},
	}
}

var chainErrorPrefixPattern = regexp.MustCompile(`^(?:unsupported|invalid)_proxy_chain_`)

// RenderWithPlan 按目标渲染器编译节点并输出最终配置正文、统计与告警。
func RenderWithPlan(profile AggregatorProfile, renderer Renderer, subs []Subscription, rawNodes []ProxyNode, ctx RenderContext) RenderResult {
	sel := SelectAggregatedNodes(profile, subs, rawNodes)
	entries := SanitizeEntriesForRenderer(sel.Entries, renderer.Capabilities.SanitizeName)
	chains := resolveProxyChains(entries)
	chainSyntax := renderer.Capabilities.ProxyChain

	compiledEntries := make([]PlannedNode, 0, len(entries))
	compiledNodes := make([]any, 0, len(entries))
	skippedNodes := make([]SkippedNodeInfo, 0)
	compiledIdx := make(map[int]bool, len(entries))

	for _, idx := range orderEntriesByChain(entries, chains.Targets) {
		e := entries[idx]
		chainFailure := chains.Errors[idx]
		if upIdx, hasUp := chains.Targets[idx]; hasUp {
			if chainFailure == "" && chainSyntax == "" {
				chainFailure = "unsupported_proxy_chain_" + renderer.ID
			}
			if chainFailure == "" && !compiledIdx[upIdx] {
				chainFailure = "unsupported_proxy_chain_upstream_skipped"
			}
		}
		if chainFailure != "" {
			skippedNodes = append(skippedNodes, SkippedNodeInfo{Name: e.Name, Reason: chainFailure})
			continue
		}
		chainName := ""
		if upIdx, hasUp := chains.Targets[idx]; hasUp {
			chainName = entries[upIdx].Name
		}
		nodeObj, err := renderer.CompileNode(e, chainName, ctx)
		if err != nil {
			reason := err.Error()
			if de, ok := AsDomainError(err); ok {
				reason = de.Code
			}
			skippedNodes = append(skippedNodes, SkippedNodeInfo{Name: e.Name, Reason: reason})
			continue
		}
		compiledNodes = append(compiledNodes, nodeObj)
		compiledEntries = append(compiledEntries, e)
		compiledIdx[idx] = true
	}

	plan := BuildPlanFromEntries(profile, compiledEntries, sel.Stats, renderer.Capabilities)
	relayStatus := (*RelayRenderStatus)(nil)
	if ctx.Relay != nil {
		relayStatus = ctx.Relay.Status
	}

	if len(compiledEntries) == 0 && len(skippedNodes) > 0 {
		allChain := true
		for _, item := range skippedNodes {
			if !chainErrorPrefixPattern.MatchString(item.Reason) {
				allChain = false
				break
			}
		}
		relayBlocked := !allChain && relayStatus != nil && relayStatus.Candidates > 0 && !relayStatus.Active && relayStatus.Available
		nextWarn := make([]string, 0, len(plan.Warnings)+1)
		for _, w := range plan.Warnings {
			if w != "aggregator_no_nodes" {
				nextWarn = append(nextWarn, w)
			}
		}
		if allChain {
			nextWarn = append(nextWarn, "aggregator_nodes_chain_blocked")
		} else if relayBlocked {
			errCode := relayStatus.Error
			if errCode == "" {
				errCode = "relay_not_running"
			}
			nextWarn = append(nextWarn, "aggregator_relay_unavailable:"+errCode)
		} else {
			nextWarn = append(nextWarn, "aggregator_nodes_unsupported_by_target")
		}
		plan.Warnings = nextWarn
	}

	if len(ctx.CoreProtocols) > 0 && len(compiledEntries) > 0 {
		coreSet := make(map[string]bool, len(ctx.CoreProtocols))
		for _, cp := range ctx.CoreProtocols {
			coreSet[cp] = true
		}
		seenRej := map[string]bool{}
		var rejected []string
		for _, e := range compiledEntries {
			if ctx.Relay != nil && len(ctx.Relay.Endpoints) > 0 {
				if _, ok := ctx.Relay.Endpoints[e.Node.Str("id")]; ok {
					continue
				}
				if _, ok := ctx.Relay.Endpoints[e.ID]; ok {
					continue
				}
			}
			p := NormalizeProtocolAlias(e.Node.Str("protocol"))
			if !coreSet[p] && !seenRej[p] {
				seenRej[p] = true
				rejected = append(rejected, p)
			}
		}
		if len(rejected) > 0 {
			plan.Warnings = append(plan.Warnings, "aggregator_client_core_protocols:"+strings.Join(rejected, ","))
		}
	}

	if relayStatus != nil && relayStatus.Candidates > 0 && relayStatus.Requested && !relayStatus.Active {
		hasWarn := false
		for _, w := range plan.Warnings {
			if strings.HasPrefix(w, "aggregator_relay_unavailable:") {
				hasWarn = true
				break
			}
		}
		if !hasWarn {
			errCode := relayStatus.Error
			if errCode == "" {
				errCode = "relay_failed"
			}
			plan.Warnings = append(plan.Warnings, "aggregator_relay_unavailable:"+errCode)
		}
	}

	if relayStatus != nil && relayStatus.PortMode != "server" && relayStatus.Remote && relayStatus.Active && relayStatus.AdvertiseHost != "" {
		plan.Warnings = append(plan.Warnings, fmt.Sprintf("aggregator_relay_remote:%s:%s", relayStatus.AdvertiseHost, relayStatus.PortRange))
	}

	stats := plan.Stats
	stats.Selected = len(compiledEntries)
	if ctx.View == "nodes" {
		stats.Groups = 0
		stats.Regions = 0
		stats.Rules = 0
	}

	scopedSubs := scopedSubscriptions(profile, subs)
	var infos []*SubscriptionUserInfo
	for _, s := range scopedSubs {
		infos = append(infos, s.UserInfo)
	}

	return RenderResult{
		Content:      renderer.Render(plan, compiledNodes, ctx),
		Format:       renderer.ID,
		ContentType:  renderer.ContentType,
		Stats:        stats,
		SkippedNodes: skippedNodes,
		Warnings:     plan.Warnings,
		UserInfo:     AggregateUserInfo(infos),
	}
}

type localRenderingEngine struct{}

func (localRenderingEngine) Renderers() []RendererInfo {
	out := make([]RendererInfo, 0, len(allRenderers))
	for _, renderer := range allRenderers {
		out = append(out, rendererInfoFromBuiltin(renderer))
	}
	return out
}

func (localRenderingEngine) Lookup(target string) (RendererInfo, bool) {
	renderer, ok := GetRenderer(target)
	if !ok {
		return RendererInfo{}, false
	}
	return rendererInfoFromBuiltin(renderer), true
}

func (localRenderingEngine) Render(ctx context.Context, target string, profile AggregatorProfile, subs []Subscription, nodes []ProxyNode, renderCtx RenderContext) (RenderResult, error) {
	if err := ctx.Err(); err != nil {
		return RenderResult{}, err
	}
	renderer, ok := GetRenderer(target)
	if !ok {
		return RenderResult{}, errInvalid("unsupported_aggregator_format")
	}
	return RenderWithPlan(profile, renderer, subs, nodes, renderCtx), nil
}

func (localRenderingEngine) Supports(ctx context.Context, target string, entries []PlannedNode) ([]bool, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	renderer, ok := GetRenderer(target)
	if !ok {
		return nil, errInvalid("unsupported_aggregator_format")
	}
	out := make([]bool, len(entries))
	for i, entry := range entries {
		_, err := renderer.CompileNode(entry, "", RenderContext{})
		out[i] = err == nil
	}
	return out, nil
}

func (localRenderingEngine) SupportsRelayNode(_ context.Context, kernel string, node ProxyNode, version string) bool {
	switch kernel {
	case "sing-box":
		_, err := CompileSingBoxOutbound(node, "relay-probe", version, true)
		return err == nil
	case "mihomo":
		_, err := CompileMihomoProxy(node, "relay-probe", "mihomo")
		return err == nil
	default:
		return false
	}
}

func (localRenderingEngine) CompileRelay(ctx context.Context, request RelayCompileRequest) (RelayCompiledOutput, error) {
	if err := ctx.Err(); err != nil {
		return RelayCompiledOutput{}, err
	}
	opts := RelayCompileOptions{
		ListenHost:  request.ListenHost,
		Auth:        request.Auth,
		MaxPorts:    request.MaxPorts,
		OnlyIDs:     request.OnlyIDs,
		BasePort:    request.BasePort,
		LogPath:     request.LogPath,
		Version:     request.Version,
		OfficialApp: request.OfficialApp,
	}
	if len(request.PortByNode) > 0 {
		portByNode := request.PortByNode
		opts.AssignPort = func(nodeID string, _ int) int { return portByNode[nodeID] }
	}
	switch request.Kernel {
	case "sing-box":
		return CompileSingBoxRelayConfig(request.Nodes, opts), nil
	case "mihomo":
		return CompileMihomoRelayConfigText(request.Nodes, opts), nil
	default:
		return RelayCompiledOutput{}, errInvalid("unsupported_relay_kernel")
	}
}

func rendererInfoFromBuiltin(r Renderer) RendererInfo {
	return RendererInfo{
		ID: r.ID, Name: r.Name, Note: r.Note,
		ContentType: r.ContentType, Extension: r.Extension,
		Capabilities: r.Capabilities,
	}
}

func init() {
	defaultRenderingEngine = func() RenderingEngine { return localRenderingEngine{} }
}

// DescribeRendererPlugins 把内置渲染器注册表投影成进程插件契约。
func DescribeRendererPlugins() profilerender.Descriptor {
	formats := make([]profilerender.Format, 0, len(allRenderers))
	for _, renderer := range allRenderers {
		sanitize := ""
		if renderer.Capabilities.SanitizeName != nil {
			sanitize = "surge"
		}
		formats = append(formats, profilerender.Format{
			ID:          renderer.ID,
			Name:        renderer.Name,
			Note:        renderer.Note,
			ContentType: renderer.ContentType,
			Extension:   renderer.Extension,
			Capabilities: profilerender.Capabilities{
				RejectInGroups: renderer.Capabilities.RejectInGroups,
				Groups:         renderer.Capabilities.Groups,
				GroupTypes:     append([]string(nil), renderer.Capabilities.GroupTypes...),
				Protocols:      append([]string(nil), renderer.Capabilities.Protocols...),
				ProxyChain:     renderer.Capabilities.ProxyChain,
				RuleSetFormat:  renderer.Capabilities.RuleSetFormat,
				RelayFallback:  renderer.Capabilities.RelayFallback,
				CoreProtocols:  append([]string(nil), renderer.Capabilities.CoreProtocols...),
				SanitizeName:   sanitize,
			},
		})
	}
	return profilerender.Descriptor{
		ID:           "subscriptions",
		Label:        "AIH 订阅渲染",
		Formats:      formats,
		RelayKernels: []string{"sing-box", "mihomo"},
	}
}

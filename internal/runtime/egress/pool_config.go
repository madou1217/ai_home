//go:build !no_builtin_engines

package egress

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/subaggregator"
)

// BuildEgressPoolConfig 将节点库编译为只监听回环、绕过宿主 TUN 且内置 DNS 的 mihomo 运行时配置。
func BuildEgressPoolConfig(input PoolConfigInput) (*CompiledPoolConfig, error) {
	if input.MixedPort <= 0 {
		return nil, errors.New("egress_pool_mixed_port_required")
	}
	if input.ControllerPort <= 0 {
		return nil, errors.New("egress_pool_controller_port_required")
	}
	secret := strings.TrimSpace(input.Secret)
	if secret == "" {
		return nil, errors.New("egress_pool_controller_secret_required")
	}

	var interfaceName string
	if input.InterfaceName != nil {
		interfaceName = strings.TrimSpace(*input.InterfaceName)
	} else {
		interfaceName = ResolvePhysicalInterface(input.InterfacesFunc)
	}

	compiledMaps := make([]*subaggregator.YAMLMap, 0, len(input.Nodes))
	proxyObjects := make([]map[string]any, 0, len(input.Nodes))
	nodeNames := make([]string, 0, len(input.Nodes))
	nodeEntries := make([]RuntimeNodeEntry, 0, len(input.Nodes))

	// 节点标签按输入位置固定，不按“已编译数量”递增：不同内核可能跳过不同
	// 协议，按编译数量编号会让同一个逻辑节点在切换内核后变成 node-3→node-5，
	// 健康/车道/证据全部错位。跳过节点只留空洞，不重排已有标签。
	for index, node := range input.Nodes {
		name := fmt.Sprintf("node-%d", index)
		compiled, err := subaggregator.CompileMihomoProxy(node.ToSubaggregatorNode(), name, "mihomo")
		if err != nil || compiled == nil {
			continue
		}
		if interfaceName != "" {
			compiled.Set("interface-name", interfaceName)
		}
		compiledMaps = append(compiledMaps, compiled)
		proxyObjects = append(proxyObjects, yamlMapToMap(compiled))
		nodeNames = append(nodeNames, name)
		nodeEntries = append(nodeEntries, runtimeEntryFromProxy(name, node, true))
	}
	if len(nodeNames) == 0 {
		return nil, errors.New("egress_pool_no_usable_nodes")
	}

	allNamesCopy := func() []string {
		cp := make([]string, len(nodeNames))
		copy(cp, nodeNames)
		return cp
	}

	groups := []map[string]any{
		{
			"name":    mihomoGlobalGroup,
			"type":    "select",
			"proxies": allNamesCopy(),
		},
	}
	listeners := make([]map[string]any, 0, 1+len(input.LanePorts))

	if input.ProbePort > 0 {
		groups = append(groups, map[string]any{
			"name":    mihomoProbeGroup,
			"type":    "select",
			"proxies": allNamesCopy(),
		})
		listeners = append(listeners, map[string]any{
			"name":   "aih-probe",
			"type":   "mixed",
			"port":   input.ProbePort,
			"listen": PoolBindHost,
			"proxy":  mihomoProbeGroup,
		})
	}
	for idx, port := range input.LanePorts {
		if port <= 0 {
			continue
		}
		groupName := LaneGroupName(idx)
		groups = append(groups, map[string]any{
			"name":    groupName,
			"type":    "select",
			"proxies": allNamesCopy(),
		})
		listeners = append(listeners, map[string]any{
			"name":   fmt.Sprintf("aih-lane-%d", idx),
			"type":   "mixed",
			"port":   port,
			"listen": PoolBindHost,
			"proxy":  groupName,
		})
	}

	dnsSection := map[string]any{
		"enable":                  true,
		"ipv6":                    false,
		"nameserver":              append([]string(nil), DNSServers...),
		"default-nameserver":      append([]string(nil), DOHBootstrap...),
		"proxy-server-nameserver": append([]string(nil), DNSServers...),
	}
	if customDNS := input.Routing.MihomoNameservers(); len(customDNS) > 0 {
		dnsSection["nameserver"] = append([]string(nil), customDNS...)
		if input.Routing.DNS.Mode == "plain" {
			dnsSection["proxy-server-nameserver"] = append([]string(nil), customDNS...)
		} else {
			dnsSection["proxy-server-nameserver"] = append([]string(nil), DOHBootstrap...)
		}
	}

	mode := "global"
	rules := []string{"MATCH,GLOBAL"}
	if len(input.Routing.Rules) > 0 {
		mode = "rule"
		rules = input.Routing.MihomoRoutingRules()
	}
	configMap := map[string]any{
		"mixed-port":          input.MixedPort,
		"external-controller": fmt.Sprintf("%s:%d", PoolControllerHost, input.ControllerPort),
		"secret":              secret,
		"allow-lan":           false,
		"mode":                mode,
		"log-level":           "warning",
		"dns":                 dnsSection,
		"proxies":             proxyObjects,
		"proxy-groups":        groups,
		"rules":               rules,
	}
	if len(listeners) > 0 {
		configMap["listeners"] = listeners
	}

	jsonBytes, err := json.MarshalIndent(configMap, "", " ")
	if err != nil {
		return nil, fmt.Errorf("egress_pool_config_marshal_failed:%w", err)
	}
	yamlDoc := buildPoolConfigYAMLMap(input, secret, compiledMaps, groups, listeners)
	yamlText := subaggregator.EmitYAML(yamlDoc)

	return &CompiledPoolConfig{
		Config:        configMap,
		JSONBytes:     jsonBytes,
		YAMLText:      yamlText,
		NodeNames:     nodeNames,
		NodeEntries:   nodeEntries,
		InterfaceName: interfaceName,
	}, nil
}

func buildPoolConfigYAMLMap(
	input PoolConfigInput,
	secret string,
	proxies []*subaggregator.YAMLMap,
	groups []map[string]any,
	listeners []map[string]any,
) *subaggregator.YAMLMap {
	doc := &subaggregator.YAMLMap{}
	doc.Set("mixed-port", input.MixedPort)
	doc.Set("external-controller", fmt.Sprintf("%s:%d", PoolControllerHost, input.ControllerPort))
	doc.Set("secret", secret)
	doc.Set("allow-lan", false)
	doc.Set("mode", "global")
	doc.Set("log-level", "warning")

	dnsMap := &subaggregator.YAMLMap{}
	dnsMap.Set("enable", true)
	dnsMap.Set("ipv6", false)
	dnsMap.Set("nameserver", toAnySlice(DNSServers))
	dnsMap.Set("default-nameserver", toAnySlice(DOHBootstrap))
	dnsMap.Set("proxy-server-nameserver", toAnySlice(DNSServers))
	doc.Set("dns", dnsMap)

	proxyList := make([]any, 0, len(proxies))
	for _, p := range proxies {
		proxyList = append(proxyList, p)
	}
	doc.Set("proxies", proxyList)

	groupList := make([]any, 0, len(groups))
	for _, g := range groups {
		gm := &subaggregator.YAMLMap{}
		gm.Set("name", g["name"])
		gm.Set("type", g["type"])
		if pList, ok := g["proxies"].([]string); ok {
			gm.Set("proxies", toAnySlice(pList))
		}
		groupList = append(groupList, gm)
	}
	doc.Set("proxy-groups", groupList)

	if len(listeners) > 0 {
		listenerList := make([]any, 0, len(listeners))
		for _, l := range listeners {
			lm := &subaggregator.YAMLMap{}
			lm.Set("name", l["name"])
			lm.Set("type", l["type"])
			lm.Set("port", l["port"])
			lm.Set("listen", l["listen"])
			lm.Set("proxy", l["proxy"])
			listenerList = append(listenerList, lm)
		}
		doc.Set("listeners", listenerList)
	}
	doc.Set("rules", []any{"MATCH,GLOBAL"})
	return doc
}

func toAnySlice(items []string) []any {
	out := make([]any, 0, len(items))
	for _, item := range items {
		out = append(out, item)
	}
	return out
}

func yamlMapToMap(m *subaggregator.YAMLMap) map[string]any {
	if m == nil {
		return map[string]any{}
	}
	out := make(map[string]any, len(m.Entries))
	for _, entry := range m.Entries {
		out[entry.Key] = convertYAMLValue(entry.Value)
	}
	return out
}

func convertYAMLValue(val any) any {
	switch typed := val.(type) {
	case *subaggregator.YAMLMap:
		return yamlMapToMap(typed)
	case subaggregator.YAMLMap:
		return yamlMapToMap(&typed)
	case []any:
		out := make([]any, len(typed))
		for i, item := range typed {
			out[i] = convertYAMLValue(item)
		}
		return out
	case []*subaggregator.YAMLMap:
		out := make([]any, len(typed))
		for i, item := range typed {
			out[i] = yamlMapToMap(item)
		}
		return out
	default:
		return val
	}
}

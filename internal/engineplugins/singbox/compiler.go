//go:build !no_builtin_renderers

// Package singbox 是 sing-box 的 egress.engine 插件编译器。
//
// 它只负责描述能力、定位内核、把节点/规则/DNS 编译成配置与启动参数；
// 进程启动、Clash 控制面、健康、车道与回收由宿主负责。
package singbox

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/application/egressengine"
	"github.com/madou1217/ai_home/internal/runtime/subaggregator"
)

const (
	engineID       = "sing-box"
	controllerHost = "127.0.0.1"
	bindHost       = "127.0.0.1"
	configFileName = "sing-box.json"
	globalGroup    = "AIH-GLOBAL"
)

// Descriptor 返回插件能力。
func Descriptor() egressengine.Descriptor {
	return egressengine.Descriptor{
		ID:           engineID,
		Label:        "sing-box",
		Capabilities: []string{egressengine.CapabilityPool, egressengine.CapabilityLease},
		Controller:   "clash-api",
		Protocols: []string{
			"shadowsocks", "shadowsocksr", "vmess", "vless", "trojan",
			"hysteria", "hysteria2", "tuic", "anytls", "naive",
			"wireguard", "socks5", "http", "https", "ssh",
		},
	}
}

// Resolve 定位 sing-box 并统计可编译节点。
func Resolve(request egressengine.ResolveRequest) (egressengine.ResolveResult, error) {
	kernel := subaggregator.ResolvePoolKernel(engineID, request.AIHomeDir, request.Platform)
	if kernel == nil {
		return egressengine.ResolveResult{}, errors.New("sing_box_binary_not_found")
	}
	usable := 0
	for _, node := range request.Nodes {
		compiled, err := subaggregator.CompileSingBoxOutbound(toSubaggregatorNode(node), "probe", kernel.Version, false)
		if err == nil && !compiled.IsEndpoint {
			usable++
		}
	}
	return egressengine.ResolveResult{
		Binary:         kernel.Path,
		Version:        kernel.Version,
		UsableNodes:    usable,
		GlobalGroup:    globalGroup,
		ConfigFileName: configFileName,
	}, nil
}

// Compile 编译 sing-box 配置。
func Compile(_ context.Context, request egressengine.CompileRequest) (egressengine.LaunchSpec, error) {
	if request.MixedPort <= 0 || request.ControllerPort <= 0 || strings.TrimSpace(request.Secret) == "" {
		return egressengine.LaunchSpec{}, errors.New("sing_box_compile_ports_required")
	}
	if request.Lease != nil {
		if request.ProbePort > 0 || len(request.LanePorts) > 0 {
			return egressengine.LaunchSpec{}, errors.New("sing_box_lease_pool_ports_forbidden")
		}
		if !loopbackBind(request.Lease.BindAddress) {
			return egressengine.LaunchSpec{}, errors.New("sing_box_lease_bind_must_be_loopback")
		}
	}
	outbounds := make([]map[string]any, 0, len(request.Nodes)+4)
	nodeTags := make([]egressengine.NodeTag, 0, len(request.Nodes))
	for index, node := range request.Nodes {
		tag := fmt.Sprintf("node-%d", index)
		compiled, err := subaggregator.CompileSingBoxOutbound(toSubaggregatorNode(node), tag, request.Version, false)
		if err != nil || compiled.IsEndpoint {
			continue
		}
		item := yamlMapToMap(compiled.Item)
		if request.InterfaceName != "" {
			item["bind_interface"] = request.InterfaceName
		}
		outbounds = append(outbounds, item)
		for _, extra := range compiled.Extras {
			outbounds = append(outbounds, yamlMapToMap(extra))
		}
		nodeTags = append(nodeTags, egressengine.NodeTag{
			Tag:      tag,
			NodeID:   node.ID,
			Identity: identity(node.Protocol, node.Server, node.Port),
			Label:    node.Name,
			Protocol: node.Protocol,
			Server:   node.Server,
			Port:     node.Port,
		})
	}
	if len(nodeTags) == 0 {
		return egressengine.LaunchSpec{}, errors.New("sing_box_no_usable_nodes")
	}
	names := make([]string, 0, len(nodeTags))
	for _, tag := range nodeTags {
		names = append(names, tag.Tag)
	}
	selector := func(tag string) map[string]any {
		return map[string]any{"type": "selector", "tag": tag, "outbounds": append([]string(nil), names...), "default": names[0]}
	}
	selectors := []map[string]any{selector(globalGroup)}
	if request.ProbePort > 0 {
		selectors = append(selectors, selector("AIH-PROBE"))
	}
	laneIndexes := make([]int, 0, len(request.LanePorts))
	for index, port := range request.LanePorts {
		if port <= 0 {
			continue
		}
		laneIndexes = append(laneIndexes, index)
		selectors = append(selectors, selector(fmt.Sprintf("LANE-%d", index)))
	}

	rules := make([]map[string]any, 0, len(request.Rules)*(len(laneIndexes)+1)+1+len(laneIndexes))
	for _, index := range laneIndexes {
		laneTag := fmt.Sprintf("aih-lane-%d", index)
		for _, rule := range request.Rules {
			item := map[string]any{
				"inbound":  []string{laneTag},
				"outbound": ruleOutbound(rule.Action, fmt.Sprintf("LANE-%d", index)),
			}
			for key, value := range ruleMatch(rule) {
				item[key] = value
			}
			rules = append(rules, item)
		}
	}
	listenHost := bindHost
	leaseUsers := []map[string]any(nil)
	if request.Lease != nil {
		if bind := strings.TrimSpace(request.Lease.BindAddress); bind != "" {
			listenHost = bind
		}
		for _, credential := range request.Lease.IngressAuth {
			username, password, ok := strings.Cut(credential, ":")
			if ok && username != "" {
				leaseUsers = append(leaseUsers, map[string]any{"username": username, "password": password})
			}
		}
	}
	mixedInbound := map[string]any{
		"type": "mixed", "tag": "aih-mixed", "listen": listenHost, "listen_port": request.MixedPort,
	}
	if len(leaseUsers) > 0 {
		mixedInbound["users"] = leaseUsers
	}
	inbounds := []map[string]any{mixedInbound}
	if request.ProbePort > 0 {
		inbounds = append(inbounds, map[string]any{
			"type": "mixed", "tag": "aih-probe", "listen": listenHost, "listen_port": request.ProbePort,
		})
		rules = append(rules, map[string]any{"inbound": []string{"aih-probe"}, "outbound": "AIH-PROBE"})
	}
	for _, index := range laneIndexes {
		port := request.LanePorts[index]
		inbounds = append(inbounds, map[string]any{
			"type": "mixed", "tag": fmt.Sprintf("aih-lane-%d", index), "listen": listenHost, "listen_port": port,
		})
		rules = append(rules, map[string]any{
			"inbound": []string{fmt.Sprintf("aih-lane-%d", index)}, "outbound": fmt.Sprintf("LANE-%d", index),
		})
	}
	for _, rule := range request.Rules {
		item := map[string]any{"inbound": []string{"aih-mixed"}, "outbound": ruleOutbound(rule.Action, globalGroup)}
		for key, value := range ruleMatch(rule) {
			item[key] = value
		}
		rules = append(rules, item)
	}

	allOutbounds := append([]map[string]any(nil), selectors...)
	allOutbounds = append(allOutbounds, outbounds...)
	allOutbounds = append(allOutbounds,
		map[string]any{"type": "direct", "tag": "direct"},
		map[string]any{"type": "block", "tag": "block"},
	)
	config := map[string]any{
		"log":       map[string]any{"level": "warn"},
		"inbounds":  inbounds,
		"outbounds": allOutbounds,
		"route":     map[string]any{"rules": rules, "final": globalGroup},
		"experimental": map[string]any{
			"clash_api": map[string]any{
				"external_controller": fmt.Sprintf("%s:%d", controllerHost, request.ControllerPort),
				"secret":              request.Secret,
			},
		},
	}
	if dns := compileDNS(request.DNS); dns != nil {
		config["dns"] = dns
	}
	raw, err := json.MarshalIndent(config, "", " ")
	if err != nil {
		return egressengine.LaunchSpec{}, err
	}
	return egressengine.LaunchSpec{
		Config:         raw,
		ConfigFileName: configFileName,
		Args:           []string{"run", "-c", "{{config}}"},
		GlobalGroup:    globalGroup,
		NodeTags:       nodeTags,
		Controller:     "clash-api",
		Version:        request.Version,
	}, nil
}

// loopbackBind 只允许回环监听；空值表示插件默认的 127.0.0.1。
func loopbackBind(address string) bool {
	address = strings.TrimSpace(address)
	if address == "" || strings.EqualFold(address, "localhost") {
		return true
	}
	ip := net.ParseIP(strings.Trim(address, "[]"))
	return ip != nil && ip.IsLoopback()
}

func toSubaggregatorNode(node egressengine.Node) subaggregator.ProxyNode {
	out := make(subaggregator.ProxyNode, len(node.Options)+6)
	for key, value := range node.Options {
		out[key] = value
	}
	out["id"] = node.ID
	out["name"] = node.Name
	out["protocol"] = node.Protocol
	out["server"] = node.Server
	out["port"] = node.Port
	return out
}

func ruleMatch(rule egressengine.Rule) map[string]any {
	switch strings.ToLower(strings.TrimSpace(rule.Type)) {
	case "domain":
		return map[string]any{"domain": []string{rule.Value}}
	case "domain-suffix":
		return map[string]any{"domain_suffix": []string{rule.Value}}
	case "domain-keyword":
		return map[string]any{"domain_keyword": []string{rule.Value}}
	case "ip-cidr":
		return map[string]any{"ip_cidr": []string{rule.Value}}
	default:
		return map[string]any{}
	}
}

func ruleOutbound(action, laneGroup string) string {
	switch strings.ToLower(strings.TrimSpace(action)) {
	case "direct":
		return "direct"
	case "reject":
		return "block"
	default:
		return laneGroup
	}
}

func compileDNS(policy egressengine.DNS) map[string]any {
	mode := strings.ToLower(strings.TrimSpace(policy.Mode))
	if mode == "" || mode == "default" || len(policy.Servers) == 0 {
		return nil
	}
	detour := globalGroup
	if strings.EqualFold(strings.TrimSpace(policy.Route), "direct") {
		detour = "direct"
	}
	servers := make([]map[string]any, 0, len(policy.Servers))
	for index, server := range policy.Servers {
		entry := map[string]any{"tag": fmt.Sprintf("aih-dns-%d", index), "detour": detour}
		if mode == "doh" {
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
	return map[string]any{"servers": servers, "final": "aih-dns-0"}
}

func identity(protocol, server string, port int) string {
	p := strings.ToLower(strings.TrimSpace(protocol))
	s := strings.ToLower(strings.TrimSuffix(strings.TrimPrefix(strings.TrimSpace(server), "["), "]"))
	s = strings.TrimSuffix(s, ".")
	if p == "" || s == "" || port <= 0 {
		return ""
	}
	return fmt.Sprintf("%s|%s|%d", p, s, port)
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

func convertYAMLValue(value any) any {
	switch typed := value.(type) {
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
	default:
		return value
	}
}

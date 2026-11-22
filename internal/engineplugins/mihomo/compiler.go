// Package mihomo 是 mihomo 的 egress.engine 插件编译器。
//
// 只负责定位内核、编译配置/启动参数；进程/控制面/健康/回收由宿主负责。
package mihomo

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/egressengine"
	"github.com/madou1217/ai_home/internal/runtime/subaggregator"
)

const (
	engineID       = "mihomo"
	configFileName = "config.json"
	globalGroup    = "GLOBAL"
)

var (
	dnsServers = []string{
		"1.1.1.1", "8.8.8.8",
		"https://1.1.1.1/dns-query", "https://8.8.8.8/dns-query",
	}
	dohBootstrap = []string{"1.1.1.1", "8.8.8.8"}
	clientPaths  = []string{
		"/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo-alpha",
		"/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo",
		"/Applications/Mihomo Party.app/Contents/Resources/resources/mihomo",
		"/Applications/ClashX Meta.app/Contents/Resources/mihomo",
		"/Applications/ClashX Pro.app/Contents/Resources/mihomo",
	}
	windowsClientPaths = []string{
		`C:\Program Files\Clash Verge\verge-mihomo-alpha.exe`,
		`C:\Program Files\Clash Verge\verge-mihomo.exe`,
		`C:\Program Files\Mihomo Party\resources\sidecar\mihomo.exe`,
	}
)

// Descriptor 返回插件能力。
func Descriptor() egressengine.Descriptor {
	return egressengine.Descriptor{
		ID:           engineID,
		Label:        "mihomo",
		Capabilities: []string{"pool", "lease"},
		Controller:   "clash-api",
		Protocols: []string{
			"shadowsocks", "shadowsocksr", "vmess", "vless", "trojan",
			"hysteria", "hysteria2", "tuic", "anytls", "snell",
			"wireguard", "socks5", "http", "https", "ssh",
		},
	}
}

// Resolve 定位 mihomo 并统计可编译节点。
func Resolve(request egressengine.ResolveRequest) (egressengine.ResolveResult, error) {
	binary, source := resolveBinary(request.AIHomeDir, request.Platform)
	if binary == "" {
		return egressengine.ResolveResult{}, errors.New("mihomo_binary_not_found")
	}
	_ = source
	usable := 0
	for _, node := range request.Nodes {
		if _, err := subaggregator.CompileMihomoProxy(toSubaggregatorNode(node), "probe", "mihomo"); err == nil {
			usable++
		}
	}
	return egressengine.ResolveResult{
		Binary:         binary,
		Version:        readVersion(binary),
		UsableNodes:    usable,
		GlobalGroup:    globalGroup,
		ConfigFileName: configFileName,
	}, nil
}

// Compile 编译 mihomo 配置。
func Compile(_ context.Context, request egressengine.CompileRequest) (egressengine.LaunchSpec, error) {
	if request.MixedPort <= 0 || request.ControllerPort <= 0 || strings.TrimSpace(request.Secret) == "" {
		return egressengine.LaunchSpec{}, errors.New("mihomo_compile_ports_required")
	}
	if request.Lease != nil && (request.ProbePort > 0 || len(request.LanePorts) > 0) {
		return egressengine.LaunchSpec{}, errors.New("mihomo_lease_pool_ports_forbidden")
	}
	proxies := make([]any, 0, len(request.Nodes))
	nodeTags := make([]egressengine.NodeTag, 0, len(request.Nodes))
	for index, node := range request.Nodes {
		tag := fmt.Sprintf("node-%d", index)
		compiled, err := subaggregator.CompileMihomoProxy(toSubaggregatorNode(node), tag, "mihomo")
		if err != nil || compiled == nil {
			continue
		}
		if request.InterfaceName != "" {
			compiled.Set("interface-name", request.InterfaceName)
		}
		proxies = append(proxies, yamlMapToMap(compiled))
		nodeTags = append(nodeTags, egressengine.NodeTag{
			Tag: tag, NodeID: node.ID, Identity: identity(node.Protocol, node.Server, node.Port),
			Label: node.Name, Protocol: node.Protocol, Server: node.Server, Port: node.Port,
		})
	}
	if len(nodeTags) == 0 {
		return egressengine.LaunchSpec{}, errors.New("mihomo_no_usable_nodes")
	}
	names := make([]string, 0, len(nodeTags))
	for _, tag := range nodeTags {
		names = append(names, tag.Tag)
	}
	groups := []map[string]any{{"name": globalGroup, "type": "select", "proxies": names}}
	listeners := make([]map[string]any, 0, len(request.LanePorts)+1)
	if request.ProbePort > 0 {
		groups = append(groups, map[string]any{"name": "AIH-PROBE", "type": "select", "proxies": names})
		listeners = append(listeners, map[string]any{
			"name": "aih-probe", "type": "mixed", "port": request.ProbePort, "listen": "127.0.0.1", "proxy": "AIH-PROBE",
		})
	}
	for index, port := range request.LanePorts {
		if port <= 0 {
			continue
		}
		group := fmt.Sprintf("LANE-%d", index)
		groups = append(groups, map[string]any{"name": group, "type": "select", "proxies": names})
		listeners = append(listeners, map[string]any{
			"name": fmt.Sprintf("aih-lane-%d", index), "type": "mixed", "port": port, "listen": "127.0.0.1", "proxy": group,
		})
	}

	dns := map[string]any{
		"enable": true, "ipv6": false,
		"nameserver":              append([]string(nil), dnsServers...),
		"default-nameserver":      append([]string(nil), dohBootstrap...),
		"proxy-server-nameserver": append([]string(nil), dnsServers...),
	}
	if custom := customNameservers(request.DNS); len(custom) > 0 {
		dns["nameserver"] = custom
		if strings.EqualFold(strings.TrimSpace(request.DNS.Mode), "plain") {
			dns["proxy-server-nameserver"] = append([]string(nil), custom...)
		}
	}
	mode := "global"
	rules := []string{"MATCH,GLOBAL"}
	if len(request.Rules) > 0 {
		mode = "rule"
		rules = mihomoRules(request.Rules)
	}
	config := map[string]any{
		"mixed-port":          request.MixedPort,
		"external-controller": fmt.Sprintf("127.0.0.1:%d", request.ControllerPort),
		"secret":              request.Secret,
		"allow-lan":           false,
		"mode":                mode,
		"log-level":           "warning",
		"dns":                 dns,
		"proxies":             proxies,
		"proxy-groups":        groups,
		"rules":               rules,
	}
	if len(listeners) > 0 {
		config["listeners"] = listeners
	}
	applyLease(config, request.Lease)
	raw, err := json.MarshalIndent(config, "", " ")
	if err != nil {
		return egressengine.LaunchSpec{}, err
	}
	return egressengine.LaunchSpec{
		Config:         raw,
		ConfigFileName: configFileName,
		Args:           []string{"-d", "{{dir}}", "-f", "{{config}}"},
		GlobalGroup:    globalGroup,
		NodeTags:       nodeTags,
		Controller:     "clash-api",
		Version:        request.Version,
	}, nil
}

// applyLease 把单节点租约的入口约束写进配置：绑回环、入口独立认证、不持久化选择。
func applyLease(config map[string]any, lease *egressengine.Lease) {
	if lease == nil {
		return
	}
	if bind := strings.TrimSpace(lease.BindAddress); bind != "" {
		config["bind-address"] = bind
	}
	config["ipv6"] = false
	if len(lease.IngressAuth) > 0 {
		config["authentication"] = append([]string(nil), lease.IngressAuth...)
		config["skip-auth-prefixes"] = []string{}
	}
	config["profile"] = map[string]any{"store-selected": false, "store-fake-ip": false}
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

// ResolveBinary 返回可用的 mihomo 内核路径；找不到为空。
func ResolveBinary(aiHomeDir, platform string) string {
	binary, _ := resolveBinary(aiHomeDir, platform)
	return binary
}

func resolveBinary(aiHomeDir, platform string) (string, string) {
	if platform == "" {
		platform = runtime.GOOS
	}
	exe := "mihomo"
	if strings.HasPrefix(strings.ToLower(platform), "win") {
		exe += ".exe"
	}
	if root := strings.TrimSpace(aiHomeDir); root != "" {
		for _, candidate := range []string{filepath.Join(root, "tools", exe), filepath.Join(root, "bin", exe)} {
			if fileExists(candidate) {
				return candidate, "managed"
			}
		}
	}
	for _, name := range []string{"mihomo", "clash-meta", "clash"} {
		for _, dir := range filepath.SplitList(os.Getenv("PATH")) {
			candidate := filepath.Join(dir, executableName(name, platform))
			if fileExists(candidate) {
				return candidate, "path"
			}
		}
	}
	if strings.HasPrefix(strings.ToLower(platform), "win") {
		for _, candidate := range windowsClientPaths {
			if fileExists(candidate) {
				return candidate, "client"
			}
		}
	} else {
		for _, candidate := range clientPaths {
			if fileExists(candidate) {
				return candidate, "client"
			}
		}
	}
	return "", ""
}

func executableName(name, platform string) string {
	if strings.HasPrefix(strings.ToLower(platform), "win") && !strings.HasSuffix(strings.ToLower(name), ".exe") {
		return name + ".exe"
	}
	return name
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir() && info.Size() > 0
}

func readVersion(binary string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, binary, "-v").CombinedOutput()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(output))
}

func mihomoRules(rules []egressengine.Rule) []string {
	out := make([]string, 0, len(rules)+1)
	for _, rule := range rules {
		action := "GLOBAL"
		switch strings.ToLower(strings.TrimSpace(rule.Action)) {
		case "direct":
			action = "DIRECT"
		case "reject":
			action = "REJECT"
		}
		switch strings.ToLower(strings.TrimSpace(rule.Type)) {
		case "domain":
			out = append(out, "DOMAIN,"+rule.Value+","+action)
		case "domain-suffix":
			out = append(out, "DOMAIN-SUFFIX,"+rule.Value+","+action)
		case "domain-keyword":
			out = append(out, "DOMAIN-KEYWORD,"+rule.Value+","+action)
		case "ip-cidr":
			out = append(out, "IP-CIDR,"+rule.Value+","+action+",no-resolve")
		}
	}
	return append(out, "MATCH,GLOBAL")
}

func customNameservers(dns egressengine.DNS) []string {
	mode := strings.ToLower(strings.TrimSpace(dns.Mode))
	if mode != "doh" && mode != "plain" {
		return nil
	}
	return append([]string(nil), dns.Servers...)
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
		out[entry.Key] = convertValue(entry.Value)
	}
	return out
}

func convertValue(value any) any {
	switch typed := value.(type) {
	case *subaggregator.YAMLMap:
		return yamlMapToMap(typed)
	case subaggregator.YAMLMap:
		return yamlMapToMap(&typed)
	case []any:
		out := make([]any, len(typed))
		for i, item := range typed {
			out[i] = convertValue(item)
		}
		return out
	default:
		return value
	}
}

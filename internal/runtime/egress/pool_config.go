package egress

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"regexp"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/subaggregator"
)

const (
	// PoolBindHost 与 PoolControllerHost 严格绑定本地回环，不暴露到局域网。
	PoolBindHost       = "127.0.0.1"
	PoolControllerHost = "127.0.0.1"

	// DefaultMixedPort 等默认回环端口与 Node egress-pool-service 对齐。
	DefaultMixedPort      = 17890
	DefaultControllerPort = 17891
	DefaultProbePort      = 17892
	DefaultLanePortBase   = 17893
)

var (
	// DNSUDPServers 在前，DNSDOHServers 在后：与 Node 隔离实测结论一致，优先用公共 UDP DNS，
	// 防止仅配 DoH 时在 443 受限环境导致节点域名解析卡死。
	DNSUDPServers = []string{"1.1.1.1", "8.8.8.8"}
	DNSDOHServers = []string{"https://1.1.1.1/dns-query", "https://8.8.8.8/dns-query"}
	DNSServers    = []string{
		"1.1.1.1",
		"8.8.8.8",
		"https://1.1.1.1/dns-query",
		"https://8.8.8.8/dns-query",
	}
	DOHBootstrap = []string{"1.1.1.1", "8.8.8.8"}

	virtualInterfacePattern = regexp.MustCompile(`(?i)^(utun|tun|tap|wintun)|clash|mihomo|^meta|sing-?box|wireguard`)
)

// LaneGroupName 返回车道 index 对应的 mihomo select 策略组名。
func LaneGroupName(index int) string {
	return fmt.Sprintf("LANE-%d", index)
}

// IsTUNAddress 判断地址是否属于常见 TUN / fake-ip 网段 198.18.0.0/15。
func IsTUNAddress(address string) bool {
	parts := strings.Split(strings.TrimSpace(address), ".")
	if len(parts) != 4 {
		return false
	}
	a, errA := strconv.Atoi(parts[0])
	b, errB := strconv.Atoi(parts[1])
	return errA == nil && errB == nil && a == 198 && (b == 18 || b == 19)
}

// NetInterfaceEntry 描述本机网络接口的 IPv4 地址快照（供单测注入）。
type NetInterfaceEntry struct {
	Name       string
	IPv4       []string
	IsLoopback bool
}

func defaultSystemInterfaces() ([]NetInterfaceEntry, error) {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil, err
	}
	out := make([]NetInterfaceEntry, 0, len(ifaces))
	for _, iface := range ifaces {
		entry := NetInterfaceEntry{
			Name:       iface.Name,
			IsLoopback: iface.Flags&net.FlagLoopback != 0,
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			ipNet, ok := addr.(*net.IPNet)
			if !ok || ipNet == nil || ipNet.IP == nil {
				continue
			}
			v4 := ipNet.IP.To4()
			if v4 == nil || v4.IsLoopback() {
				continue
			}
			entry.IPv4 = append(entry.IPv4, v4.String())
		}
		out = append(out, entry)
	}
	return out, nil
}

// ResolvePhysicalInterface 选出第一块具可用非内网非 fake-ip IPv4 的物理网卡，找不到返回空串。
func ResolvePhysicalInterface(source func() ([]NetInterfaceEntry, error)) string {
	if source == nil {
		source = defaultSystemInterfaces
	}
	entries, err := source()
	if err != nil {
		return ""
	}
	for _, entry := range entries {
		name := strings.TrimSpace(entry.Name)
		if name == "" || entry.IsLoopback || virtualInterfacePattern.MatchString(name) {
			continue
		}
		for _, ipStr := range entry.IPv4 {
			ip := net.ParseIP(strings.TrimSpace(ipStr))
			if ip == nil {
				continue
			}
			v4 := ip.To4()
			if v4 == nil || v4.IsLoopback() || IsTUNAddress(v4.String()) {
				continue
			}
			return name
		}
	}
	return ""
}

// PoolConfigInput 描述编译出口池 mihomo 配置所需的参数。
type PoolConfigInput struct {
	Nodes          []ProxyNode
	MixedPort      int
	ControllerPort int
	Secret         string
	InterfaceName  *string
	InterfacesFunc func() ([]NetInterfaceEntry, error)
	ProbePort      int
	LanePorts      []int
}

// CompiledPoolConfig 包含编译后的 mihomo 配置结构、JSON/YAML 文本与节点映射。
type CompiledPoolConfig struct {
	Config        map[string]any
	JSONBytes     []byte
	YAMLText      string
	NodeNames     []string
	NodeEntries   []RuntimeNodeEntry
	InterfaceName string
}

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

	for _, node := range input.Nodes {
		name := fmt.Sprintf("node-%d", len(compiledMaps))
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
	if len(compiledMaps) == 0 {
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

	configMap := map[string]any{
		"mixed-port":          input.MixedPort,
		"external-controller": fmt.Sprintf("%s:%d", PoolControllerHost, input.ControllerPort),
		"secret":              secret,
		"allow-lan":           false,
		"mode":                "global",
		"log-level":           "warning",
		"dns":                 dnsSection,
		"proxies":             proxyObjects,
		"proxy-groups":        groups,
		"rules":               []string{"MATCH,GLOBAL"},
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

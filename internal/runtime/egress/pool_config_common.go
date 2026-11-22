package egress

import (
	"fmt"
	"net"
	"regexp"
	"strconv"
	"strings"
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

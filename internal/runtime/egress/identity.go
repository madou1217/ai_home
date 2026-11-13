// Package egress 提供出口池、上游地区策略与账号出口分配的核心运行时与持久化逻辑。
package egress

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

var (
	runtimeNodeNamePattern = regexp.MustCompile(`(?i)^node-\d+$`)
	ipv4LiteralPattern     = regexp.MustCompile(`^\d{1,3}(?:\.\d{1,3}){3}$`)
	priv172Pattern         = regexp.MustCompile(`^172\.(1[6-9]|2\d|3[01])\.`)
	reservedDocPattern     = regexp.MustCompile(`^(192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)`)
	informationalPattern   = regexp.MustCompile(`(?i)剩余|到期|重置|流量|官网|过期|套餐|Expire|Traffic|\d+(?:\.\d+)?\s*(?:GB|MB|TB|PB)\b`)
)

// NormalizeProtocol 归一化代理协议名（去空白并小写）。
func NormalizeProtocol(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

// NormalizeServer 归一化节点服务器地址（去方括号、末尾点与大小写差异）。
func NormalizeServer(value string) string {
	trimmed := strings.TrimSpace(value)
	trimmed = strings.TrimPrefix(trimmed, "[")
	trimmed = strings.TrimSuffix(trimmed, "]")
	trimmed = strings.TrimSuffix(trimmed, ".")
	return strings.ToLower(trimmed)
}

// NormalizePort 校验并归一化端口号，非法端口返回 0。
func NormalizePort(value int) int {
	if value > 0 && value <= 65535 {
		return value
	}
	return 0
}

type endpointJSON struct {
	Protocol string `json:"protocol"`
	Server   string `json:"server"`
	Port     int    `json:"port"`
}

// BuildExitIdentity 生成稳定出口身份（protocol|server|port），不含节点凭据与运行序号。
func BuildExitIdentity(protocol string, server string, port int) string {
	p := NormalizeProtocol(protocol)
	s := NormalizeServer(server)
	pt := NormalizePort(port)
	if p == "" || s == "" || pt == 0 {
		return ""
	}
	return fmt.Sprintf("%s|%s|%d", p, s, pt)
}

// BuildNodeEntityID 生成与 Node egress-node-identity.js 完全一致的稳定节点实体 ID。
func BuildNodeEntityID(protocol string, server string, port int) string {
	p := NormalizeProtocol(protocol)
	s := NormalizeServer(server)
	pt := NormalizePort(port)
	if p == "" || s == "" || pt == 0 {
		return ""
	}
	raw, err := json.Marshal(endpointJSON{
		Protocol: p,
		Server:   s,
		Port:     pt,
	})
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(raw)
	return "node_" + hex.EncodeToString(sum[:])[:24]
}

// IsRuntimeNodeName 判断是否是临时运行序号名（例如 node-1），不可持久化引用。
func IsRuntimeNodeName(value string) bool {
	return runtimeNodeNamePattern.MatchString(strings.TrimSpace(value))
}

// IsRoutableServer 过滤占位/回环/私网 IPv4（域名始终放行由探测决定）。
func IsRoutableServer(server string) bool {
	host := NormalizeServer(server)
	if host == "" {
		return false
	}
	if !ipv4LiteralPattern.MatchString(host) {
		return true
	}
	if host == "0.0.0.0" || strings.HasPrefix(host, "127.") || strings.HasPrefix(host, "169.254.") {
		return false
	}
	if strings.HasPrefix(host, "10.") || strings.HasPrefix(host, "192.168.") {
		return false
	}
	if priv172Pattern.MatchString(host) || reservedDocPattern.MatchString(host) {
		return false
	}
	return true
}

// IsInformationalNode 识别机场信息行假节点（例如“剩余流量”“Expire Date”）。
func IsInformationalNode(name string) bool {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return false
	}
	return informationalPattern.MatchString(trimmed)
}

// RedactProxyURL 脱敏代理地址中的用户名和密码，并移除末尾斜杠。
func RedactProxyURL(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return ""
	}
	if parsed.User != nil {
		user := ""
		pass, hasPass := parsed.User.Password()
		if parsed.User.Username() != "" {
			user = "***"
		}
		if hasPass && pass != "" {
			parsed.User = url.UserPassword(user, "***")
		} else if user != "" {
			parsed.User = url.User(user)
		} else {
			parsed.User = nil
		}
	}
	out := strings.TrimRight(parsed.String(), "/")
	if parsed.User != nil {
		out = strings.Replace(out, "%2A%2A%2A", "***", 2)
	}
	return out
}

// IsLoopbackHTTPURL 只接受 127.0.0.1 HTTP 回环地址。
func IsLoopbackHTTPURL(raw string) bool {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return false
	}
	return strings.EqualFold(parsed.Scheme, "http") && parsed.Hostname() == "127.0.0.1" && parsed.Port() != ""
}

// ExitKeyOfProxyURL 生成网络出口缓存键（direct 或 protocol//host:port，不含凭据）。
func ExitKeyOfProxyURL(proxyURL string) string {
	trimmed := strings.TrimSpace(proxyURL)
	if trimmed == "" {
		return "direct"
	}
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Scheme == "" || parsed.Hostname() == "" {
		return "direct"
	}
	port := parsed.Port()
	return fmt.Sprintf("%s://%s:%s", strings.ToLower(parsed.Scheme), strings.ToLower(parsed.Hostname()), port)
}

// ParsePortAny 从 JSON 任意数值类型安全解析端口。
func ParsePortAny(value any) int {
	switch typed := value.(type) {
	case int:
		return NormalizePort(typed)
	case int64:
		return NormalizePort(int(typed))
	case float64:
		if typed != float64(int(typed)) {
			return 0
		}
		return NormalizePort(int(typed))
	case json.Number:
		n, err := strconv.Atoi(typed.String())
		if err != nil {
			return 0
		}
		return NormalizePort(n)
	case string:
		n, err := strconv.Atoi(strings.TrimSpace(typed))
		if err != nil {
			return 0
		}
		return NormalizePort(n)
	default:
		return 0
	}
}

// Package serverconfig 是「本机 AIH 服务监听在哪」这一事实的共享契约。
//
// Node 来源：lib/server/server-defaults.js（DEFAULT_SERVER_HOST / DEFAULT_SERVER_PORT /
// normalizeServerPort / normalizeServerHost）。
//
// 监听端口的归一规则此前在 transport 的配置面、重启面与 codex app-server 的端点推导里
// 各写一份，默认端口 9527 也散落在十余处字面量里。这些值一旦分叉，重启后客户端会连到
// 错误端口，属于静默故障，因此收敛为单一契约：所有需要"这个值是不是合法监听端口"的
// 地方都调用本包，不再各自比较边界。
package serverconfig

import (
	"math"
	"strconv"
	"strings"
)

const (
	// DefaultHost 与 Node DEFAULT_SERVER_HOST 一致：仅回环监听。
	DefaultHost = "127.0.0.1"
	// DefaultPort 与 Node DEFAULT_SERVER_PORT 一致。
	DefaultPort = 9527
)

// NormalizePort 把任意来源的端口值归一为合法监听端口；非法或缺失时回落 DefaultPort。
//
// 取值语义与 Node `Number(value)` + `Number.isInteger` 一致：
// 数字、数字字符串按数值解析；bool 按 1/0；其余类型视为非法。
// 与 Node 一样，越界或非整数一律回落默认端口，不报错——配置文件被手改成
// 0 或 70000 时，服务仍应起在默认端口上，而不是拒绝启动。
func NormalizePort(value any) int {
	port := portNumber(value)
	if isValidPort(port) {
		return int(port)
	}
	return DefaultPort
}

// IsValidPort 报告值是否已经是合法监听端口（1..65535 的整数）。
func IsValidPort(value any) bool {
	return isValidPort(portNumber(value))
}

// PortOr 归一端口，但非法时使用调用方给定的回退值；回退值本身非法时用 DefaultPort。
//
// 对应 Node normalizeServerPort(value, fallback)。
func PortOr(value any, fallback int) int {
	if port := portNumber(value); isValidPort(port) {
		return int(port)
	}
	if fallback >= 1 && fallback <= 65535 {
		return fallback
	}
	return DefaultPort
}

// NormalizeHost 归一监听主机：空值与 0.0.0.0 都回落回环地址。
func NormalizeHost(value string) string {
	host := strings.TrimSpace(value)
	if host == "" || host == "0.0.0.0" {
		return DefaultHost
	}
	return host
}

// FormatHost 返回可直接放进 URL 的主机部分：归一后再给 IPv6 字面量加方括号。
//
// 与 Node formatUrlHost 一致：`::1` → `[::1]`，已带括号的不重复包。
func FormatHost(value string) string {
	host := NormalizeHost(value)
	if strings.Contains(host, ":") && !strings.HasPrefix(host, "[") {
		return "[" + host + "]"
	}
	return host
}

// BaseURL 返回指向本机 AIH 服务的 http 地址（例如 http://127.0.0.1:9527/v1）。
//
// path 为空时返回根地址（不带结尾斜杠），否则原样追加。主机与端口按本包规则归一，
// 因此调用方不需要自己再判一次边界——这正是此前五处 URL 构造各写一遍的规则。
func BaseURL(host string, port int, path string) string {
	base := "http://" + FormatHost(host) + ":" + strconv.Itoa(NormalizePort(port))
	return base + path
}

func isValidPort(port float64) bool {
	return !math.IsNaN(port) && port > 0 && port <= 65535 && port == math.Trunc(port)
}

// portNumber 复刻 JS 的 Number() 转换：nil 与空串为 0，bool 为 1/0，
// 数字与数字字符串按数值，其余为 NaN。
func portNumber(value any) float64 {
	switch typed := value.(type) {
	case nil:
		return 0
	case float64:
		return typed
	case float32:
		return float64(typed)
	case int:
		return float64(typed)
	case int64:
		return float64(typed)
	case bool:
		if typed {
			return 1
		}
		return math.NaN()
	case string:
		text := strings.TrimSpace(typed)
		if text == "" {
			return 0
		}
		parsed, err := strconv.ParseFloat(text, 64)
		if err != nil {
			return math.NaN()
		}
		return parsed
	case interface{ Float64() (float64, error) }:
		parsed, err := typed.Float64()
		if err != nil {
			return math.NaN()
		}
		return parsed
	default:
		return math.NaN()
	}
}

package providercliupgrade

import "strings"

// 下载类失败的网络归因。
//
// 安装/更新代理只在**网络不可用**时自动启用，所以这里的判定必须比
// ClassifyInstallFailure 更保守：后者用于熔断计数，可以把 "proxy"、"network"
// 这类宽泛词当成线索；这里一旦误判，就会把「版本不存在」「权限不足」这类
// 与出口无关的失败也送进代理重试，浪费一次完整安装。
//
// 因此只认明确的传输层错误（解析、连接、超时、重置、不可达、代理隧道）。
// 不认 HTTP 状态码：502/503 也可能是 registry 自身故障，换出口不会更好。
type egressFailureRule struct {
	reason  string
	markers []string
}

var egressFailureRules = []egressFailureRule{
	{
		reason: "DNS 解析失败",
		markers: []string{
			"enotfound", "eai_again", "getaddrinfo", "eai_fail",
			"could not resolve host", "could not resolve proxy",
			"temporary failure in name resolution", "name or service not known",
			"nodename nor servname provided", "unknown host",
			"the remote name could not be resolved", "无法解析",
			"curl: (6)",
		},
	},
	{
		reason: "连接超时",
		markers: []string{
			"etimedout", "econnaborted", "connection timed out", "connect timeout",
			"connect timed out", "tls handshake timeout", "i/o timeout",
			"context deadline exceeded", "curl: (28)",
		},
	},
	{
		reason: "连接被拒绝",
		markers: []string{
			"econnrefused", "connection refused", "unable to connect to the remote server",
			"curl: (7)",
		},
	},
	{
		reason: "连接被重置",
		markers: []string{
			"econnreset", "connection reset", "socket hang up", "ssl_error_syscall",
			"client network socket disconnected", "基础连接已经关闭",
			"curl: (35)", "curl: (56)",
		},
	},
	{
		reason: "网络不可达",
		markers: []string{
			"enetunreach", "ehostunreach", "network is unreachable", "no route to host",
		},
	},
	{
		reason: "代理入口不可达",
		markers: []string{
			"proxyconnect", "proxy connect", "tunneling socket could not be established",
			"tunnel connection failed",
		},
	},
	{
		reason: "网络请求失败",
		markers: []string{
			"fetch failed", "network request failed", "network error",
			"ecconnreset", "unexpected eof",
		},
	},
}

// EgressFailureReason 判断一段安装输出是否属于「换出口可能有用」的网络失败，
// 并把具体现象压成一句可以给终端看的短原因。
//
// 判定顺序有意义：先排除「确定的终止条件」，再认传输层错误。像 Windows 上
// 「安装器无法保证所有下载走代理」这类失败的文案里可能带 proxy 字样，如果先
// 匹配传输层标记，它会被误当成网络问题而触发无意义的重试。
func EgressFailureReason(text string) (string, bool) {
	lower := strings.ToLower(text)
	if strings.TrimSpace(lower) == "" {
		return "", false
	}
	if strings.Contains(lower, egressUnsupportedMarker) {
		return "", false
	}
	for _, rule := range egressFailureRules {
		for _, marker := range rule.markers {
			if strings.Contains(lower, marker) {
				return rule.reason, true
			}
		}
	}
	return "", false
}

// egressUnsupportedMarker 与 apps.ErrEgressUnsupported 的文案保持同一口径。
// 单列成常量而不是 import apps：本包是失败归因，不依赖安装计划实现。
const egressUnsupportedMarker = "不能保证所有下载"

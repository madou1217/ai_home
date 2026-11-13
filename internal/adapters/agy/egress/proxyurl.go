package egress

import (
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

// 本文件对应 Node lib/server/zcode-egress-resolver.js 的 proxyUrlIssue() /
// normalizeProxyUrl()：允许 scheme://host:port 与 host:port 简写，不允许凭据、
// 路径、查询串。错误码沿用 Node 原文（WebUI 文案表按它映射）。

// allowedProxySchemes 对应 ALLOWED_PROXY_SCHEMES。agy 的 provider 描述符没有
// egress.proxySchemes（lib/providers/defs/agy.js），因此按全集放行：
// Go http.Transport 原生支持 socks5/socks5h，网关侧不再是「静默直连」。
var allowedProxySchemes = map[string]struct{}{
	"http":    {},
	"https":   {},
	"socks5":  {},
	"socks5h": {},
}

// nativeProxyOnlySchemes 是原生代理字段只认 HTTP(S) 的消费方能力集合。
// 对应 Node lib/providers/defs/zcode.js 与 opencode.js 的 egress.proxySchemes。
var nativeProxyOnlySchemes = map[string]struct{}{
	"http":  {},
	"https": {},
}

// providerProxySchemes 按 provider 收窄出口地址可用的 scheme，语义与 Node
// allowedSchemesForProvider() 一致：只有描述符明确收窄时才收窄，未列出 = 全集。
// 收窄的现有 provider 与 Node 描述符保持一致（zcode 原生 setting.json httpProxy、
// opencode 的 Bun 运行时静默忽略 socks env）；新增 provider 默认放行，不会被 Go 误拒。
var providerProxySchemes = map[string]map[string]struct{}{
	"zcode":    nativeProxyOnlySchemes,
	"opencode": nativeProxyOnlySchemes,
}

// zcodeNativeSchemeError 沿用 Node 的历史错误名（WebUI 文案表按它映射）。
const zcodeNativeSchemeError = "zcode_native_proxy_scheme_unsupported"

// hostPortShorthandPattern 对应 Node 的 /^[^\s:/?#]+:\d{1,5}$/。
var hostPortShorthandPattern = regexp.MustCompile("^[^\\s:/?#]+:[0-9]{1,5}$")

// ProxyURLIssueForProvider 返回该 provider 消费方看到的问题码；空字符串表示合法。
func ProxyURLIssueForProvider(rawURL string, provider string) string {
	allowed := allowedProxySchemes
	if narrowed, exists := providerProxySchemes[strings.ToLower(strings.TrimSpace(provider))]; exists {
		allowed = narrowed
	}
	return proxyURLIssueWith(rawURL, allowed, true)
}

// proxyURLIssue 返回代理地址的问题码；空字符串表示合法。
func proxyURLIssue(rawURL string) string {
	return proxyURLIssueWith(rawURL, allowedProxySchemes, false)
}

func proxyURLIssueWith(rawURL string, allowed map[string]struct{}, narrowable bool) string {
	value := strings.TrimSpace(rawURL)
	if value == "" {
		return "invalid_proxy_url"
	}
	candidate := value
	if !strings.Contains(value, "://") {
		if !hostPortShorthandPattern.MatchString(value) {
			return "invalid_proxy_url"
		}
		candidate = "http://" + value
	}
	parsed, err := url.Parse(candidate)
	if err != nil {
		return "invalid_proxy_url"
	}
	scheme := strings.ToLower(parsed.Scheme)
	if _, supported := allowedProxySchemes[scheme]; !supported {
		return "proxy_scheme_unsupported"
	}
	if _, supported := allowed[scheme]; !supported && narrowable {
		return zcodeNativeSchemeError
	}
	// 凭据会随绑定落盘并注入客户端环境变量，当前不支持（Node 同样拒绝）。
	if parsed.Hostname() == "" || parsed.User != nil {
		return "invalid_proxy_url"
	}
	if port := parsed.Port(); port != "" {
		// Node 的 URL 构造器对超出 0-65535 的端口直接抛错；Go 的 url.Parse 不查范围。
		number, err := strconv.Atoi(port)
		if err != nil || number <= 0 || number > 65535 {
			return "invalid_proxy_url"
		}
	}
	if (parsed.Path != "" && parsed.Path != "/") || parsed.RawQuery != "" ||
		parsed.Fragment != "" || parsed.Opaque != "" {
		return "invalid_proxy_url"
	}
	return ""
}

// normalizeProxyURL 归一化成完整的 scheme://host:port；不合法返回空字符串。
//
// 与 Node 的 URL.host 行为一致：http/https 的默认端口（80/443）会被省略。
func normalizeProxyURL(rawURL string) string {
	if proxyURLIssue(rawURL) != "" {
		return ""
	}
	value := strings.TrimSpace(rawURL)
	candidate := value
	if !strings.Contains(value, "://") {
		candidate = "http://" + value
	}
	parsed, err := url.Parse(candidate)
	if err != nil {
		return ""
	}
	scheme := strings.ToLower(parsed.Scheme)
	host := strings.ToLower(parsed.Hostname())
	if strings.Contains(host, ":") {
		// IPv6 字面量：Go 的 Hostname() 去掉方括号，写回地址时需要补上。
		host = "[" + host + "]"
	}
	port := parsed.Port()
	if (scheme == "http" && port == "80") || (scheme == "https" && port == "443") {
		port = ""
	}
	normalized := scheme + "://" + host
	if port != "" {
		normalized += ":" + port
	}
	return normalized
}

// isLoopbackHTTPURL 对应 Node egress-pool-state-file.js 的 isLoopbackHttpUrl()：
// 只接受 http://127.0.0.1:<port>。池是本地出站端口，文件被篡改成外部地址时
// 绝不当作出口。
func isLoopbackHTTPURL(value string) bool {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil {
		return false
	}
	return strings.EqualFold(parsed.Scheme, "http") &&
		parsed.Hostname() == "127.0.0.1" &&
		parsed.Port() != ""
}

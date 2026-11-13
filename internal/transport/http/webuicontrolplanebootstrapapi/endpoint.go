package webuicontrolplanebootstrapapi

import (
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

const (
	// defaultManagementPort 是 Node 在拿不到监听端口时的兜底端口（server 默认 9527）。
	defaultManagementPort = 9527
	// maxEndpointHints 限制端点提示条数：引导响应只用来让页面快速连上，不做穷举。
	maxEndpointHints = 8
)

// endpointHint 复刻 /control-plane/endpoints 契约的提示结构，便于客户端合并两处结果。
//
// 本包只填引导自身能证明的条目（浏览器地址、本机回环）；局域网候选由
// webuicontrolplaneapi 的 endpoints 契约负责，避免出现第二份网卡枚举实现。
type endpointHint struct {
	Endpoint    string `json:"endpoint"`
	Source      string `json:"source"`
	Label       string `json:"label"`
	Warning     string `json:"warning"`
	Recommended bool   `json:"recommended"`
}

// endpointResolution 是一次引导请求对 endpoint 的推导结果。
type endpointResolution struct {
	// Endpoint 写进 profile.endpoint。
	Endpoint string
	// Source 是 Endpoint 的来源："request"（浏览器地址）或 "loopback"（本机回环）。
	Source string
	// BrowserEndpoint 是浏览器可见地址；为空表示请求没带 Host。
	BrowserEndpoint string
	// RequestIsLoopback 表示浏览器地址栏本身就是 loopback（决定告警文案与推荐位）。
	RequestIsLoopback bool
}

// resolveEndpoint 复刻 Node 的推导规则：
// 浏览器地址栏是 loopback 名字时用它（端口映射也能对上），否则 profile endpoint 固定回落到
// http://127.0.0.1:<监听端口>——非 loopback 的地址可能是反代域名，不该被当成网关自身地址。
func (handler *Handler) resolveEndpoint(request *http.Request) endpointResolution {
	base := handler.requestBaseURL(request)
	parsed, _ := url.Parse(base)
	host := ""
	if parsed != nil {
		host = strings.TrimSpace(parsed.Host)
	}
	port := validPort(request.URL.Query().Get("port"))
	if port == 0 {
		port = localListenPort(request)
	}
	if port == 0 {
		port = urlPort(parsed)
	}
	if port == 0 {
		port = defaultManagementPort
	}
	loopback := "http://127.0.0.1:" + strconv.Itoa(port)
	if host == "" {
		return endpointResolution{Endpoint: loopback, Source: "loopback"}
	}
	if isLoopbackHostName(host) {
		browser := "http://" + host
		return endpointResolution{Endpoint: browser, Source: "request", BrowserEndpoint: browser, RequestIsLoopback: true}
	}
	return endpointResolution{Endpoint: loopback, Source: "loopback", BrowserEndpoint: base}
}

// requestBaseURL 取浏览器可见的 base URL。
//
// 当宿主未注入 PublicBaseURL 且请求带了 Node 透传的 host/port 查询参数时，
// 按参数里的原始 Host 还原浏览器地址（避免落成 Node→Go 内部回环端口）。
func (handler *Handler) requestBaseURL(request *http.Request) string {
	if handler.publicBaseURL != nil {
		if value := strings.TrimRight(strings.TrimSpace(handler.publicBaseURL(request)), "/"); value != "" {
			return value
		}
	}
	query := request.URL.Query()
	if query.Has("host") || query.Has("port") {
		host := sanitizeQueryHost(query.Get("host"))
		if host == "" {
			return ""
		}
		scheme := "http"
		if strings.EqualFold(strings.TrimSpace(query.Get("proto")), "https") {
			scheme = "https"
		}
		return scheme + "://" + host
	}
	host := strings.TrimSpace(request.Host)
	if host == "" {
		return ""
	}
	scheme := "http"
	if request.TLS != nil {
		scheme = "https"
	}
	return scheme + "://" + host
}

// sanitizeQueryHost 校验查询参数传入的 Host[:Port]，拒绝路径、userinfo、空白与控制字符。
func sanitizeQueryHost(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" || strings.ContainsAny(trimmed, "/\\@?# \t\r\n") {
		return ""
	}
	for _, r := range trimmed {
		if r < 0x20 || r == 0x7f {
			return ""
		}
	}
	parsed, err := url.Parse("http://" + trimmed)
	if err != nil || parsed == nil || parsed.Host != trimmed || parsed.Hostname() == "" {
		return ""
	}
	if rawPort := parsed.Port(); rawPort != "" && validPort(rawPort) == 0 {
		return ""
	}
	return trimmed
}

// localListenPort 取本连接实际监听端口，比猜配置更可靠。
func localListenPort(request *http.Request) int {
	address, ok := request.Context().Value(http.LocalAddrContextKey).(net.Addr)
	if !ok || address == nil {
		return 0
	}
	_, port, err := net.SplitHostPort(address.String())
	if err != nil {
		return 0
	}
	return validPort(port)
}

func urlPort(parsed *url.URL) int {
	if parsed == nil {
		return 0
	}
	return validPort(parsed.Port())
}

func validPort(value string) int {
	port, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || port <= 0 || port > 65535 {
		return 0
	}
	return port
}

// isLoopbackHostName 复刻 Node webui-auth-gate 的判定：只认 localhost / 127.0.0.1 / ::1，
// 端口部分允许省略。只认这几个名字是有意的——引导入口的信任边界越窄越好。
func isLoopbackHostName(value string) bool {
	host := strings.ToLower(strings.TrimSpace(value))
	// 裸 IPv6 没有端口，且 "::1" 会被 stripHostPort 当成 host:port 截断，先单独认。
	if host == "::1" {
		return true
	}
	host = stripHostPort(host)
	if host == "" {
		return false
	}
	return host == "localhost" || host == "127.0.0.1" || host == "[::1]"
}

// stripHostPort 去掉 host 的端口部分；不是数字端口时原样返回（与 Node 的正则一致）。
func stripHostPort(host string) string {
	if strings.HasPrefix(host, "[") {
		if index := strings.Index(host, "]"); index >= 0 {
			return host[:index+1]
		}
		return host
	}
	index := strings.LastIndex(host, ":")
	if index < 0 {
		return host
	}
	for _, char := range host[index+1:] {
		if char < '0' || char > '9' {
			return host
		}
	}
	return host[:index]
}

// buildEndpointHints 产出引导响应里的端点提示与告警：先给浏览器地址，再给本机回环地址。
func buildEndpointHints(resolution endpointResolution) ([]endpointHint, []string) {
	hints := make([]endpointHint, 0, 2)
	warnings := []string{}
	if resolution.BrowserEndpoint != "" {
		hint := endpointHint{
			Endpoint: resolution.BrowserEndpoint,
			Source:   "request",
			Label:    "当前浏览器地址",
			// 只有浏览器地址本身不是 loopback 时，这个地址才可能给别的设备用。
			Recommended: !resolution.RequestIsLoopback,
		}
		if resolution.RequestIsLoopback {
			hint.Warning = "localhost 只适合同机访问。"
			warnings = append(warnings, "当前浏览器地址是 localhost，只适合同机访问，手机不能直接使用。")
		}
		hints = append(hints, hint)
	}
	if resolution.Endpoint != "" && resolution.Endpoint != resolution.BrowserEndpoint && len(hints) < maxEndpointHints {
		hints = append(hints, endpointHint{
			Endpoint: resolution.Endpoint,
			Source:   resolution.Source,
			Label:    "本机回环地址",
			Warning:  "只适合同机访问。",
		})
	}
	return hints, warnings
}

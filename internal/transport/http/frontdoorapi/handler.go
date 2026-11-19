package frontdoorapi

// Deprecated: 旧前置门的流式反代实现，仅保留给历史对照测试。
//
// 生产路由已不再把未注册路径转交给其它宿主；Go 拥有公开端口后，未知路径统一返回
// 稳定 JSON 404。这里保留 ReverseProxy 的流式语义仅用于理解旧协议和已有单元测试：
//
//   - 升级请求（WebSocket）由 ReverseProxy 的协议切换路径处理，不会把 101 吞成 200；
//   - 响应体按块透传并立即冲刷，SSE 的心跳与增量不会攒在缓冲区里；
//   - 请求体不被读取，上传大文件时内存占用与文件大小无关。
//
// 目标地址只接受 loopback HTTP：这是宿主内部拓扑，不是对外代理能力。

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"
)

// ErrInvalidTarget 表示前置门目标地址不是合法的 loopback HTTP 端点。
var ErrInvalidTarget = errors.New("前置门目标地址无效")

// incomingForwardingHeaders 枚举代表请求已途经上游反向代理或跨节点网关的请求头。
var incomingForwardingHeaders = []string{
	"X-Forwarded-For",
	"X-Real-Ip",
	"Forwarded",
	"X-Forwarded-Host",
	"X-Forwarded-Proto",
	"Cf-Connecting-Ip",
	"X-Aih-Server-Id",
}

// Handler 把请求转交给 Node 宿主。
type Handler struct {
	target *url.URL
	proxy  *httputil.ReverseProxy
}

// New 构造前置门代理。target 形如 http://127.0.0.1:19551。
func New(target string) (*Handler, error) {
	parsed, err := parseTarget(target)
	if err != nil {
		return nil, err
	}
	handler := &Handler{target: parsed}
	// 不复用 http.DefaultTransport：进程入口会把它替换成带出站回退的 RoundTripper
	// （aihserver.InstallOutboundFallback），类型断言会直接 panic；即使没被替换，
	// 默认 Transport 也会读 HTTP_PROXY，把内部管理密钥发给代理。
	transport := &http.Transport{
		Proxy:                 nil,
		DialContext:           (&net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          100,
		MaxIdleConnsPerHost:   64,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
	}
	handler.proxy = &httputil.ReverseProxy{
		Transport: transport,
		Rewrite: func(request *httputil.ProxyRequest) {
			request.SetURL(parsed)
			rewriteForwardingHeaders(request)
			// 保留原始 Host：Node 用它判定「这是本机请求」，也用于拼接绝对地址。
			// 改写成上游端口会让 Node 认为自己是被别的站点访问的。
			request.Out.Host = request.In.Host
		},
		// SSE 与长轮询必须逐块冲刷；-1 表示每次写都冲刷。
		FlushInterval: -1,
		ErrorHandler:  handleProxyError,
	}
	return handler, nil
}

// rewriteForwardingHeaders 维护三类入站拓扑的安全边界：
//  1. 本机直连（TCP 对端是回环且无任何入站转发头）：不注入 X-Forwarded-*，让 Node 的
//     isDirectLoopbackRequest / isLoopbackBootstrapIngress 继续识别为本机直连；
//  2. 本机反向代理（如 Nginx/Caddy 在 127.0.0.1 转发公网流量并携带转发头）：先恢复被
//     ReverseProxy 清空的入站 X-Forwarded-For / Forwarded，再追加当前对端并保留原始
//     X-Forwarded-Host / X-Forwarded-Proto，确保 Node 不会把反代流量误判为本机直连；
//  3. 外部（非回环）客户端直连或经外部代理访问 Go：必须写入 X-Forwarded-For，避免 Node
//     看到 Go→Node 的 127.0.0.1 套接字后把远端客户端误判为本机。
func rewriteForwardingHeaders(request *httputil.ProxyRequest) {
	if request == nil || request.In == nil || request.Out == nil {
		return
	}
	inHeader := request.In.Header
	hasForwarded := hasIncomingForwardingHeaders(inHeader)
	if isLoopbackPeer(request.In.RemoteAddr) && !hasForwarded {
		return
	}

	priorXFF := nonEmptyHeaderValues(inHeader, "X-Forwarded-For")
	if len(priorXFF) > 0 {
		request.Out.Header["X-Forwarded-For"] = priorXFF
	}
	request.SetXForwarded()

	// 若 RemoteAddr 不含端口导致 SetXForwarded 清空了 X-Forwarded-For，兜底补齐对端地址。
	if strings.TrimSpace(request.Out.Header.Get("X-Forwarded-For")) == "" {
		peer := extractPeerHost(request.In.RemoteAddr)
		switch {
		case len(priorXFF) > 0 && peer != "":
			request.Out.Header.Set("X-Forwarded-For", strings.Join(priorXFF, ", ")+", "+peer)
		case len(priorXFF) > 0:
			request.Out.Header.Set("X-Forwarded-For", strings.Join(priorXFF, ", "))
		case peer != "":
			request.Out.Header.Set("X-Forwarded-For", peer)
		}
	}

	if forwarded := nonEmptyHeaderValues(inHeader, "Forwarded"); len(forwarded) > 0 {
		request.Out.Header["Forwarded"] = forwarded
	}
	if hasForwarded {
		if xfh := strings.TrimSpace(inHeader.Get("X-Forwarded-Host")); xfh != "" {
			request.Out.Header.Set("X-Forwarded-Host", xfh)
		}
		if xfp := strings.TrimSpace(inHeader.Get("X-Forwarded-Proto")); xfp != "" {
			request.Out.Header.Set("X-Forwarded-Proto", xfp)
		}
	}
}

func hasIncomingForwardingHeaders(header http.Header) bool {
	if len(header) == 0 {
		return false
	}
	for _, name := range incomingForwardingHeaders {
		for _, value := range header.Values(name) {
			if strings.TrimSpace(value) != "" {
				return true
			}
		}
	}
	return false
}

func nonEmptyHeaderValues(header http.Header, name string) []string {
	values := header.Values(name)
	if len(values) == 0 {
		return nil
	}
	copied := make([]string, 0, len(values))
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			copied = append(copied, value)
		}
	}
	if len(copied) == 0 {
		return nil
	}
	return copied
}

func extractPeerHost(remoteAddr string) string {
	trimmed := strings.TrimSpace(remoteAddr)
	if trimmed == "" {
		return ""
	}
	host, _, err := net.SplitHostPort(trimmed)
	if err != nil {
		host = strings.Trim(trimmed, "[]")
	}
	if zoneIndex := strings.IndexByte(host, '%'); zoneIndex >= 0 {
		host = host[:zoneIndex]
	}
	return strings.TrimSpace(host)
}

func isLoopbackPeer(remoteAddr string) bool {
	host := extractPeerHost(remoteAddr)
	if host == "" {
		return false
	}
	lower := strings.ToLower(host)
	lower = strings.TrimPrefix(lower, "::ffff:")
	if lower == "::1" {
		return true
	}
	ip := net.ParseIP(lower)
	return ip != nil && ip.IsLoopback()
}

// Target 返回归一化后的目标地址，供状态接口展示。
func (handler *Handler) Target() string {
	if handler == nil || handler.target == nil {
		return ""
	}
	return handler.target.String()
}

func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	handler.proxy.ServeHTTP(response, request)
}

// parseTarget 只接受 http/https、带主机、无用户信息与查询串的裸地址。
//
// 带路径的目标会把 /v0 前缀拼接到 /v0/... 之前，形成 /base/v0/...，而 Node 的
// 路由表按绝对路径匹配，结果是一律 404——这种配置必须在启动期就拒绝。
func parseTarget(target string) (*url.URL, error) {
	trimmed := strings.TrimSpace(target)
	if trimmed == "" {
		return nil, fmt.Errorf("%w: 地址为空", ErrInvalidTarget)
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidTarget, err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, fmt.Errorf("%w: 只支持 http/https", ErrInvalidTarget)
	}
	if parsed.Host == "" {
		return nil, fmt.Errorf("%w: 缺少主机", ErrInvalidTarget)
	}
	if parsed.User != nil {
		return nil, fmt.Errorf("%w: 不允许携带用户信息", ErrInvalidTarget)
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, fmt.Errorf("%w: 不允许携带查询串或片段", ErrInvalidTarget)
	}
	if candidate := strings.TrimSuffix(parsed.Path, "/"); candidate != "" {
		return nil, fmt.Errorf("%w: 不允许携带路径前缀", ErrInvalidTarget)
	}
	parsed.Path = ""
	parsed.RawPath = ""
	return parsed, nil
}

// handleProxyError 用稳定 JSON 形状报告 Node 不可达，避免标准库默认的纯文本。
func handleProxyError(response http.ResponseWriter, request *http.Request, err error) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	response.WriteHeader(http.StatusBadGateway)
	_ = json.NewEncoder(response).Encode(map[string]any{
		"error": map[string]string{
			"code":    "node_unreachable",
			"message": "Node 宿主不可达",
			"path":    request.URL.Path,
		},
	})
}

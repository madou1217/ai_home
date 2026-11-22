// Package websameorigin 统一判定 WebUI WebSocket 握手的同源约束。
//
// 背景：Go Server 只监听回环地址，对外由本地反向代理（Cloudflare Tunnel /
// cloudflared / nginx）终止 TLS。此时 origin 看到的请求是明文 HTTP，而浏览器
// 发出的 Origin 是 https://…。如果按「实际请求 TLS 状态」推导 scheme，所有
// 浏览器 WS 都会被误判成跨源（2026-11-23 真机：wss 全部 403，非浏览器客户端
// 不带 Origin 反而能连）。
//
// 信任边界：只有 **RemoteAddr 是回环** 的请求才采信 X-Forwarded-Proto。
// 远端客户端无法直接连到回环监听；能到达这里的只能是本机反代（或本机进程，
// 本机进程本就拥有全部权限）。监听地址若被改成非回环，这条信任自动失效。
package websameorigin

import (
	"encoding/json"
	"net"
	"net/http"
	"net/url"
	"strings"
)

// Matches 判断浏览器 WebSocket 握手是否同源。
//
// 不带 Origin 的非浏览器客户端返回 true，仍由首帧 Bearer 鉴权约束。
// trustForwardedScheme 控制是否在回环来源上采信 X-Forwarded-Proto。
func Matches(request *http.Request, trustForwardedScheme bool) bool {
	if request == nil {
		return false
	}
	origin := strings.TrimSpace(request.Header.Get("Origin"))
	if origin == "" {
		return true
	}
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Host == "" || parsed.User != nil ||
		parsed.RawQuery != "" || parsed.Fragment != "" ||
		(parsed.Path != "" && parsed.Path != "/") {
		return false
	}
	expectedScheme := effectiveScheme(request, trustForwardedScheme)
	if !strings.EqualFold(parsed.Scheme, expectedScheme) {
		return false
	}
	originHost, originPort, ok := splitNormalizedHostPort(parsed.Host, expectedScheme)
	if !ok {
		return false
	}
	requestHost, requestPort, ok := splitNormalizedHostPort(request.Host, expectedScheme)
	if !ok {
		return false
	}
	return originHost == requestHost && originPort == requestPort
}

func effectiveScheme(request *http.Request, trustForwardedScheme bool) string {
	if request.TLS != nil {
		return "https"
	}
	if trustForwardedScheme && isLoopbackRemote(request.RemoteAddr) {
		if proto := forwardedProto(request.Header.Get("X-Forwarded-Proto")); proto != "" {
			return proto
		}
		// Cloudflare 边缘保证写 CF-Visitor；没有 X-Forwarded-Proto 的链路用它兜底。
		if scheme := cloudflareVisitorScheme(request.Header.Get("CF-Visitor")); scheme != "" {
			return scheme
		}
	}
	return "http"
}

// forwardedProto 只接受单个 http/https 值；逗号链取第一跳（最接近客户端的那一跳
// 由最近的反代写入，后续值可能是上游代理拼进来的，不作为信任依据）。
func forwardedProto(raw string) string {
	first := strings.TrimSpace(strings.Split(raw, ",")[0])
	switch strings.ToLower(first) {
	case "http", "https":
		return strings.ToLower(first)
	default:
		return ""
	}
}

func cloudflareVisitorScheme(raw string) string {
	var visitor struct {
		Scheme string `json:"scheme"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(raw)), &visitor); err != nil {
		return ""
	}
	switch strings.ToLower(strings.TrimSpace(visitor.Scheme)) {
	case "http", "https":
		return strings.ToLower(strings.TrimSpace(visitor.Scheme))
	default:
		return ""
	}
}

func isLoopbackRemote(remoteAddr string) bool {
	host, _, err := net.SplitHostPort(strings.TrimSpace(remoteAddr))
	if err != nil {
		host = strings.TrimSpace(remoteAddr)
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	return ip != nil && ip.IsLoopback()
}

func splitNormalizedHostPort(rawHost, scheme string) (string, string, bool) {
	trimmed := strings.TrimSpace(rawHost)
	if trimmed == "" || strings.HasSuffix(trimmed, ":") {
		return "", "", false
	}
	parsed, err := url.Parse(scheme + "://" + trimmed)
	if err != nil || parsed.Host == "" || parsed.User != nil ||
		parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", "", false
	}
	hostname := strings.ToLower(parsed.Hostname())
	if hostname == "" {
		return "", "", false
	}
	port := parsed.Port()
	if port == "" {
		if scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	return hostname, port, true
}

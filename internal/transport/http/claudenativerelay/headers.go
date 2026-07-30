package claudenativerelay

import (
	"net/http"
	"net/textproto"
	"strings"
)

var hopByHopHeaders = map[string]struct{}{
	"Connection":          {},
	"Keep-Alive":          {},
	"Proxy-Authenticate":  {},
	"Proxy-Authorization": {},
	"Proxy-Connection":    {},
	"Te":                  {},
	"Trailer":             {},
	"Transfer-Encoding":   {},
	"Upgrade":             {},
}

// copyRequestHeaders 保留原生 Claude 安全 Header，同时移除认证和代理控制字段。
func copyRequestHeaders(destination, source http.Header) {
	excluded := connectionHeaderNames(source)
	for name := range hopByHopHeaders {
		excluded[name] = struct{}{}
	}
	excluded["Authorization"] = struct{}{}
	excluded["X-Api-Key"] = struct{}{}
	excluded[RelayTokenHeader] = struct{}{}
	excluded["X-Account-Ref"] = struct{}{}
	excluded["Forwarded"] = struct{}{}
	excluded["Cookie"] = struct{}{}

	for name, values := range source {
		canonical := textproto.CanonicalMIMEHeaderKey(name)
		if _, found := excluded[canonical]; found ||
			strings.HasPrefix(canonical, "X-Aih-") ||
			strings.HasPrefix(canonical, "X-Forwarded-") {
			continue
		}
		for _, value := range values {
			destination.Add(canonical, value)
		}
	}
}

// copyResponseHeaders 只把端到端 Header 返回给原生 Claude 客户端。
func copyResponseHeaders(destination, source http.Header) {
	excluded := connectionHeaderNames(source)
	for name := range hopByHopHeaders {
		excluded[name] = struct{}{}
	}
	for name, values := range source {
		canonical := textproto.CanonicalMIMEHeaderKey(name)
		if _, found := excluded[canonical]; found {
			continue
		}
		for _, value := range values {
			destination.Add(canonical, value)
		}
	}
}

// connectionHeaderNames 返回 Connection 动态声明的逐跳 Header。
func connectionHeaderNames(header http.Header) map[string]struct{} {
	names := make(map[string]struct{})
	for _, value := range header.Values("Connection") {
		for token := range strings.SplitSeq(value, ",") {
			canonical := textproto.CanonicalMIMEHeaderKey(
				strings.TrimSpace(token),
			)
			if canonical != "" {
				names[canonical] = struct{}{}
			}
		}
	}
	return names
}

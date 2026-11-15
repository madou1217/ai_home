package codexappserverapi

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	DefaultRemoteControlOrigin   = "https://chatgpt.com"
	DefaultRemoteControlBasePath = "/backend-api"
	MaxRemoteHTTPBodyBytes       = 64 * 1024 * 1024
)

var (
	hopByHopHeaders = map[string]struct{}{
		"connection":          {},
		"content-length":      {},
		"host":                {},
		"keep-alive":          {},
		"proxy-authenticate":  {},
		"proxy-authorization": {},
		"te":                  {},
		"trailer":             {},
		"transfer-encoding":   {},
		"upgrade":             {},
	}
	wsHandshakeHeaders = map[string]struct{}{
		"sec-websocket-accept":     {},
		"sec-websocket-extensions": {},
		"sec-websocket-key":        {},
		"sec-websocket-protocol":   {},
		"sec-websocket-version":    {},
	}
)

// RemoteControlDependencies 配置 ChatGPT remote-control HTTP/WebSocket 反向代理。
type RemoteControlDependencies struct {
	Context           context.Context
	UpstreamOrigin    string
	SuppressStateFile string
	HTTPClient        *http.Client
	Now               func() time.Time
	WriteTrace        func(entry map[string]any)
}

// RemoteControlHandler 转发 Codex remote-control 的 HTTP 与 WebSocket 流量到上游 Origin。
type RemoteControlHandler struct {
	upstreamOrigin    *url.URL
	suppressStateFile string
	httpClient        *http.Client
	now               func() time.Time
	writeTrace        func(entry map[string]any)
	lifetime          context.Context
}

// NewRemoteControlHandler 创建 remote-control HTTP/WS 代理处理器。
func NewRemoteControlHandler(deps RemoteControlDependencies) (*RemoteControlHandler, error) {
	rawOrigin := strings.TrimSpace(deps.UpstreamOrigin)
	if rawOrigin == "" {
		rawOrigin = DefaultRemoteControlOrigin
	}
	parsed, err := url.Parse(rawOrigin)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") {
		return nil, fmt.Errorf("无效的上游 Origin: %q", rawOrigin)
	}
	client := deps.HTTPClient
	if client == nil {
		client = &http.Client{
			Timeout: 60 * time.Second,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
	}
	nowFn := deps.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	writeTrace := deps.WriteTrace
	lifetime := deps.Context
	if lifetime == nil {
		lifetime = context.Background()
	}
	return &RemoteControlHandler{
		upstreamOrigin:    parsed,
		suppressStateFile: strings.TrimSpace(deps.SuppressStateFile),
		httpClient:        client,
		now:               nowFn,
		writeTrace:        writeTrace,
		lifetime:          lifetime,
	}, nil
}

func (h *RemoteControlHandler) trace(entry map[string]any) {
	if h.writeTrace != nil {
		h.writeTrace(entry)
	}
}

func (h *RemoteControlHandler) targetURL(reqURL *url.URL, forWebSocket bool) *url.URL {
	target := &url.URL{
		Scheme: h.upstreamOrigin.Scheme,
		Host:   h.upstreamOrigin.Host,
		Path:   DefaultRemoteControlBasePath,
	}
	if reqURL != nil {
		if reqURL.Path != "" {
			target.Path = reqURL.Path
		}
		target.RawQuery = reqURL.RawQuery
		target.RawPath = reqURL.RawPath
	}
	if forWebSocket {
		if strings.EqualFold(target.Scheme, "http") {
			target.Scheme = "ws"
		} else {
			target.Scheme = "wss"
		}
	}
	return target
}

func copyFilteredHeaders(src http.Header, extraSkip map[string]struct{}) http.Header {
	out := make(http.Header)
	connectionHeaders := make(map[string]bool)
	for _, value := range src.Values("Connection") {
		for _, name := range strings.Split(value, ",") {
			connectionHeaders[strings.ToLower(strings.TrimSpace(name))] = true
		}
	}
	for key, vals := range src {
		lower := strings.ToLower(key)
		if connectionHeaders[lower] {
			continue
		}
		if _, skip := hopByHopHeaders[lower]; skip {
			continue
		}
		if _, skip := extraSkip[lower]; skip {
			continue
		}
		copied := make([]string, len(vals))
		copy(copied, vals)
		out[key] = copied
	}
	return out
}

// ServeHTTP 根据请求是否为 WebSocket Upgrade 分流至 WS 双向代理或 HTTP 转发。
func (h *RemoteControlHandler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if h == nil || request == nil {
		http.Error(response, "remote_control_proxy_failed", http.StatusServiceUnavailable)
		return
	}
	ctx, cancel := context.WithCancel(request.Context())
	stop := context.AfterFunc(h.lifetime, cancel)
	defer stop()
	defer cancel()
	request = request.WithContext(ctx)
	if IsUpgradeRequest(request) {
		h.serveWebSocket(response, request)
		return
	}
	h.serveHTTPRequest(response, request)
}

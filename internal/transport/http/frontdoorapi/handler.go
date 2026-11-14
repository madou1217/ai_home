package frontdoorapi

// 前置门（front door）：Go 监听公开端口后，把自身未实现的路由原样转交给 Node 宿主。
//
// 迁移到「Go 拥有公开端口」之后，Node 仍持有两类能力：WebUI 数据面（/v0/webui/*）
// 与插件运行时回调。二者都是**流式**的（SSE、WebSocket 升级、文件上传/下载），
// 因此这里用 httputil.ReverseProxy 而不是拼接 JSON 的二跳代理：
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
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
)

// ErrInvalidTarget 表示前置门目标地址不是合法的 loopback HTTP 端点。
var ErrInvalidTarget = errors.New("前置门目标地址无效")

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
	transport := http.DefaultTransport.(*http.Transport).Clone()
	// 回环流量绝不走宿主机代理：HTTP_PROXY 一类的环境变量会让内部调用出网，
	// 表现为上游 502 或把内部管理密钥发给代理。
	transport.Proxy = nil
	transport.MaxIdleConnsPerHost = 64
	handler.proxy = &httputil.ReverseProxy{
		Transport: transport,
		Rewrite: func(request *httputil.ProxyRequest) {
			request.SetURL(parsed)
			request.SetXForwarded()
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

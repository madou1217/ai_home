package aihserver

import (
	"log"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
	"time"
)

// 出站代理回退：环境变量代理不可达时改直连，避免「一个失效代理锁死所有出站」。
//
// Node 侧一直是这个语义：`fetchWithTimeout` 只对**环境变量来源**的代理
// （resolveProxyConfig 的 source=env_proxy）在连接类错误上重试直连
// （shouldRetryWithoutProxy），显式配置的代理从不绕过。Go 迁移后少了这一层，
// 于是宿主 `HTTP(S)_PROXY` 指向一个已关闭的本机端口时：Node 的请求照常直连，
// Go 的每个请求都在毫秒级被拒（OAuth 换码表现为 provider_unavailable）。
//
// 两个边界必须守住：
//   - 只回退「连不上代理」的错误（proxyconnect / socks connect），代理转发过程中的
//     上游错误不动：那不是出口问题，直连不会更好。
//   - 显式代理（server config proxyUrl）由 Node 通过 AIH_SERVER_PROXY_STRICT 标注，
//     失败必须失败关闭：绕过显式代理就是静默换出口 IP。

// stdlibDefaultTransport 在进程启动时捕获标准库默认值。
//
// installOutboundFallback 之后 http.DefaultTransport 不再是一个 *http.Transport，
// 所有需要克隆默认参数的地方（出站连接池）必须从这里出发。
var stdlibDefaultTransport = http.DefaultTransport.(*http.Transport)

// proxyStrictEnv 由 Node 在把显式代理写进 Go 环境时注入（见 go-core-proxy-guard）。
const proxyStrictEnv = "AIH_SERVER_PROXY_STRICT"

// proxyFallbackLogInterval 让同一场代理故障最多每 30s 写一条日志。
const proxyFallbackLogInterval = 30 * time.Second

type proxyFallbackTransport struct {
	base   *http.Transport
	direct *http.Transport
}

// InstallOutboundFallback 把带回退的出站层装成 http.DefaultTransport。
//
// 只在进程入口调用一次（幂等）：所有未指定 Transport 的 http.Client（OAuth 换码、
// 额度探测、模型目录、插件控制面等）都会拿到同一套语义。
func InstallOutboundFallback() {
	if _, installed := http.DefaultTransport.(*proxyFallbackTransport); installed {
		return
	}
	base := stdlibDefaultTransport.Clone()
	direct := stdlibDefaultTransport.Clone()
	direct.Proxy = nil
	http.DefaultTransport = &proxyFallbackTransport{base: base, direct: direct}
}

// wrapOutboundTransport 给自建连接池套上同一套回退语义。
func wrapOutboundTransport(transport *http.Transport) http.RoundTripper {
	if transport == nil {
		return nil
	}
	direct := transport.Clone()
	direct.Proxy = nil
	return &proxyFallbackTransport{base: transport, direct: direct}
}

func (transport *proxyFallbackTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	response, err := transport.base.RoundTrip(request)
	if err == nil || !proxyFallbackAllowed(request, err) {
		return response, err
	}
	retry := request.Clone(request.Context())
	if request.Body != nil && request.Body != http.NoBody {
		// 只能重放可重建的请求体：拿不到 GetBody 就放弃回退，绝不重发半截请求。
		body, bodyErr := request.GetBody()
		if bodyErr != nil {
			return response, err
		}
		retry.Body = body
	}
	logProxyFallback(request, err)
	return transport.direct.RoundTrip(retry)
}

// proxyFallbackAllowed 判断这次失败是否属于「环境代理不可达」。
func proxyFallbackAllowed(request *http.Request, err error) bool {
	if request == nil || request.URL == nil || err == nil {
		return false
	}
	// 显式代理是操作者选择的出口：连不上就失败，不能静默换出口 IP。
	if strings.TrimSpace(os.Getenv(proxyStrictEnv)) != "" {
		return false
	}
	message := err.Error()
	return strings.Contains(message, "proxyconnect") ||
		strings.Contains(message, "socks connect") ||
		strings.Contains(message, "proxy connect")
}

// lastProxyFallbackLogAt 记录上一次回退日志的时间（UnixNano）。
var lastProxyFallbackLogAt atomic.Int64

// logProxyFallback 说明「这次请求为什么改直连」，日志里只出现 host，不含凭据。
func logProxyFallback(request *http.Request, cause error) {
	now := time.Now().UnixNano()
	previous := lastProxyFallbackLogAt.Load()
	if previous != 0 && now-previous < int64(proxyFallbackLogInterval) {
		return
	}
	if !lastProxyFallbackLogAt.CompareAndSwap(previous, now) {
		return
	}
	log.Printf(
		"outbound: 环境代理不可达，本次改直连 host=%s: %v",
		request.URL.Host,
		cause,
	)
}

package aihserver

import (
	"net/http"
	"time"
)

const (
	// upstreamMaxIdleConnsPerHost 按单个上游 host 的并发量级设置：一个中转端点或官方端点
	// 常常同时承载几十个流式请求。
	upstreamMaxIdleConnsPerHost = 128
	upstreamMaxIdleConns        = 512
	upstreamIdleConnTimeout     = 90 * time.Second
)

// newUpstreamTransport 返回推理与 Claude 中转出站使用的连接池。
//
// http.DefaultTransport 每个 host 只保留 2 个空闲连接：并发高于 2 时，多出来的 HTTP/1.1
// 连接用完即关，远端 HTTPS 每次都要重新握手，本机高 QPS 时还会耗尽临时端口
// （基准测试中 c16 下 20 s 新建约 1.6 万个上游连接后开始拨号失败）。
// 其余参数（代理、HTTP/2、握手超时）沿用 DefaultTransport。
func newUpstreamTransport() *http.Transport {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.MaxIdleConns = upstreamMaxIdleConns
	transport.MaxIdleConnsPerHost = upstreamMaxIdleConnsPerHost
	transport.IdleConnTimeout = upstreamIdleConnTimeout
	return transport
}

// idleConnectionCloser 在组合关闭时释放连接池里的空闲连接。
type idleConnectionCloser struct {
	transport *http.Transport
}

func (closer idleConnectionCloser) Close() error {
	closer.transport.CloseIdleConnections()
	return nil
}

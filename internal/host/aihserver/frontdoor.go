package aihserver

import (
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
)

const (
	// frontDoorPeerHeader 携带客户端的真实 TCP 对端主机。
	//
	// 前门把请求转给回环上的 Node 后，Node 看到的 socket 对端恒为 127.0.0.1，
	// 无法再区分「本机浏览器」与「经前门进来的局域网客户端」；这个头是唯一可信的
	// 来源，因此客户端自带的同名头一律先删掉再写入。
	frontDoorPeerHeader = "X-AIH-Peer"
	// frontDoorTokenHeader 是前门与 Node 之间的共享凭据头，只在配置了 token 时写入。
	frontDoorTokenHeader = "X-AIH-Front-Door"
)

// NewFrontDoor 构造公开端口的兜底反向代理：未识别的路由原样交给回环上的 Node。
//
// 语义要点：
//   - FlushInterval 为 -1，上游每写一次就立刻冲刷。httputil 对 SSE 与 chunked 响应
//     有即时冲刷的特判，但声明了长度的流式响应仍取决于这个值，默认的 0 会把首帧
//     压到响应结束才发出。
//   - 客户端自带的转发头全部丢弃，只有本函数写入的值可信。
//   - 保留原始 Host：Node 用 Host 判断是不是本机回环内部入口。
//   - Transport 不设 ResponseHeaderTimeout：长轮询与慢上游不允许被「等响应头超时」截断。
//   - Upgrade（WebSocket）由 httputil.ReverseProxy 自带处理，这里只保证不破坏它。
func NewFrontDoor(
	upstream *url.URL,
	token string,
	errorLog *log.Logger,
) (http.Handler, error) {
	if upstream == nil {
		return nil, errors.New("前门上游地址为空")
	}
	scheme := strings.ToLower(strings.TrimSpace(upstream.Scheme))
	if scheme != "http" && scheme != "https" {
		return nil, errors.New("前门上游地址必须是 http 或 https")
	}
	if strings.TrimSpace(upstream.Host) == "" {
		return nil, errors.New("前门上游地址缺少主机")
	}
	if errorLog == nil {
		errorLog = log.New(io.Discard, "", 0)
	}

	proxy := httputil.NewSingleHostReverseProxy(upstream)
	// 负数表示每次 Write 之后都 flush，而不是按固定间隔攒批。
	proxy.FlushInterval = -1
	transport := http.DefaultTransport.(*http.Transport).Clone()
	// 显式归零：前门承载 SSE 流，上游可能长时间不返回响应头。
	transport.ResponseHeaderTimeout = 0
	// Upgrade 只能在 HTTP/1.1 上表达；h2 传输会丢弃 Connection/Upgrade 语义。
	transport.ForceAttemptHTTP2 = false
	proxy.Transport = transport

	rewrite := proxy.Director
	proxy.Director = func(request *http.Request) {
		// 默认 Director 会改写 URL 的 scheme/host，但不动 Host 字段；这里显式保存再写回，
		// 避免将来换成 Rewrite 或自定义 Director 时把 Host 一起改掉。
		originalHost := request.Host
		peerHost := frontDoorPeerHost(request.RemoteAddr)
		rewrite(request)
		if originalHost != "" {
			request.Host = originalHost
		}
		stripClientForwardingHeaders(request.Header)
		if peerHost != "" {
			request.Header.Set(frontDoorPeerHeader, peerHost)
		}
		if token != "" {
			request.Header.Set(frontDoorTokenHeader, token)
		}
	}

	proxy.ErrorHandler = func(
		response http.ResponseWriter,
		request *http.Request,
		err error,
	) {
		// 只记录方法与路径；查询串可能带凭据，不落日志。
		errorLog.Printf("前门反代失败: %s %s: %v", request.Method, request.URL.Path, err)
		writeSystemJSON(response, http.StatusBadGateway, systemErrorResponse{
			Error: systemErrorView{
				Code:    "front_door_unavailable",
				Message: "前门上游暂时不可用",
			},
		})
	}
	return proxy, nil
}

// stripClientForwardingHeaders 清除客户端可伪造的转发头。
//
// X-Forwarded-For 另外置成 nil 切片：ReverseProxy 在 Director 之后会自动追加客户端 IP，
// nil 是它约定的「不要生成该头」标记（见 ServeHTTP 里的 omit 判定）。前门改用
// X-AIH-Peer 表达对端，避免 Node 把「经过代理」误读成「第一跳就是客户端」。
func stripClientForwardingHeaders(header http.Header) {
	for _, name := range []string{
		"X-Forwarded-For",
		"X-Forwarded-Host",
		"X-Forwarded-Proto",
		"X-Real-IP",
		frontDoorPeerHeader,
		frontDoorTokenHeader,
	} {
		header.Del(name)
	}
	header["X-Forwarded-For"] = nil
}

// frontDoorPeerHost 取 RemoteAddr 的主机部分。
//
// 正常 TCP 连接是 "host:port"；unix socket 或测试直接填写地址时没有端口，
// 此时按原样使用（去掉 IPv6 的方括号）而不是丢掉整个对端信息。
func frontDoorPeerHost(remoteAddr string) string {
	trimmed := strings.TrimSpace(remoteAddr)
	if host, _, err := net.SplitHostPort(trimmed); err == nil {
		return host
	}
	return strings.Trim(trimmed, "[]")
}

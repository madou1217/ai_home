package aihserver

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// lockedBuffer 让测试能安全读取 ErrorHandler 在服务端 goroutine 写入的日志。
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (buffer *lockedBuffer) Write(data []byte) (int, error) {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	return buffer.buf.Write(data)
}

func (buffer *lockedBuffer) String() string {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	return buffer.buf.String()
}

// newTestFrontDoor 用 httptest 上游地址构造前门，并返回可直连的代理地址。
func newTestFrontDoor(
	t *testing.T,
	upstream string,
	token string,
	errorLog *log.Logger,
) *httptest.Server {
	t.Helper()
	target, err := url.Parse(upstream)
	if err != nil {
		t.Fatalf("解析上游地址 %q: %v", upstream, err)
	}
	handler, err := NewFrontDoor(target, token, errorLog)
	if err != nil {
		t.Fatalf("NewFrontDoor: %v", err)
	}
	front := httptest.NewServer(handler)
	t.Cleanup(front.Close)
	return front
}

// capturedRequest 是上游侧看到的请求快照。
type capturedRequest struct {
	method   string
	path     string
	rawQuery string
	host     string
	header   http.Header
	body     string
}

func captureOnce() (chan capturedRequest, *httptest.Server) {
	captured := make(chan capturedRequest, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		request *http.Request,
	) {
		body, _ := io.ReadAll(request.Body)
		captured <- capturedRequest{
			method:   request.Method,
			path:     request.URL.Path,
			rawQuery: request.URL.RawQuery,
			host:     request.Host,
			header:   request.Header.Clone(),
			body:     string(body),
		}
		response.Header().Set("X-Upstream", "yes")
		response.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(response, "upstream-ok")
	}))
	return captured, upstream
}

// 逐项验证透传合同：方法、路径、查询串、请求体、自定义头、原始 Host。
// 同时验证客户端伪造的转发头被全部丢弃，并由前门写入 X-AIH-Peer / X-AIH-Front-Door。
func TestFrontDoorForwardsRequestAndRewritesForwardingHeaders(t *testing.T) {
	captured, upstream := captureOnce()
	defer upstream.Close()
	front := newTestFrontDoor(t, upstream.URL, "front-door-token", nil)

	request, err := http.NewRequest(
		http.MethodPost,
		front.URL+"/v0/webui/sessions?limit=2&cursor=a%2Fb",
		strings.NewReader("payload"),
	)
	if err != nil {
		t.Fatalf("构造请求: %v", err)
	}
	request.Host = "aih.example.com:9527"
	request.Header.Set("X-Custom", "keep")
	request.Header.Set("X-Forwarded-For", "203.0.113.9, 198.51.100.7")
	request.Header.Set("X-Forwarded-Host", "evil.example.com")
	request.Header.Set("X-Forwarded-Proto", "https")
	request.Header.Set("X-Real-IP", "203.0.113.9")
	request.Header.Set("X-AIH-Peer", "203.0.113.9")
	request.Header.Set("X-AIH-Front-Door", "forged-token")

	response, err := front.Client().Do(request)
	if err != nil {
		t.Fatalf("请求前门: %v", err)
	}
	defer response.Body.Close()
	responseBody, _ := io.ReadAll(response.Body)
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("状态码 = %d, body = %s", response.StatusCode, responseBody)
	}
	if string(responseBody) != "upstream-ok" {
		t.Fatalf("响应体 = %q", responseBody)
	}
	if response.Header.Get("X-Upstream") != "yes" {
		t.Fatalf("上游响应头未透传: %#v", response.Header)
	}

	got := <-captured
	if got.method != http.MethodPost {
		t.Errorf("method = %q", got.method)
	}
	if got.path != "/v0/webui/sessions" {
		t.Errorf("path = %q", got.path)
	}
	if got.rawQuery != "limit=2&cursor=a%2Fb" {
		t.Errorf("rawQuery = %q", got.rawQuery)
	}
	if got.body != "payload" {
		t.Errorf("body = %q", got.body)
	}
	if got.header.Get("X-Custom") != "keep" {
		t.Errorf("普通请求头被改写: %#v", got.header)
	}
	if got.host != "aih.example.com:9527" {
		t.Errorf("Host = %q，必须原样保留", got.host)
	}
	if values := got.header.Values("X-Forwarded-For"); len(values) != 0 {
		t.Errorf("X-Forwarded-For 未被剥离: %#v", values)
	}
	for _, name := range []string{
		"X-Forwarded-Host",
		"X-Forwarded-Proto",
		"X-Real-IP",
	} {
		if value := got.header.Get(name); value != "" {
			t.Errorf("%s 未被剥离: %q", name, value)
		}
	}
	if value := got.header.Get("X-AIH-Peer"); value != "127.0.0.1" {
		t.Errorf("X-AIH-Peer = %q，应为真实对端主机", value)
	}
	if value := got.header.Get("X-AIH-Front-Door"); value != "front-door-token" {
		t.Errorf("X-AIH-Front-Door = %q，应被前门 token 覆盖", value)
	}
}

// token 为空时不写入口头，避免 Node 误以为请求经过受信前门。
func TestFrontDoorOmitsTokenHeaderWhenTokenEmpty(t *testing.T) {
	captured, upstream := captureOnce()
	defer upstream.Close()
	front := newTestFrontDoor(t, upstream.URL, "", nil)

	request, err := http.NewRequest(http.MethodGet, front.URL+"/plain", nil)
	if err != nil {
		t.Fatalf("构造请求: %v", err)
	}
	request.Header.Set("X-AIH-Front-Door", "forged-token")
	response, err := front.Client().Do(request)
	if err != nil {
		t.Fatalf("请求前门: %v", err)
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, response.Body)

	got := <-captured
	if value := got.header.Get("X-AIH-Front-Door"); value != "" {
		t.Fatalf("空 token 仍写入了 X-AIH-Front-Door = %q", value)
	}
	if value := got.header.Get("X-AIH-Peer"); value != "127.0.0.1" {
		t.Fatalf("X-AIH-Peer = %q", value)
	}
}

// 流式响应必须逐帧冲刷：上游还没结束响应时写下的第一帧要立刻到达客户端。
//
// 两个子用例分别守住两件事：
//   - text/event-stream：SSE 的逐帧语义；
//   - application/x-ndjson：非 SSE 的普通流没有 httputil 的 SSE 特判，首帧能否立即
//     到达完全取决于 FlushInterval=-1，这一条才是该设置的回归守卫。
func TestFrontDoorFlushesStreamFramesImmediately(t *testing.T) {
	cases := []struct {
		name           string
		contentType    string
		declaredLength bool
	}{
		{name: "sse", contentType: "text/event-stream"},
		// 声明长度会关掉 httputil 对 chunked 响应的默认即时冲刷，这样这个子用例
		// 才真正由 FlushInterval=-1 决定首帧能否立刻到达。
		{name: "ndjson", contentType: "application/x-ndjson", declaredLength: true},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			release := make(chan struct{})
			var releaseOnce sync.Once
			releaseUpstream := func() { releaseOnce.Do(func() { close(release) }) }

			upstream := httptest.NewServer(http.HandlerFunc(func(
				response http.ResponseWriter,
				request *http.Request,
			) {
				firstFrame := "data: first\n\n"
				secondFrame := "data: second\n\n"
				if testCase.declaredLength {
					response.Header().Set("Content-Length", strconv.Itoa(len(firstFrame)+len(secondFrame)))
				}
				response.Header().Set("Content-Type", testCase.contentType)
				response.WriteHeader(http.StatusOK)
				if _, err := io.WriteString(response, firstFrame); err != nil {
					return
				}
				response.(http.Flusher).Flush()
				<-release
				_, _ = io.WriteString(response, secondFrame)
				response.(http.Flusher).Flush()
			}))
			// release 必须先于 Close：失败路径下上游 handler 还堵在 <-release，
			// 直接 Close 会一直等这条活跃连接。
			defer func() {
				releaseUpstream()
				upstream.Close()
			}()
			front := newTestFrontDoor(t, upstream.URL, "", nil)

			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			request, err := http.NewRequestWithContext(ctx, http.MethodGet, front.URL+"/events", nil)
			if err != nil {
				t.Fatalf("构造请求: %v", err)
			}
			response, err := front.Client().Do(request)
			if err != nil {
				t.Fatalf("流式响应头没有及时到达: %v", err)
			}
			defer response.Body.Close()

			reader := bufio.NewReader(response.Body)
			firstLine := make(chan string, 1)
			go func() {
				line, readErr := reader.ReadString('\n')
				if readErr != nil {
					firstLine <- "读取失败: " + readErr.Error()
					return
				}
				firstLine <- line
			}()

			select {
			case line := <-firstLine:
				if line != "data: first\n" {
					t.Fatalf("首帧 = %q", line)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("首帧 2s 内没有到达：FlushInterval 必须为 -1")
			}

			releaseUpstream()
			rest, err := io.ReadAll(reader)
			if err != nil {
				t.Fatalf("读取剩余帧: %v", err)
			}
			if !strings.Contains(string(rest), "data: second") {
				t.Fatalf("剩余帧 = %q", rest)
			}
		})
	}
}

// 上游不可达时返回 502 + 稳定 JSON 错误码，并留下日志。
func TestFrontDoorReturnsBadGatewayJSONWhenUpstreamUnreachable(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("占端口: %v", err)
	}
	address := listener.Addr().String()
	_ = listener.Close()

	target, err := url.Parse("http://" + address)
	if err != nil {
		t.Fatalf("解析上游地址: %v", err)
	}
	logs := &lockedBuffer{}
	handler, err := NewFrontDoor(target, "", log.New(logs, "", 0))
	if err != nil {
		t.Fatalf("NewFrontDoor: %v", err)
	}
	front := httptest.NewServer(handler)
	defer front.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, front.URL+"/missing", nil)
	if err != nil {
		t.Fatalf("构造请求: %v", err)
	}
	response, err := front.Client().Do(request)
	if err != nil {
		t.Fatalf("前门应返回 502 而不是断开: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusBadGateway {
		t.Fatalf("状态码 = %d", response.StatusCode)
	}
	if contentType := response.Header.Get("Content-Type"); !strings.HasPrefix(contentType, "application/json") {
		t.Fatalf("Content-Type = %q", contentType)
	}

	var payload struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatalf("解析 502 响应: %v", err)
	}
	if payload.Error.Code != "front_door_unavailable" {
		t.Fatalf("错误码 = %q", payload.Error.Code)
	}
	if payload.Error.Message == "" {
		t.Fatal("错误消息为空")
	}
	if !strings.Contains(logs.String(), "前门反代失败") {
		t.Fatalf("日志未记录失败: %q", logs.String())
	}
}

// Upgrade 必须原样透传：101 状态行与之后的双向字节都不能被代理层加工。
func TestFrontDoorProxiesWebSocketUpgrade(t *testing.T) {
	type upgradeObservation struct {
		host       string
		requestURI string
		header     http.Header
	}
	observed := make(chan upgradeObservation, 1)

	upstream := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		request *http.Request,
	) {
		observed <- upgradeObservation{
			host:       request.Host,
			requestURI: request.URL.RequestURI(),
			header:     request.Header.Clone(),
		}
		if !strings.EqualFold(request.Header.Get("Upgrade"), "websocket") {
			http.Error(response, "missing upgrade", http.StatusBadRequest)
			return
		}
		connection, buffered, err := response.(http.Hijacker).Hijack()
		if err != nil {
			return
		}
		defer connection.Close()
		_ = connection.SetDeadline(time.Now().Add(5 * time.Second))
		_, _ = buffered.WriteString(
			"HTTP/1.1 101 Switching Protocols\r\n" +
				"Connection: Upgrade\r\n" +
				"Upgrade: websocket\r\n\r\n",
		)
		if err := buffered.Flush(); err != nil {
			return
		}
		payload := make([]byte, 4)
		if _, err := io.ReadFull(buffered, payload); err != nil {
			return
		}
		_, _ = buffered.Write(payload)
		_ = buffered.Flush()
	}))
	defer upstream.Close()
	front := newTestFrontDoor(t, upstream.URL, "front-door-token", nil)

	frontURL, err := url.Parse(front.URL)
	if err != nil {
		t.Fatalf("解析前门地址: %v", err)
	}
	connection, err := net.DialTimeout("tcp", frontURL.Host, 5*time.Second)
	if err != nil {
		t.Fatalf("连接前门: %v", err)
	}
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(5 * time.Second))

	_, err = io.WriteString(connection,
		"GET /ws?room=1 HTTP/1.1\r\n"+
			"Host: aih.example.com\r\n"+
			"Connection: Upgrade\r\n"+
			"Upgrade: websocket\r\n"+
			"Sec-WebSocket-Version: 13\r\n"+
			"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
	)
	if err != nil {
		t.Fatalf("写入升级请求: %v", err)
	}

	reader := bufio.NewReader(connection)
	response, err := http.ReadResponse(reader, &http.Request{Method: http.MethodGet})
	if err != nil {
		t.Fatalf("读取升级响应: %v", err)
	}
	if response.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("状态码 = %d", response.StatusCode)
	}
	if !strings.EqualFold(response.Header.Get("Upgrade"), "websocket") {
		t.Fatalf("Upgrade = %q", response.Header.Get("Upgrade"))
	}

	if _, err := io.WriteString(connection, "ping"); err != nil {
		t.Fatalf("写入隧道数据: %v", err)
	}
	echo := make([]byte, 4)
	if _, err := io.ReadFull(reader, echo); err != nil {
		t.Fatalf("读取隧道回显: %v", err)
	}
	if string(echo) != "ping" {
		t.Fatalf("回显 = %q", echo)
	}

	select {
	case got := <-observed:
		if got.host != "aih.example.com" {
			t.Errorf("Host = %q", got.host)
		}
		if got.requestURI != "/ws?room=1" {
			t.Errorf("requestURI = %q", got.requestURI)
		}
		if value := got.header.Get("X-AIH-Peer"); value != "127.0.0.1" {
			t.Errorf("X-AIH-Peer = %q", value)
		}
		if value := got.header.Get("X-AIH-Front-Door"); value != "front-door-token" {
			t.Errorf("X-AIH-Front-Door = %q", value)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("上游没有收到升级请求")
	}
}

func TestNewFrontDoorRejectsInvalidUpstream(t *testing.T) {
	cases := []struct {
		name     string
		upstream *url.URL
	}{
		{name: "nil", upstream: nil},
		{name: "缺少协议", upstream: &url.URL{Host: "127.0.0.1:8080"}},
		{name: "不支持协议", upstream: &url.URL{Scheme: "ftp", Host: "127.0.0.1:8080"}},
		{name: "缺少主机", upstream: &url.URL{Scheme: "http"}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			handler, err := NewFrontDoor(testCase.upstream, "", nil)
			if err == nil {
				t.Fatal("非法上游应当返回错误")
			}
			if handler != nil {
				t.Fatal("出错时不应返回 handler")
			}
		})
	}
}

func TestFrontDoorPeerHost(t *testing.T) {
	cases := map[string]string{
		"192.0.2.10:51234":  "192.0.2.10",
		"[2001:db8::1]:443": "2001:db8::1",
		"192.0.2.10":        "192.0.2.10",
		"[2001:db8::1]":     "2001:db8::1",
		"":                  "",
		"   ":               "",
	}
	for remoteAddr, expected := range cases {
		if got := frontDoorPeerHost(remoteAddr); got != expected {
			t.Errorf("frontDoorPeerHost(%q) = %q, want %q", remoteAddr, got, expected)
		}
	}
}

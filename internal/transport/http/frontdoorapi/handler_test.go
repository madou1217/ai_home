package frontdoorapi

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// TestHandlerForwardsRequestShape 保证方法、路径、查询串、请求体与自定义头原样到达 Node。
func TestHandlerForwardsRequestShape(t *testing.T) {
	type captured struct {
		method string
		path   string
		query  string
		body   string
		header string
		host   string
	}
	var got captured
	backend := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body)
		got = captured{
			method: request.Method,
			path:   request.URL.Path,
			query:  request.URL.RawQuery,
			body:   string(body),
			header: request.Header.Get("X-Test-Trace"),
			host:   request.Host,
		}
		response.Header().Set("X-Backend", "node")
		response.WriteHeader(http.StatusCreated)
		_, _ = response.Write([]byte("forwarded"))
	}))
	defer backend.Close()

	handler := mustNewHandler(t, backend.URL)
	front := httptest.NewServer(handler)
	defer front.Close()

	request, err := http.NewRequest(
		http.MethodPost,
		front.URL+"/v0/webui/accounts/watch?since=42",
		strings.NewReader("payload"),
	)
	if err != nil {
		t.Fatalf("构造请求失败: %v", err)
	}
	request.Header.Set("X-Test-Trace", "trace-1")
	response, err := front.Client().Do(request)
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)

	if response.StatusCode != http.StatusCreated {
		t.Fatalf("状态码 = %d，期望 201", response.StatusCode)
	}
	if string(body) != "forwarded" {
		t.Fatalf("响应体 = %q", string(body))
	}
	if response.Header.Get("X-Backend") != "node" {
		t.Fatalf("响应头未透传: %v", response.Header)
	}
	want := captured{
		method: http.MethodPost,
		path:   "/v0/webui/accounts/watch",
		query:  "since=42",
		body:   "payload",
		header: "trace-1",
	}
	if got.method != want.method || got.path != want.path || got.query != want.query ||
		got.body != want.body || got.header != want.header {
		t.Fatalf("上游收到 %+v，期望 %+v", got, want)
	}
	// Host 保持客户端视角：Node 依赖它判定「这是本机请求」。
	if got.host != strings.TrimPrefix(front.URL, "http://") {
		t.Fatalf("上游 Host = %q，期望 %q", got.host, front.URL)
	}
}

// TestHandlerForwardingBoundaryThreeCases 严格验证三类网络入站拓扑的转发头边界：
//  1. 本机回环直连（127.0.0.1 / ::1 且无转发头）：禁止注入 X-Forwarded-*，保持本机直连语义；
//  2. 本机反向代理（127.0.0.1 携带 X-Forwarded-For / X-Real-Ip / Forwarded / X-Forwarded-Proto 等）：
//     保留原始转发头并追加 X-Forwarded-For 链，防止反代公网流量伪装成本机直连；
//  3. 外部非回环对端：必须注入 X-Forwarded-For，防止 Node 把 Go 的回环套接字误判为本机客户端。
func TestHandlerForwardingBoundaryThreeCases(t *testing.T) {
	type capturedHeaders struct {
		xff       string
		xfHost    string
		xfProto   string
		xRealIP   string
		forwarded string
		host      string
	}

	seenCh := make(chan capturedHeaders, 8)
	backend := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		seenCh <- capturedHeaders{
			xff:       request.Header.Get("X-Forwarded-For"),
			xfHost:    request.Header.Get("X-Forwarded-Host"),
			xfProto:   request.Header.Get("X-Forwarded-Proto"),
			xRealIP:   request.Header.Get("X-Real-Ip"),
			forwarded: request.Header.Get("Forwarded"),
			host:      request.Host,
		}
		response.WriteHeader(http.StatusNoContent)
	}))
	defer backend.Close()

	proxyHandler := mustNewHandler(t, backend.URL)

	t.Run("本机IPv4直连不注入X-Forwarded头", func(t *testing.T) {
		front := httptest.NewServer(proxyHandler)
		defer front.Close()

		resp, err := front.Client().Get(front.URL + "/v0/webui/control-plane/bootstrap")
		if err != nil {
			t.Fatalf("请求失败: %v", err)
		}
		_ = resp.Body.Close()
		got := <-seenCh
		if got.xff != "" || got.xfHost != "" || got.xfProto != "" || got.forwarded != "" || got.xRealIP != "" {
			t.Fatalf("本机直连不应注入任何转发头，实际收到: %+v", got)
		}
	})

	t.Run("本机IPv6直连不注入X-Forwarded头", func(t *testing.T) {
		ln, err := net.Listen("tcp6", "[::1]:0")
		if err != nil {
			t.Skipf("当前环境不支持 IPv6 回环监听: %v", err)
		}
		front := httptest.NewUnstartedServer(proxyHandler)
		front.Listener = ln
		front.Start()
		defer front.Close()

		resp, err := front.Client().Get(front.URL + "/v0/webui/control-plane/bootstrap")
		if err != nil {
			t.Fatalf("IPv6 请求失败: %v", err)
		}
		_ = resp.Body.Close()
		got := <-seenCh
		if got.xff != "" || got.xfHost != "" || got.xfProto != "" {
			t.Fatalf("IPv6 本机直连不应注入转发头，实际收到: %+v", got)
		}
	})

	t.Run("本机反向代理保留转发链并追加回环跳", func(t *testing.T) {
		front := httptest.NewServer(proxyHandler)
		defer front.Close()

		req, err := http.NewRequest(http.MethodGet, front.URL+"/v0/webui/control-plane/bootstrap", nil)
		if err != nil {
			t.Fatalf("构造请求失败: %v", err)
		}
		req.Host = "aih.example.com"
		req.Header.Set("X-Forwarded-For", "203.0.113.7")
		req.Header.Set("X-Real-Ip", "203.0.113.7")
		req.Header.Set("Forwarded", "for=203.0.113.7;proto=https;host=aih.example.com")
		req.Header.Set("X-Forwarded-Host", "aih.example.com")
		req.Header.Set("X-Forwarded-Proto", "https")

		resp, err := front.Client().Do(req)
		if err != nil {
			t.Fatalf("请求失败: %v", err)
		}
		_ = resp.Body.Close()
		got := <-seenCh
		if got.xff != "203.0.113.7, 127.0.0.1" {
			t.Fatalf("X-Forwarded-For = %q，期望 %q", got.xff, "203.0.113.7, 127.0.0.1")
		}
		if got.xRealIP != "203.0.113.7" {
			t.Fatalf("X-Real-Ip = %q，期望 203.0.113.7", got.xRealIP)
		}
		if got.forwarded != "for=203.0.113.7;proto=https;host=aih.example.com" {
			t.Fatalf("Forwarded = %q", got.forwarded)
		}
		if got.xfHost != "aih.example.com" || got.xfProto != "https" {
			t.Fatalf("X-Forwarded-Host/Proto 未保留: %+v", got)
		}
	})

	t.Run("本机反代仅传X-Real-Ip时同样标记转发头", func(t *testing.T) {
		front := httptest.NewServer(proxyHandler)
		defer front.Close()

		req, _ := http.NewRequest(http.MethodGet, front.URL+"/v0/webui/health", nil)
		req.Header.Set("X-Real-Ip", "198.51.100.88")
		resp, err := front.Client().Do(req)
		if err != nil {
			t.Fatalf("请求失败: %v", err)
		}
		_ = resp.Body.Close()
		got := <-seenCh
		if got.xff != "127.0.0.1" || got.xRealIP != "198.51.100.88" {
			t.Fatalf("仅传 X-Real-Ip 时应生成 XFF 并保留 X-Real-Ip，实际: %+v", got)
		}
	})

	t.Run("外部非回环客户端必须注入X-Forwarded-For", func(t *testing.T) {
		externalFront := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			cloned := r.Clone(r.Context())
			cloned.RemoteAddr = "198.51.100.42:54321"
			proxyHandler.ServeHTTP(w, cloned)
		}))
		defer externalFront.Close()

		resp, err := externalFront.Client().Get(externalFront.URL + "/v0/webui/health")
		if err != nil {
			t.Fatalf("请求失败: %v", err)
		}
		_ = resp.Body.Close()
		got := <-seenCh
		if got.xff != "198.51.100.42" {
			t.Fatalf("外部客户端 X-Forwarded-For = %q，期望 198.51.100.42", got.xff)
		}
	})
}

// TestHandlerStreamsChunks 保证首块响应在第二块产生前就到达客户端（SSE 语义）。
func TestHandlerStreamsChunks(t *testing.T) {
	release := make(chan struct{})
	backend := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		flusher, _ := response.(http.Flusher)
		response.Header().Set("Content-Type", "text/event-stream")
		response.WriteHeader(http.StatusOK)
		_, _ = response.Write([]byte("data: first\n\n"))
		if flusher != nil {
			flusher.Flush()
		}
		<-release
		_, _ = response.Write([]byte("data: second\n\n"))
		if flusher != nil {
			flusher.Flush()
		}
	}))
	defer backend.Close()
	defer close(release)

	front := httptest.NewServer(mustNewHandler(t, backend.URL))
	defer front.Close()

	response, err := front.Client().Get(front.URL + "/v0/webui/events")
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	defer response.Body.Close()
	reader := bufio.NewReader(response.Body)
	line, err := reader.ReadString('\n')
	if err != nil {
		t.Fatalf("读取首块失败: %v", err)
	}
	if line != "data: first\n" {
		t.Fatalf("首块 = %q", line)
	}
}

// TestHandlerProxiesWebSocketUpgrade 保证 101 升级不被反向代理吞成普通响应。
func TestHandlerProxiesWebSocketUpgrade(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if !strings.EqualFold(request.Header.Get("Upgrade"), "websocket") {
			response.WriteHeader(http.StatusBadRequest)
			return
		}
		hijacker, ok := response.(http.Hijacker)
		if !ok {
			t.Error("上游不支持 Hijack")
			return
		}
		connection, buffer, err := hijacker.Hijack()
		if err != nil {
			t.Errorf("Hijack 失败: %v", err)
			return
		}
		defer connection.Close()
		_, _ = buffer.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
		_ = buffer.Flush()
		line, _ := buffer.ReadString('\n')
		_, _ = buffer.WriteString("echo:" + line)
		_ = buffer.Flush()
	}))
	defer backend.Close()

	front := httptest.NewServer(mustNewHandler(t, backend.URL))
	defer front.Close()

	connection, err := net.Dial("tcp", strings.TrimPrefix(front.URL, "http://"))
	if err != nil {
		t.Fatalf("连接前置门失败: %v", err)
	}
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(5 * time.Second))
	request := "GET /v0/webui/accounts/watch HTTP/1.1\r\n" +
		"Host: " + strings.TrimPrefix(front.URL, "http://") + "\r\n" +
		"Upgrade: websocket\r\nConnection: Upgrade\r\n" +
		"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
	if _, err := connection.Write([]byte(request)); err != nil {
		t.Fatalf("写升级请求失败: %v", err)
	}
	reader := bufio.NewReader(connection)
	statusLine, err := reader.ReadString('\n')
	if err != nil {
		t.Fatalf("读取状态行失败: %v", err)
	}
	if !strings.Contains(statusLine, "101") {
		t.Fatalf("状态行 = %q，期望 101", statusLine)
	}
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatalf("读取升级响应头失败: %v", err)
		}
		if line == "\r\n" {
			break
		}
	}
	if _, err := connection.Write([]byte("ping\n")); err != nil {
		t.Fatalf("写升级后数据失败: %v", err)
	}
	echo, err := reader.ReadString('\n')
	if err != nil {
		t.Fatalf("读取回显失败: %v", err)
	}
	if echo != "echo:ping\n" {
		t.Fatalf("回显 = %q", echo)
	}
}

// TestHandlerReportsUnreachableNode 保证 Node 停机时给出稳定 JSON 502，而不是纯文本。
func TestHandlerReportsUnreachableNode(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	target := backend.URL
	backend.Close()

	handler := mustNewHandler(t, target)
	front := httptest.NewServer(handler)
	defer front.Close()

	response, err := front.Client().Get(front.URL + "/v0/webui/health")
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusBadGateway {
		t.Fatalf("状态码 = %d，期望 502", response.StatusCode)
	}
	var payload struct {
		Error struct {
			Code string `json:"code"`
			Path string `json:"path"`
		} `json:"error"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatalf("响应不是稳定 JSON: %v", err)
	}
	if payload.Error.Code != "node_unreachable" {
		t.Fatalf("错误码 = %q", payload.Error.Code)
	}
}

// TestNewRejectsInvalidTargets 把配置错误拦在启动期。
func TestNewRejectsInvalidTargets(t *testing.T) {
	cases := []struct {
		name   string
		target string
	}{
		{name: "空地址", target: ""},
		{name: "缺少协议", target: "127.0.0.1:19551"},
		{name: "非 HTTP 协议", target: "ftp://127.0.0.1:19551"},
		{name: "缺少主机", target: "http:///v0"},
		{name: "携带用户信息", target: "http://user:pass@127.0.0.1:19551"},
		{name: "携带路径", target: "http://127.0.0.1:19551/node"},
		{name: "携带查询串", target: "http://127.0.0.1:19551?x=1"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if _, err := New(testCase.target); err == nil {
				t.Fatalf("New(%q) 未报错", testCase.target)
			}
		})
	}
}

func TestNewNormalizesTrailingSlash(t *testing.T) {
	handler, err := New("http://127.0.0.1:19551/")
	if err != nil {
		t.Fatalf("New 失败: %v", err)
	}
	if handler.Target() != "http://127.0.0.1:19551" {
		t.Fatalf("Target() = %q", handler.Target())
	}
}

func mustNewHandler(t *testing.T, target string) *Handler {
	t.Helper()
	handler, err := New(target)
	if err != nil {
		t.Fatalf("构造前置门失败: %v", err)
	}
	return handler
}

// TestNewSurvivesReplacedDefaultTransport 防止再次踩到「进程入口替换了
// http.DefaultTransport」的坑：构造前置门不得依赖它的具体类型，更不能 panic。
type stubRoundTripper struct{}

func (stubRoundTripper) RoundTrip(*http.Request) (*http.Response, error) {
	return nil, errors.New("stub transport")
}

func TestNewSurvivesReplacedDefaultTransport(t *testing.T) {
	original := http.DefaultTransport
	http.DefaultTransport = stubRoundTripper{}
	defer func() { http.DefaultTransport = original }()

	handler, err := New("http://127.0.0.1:19551")
	if err != nil {
		t.Fatalf("New 失败: %v", err)
	}
	if handler == nil {
		t.Fatal("New 返回空处理器")
	}
}

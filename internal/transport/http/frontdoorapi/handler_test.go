package frontdoorapi

import (
	"bufio"
	"encoding/json"
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

// TestHandlerSetsForwardedFor 保证 Node 侧仍能拿到真实客户端地址。
func TestHandlerSetsForwardedFor(t *testing.T) {
	chain := make(chan string, 1)
	backend := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		chain <- request.Header.Get("X-Forwarded-For")
		response.WriteHeader(http.StatusNoContent)
	}))
	defer backend.Close()

	front := httptest.NewServer(mustNewHandler(t, backend.URL))
	defer front.Close()

	response, err := front.Client().Get(front.URL + "/v0/webui/health")
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	response.Body.Close()
	select {
	case forwarded := <-chain:
		if strings.TrimSpace(forwarded) == "" {
			t.Fatal("X-Forwarded-For 为空")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("上游未收到请求")
	}
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

package relaymux

import (
	"bytes"
	"errors"
	"io"
	"net"
	"net/http"
	"testing"
	"time"
)

func startMux(t *testing.T, handler ConnHandler, configure func(*Config)) (*Mux, string) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("监听 127.0.0.1 失败: %v", err)
	}
	config := Config{
		Listener:    listener,
		Handler:     handler,
		PeekTimeout: 2 * time.Second,
	}
	if configure != nil {
		configure(&config)
	}
	mux, err := New(config)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	go func() {
		_ = mux.Dispatch()
	}()
	t.Cleanup(func() { _ = mux.Close() })
	return mux, listener.Addr().String()
}

func dialMux(t *testing.T, address string) net.Conn {
	t.Helper()
	conn, err := net.Dial("tcp", address)
	if err != nil {
		t.Fatalf("连接分流器失败: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	if err := conn.SetDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatalf("设置超时失败: %v", err)
	}
	return conn
}

func acceptWithTimeout(t *testing.T, mux *Mux) net.Conn {
	t.Helper()
	type result struct {
		conn net.Conn
		err  error
	}
	results := make(chan result, 1)
	go func() {
		conn, err := mux.Accept()
		results <- result{conn: conn, err: err}
	}()
	select {
	case value := <-results:
		if value.err != nil {
			t.Fatalf("Accept() error = %v", value.err)
		}
		t.Cleanup(func() { _ = value.conn.Close() })
		return value.conn
	case <-time.After(2 * time.Second):
		t.Fatal("等待非 SOCKS5 连接超时")
		return nil
	}
}

func TestNewValidatesConfig(t *testing.T) {
	if _, err := New(Config{}); !errors.Is(err, ErrMissingListener) {
		t.Fatalf("New() error = %v, want ErrMissingListener", err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("监听失败: %v", err)
	}
	defer listener.Close()
	if _, err := New(Config{Listener: listener}); !errors.Is(err, ErrMissingHandler) {
		t.Fatalf("New() error = %v, want ErrMissingHandler", err)
	}
}

func TestMuxRoutesSOCKS5AndReplaysPeekedByte(t *testing.T) {
	greetings := make(chan []byte, 1)
	handler := func(conn net.Conn) error {
		defer conn.Close()
		greeting := make([]byte, 3)
		if _, err := io.ReadFull(conn, greeting); err != nil {
			greetings <- nil
			return err
		}
		greetings <- greeting
		return nil
	}
	_, address := startMux(t, handler, nil)
	conn := dialMux(t, address)
	if _, err := conn.Write([]byte{0x05, 0x01, 0x02}); err != nil {
		t.Fatalf("写入问候失败: %v", err)
	}
	select {
	case greeting := <-greetings:
		if !bytes.Equal(greeting, []byte{0x05, 0x01, 0x02}) {
			t.Fatalf("handler 收到 %v, want [5 1 2]（首字节必须回填）", greeting)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("等待 SOCKS5 handler 超时")
	}
}

func TestMuxReplaysPeekedByteForFallbackListener(t *testing.T) {
	socksCalls := make(chan struct{}, 1)
	handler := func(conn net.Conn) error {
		_ = conn.Close()
		select {
		case socksCalls <- struct{}{}:
		default:
		}
		return nil
	}
	mux, address := startMux(t, handler, nil)
	conn := dialMux(t, address)
	payload := []byte("GET / HTTP/1.1\r\nHost: relaymux\r\n\r\n")
	if _, err := conn.Write(payload); err != nil {
		t.Fatalf("写入明文请求失败: %v", err)
	}

	serverConn := acceptWithTimeout(t, mux)
	received := make([]byte, len(payload))
	if _, err := io.ReadFull(serverConn, received); err != nil {
		t.Fatalf("上层读取失败: %v", err)
	}
	if !bytes.Equal(received, payload) {
		t.Fatalf("上层收到 %q, want %q（peek 的字节不能丢）", received, payload)
	}
	select {
	case <-socksCalls:
		t.Fatal("明文连接不应交给 SOCKS5 handler")
	default:
	}
}

func TestMuxSharesPortBetweenHTTPAndSOCKS5(t *testing.T) {
	greetings := make(chan []byte, 1)
	handler := func(conn net.Conn) error {
		defer conn.Close()
		greeting := make([]byte, 3)
		if _, err := io.ReadFull(conn, greeting); err != nil {
			return err
		}
		greetings <- greeting
		_, err := conn.Write([]byte{0x05, 0xff})
		return err
	}
	mux, address := startMux(t, handler, nil)
	server := &http.Server{Handler: http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(writer, "ok")
	})}
	go func() {
		_ = server.Serve(mux)
	}()
	t.Cleanup(func() { _ = server.Close() })

	client := &http.Client{Timeout: 3 * time.Second}
	response, err := client.Get("http://" + address + "/health")
	if err != nil {
		t.Fatalf("同端口 HTTP 请求失败: %v", err)
	}
	body, err := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if err != nil {
		t.Fatalf("读取 HTTP 响应失败: %v", err)
	}
	if string(body) != "ok" {
		t.Fatalf("HTTP 响应 = %q, want ok", body)
	}

	socksConn := dialMux(t, address)
	if _, err := socksConn.Write([]byte{0x05, 0x01, 0x00}); err != nil {
		t.Fatalf("写入 SOCKS5 问候失败: %v", err)
	}
	reply := make([]byte, 2)
	if _, err := io.ReadFull(socksConn, reply); err != nil {
		t.Fatalf("读取 SOCKS5 回复失败: %v", err)
	}
	if !bytes.Equal(reply, []byte{0x05, 0xff}) {
		t.Fatalf("SOCKS5 回复 = %v, want [5 255]", reply)
	}
	select {
	case greeting := <-greetings:
		if !bytes.Equal(greeting, []byte{0x05, 0x01, 0x00}) {
			t.Fatalf("handler 收到 %v, want [5 1 0]", greeting)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("等待 SOCKS5 handler 超时")
	}
}

func TestMuxClosesIdleConnectionAfterPeekTimeout(t *testing.T) {
	handlerCalls := make(chan struct{}, 1)
	handler := func(conn net.Conn) error {
		_ = conn.Close()
		select {
		case handlerCalls <- struct{}{}:
		default:
		}
		return nil
	}
	_, address := startMux(t, handler, func(config *Config) {
		config.PeekTimeout = 100 * time.Millisecond
	})
	conn := dialMux(t, address)
	var buffer [1]byte
	if _, err := conn.Read(buffer[:]); err == nil {
		t.Fatal("首字节超时后连接应被关闭")
	}
	select {
	case <-handlerCalls:
		t.Fatal("没有首字节的连接不应进入 SOCKS5 handler")
	default:
	}
}

func TestMuxDispatchStopsOnClose(t *testing.T) {
	mux, _ := startMux(t, func(conn net.Conn) error {
		_ = conn.Close()
		return nil
	}, nil)
	finished := make(chan error, 1)
	go func() {
		finished <- mux.Dispatch()
	}()
	if err := mux.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	select {
	case err := <-finished:
		if !errors.Is(err, net.ErrClosed) {
			t.Fatalf("Dispatch() error = %v, want net.ErrClosed", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Close() 后 Dispatch 未退出")
	}
}

func TestReplayConnReturnsPeekedByteFirst(t *testing.T) {
	server, client := net.Pipe()
	defer server.Close()
	wrapped := &replayConn{Conn: server, pending: []byte{0x05}}
	go func() {
		_, _ = client.Write([]byte("abc"))
		_ = client.Close()
	}()
	data, err := io.ReadAll(wrapped)
	if err != nil {
		t.Fatalf("读取失败: %v", err)
	}
	if !bytes.Equal(data, []byte{0x05, 'a', 'b', 'c'}) {
		t.Fatalf("读取结果 = %v, want [5 97 98 99]", data)
	}
}

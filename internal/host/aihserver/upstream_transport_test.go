package aihserver

import (
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
)

func TestUpstreamTransportKeepsDefaultTransportBehavior(t *testing.T) {
	transport := newUpstreamTransport()
	if transport.MaxIdleConnsPerHost != upstreamMaxIdleConnsPerHost || transport.MaxIdleConns != upstreamMaxIdleConns {
		t.Fatalf("连接池上限 = %d/%d", transport.MaxIdleConnsPerHost, transport.MaxIdleConns)
	}
	if transport.Proxy == nil || !transport.ForceAttemptHTTP2 {
		t.Fatal("必须沿用 DefaultTransport 的代理与 HTTP/2 设置")
	}
	if transport == http.DefaultTransport {
		t.Fatal("不能修改共享的 DefaultTransport")
	}
}

// 并发 16 的请求连续跑几轮，连接应当被复用；DefaultTransport 只保留 2 个空闲连接，每轮都会新建约 14 个。
func TestUpstreamTransportReusesConnectionsUnderConcurrency(t *testing.T) {
	const concurrency, rounds = 16, 4
	var newConnections atomic.Int64
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(writer, "ok")
	}))
	server.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateNew {
			newConnections.Add(1)
		}
	}
	server.Start()
	defer server.Close()

	transport := newUpstreamTransport()
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport}
	for round := 0; round < rounds; round++ {
		var group sync.WaitGroup
		for index := 0; index < concurrency; index++ {
			group.Add(1)
			go func() {
				defer group.Done()
				response, err := client.Get(server.URL)
				if err != nil {
					t.Error(err)
					return
				}
				_, _ = io.Copy(io.Discard, response.Body)
				_ = response.Body.Close()
			}()
		}
		group.Wait()
	}
	if got := newConnections.Load(); got > concurrency {
		t.Fatalf("%d 轮并发 %d 新建了 %d 个连接，空闲连接没有被复用", rounds, concurrency, got)
	}
}

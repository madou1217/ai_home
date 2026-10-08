package aihserver_test

import (
	"context"
	"net"
	"net/http"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/host/aihserver"
	"github.com/madou1217/ai_home/internal/testsupport/accountmodels"
	"github.com/madou1217/ai_home/internal/transport/http/shutdownapi"
)

// startTestServerWithShutdown 装配一个带优雅退出回调的真实 Listener。
func startTestServerWithShutdown(t *testing.T) (string, *http.Client, chan struct{}) {
	t.Helper()

	requested := make(chan struct{}, 1)
	server, err := aihserver.New(context.Background(), aihserver.Options{
		AIHomeDir:        t.TempDir(),
		ManagementKey:    func() string { return testManagementKey },
		ClientKey:        func() string { return testClientKey },
		ModelDiscoverers: accountmodels.NewDiscoverers(),
		UsageHTTPClient:  syntheticUsageHTTPClient{},
		RequestShutdown:  func() { requested <- struct{}{} },
	})
	if err != nil {
		t.Fatalf("aihserver.New() error = %v", err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		_ = server.Close()
		t.Fatalf("net.Listen() error = %v", err)
	}
	serveErrors := make(chan error, 1)
	go func() {
		serveErrors <- server.Serve(listener)
	}()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := server.Shutdown(ctx); err != nil {
			t.Errorf("Server.Shutdown() error = %v", err)
		}
		if err := <-serveErrors; err != nil {
			t.Errorf("Server.Serve() error = %v", err)
		}
		if err := server.Close(); err != nil {
			t.Errorf("Server.Close() error = %v", err)
		}
	})
	return "http://" + listener.Addr().String(), &http.Client{Timeout: 3 * time.Second}, requested
}

// TestShutdownEndpointRequestsGracefulExit 锁定 P1 的 Windows 关闭路径：宿主必须先拿到
// 202 再看到退出，否则它会把一次正常的优雅退出读成端点不可用而退回强杀。
func TestShutdownEndpointRequestsGracefulExit(t *testing.T) {
	t.Parallel()

	baseURL, client, requested := startTestServerWithShutdown(t)

	unauthorized := performRequest(
		t,
		client,
		http.MethodPost,
		baseURL+shutdownapi.Path,
		testClientKey,
		nil,
	)
	assertStatus(t, unauthorized, http.StatusUnauthorized)
	select {
	case <-requested:
		t.Fatal("客户端密钥触发了优雅退出")
	case <-time.After(100 * time.Millisecond):
	}

	accepted := performRequest(
		t,
		client,
		http.MethodPost,
		baseURL+shutdownapi.Path,
		testManagementKey,
		nil,
	)
	assertStatus(t, accepted, http.StatusAccepted)
	select {
	case <-requested:
	case <-time.After(time.Second):
		t.Fatal("管理端点没有触发优雅退出")
	}
}

// TestShutdownEndpointIsAbsentWithoutAReceiver 验证没有退出回调时不挂载该端点：
// 一个没有接收方的关闭端点只会把「关不掉」伪装成「已受理」。
func TestShutdownEndpointIsAbsentWithoutAReceiver(t *testing.T) {
	t.Parallel()

	baseURL, client := startTestServer(t)
	missing := performRequest(
		t,
		client,
		http.MethodPost,
		baseURL+shutdownapi.Path,
		testManagementKey,
		nil,
	)
	assertStatus(t, missing, http.StatusNotFound)
}

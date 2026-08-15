package aihserver_test

import (
	"context"
	"net"
	"net/http"
	"sync"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/internal/host/aihserver"
	"github.com/madou1217/ai_home/internal/testsupport/accountmodels"
	"github.com/madou1217/ai_home/internal/transport/http/accountsapi"
)

// TestServerRecoversInterruptedInitialModelRefreshAfterRestart 验证内存刷新队列
// 随进程退出丢失后，新 Server 会从 aih.db 异步重建任务；构造和监听均不等待上游。
func TestServerRecoversInterruptedInitialModelRefreshAfterRestart(t *testing.T) {
	aiHomeDir := t.TempDir()
	firstDiscoverer := newRestartRecoveryModelDiscoverer()
	firstServer := newRestartRecoveryTestServer(t, aiHomeDir, firstDiscoverer)
	firstRuntime := startRestartRecoveryTestServer(t, firstServer)
	payload := []byte(`{"provider_id":"codex","auth":{"kind":"api_key",` +
		`"api_key":"synthetic-restart-recovery-key"}}`)
	created := performRequest(
		t,
		firstRuntime.client,
		http.MethodPost,
		firstRuntime.baseURL+accountsapi.CollectionPath,
		testManagementKey,
		payload,
	)
	assertStatus(t, created, http.StatusCreated)
	var createdDocument struct {
		Data struct {
			AccountRef string `json:"account_ref"`
		} `json:"data"`
	}
	decodeJSON(t, created.body, &createdDocument)
	select {
	case <-firstDiscoverer.started:
	case <-time.After(time.Second):
		t.Fatal("首次 Server 未启动注册后的模型刷新")
	}
	firstRuntime.stop(t)

	secondDiscoverer := newRestartRecoveryModelDiscoverer()
	type serverResult struct {
		server *aihserver.Server
		err    error
	}
	newResult := make(chan serverResult, 1)
	go func() {
		server, err := aihserver.New(
			context.Background(),
			restartRecoveryServerOptions(aiHomeDir, secondDiscoverer),
		)
		newResult <- serverResult{server: server, err: err}
	}()

	var secondServer *aihserver.Server
	select {
	case result := <-newResult:
		if result.err != nil {
			t.Fatalf("aihserver.New(restart) error = %v", result.err)
		}
		secondServer = result.server
	case <-time.After(time.Second):
		t.Fatal("Server 构造被恢复模型发现阻塞")
	}
	secondRuntime := startRestartRecoveryTestServer(t, secondServer)
	select {
	case <-secondDiscoverer.started:
	case <-time.After(time.Second):
		secondRuntime.stop(t)
		t.Fatal("重启后没有自动重建首次模型刷新任务")
	}

	health := performRequest(
		t,
		secondRuntime.client,
		http.MethodGet,
		secondRuntime.baseURL+"/healthz",
		"",
		nil,
	)
	assertStatus(t, health, http.StatusOK)
	modelsBeforeRelease := performRequest(
		t,
		secondRuntime.client,
		http.MethodGet,
		secondRuntime.baseURL+accountsapi.CollectionPath+"/"+
			createdDocument.Data.AccountRef+"/models",
		testManagementKey,
		nil,
	)
	assertStatus(t, modelsBeforeRelease, http.StatusOK)
	if modelsBeforeRelease.body != `{"data":[]}` {
		secondRuntime.stop(t)
		t.Fatalf("恢复上游完成前模型快照 = %s", modelsBeforeRelease.body)
	}

	close(secondDiscoverer.release)
	waitForAccountModels(
		t,
		secondRuntime.client,
		secondRuntime.baseURL,
		createdDocument.Data.AccountRef,
		[]string{"gpt-recovered-after-restart"},
	)
	secondRuntime.stop(t)
}

// restartRecoveryModelDiscoverer 让测试分别控制进程退出前和重启后的上游完成点。
type restartRecoveryModelDiscoverer struct {
	started     chan struct{}
	release     chan struct{}
	startedOnce sync.Once
}

func newRestartRecoveryModelDiscoverer() *restartRecoveryModelDiscoverer {
	return &restartRecoveryModelDiscoverer{
		started: make(chan struct{}),
		release: make(chan struct{}),
	}
}

func (*restartRecoveryModelDiscoverer) ProviderID() string {
	return "codex"
}

func (discoverer *restartRecoveryModelDiscoverer) DiscoverModels(
	ctx context.Context,
	_ accountapp.Credential,
) ([]string, error) {
	discoverer.startedOnce.Do(func() {
		close(discoverer.started)
	})
	select {
	case <-discoverer.release:
		return []string{"gpt-recovered-after-restart"}, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func newRestartRecoveryTestServer(
	t *testing.T,
	aiHomeDir string,
	discoverer accountapp.ProviderModelDiscoverer,
) *aihserver.Server {
	t.Helper()
	server, err := aihserver.New(
		context.Background(),
		restartRecoveryServerOptions(aiHomeDir, discoverer),
	)
	if err != nil {
		t.Fatalf("aihserver.New() error = %v", err)
	}
	return server
}

func restartRecoveryServerOptions(
	aiHomeDir string,
	discoverer accountapp.ProviderModelDiscoverer,
) aihserver.Options {
	discoverers := accountmodels.NewDiscoverers()
	discoverers[0] = discoverer
	return aihserver.Options{
		AIHomeDir:        aiHomeDir,
		ManagementKey:    func() string { return testManagementKey },
		ClientKey:        func() string { return testClientKey },
		ModelDiscoverers: discoverers,
		UsageHTTPClient:  syntheticUsageHTTPClient{},
	}
}

type restartRecoveryTestRuntime struct {
	server      *aihserver.Server
	listener    net.Listener
	serveErrors chan error
	baseURL     string
	client      *http.Client
	stopOnce    sync.Once
}

func startRestartRecoveryTestServer(
	t *testing.T,
	server *aihserver.Server,
) *restartRecoveryTestRuntime {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		_ = server.Close()
		t.Fatalf("net.Listen() error = %v", err)
	}
	runtime := &restartRecoveryTestRuntime{
		server:      server,
		listener:    listener,
		serveErrors: make(chan error, 1),
		baseURL:     "http://" + listener.Addr().String(),
		client:      &http.Client{Timeout: time.Second},
	}
	go func() {
		runtime.serveErrors <- server.Serve(listener)
	}()
	t.Cleanup(func() {
		runtime.stop(t)
	})
	return runtime
}

func (runtime *restartRecoveryTestRuntime) stop(t *testing.T) {
	t.Helper()
	runtime.stopOnce.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := runtime.server.Shutdown(ctx); err != nil {
			t.Errorf("Server.Shutdown() error = %v", err)
		}
		if err := <-runtime.serveErrors; err != nil {
			t.Errorf("Server.Serve() error = %v", err)
		}
		if err := runtime.server.Close(); err != nil {
			t.Errorf("Server.Close() error = %v", err)
		}
	})
}

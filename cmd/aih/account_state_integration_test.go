package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/internal/host/aihaccount"
	"github.com/madou1217/ai_home/internal/host/aihserver"
	"github.com/madou1217/ai_home/internal/transport/http/accountsapi"
)

const (
	integrationManagementKey = "synthetic-cli-integration-management-key-2026"
	integrationClientKey     = "synthetic-cli-integration-client-key-2026"
	integrationModel         = "gpt-5.6-sol"
)

// TestAccountStateCommandUpdatesRunningServerRoutes 验证真实 TCP、真实临时
// SQLite 和运行中倒排形成闭环：按别名停用后模型消失，按 AccountRef 启用后恢复。
func TestAccountStateCommandUpdatesRunningServerRoutes(t *testing.T) {
	server, baseURL, client, serveErrors := startAccountStateServer(t)
	defer func() {
		if err := server.Close(); err != nil {
			t.Errorf("Server.Close() error = %v", err)
		}
		select {
		case err := <-serveErrors:
			if err != nil {
				t.Errorf("Server.Serve() error = %v", err)
			}
		case <-time.After(time.Second):
			t.Error("等待 Server.Serve() 退出超时")
		}
	}()
	accountRef := createIntegrationAccount(t, client, baseURL)
	waitForIntegrationModel(t, client, baseURL, true)

	runtime := testCommandRuntime(t, map[string]string{
		"AIH_SERVER_BASE_URL":       baseURL,
		"AIH_SERVER_MANAGEMENT_KEY": integrationManagementKey,
	})
	runtime.managementAPI = client
	runtime.stdout = io.Discard
	runtime.newAccountApp = func(
		context.Context,
		aihaccount.Options,
	) (accountApplication, error) {
		t.Fatal("运行期启停不得打开第二个 SQLite Store")
		return nil, nil
	}
	if err := run(
		context.Background(),
		[]string{"account", "disable", "codex:1"},
		runtime,
	); err != nil {
		t.Fatalf("disable command error = %v", err)
	}
	waitForIntegrationModel(t, client, baseURL, false)
	if err := run(
		context.Background(),
		[]string{"account", "enable", accountRef},
		runtime,
	); err != nil {
		t.Fatalf("enable command error = %v", err)
	}
	waitForIntegrationModel(t, client, baseURL, true)
}

// integrationModelDiscoverer 为注册阶段提供不会访问上游的确定性模型目录。
type integrationModelDiscoverer struct{}

// ProviderID 返回该测试策略唯一支持的 Codex。
func (integrationModelDiscoverer) ProviderID() string {
	return "codex"
}

// DiscoverModels 返回一个真实格式模型 ID，不读取合成凭据正文。
func (integrationModelDiscoverer) DiscoverModels(
	context.Context,
	accountapp.Credential,
) ([]string, error) {
	return []string{integrationModel}, nil
}

// startAccountStateServer 启动真实 TCP Go Server 和私有临时 aih.db。
func startAccountStateServer(
	t *testing.T,
) (*aihserver.Server, string, *http.Client, <-chan error) {
	t.Helper()
	server, err := aihserver.New(context.Background(), aihserver.Options{
		AIHomeDir:     t.TempDir(),
		ManagementKey: func() string { return integrationManagementKey },
		ClientKey:     func() string { return integrationClientKey },
		ModelDiscoverers: []accountapp.ProviderModelDiscoverer{
			integrationModelDiscoverer{},
		},
		ErrorLog: nil,
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
	return server, "http://" + listener.Addr().String(), &http.Client{
		Timeout: 5 * time.Second,
	}, serveErrors
}

// createIntegrationAccount 通过正式管理 API 注册一个合成 Codex API Key 账号。
func createIntegrationAccount(
	t *testing.T,
	client *http.Client,
	baseURL string,
) string {
	t.Helper()
	payload := []byte(`{"provider_id":"codex","auth":{"kind":"api_key","api_key":"synthetic-cli-integration-api-key","base_url":"https://api.openai.com/v1"}}`)
	request, err := http.NewRequest(
		http.MethodPost,
		baseURL+accountsapi.CollectionPath,
		bytes.NewReader(payload),
	)
	if err != nil {
		t.Fatalf("http.NewRequest() error = %v", err)
	}
	request.Header.Set("Authorization", "Bearer "+integrationManagementKey)
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		t.Fatalf("create account request error = %v", err)
	}
	defer func() { _ = response.Body.Close() }()
	var document struct {
		Data struct {
			AccountRef string `json:"account_ref"`
		} `json:"data"`
	}
	if response.StatusCode != http.StatusCreated ||
		json.NewDecoder(response.Body).Decode(&document) != nil ||
		document.Data.AccountRef == "" {
		t.Fatalf("create account status=%d document=%+v", response.StatusCode, document)
	}
	return document.Data.AccountRef
}

// waitForIntegrationModel 等待异步目录发布与账号启停结果一致。
func waitForIntegrationModel(
	t *testing.T,
	client *http.Client,
	baseURL string,
	visible bool,
) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		request, err := http.NewRequest(
			http.MethodGet,
			baseURL+"/v1/models",
			nil,
		)
		if err != nil {
			t.Fatalf("http.NewRequest(models) error = %v", err)
		}
		request.Header.Set("Authorization", "Bearer "+integrationClientKey)
		response, err := client.Do(request)
		if err == nil {
			body, readErr := io.ReadAll(response.Body)
			_ = response.Body.Close()
			found := strings.Contains(string(body), `"id":"`+integrationModel+`"`)
			if readErr == nil && response.StatusCode == http.StatusOK && found == visible {
				return
			}
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("等待模型可见性超时: model=%s visible=%t", integrationModel, visible)
}

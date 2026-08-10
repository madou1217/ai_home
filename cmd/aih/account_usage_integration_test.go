package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/internal/host/aihserver"
	"github.com/madou1217/ai_home/internal/transport/http/accountsapi"
)

const integrationCodexAccessToken = "synthetic-cli-usage-codex-access-token"

// TestAccountUsageCommandPersistsSnapshotAcrossServerRestart 验证真实 TCP、
// 正式原生导入、额度上游 Adapter、aih.db 和 CLI 的完整闭环。重启后的 show
// 必须读取已提交快照，不能依赖命令进程内状态。
func TestAccountUsageCommandPersistsSnapshotAcrossServerRestart(t *testing.T) {
	home := t.TempDir()
	upstream := &codexUsageIntegrationUpstream{t: t}
	server, baseURL, client, serveErrors := startAccountUsageServer(
		t,
		home,
		upstream,
	)
	accountRef := importIntegrationCodexOAuthAccount(t, client, baseURL)
	waitForUsageCalls(t, upstream, 1)

	refreshOutput := &bytes.Buffer{}
	refreshRuntime := testCommandRuntime(t, map[string]string{
		"AIH_SERVER_BASE_URL":       baseURL,
		"AIH_SERVER_MANAGEMENT_KEY": integrationManagementKey,
	})
	refreshRuntime.managementAPI = client
	refreshRuntime.stdout = refreshOutput
	if err := run(
		context.Background(),
		[]string{"account", "usage", "refresh", accountRef},
		refreshRuntime,
	); err != nil {
		t.Fatalf("usage refresh command error = %v", err)
	}
	// 注册生命周期和显式刷新允许合并同账号的在途请求，因此这里只要求
	// 正式 Strategy 至少访问一次上游，命令必须等待同一结果并展示快照。
	if upstream.CallCount() < 1 ||
		!strings.Contains(refreshOutput.String(), "72.34%") {
		t.Fatalf(
			"refresh calls=%d output=%s",
			upstream.CallCount(),
			refreshOutput.String(),
		)
	}
	stopAccountUsageServer(t, server, serveErrors)

	restartedUpstream := &codexUsageIntegrationUpstream{t: t}
	restarted, restartedURL, restartedClient, restartedErrors :=
		startAccountUsageServer(t, home, restartedUpstream)
	defer stopAccountUsageServer(t, restarted, restartedErrors)
	showOutput := &bytes.Buffer{}
	showRuntime := testCommandRuntime(t, map[string]string{
		"AIH_SERVER_BASE_URL":       restartedURL,
		"AIH_SERVER_MANAGEMENT_KEY": integrationManagementKey,
	})
	showRuntime.managementAPI = restartedClient
	showRuntime.stdout = showOutput
	if err := run(
		context.Background(),
		[]string{"account", "usage", "show", accountRef},
		showRuntime,
	); err != nil {
		t.Fatalf("usage show after restart error = %v", err)
	}
	for _, expected := range []string{
		"provider=codex",
		"source=codex_wham_usage",
		"72.34%",
		"5h0m0s",
	} {
		if !strings.Contains(showOutput.String(), expected) {
			t.Fatalf("重启后额度输出缺少 %q: %s", expected, showOutput.String())
		}
	}
}

// startAccountUsageServer 在指定 AIH_HOME 上启动正式 Go Server 组合根。
func startAccountUsageServer(
	t *testing.T,
	home string,
	upstream aihserver.UsageHTTPClient,
) (*aihserver.Server, string, *http.Client, <-chan error) {
	t.Helper()
	server, err := aihserver.New(context.Background(), aihserver.Options{
		AIHomeDir:     home,
		ManagementKey: func() string { return integrationManagementKey },
		ClientKey:     func() string { return integrationClientKey },
		ModelDiscoverers: []accountapp.ProviderModelDiscoverer{
			integrationModelDiscoverer{},
		},
		UsageHTTPClient: upstream,
		ErrorLog:        nil,
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

// stopAccountUsageServer 关闭 HTTP、后台协调器和 SQLite，并等待 Serve 退出。
func stopAccountUsageServer(
	t *testing.T,
	server *aihserver.Server,
	serveErrors <-chan error,
) {
	t.Helper()
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
}

// importIntegrationCodexOAuthAccount 通过正式原生导入 API 写入合成 OAuth。
func importIntegrationCodexOAuthAccount(
	t *testing.T,
	client *http.Client,
	baseURL string,
) string {
	t.Helper()
	idToken := integrationJWT(t, map[string]any{
		"sub":   "cli-usage-integration-user",
		"email": "cli-usage-integration@example.invalid",
		"https://api.openai.com/auth": map[string]any{
			"chatgpt_account_id": "cli-usage-integration-workspace",
			"chatgpt_plan_type":  "team",
		},
	})
	payload, err := json.Marshal(map[string]any{
		"provider_id": "codex",
		"artifacts": map[string]any{
			"auth_json": map[string]any{
				"auth_mode":      "chatgpt",
				"OPENAI_API_KEY": nil,
				"tokens": map[string]any{
					"id_token":      idToken,
					"access_token":  integrationCodexAccessToken,
					"refresh_token": "synthetic-cli-usage-codex-refresh-token",
					"account_id":    "cli-usage-integration-workspace",
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("json.Marshal(import payload) error = %v", err)
	}
	request, err := http.NewRequest(
		http.MethodPost,
		baseURL+accountsapi.NativeImportPath,
		bytes.NewReader(payload),
	)
	if err != nil {
		t.Fatalf("http.NewRequest(import) error = %v", err)
	}
	request.Header.Set("Authorization", "Bearer "+integrationManagementKey)
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		t.Fatalf("native import request error = %v", err)
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
		t.Fatalf("native import status=%d document=%+v", response.StatusCode, document)
	}
	return document.Data.AccountRef
}

// integrationJWT 创建本地可信 artifact 测试使用的无签名 JWT。
func integrationJWT(t *testing.T, claims map[string]any) string {
	t.Helper()
	header, err := json.Marshal(map[string]string{"alg": "none", "typ": "JWT"})
	if err != nil {
		t.Fatalf("json.Marshal(jwt header) error = %v", err)
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatalf("json.Marshal(jwt claims) error = %v", err)
	}
	return base64.RawURLEncoding.EncodeToString(header) + "." +
		base64.RawURLEncoding.EncodeToString(payload) + ".signature"
}

// codexUsageIntegrationUpstream 模拟官方额度端点，不模拟 AIH 管理 API。
type codexUsageIntegrationUpstream struct {
	t     *testing.T
	calls atomic.Int64
}

// Do 校验正式 Codex Strategy 的 URL 和认证头，并返回 wham 原始结构。
func (upstream *codexUsageIntegrationUpstream) Do(
	request *http.Request,
) (*http.Response, error) {
	upstream.t.Helper()
	if request.Method != http.MethodGet ||
		request.URL.String() != "https://chatgpt.com/backend-api/wham/usage" ||
		request.Header.Get("Authorization") != "Bearer "+integrationCodexAccessToken ||
		request.Header.Get("ChatGPT-Account-ID") != "cli-usage-integration-workspace" {
		upstream.t.Fatalf("Codex usage request invalid: %s %s", request.Method, request.URL)
	}
	upstream.calls.Add(1)
	document := `{"rate_limit":{"primary_window":{` +
		`"used_percent":27.66,"limit_window_seconds":18000,` +
		`"reset_after_seconds":3600},"limit_reached":false}}`
	return &http.Response{
		StatusCode: http.StatusOK,
		Header: http.Header{
			"Content-Type": []string{"application/json"},
		},
		Body: io.NopCloser(strings.NewReader(document)),
	}, nil
}

// CallCount 返回已接收的真实 Strategy 请求数。
func (upstream *codexUsageIntegrationUpstream) CallCount() int64 {
	return upstream.calls.Load()
}

// waitForUsageCalls 等待注册生命周期触发的初次额度刷新完成。
func waitForUsageCalls(
	t *testing.T,
	upstream *codexUsageIntegrationUpstream,
	want int64,
) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if upstream.CallCount() >= want {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("等待 Codex usage 请求超时: calls=%d want>=%d", upstream.CallCount(), want)
}

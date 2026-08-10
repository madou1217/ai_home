package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"testing"

	"github.com/madou1217/ai_home/internal/host/aihaccount"
	"github.com/madou1217/ai_home/internal/transport/http/accountsapi"
)

// TestAccountDefaultCommandsPersistSetAndClearAcrossRestarts 验证真实 TCP、
// 临时 SQLite 和生产 Composition Root 中，默认选择的设置和清除都可跨重启保持。
func TestAccountDefaultCommandsPersistSetAndClearAcrossRestarts(t *testing.T) {
	t.Parallel()

	aiHomeDir := t.TempDir()
	server, baseURL, client, serveErrors := startAccountIntegrationServer(t, aiHomeDir)
	accountRef := createIntegrationAccount(t, client, baseURL)
	waitForIntegrationModel(t, client, baseURL, true)
	assertProviderDefaultStatus(t, client, baseURL, http.StatusNotFound)
	assertProviderDefaultSelection(t, client, baseURL, http.StatusNotFound, "", "")

	runtime, output := accountDefaultIntegrationRuntime(t, client, baseURL)
	if err := run(
		context.Background(),
		[]string{"account", "default", "set", "codex", "codex:1"},
		runtime,
	); err != nil {
		t.Fatalf("default set command error = %v", err)
	}
	if err := run(
		context.Background(),
		[]string{"account", "default", "show", "codex"},
		runtime,
	); err != nil {
		t.Fatalf("default show command error = %v", err)
	}
	if !bytes.Contains(output.Bytes(), []byte(accountRef)) {
		t.Fatalf("default command output = %q", output.String())
	}
	assertProviderDefaultStatus(t, client, baseURL, http.StatusOK)
	assertProviderDefaultSelection(
		t,
		client,
		baseURL,
		http.StatusOK,
		accountRef,
		"provider_default",
	)
	waitForIntegrationModel(t, client, baseURL, true)
	stopAccountIntegrationServer(t, server, serveErrors)

	restarted, restartedURL, restartedClient, restartedErrors :=
		startAccountIntegrationServer(t, aiHomeDir)
	runtime, _ = accountDefaultIntegrationRuntime(t, restartedClient, restartedURL)
	if err := run(
		context.Background(),
		[]string{"account", "default", "show", "codex"},
		runtime,
	); err != nil {
		t.Fatalf("restarted default show command error = %v", err)
	}
	assertProviderDefaultSelection(
		t,
		restartedClient,
		restartedURL,
		http.StatusOK,
		accountRef,
		"provider_default",
	)
	if err := run(
		context.Background(),
		[]string{"account", "default", "clear", "codex"},
		runtime,
	); err != nil {
		t.Fatalf("default clear command error = %v", err)
	}
	assertProviderDefaultStatus(t, restartedClient, restartedURL, http.StatusNotFound)
	assertProviderDefaultSelection(
		t,
		restartedClient,
		restartedURL,
		http.StatusNotFound,
		"",
		"",
	)
	waitForIntegrationModel(t, restartedClient, restartedURL, true)
	stopAccountIntegrationServer(t, restarted, restartedErrors)

	cleared, clearedURL, clearedClient, clearedErrors :=
		startAccountIntegrationServer(t, aiHomeDir)
	defer stopAccountIntegrationServer(t, cleared, clearedErrors)
	assertProviderDefaultStatus(t, clearedClient, clearedURL, http.StatusNotFound)
	assertProviderDefaultSelection(
		t,
		clearedClient,
		clearedURL,
		http.StatusNotFound,
		"",
		"",
	)
	waitForIntegrationModel(t, clearedClient, clearedURL, true)
}

// accountDefaultIntegrationRuntime 创建只连接目标 Server 的默认账号命令运行时。
func accountDefaultIntegrationRuntime(
	t *testing.T,
	client *http.Client,
	baseURL string,
) (commandRuntime, *bytes.Buffer) {
	t.Helper()
	output := &bytes.Buffer{}
	runtime := testCommandRuntime(t, map[string]string{
		"AIH_SERVER_BASE_URL":       baseURL,
		"AIH_SERVER_MANAGEMENT_KEY": integrationManagementKey,
	})
	runtime.stdout = output
	runtime.managementAPI = client
	runtime.newAccountApp = func(
		context.Context,
		aihaccount.Options,
	) (accountApplication, error) {
		t.Fatal("运行期默认账号命令不得打开第二个 SQLite Store")
		return nil, nil
	}
	return runtime, output
}

// assertProviderDefaultStatus 核对默认关系资源的公开 HTTP 状态。
func assertProviderDefaultStatus(
	t *testing.T,
	client *http.Client,
	baseURL string,
	wantStatus int,
) {
	t.Helper()
	request, err := http.NewRequest(
		http.MethodGet,
		baseURL+accountsapi.DefaultsPath+"/codex",
		nil,
	)
	if err != nil {
		t.Fatalf("http.NewRequest(default) error = %v", err)
	}
	request.Header.Set("Authorization", "Bearer "+integrationManagementKey)
	response, err := client.Do(request)
	if err != nil {
		t.Fatalf("default request error = %v", err)
	}
	_, _ = io.Copy(io.Discard, response.Body)
	_ = response.Body.Close()
	if response.StatusCode != wantStatus {
		t.Fatalf("default status = %d, want %d", response.StatusCode, wantStatus)
	}
}

// assertProviderDefaultSelection 核对无显式账号时的默认选择结果。
func assertProviderDefaultSelection(
	t *testing.T,
	client *http.Client,
	baseURL string,
	wantStatus int,
	wantAccountRef string,
	wantSource string,
) {
	t.Helper()
	request, err := http.NewRequest(
		http.MethodPost,
		baseURL+accountsapi.SelectionPath,
		bytes.NewBufferString(`{"provider_id":"codex"}`),
	)
	if err != nil {
		t.Fatalf("http.NewRequest(selection) error = %v", err)
	}
	request.Header.Set("Authorization", "Bearer "+integrationManagementKey)
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		t.Fatalf("selection request error = %v", err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != wantStatus {
		t.Fatalf("selection status = %d, want %d", response.StatusCode, wantStatus)
	}
	if wantStatus != http.StatusOK {
		return
	}
	var document struct {
		Data struct {
			AccountRef string `json:"account_ref"`
			Source     string `json:"selection_source"`
		} `json:"data"`
	}
	if err := json.NewDecoder(response.Body).Decode(&document); err != nil {
		t.Fatalf("decode selection response error = %v", err)
	}
	if document.Data.AccountRef != wantAccountRef || document.Data.Source != wantSource {
		t.Fatalf("selection = %+v", document.Data)
	}
}

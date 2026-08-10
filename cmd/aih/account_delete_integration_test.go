package main

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/internal/host/aihaccount"
	"github.com/madou1217/ai_home/internal/transport/http/accountsapi"
)

// TestAccountDeleteCommandPersistsAcrossServerRestart 验证真实 TCP、临时 SQLite
// 和生产 Composition Root 的删除闭环，包括模型、默认关系、别名和启动选择。
func TestAccountDeleteCommandPersistsAcrossServerRestart(t *testing.T) {
	t.Parallel()

	aiHomeDir := t.TempDir()
	server, baseURL, client, serveErrors := startAccountIntegrationServer(t, aiHomeDir)
	accountRef := createIntegrationAccount(t, client, baseURL)
	setIntegrationDefault(t, client, baseURL, accountRef)
	waitForIntegrationModel(t, client, baseURL, true)
	assertAccountDeleteResources(t, client, baseURL, accountRef, http.StatusOK)

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
		t.Fatal("运行期删除不得打开第二个 SQLite Store")
		return nil, nil
	}
	if err := run(
		context.Background(),
		[]string{"account", "delete", "codex:1", "--yes"},
		runtime,
	); err != nil {
		t.Fatalf("delete command error = %v", err)
	}
	if !strings.Contains(output.String(), accountRef) ||
		!strings.Contains(output.String(), "Provider: codex") {
		t.Fatalf("delete output = %q", output.String())
	}
	waitForIntegrationModel(t, client, baseURL, false)
	assertAccountDeleteResources(t, client, baseURL, accountRef, http.StatusNotFound)
	stopAccountIntegrationServer(t, server, serveErrors)

	restarted, restartedURL, restartedClient, restartedErrors :=
		startAccountIntegrationServer(t, aiHomeDir)
	defer stopAccountIntegrationServer(t, restarted, restartedErrors)
	waitForIntegrationModel(t, restartedClient, restartedURL, false)
	assertAccountDeleteResources(
		t,
		restartedClient,
		restartedURL,
		accountRef,
		http.StatusNotFound,
	)
}

// setIntegrationDefault 创建会随账号外键级联删除的 Provider 默认关系。
func setIntegrationDefault(
	t *testing.T,
	client *http.Client,
	baseURL string,
	accountRef string,
) {
	t.Helper()
	body := bytes.NewBufferString(`{"account_ref":"` + accountRef + `"}`)
	request, err := http.NewRequest(
		http.MethodPut,
		baseURL+accountsapi.DefaultsPath+"/codex",
		body,
	)
	if err != nil {
		t.Fatalf("http.NewRequest(default) error = %v", err)
	}
	request.Header.Set("Authorization", "Bearer "+integrationManagementKey)
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		t.Fatalf("set default request error = %v", err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("set default status = %d", response.StatusCode)
	}
}

// assertAccountDeleteResources 核对账号成员、别名、模型、默认关系和启动选择。
func assertAccountDeleteResources(
	t *testing.T,
	client *http.Client,
	baseURL string,
	accountRef string,
	wantStatus int,
) {
	t.Helper()
	for _, probe := range []struct {
		method string
		path   string
		body   string
	}{
		{method: http.MethodGet, path: accountsapi.CollectionPath + "/" + accountRef},
		{method: http.MethodGet, path: accountsapi.AliasesPath + "/codex/1"},
		{method: http.MethodGet, path: accountsapi.CollectionPath + "/" + accountRef + "/models"},
		{method: http.MethodGet, path: accountsapi.DefaultsPath + "/codex"},
		{
			method: http.MethodPost,
			path:   accountsapi.SelectionPath,
			body:   `{"provider_id":"codex","cli_account_id":1}`,
		},
	} {
		request, err := http.NewRequest(
			probe.method,
			baseURL+probe.path,
			strings.NewReader(probe.body),
		)
		if err != nil {
			t.Fatalf("http.NewRequest(%s) error = %v", probe.path, err)
		}
		request.Header.Set("Authorization", "Bearer "+integrationManagementKey)
		if probe.body != "" {
			request.Header.Set("Content-Type", "application/json")
		}
		response, err := client.Do(request)
		if err != nil {
			t.Fatalf("probe %s error = %v", probe.path, err)
		}
		_, _ = io.Copy(io.Discard, response.Body)
		_ = response.Body.Close()
		if response.StatusCode != wantStatus {
			t.Fatalf(
				"probe %s status = %d, want %d",
				probe.path,
				response.StatusCode,
				wantStatus,
			)
		}
	}
}

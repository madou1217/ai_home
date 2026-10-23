package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/madou1217/ai_home/internal/host/aihaccount"
	"github.com/madou1217/ai_home/internal/transport/http/accountsapi"
)

func TestAccountTransferAndCredentialCommandsPersistAcrossServers(t *testing.T) {
	t.Parallel()

	// sub2api 迁移格式已于 2026-10-23 移除，因此本用例不再验证跨 Server 的
	// export→import 往返（原生导出端点见迁移蓝图 P2）；保留仍然成立的
	// 「凭据轮换 + 重启后持久化」验证，这也是它原本的核心意图。

	home := t.TempDir()
	server, baseURL, client, serverErrors := startAccountIntegrationServer(t, home)
	accountRef := createIntegrationAccount(t, client, baseURL)
	waitForIntegrationModel(t, client, baseURL, true)
	setIntegrationDefault(t, client, baseURL, accountRef)

	// 导出格式已移除：命令必须明确拒绝，而不是产出一份别的文档。
	exportPath := filepath.Join(t.TempDir(), "account-export.json")
	exportRuntime := accountTransferIntegrationRuntime(t, client, baseURL, nil)
	if err := run(context.Background(), []string{
		"account", "transfer", "export", "codex:1",
		"--format", "sub2api", "--output", exportPath,
	}, exportRuntime); err == nil {
		t.Fatal("sub2api 导出格式已移除，命令不应成功")
	}
	if _, err := os.Stat(exportPath); err == nil {
		t.Fatal("被拒绝的导出不应留下文件")
	}

	// 凭据轮换 + 重启后仍然持久。
	rotatedSecret := "synthetic-cli-integration-rotated-key"
	runtime := accountTransferIntegrationRuntime(t, client, baseURL, nil)
	runtime.lookupEnv = integrationCredentialEnvironment(baseURL, rotatedSecret)
	if err := run(context.Background(), []string{
		"account", "credential", "update", "codex:1", "--from-env",
	}, runtime); err != nil {
		t.Fatalf("credential update error = %v", err)
	}
	assertIntegrationAccount(t, client, baseURL, accountRef, "codex", 1, true)
	assertProviderDefaultStatus(t, client, baseURL, http.StatusOK)
	waitForIntegrationModel(t, client, baseURL, true)
	stopAccountIntegrationServer(t, server, serverErrors)

	restarted, restartedURL, restartedClient, restartedErrors :=
		startAccountIntegrationServer(t, home)
	defer stopAccountIntegrationServer(t, restarted, restartedErrors)
	assertIntegrationAccount(t, restartedClient, restartedURL, accountRef, "codex", 1, true)
	assertProviderDefaultStatus(t, restartedClient, restartedURL, http.StatusOK)
	waitForIntegrationModel(t, restartedClient, restartedURL, true)
}

// accountTransferIntegrationRuntime 创建只连接指定真实 Server 的命令运行时。
func accountTransferIntegrationRuntime(
	t *testing.T,
	client *http.Client,
	baseURL string,
	output io.Writer,
) commandRuntime {
	t.Helper()
	runtime := testCommandRuntime(t, map[string]string{
		"AIH_SERVER_BASE_URL":       baseURL,
		"AIH_SERVER_MANAGEMENT_KEY": integrationManagementKey,
	})
	if output != nil {
		runtime.stdout = output
	}
	runtime.managementAPI = client
	runtime.newAccountApp = func(
		context.Context,
		aihaccount.Options,
	) (accountApplication, error) {
		t.Fatal("迁移和凭据命令不得打开第二个 SQLite Store")
		return nil, nil
	}
	return runtime
}

// integrationCredentialEnvironment 返回轮换命令所需的完整隔离环境查询器。
func integrationCredentialEnvironment(
	baseURL string,
	apiKey string,
) func(string) (string, bool) {
	environment := map[string]string{
		"AIH_SERVER_BASE_URL":       baseURL,
		"AIH_SERVER_MANAGEMENT_KEY": integrationManagementKey,
		"OPENAI_API_KEY":            apiKey,
		"OPENAI_BASE_URL":           "https://api.openai.com/v1",
	}
	return func(name string) (string, bool) {
		value, found := environment[name]
		return value, found
	}
}

// assertIntegrationSecretFile 核对敏感文件权限、JSON 有效性和指定合成凭据。
func assertIntegrationSecretFile(t *testing.T, path string, expectedSecret string) {
	t.Helper()
	document, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile(%s) error = %v", path, err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat(%s) error = %v", path, err)
	}
	if info.Mode().Perm() != 0o600 || !json.Valid(document) ||
		!bytes.Contains(document, []byte(expectedSecret)) {
		t.Fatalf("secret file mode=%#o valid=%t", info.Mode().Perm(), json.Valid(document))
	}
}

// assertIntegrationAccount 核对真实 Server 中的稳定身份、别名和用户状态。
func assertIntegrationAccount(
	t *testing.T,
	client *http.Client,
	baseURL string,
	accountRef string,
	providerID string,
	cliAccountID int64,
	enabled bool,
) {
	t.Helper()
	request, err := http.NewRequest(
		http.MethodGet,
		baseURL+accountsapi.CollectionPath+"/"+accountRef,
		nil,
	)
	if err != nil {
		t.Fatalf("http.NewRequest(account) error = %v", err)
	}
	request.Header.Set("Authorization", "Bearer "+integrationManagementKey)
	response, err := client.Do(request)
	if err != nil {
		t.Fatalf("account request error = %v", err)
	}
	defer func() { _ = response.Body.Close() }()
	var document struct {
		Data struct {
			AccountRef   string `json:"account_ref"`
			ProviderID   string `json:"provider_id"`
			CLIAccountID int64  `json:"cli_account_id"`
			Enabled      bool   `json:"enabled"`
		} `json:"data"`
	}
	if response.StatusCode != http.StatusOK ||
		json.NewDecoder(response.Body).Decode(&document) != nil ||
		document.Data.AccountRef != accountRef ||
		document.Data.ProviderID != providerID ||
		document.Data.CLIAccountID != cliAccountID ||
		document.Data.Enabled != enabled {
		t.Fatalf("account status=%d data=%+v", response.StatusCode, document.Data)
	}
}

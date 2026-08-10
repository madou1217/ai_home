package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/internal/host/aihaccount"
	"github.com/madou1217/ai_home/internal/transport/http/accountsapi"
)

// TestAccountTransferAndCredentialCommandsPersistAcrossServers 验证真实 TCP、
// 两个临时 SQLite Server、迁移文件和重启形成闭环：导出、导入、默认关系、
// 静态凭据轮换及模型目录都保持一致。
func TestAccountTransferAndCredentialCommandsPersistAcrossServers(t *testing.T) {
	t.Parallel()

	exportPath := filepath.Join(t.TempDir(), "account-sub2api.json")
	source, sourceURL, sourceClient, sourceErrors :=
		startAccountIntegrationServer(t, t.TempDir())
	accountRef := createIntegrationAccount(t, sourceClient, sourceURL)
	waitForIntegrationModel(t, sourceClient, sourceURL, true)
	sourceRuntime := accountTransferIntegrationRuntime(t, sourceClient, sourceURL, nil)
	if err := run(context.Background(), []string{
		"account", "transfer", "export", "codex:1",
		"--format", "sub2api", "--output", exportPath,
	}, sourceRuntime); err != nil {
		t.Fatalf("source transfer export error = %v", err)
	}
	stopAccountIntegrationServer(t, source, sourceErrors)
	assertIntegrationSecretFile(t, exportPath, "synthetic-cli-integration-api-key")

	targetHome := t.TempDir()
	target, targetURL, targetClient, targetErrors :=
		startAccountIntegrationServer(t, targetHome)
	output := &bytes.Buffer{}
	targetRuntime := accountTransferIntegrationRuntime(t, targetClient, targetURL, output)
	if err := run(context.Background(), []string{
		"account", "transfer", "import",
		"--format", "sub2api", "--input", exportPath,
	}, targetRuntime); err != nil {
		t.Fatalf("target transfer import error = %v", err)
	}
	if !strings.Contains(output.String(), accountRef) {
		t.Fatalf("target import output = %q", output.String())
	}
	waitForIntegrationModel(t, targetClient, targetURL, true)
	assertIntegrationAccount(t, targetClient, targetURL, accountRef, "codex", 1, true)
	setIntegrationDefault(t, targetClient, targetURL, accountRef)

	rotatedSecret := "synthetic-cli-integration-rotated-key"
	targetRuntime.lookupEnv = integrationCredentialEnvironment(targetURL, rotatedSecret)
	if err := run(context.Background(), []string{
		"account", "credential", "update", "codex:1", "--from-env",
	}, targetRuntime); err != nil {
		t.Fatalf("target credential update error = %v", err)
	}
	assertIntegrationAccount(t, targetClient, targetURL, accountRef, "codex", 1, true)
	assertProviderDefaultStatus(t, targetClient, targetURL, http.StatusOK)
	waitForIntegrationModel(t, targetClient, targetURL, true)
	stopAccountIntegrationServer(t, target, targetErrors)

	restarted, restartedURL, restartedClient, restartedErrors :=
		startAccountIntegrationServer(t, targetHome)
	defer stopAccountIntegrationServer(t, restarted, restartedErrors)
	assertIntegrationAccount(t, restartedClient, restartedURL, accountRef, "codex", 1, true)
	assertProviderDefaultStatus(t, restartedClient, restartedURL, http.StatusOK)
	waitForIntegrationModel(t, restartedClient, restartedURL, true)

	rotatedExport := filepath.Join(t.TempDir(), "rotated-sub2api.json")
	restartedRuntime := accountTransferIntegrationRuntime(t, restartedClient, restartedURL, nil)
	if err := run(context.Background(), []string{
		"account", "transfer", "export", "codex:1",
		"--format", "sub2api", "--output", rotatedExport,
	}, restartedRuntime); err != nil {
		t.Fatalf("restarted transfer export error = %v", err)
	}
	assertIntegrationSecretFile(t, rotatedExport, rotatedSecret)
	rotatedDocument, err := os.ReadFile(rotatedExport)
	if err != nil {
		t.Fatalf("ReadFile(rotated export) error = %v", err)
	}
	if bytes.Contains(rotatedDocument, []byte("synthetic-cli-integration-api-key")) {
		t.Fatal("重启后导出仍包含轮换前凭据")
	}
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

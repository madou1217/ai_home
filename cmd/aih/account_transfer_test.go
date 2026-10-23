package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	accountcontract "github.com/madou1217/ai_home/internal/contracts/accountmanagement"
)

// TestAccountTransferExportsCLIProxyAPIAuthFile 验证 CPA 导出走独立成员资源，
// 并保持官方单 auth-file 结构而不是创建 AIH 私有 envelope。
func TestAccountTransferExportsCLIProxyAPIAuthFile(t *testing.T) {
	document := `{"type":"claude","access_token":"synthetic-cpa-secret"}`
	transport := &accountExportCommandHTTPClient{
		t:        t,
		suffix:   accountcontract.AccountCLIProxyAPIExportSuffix,
		fileName: "cliproxyapi-auth.json",
		document: document,
	}
	outputPath := filepath.Join(t.TempDir(), "claude-cpa.json")
	runtime := transferCommandRuntime(t, transport)

	if err := run(context.Background(), []string{
		"account", "transfer", "export", "acct_11111111111111111111",
		"--format", "cliproxyapi", "--output", outputPath,
	}, runtime); err != nil {
		t.Fatalf("run() error = %v", err)
	}
	content, err := os.ReadFile(outputPath)
	if err != nil || string(content) != document || transport.calls != 2 {
		t.Fatalf("content=%q calls=%d error=%v", content, transport.calls, err)
	}
}

// TestAccountTransferRejectsInvalidSyntaxBeforeIO 验证格式、路径和参数都必须显式。
func TestAccountTransferRejectsInvalidSyntaxBeforeIO(t *testing.T) {
	for _, arguments := range [][]string{
		{"account", "transfer", "export", "claude:9", "--format", "sub2api"},
		{"account", "transfer", "export", "claude:9", "--format", "aih", "--output", "x.json"},
		{"account", "transfer", "export", "claude:9", "--format", "sub2api", "--output", "-"},
		{"account", "transfer", "import", "--format", "cliproxyapi", "--input", "x.json"},
		{"account", "transfer", "import", "--format", "sub2api", "--input", "-"},
		{"account", "transfer", "remove"},
	} {
		runtime := transferCommandRuntime(t, &unexpectedAccountStateHTTPClient{t: t})
		if err := run(context.Background(), arguments, runtime); err == nil {
			t.Fatalf("run(%v) unexpectedly succeeded", arguments)
		}
	}
}

// accountExportCommandHTTPClient 返回公开账号快照和指定格式附件。
type accountExportCommandHTTPClient struct {
	t        *testing.T
	suffix   string
	fileName string
	document string
	calls    int
}

// Do 断言导出命令先核实账号，再下载同一 AccountRef 的附件。
func (client *accountExportCommandHTTPClient) Do(request *http.Request) (*http.Response, error) {
	client.t.Helper()
	body, err := io.ReadAll(request.Body)
	if err != nil {
		client.t.Fatalf("ReadAll(request body) error = %v", err)
	}
	if request.Header.Get("Authorization") != "Bearer "+commandTestManagementKey || len(body) != 0 {
		client.t.Fatalf("export request = %s %s %s", request.Method, request.URL, body)
	}
	client.calls++
	switch client.calls {
	case 1:
		expectedPath := accountcontract.AccountAliasesPath + "/claude/9"
		if strings.Contains(request.URL.Path, "acct_") {
			expectedPath = accountcontract.AccountsPath + "/acct_11111111111111111111"
		}
		if request.Method != http.MethodGet || request.URL.Path != expectedPath {
			client.t.Fatalf("account lookup = %s %s", request.Method, request.URL)
		}
		return commandAccountResponse(true), nil
	case 2:
		if request.Method != http.MethodGet || request.URL.Path !=
			accountcontract.AccountsPath+"/acct_11111111111111111111"+client.suffix {
			client.t.Fatalf("export request = %s %s", request.Method, request.URL)
		}
		return commandTransferResponse(http.StatusOK, client.document, client.fileName), nil
	default:
		client.t.Fatalf("unexpected request count %d", client.calls)
		return nil, nil
	}
}

// transferCommandRuntime 创建只允许访问合成 Management API 的命令运行时。
func transferCommandRuntime(t *testing.T, transport interface {
	Do(*http.Request) (*http.Response, error)
}) commandRuntime {
	t.Helper()
	runtime := testCommandRuntime(t, map[string]string{
		"AIH_SERVER_BASE_URL":       "http://127.0.0.1:19527",
		"AIH_SERVER_MANAGEMENT_KEY": commandTestManagementKey,
	})
	runtime.managementAPI = transport
	return runtime
}

// commandTransferResponse 创建严格 JSON 媒体类型和可选附件头。
func commandTransferResponse(status int, body string, fileName string) *http.Response {
	header := http.Header{"Content-Type": []string{"application/json; charset=utf-8"}}
	if fileName != "" {
		header.Set("Content-Disposition", `attachment; filename="`+fileName+`"`)
	}
	return &http.Response{
		StatusCode: status,
		Header:     header,
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}

// commandAccountDocument 构造指定 Provider 的公开账号 envelope。
func commandAccountDocument(providerID string, enabled bool) string {
	return fmt.Sprintf(
		`{"data":{"account_ref":"acct_11111111111111111111","provider_id":%q,"cli_account_id":9,"enabled":%t,"updated_at":"2026-08-10T08:00:00Z"}}`,
		providerID,
		enabled,
	)
}

// commandAccountImportDocument 构造导入 API 的完整公开账号响应。
func commandAccountImportDocument(providerID string, enabled bool) string {
	return fmt.Sprintf(
		`{"data":{"account_ref":"acct_11111111111111111111","provider_id":%q,"cli_account_id":9,"enabled":%t,"has_credential":true,"auth_kind":"oauth","auth_mode":"refreshable","has_profile":false,"created_at":"2026-08-10T08:00:00Z","updated_at":"2026-08-10T08:00:00Z"}}`,
		providerID,
		enabled,
	)
}

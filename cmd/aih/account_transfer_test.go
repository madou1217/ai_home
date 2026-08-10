package main

import (
	"bytes"
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

// TestAccountTransferExportsSub2APIToExclusiveSecretFile 验证单账号导出只写
// 显式文件、权限为 0600、不会覆盖已有文件，也不会把凭据回显到终端。
func TestAccountTransferExportsSub2APIToExclusiveSecretFile(t *testing.T) {
	output := &bytes.Buffer{}
	secret := "synthetic-transfer-secret"
	document := `{"type":"sub2api-data","exported_at":"2026-08-10T08:00:00Z","proxies":[],"accounts":[{"credentials":{"access_token":"` + secret + `"}}]}`
	transport := &accountExportCommandHTTPClient{
		t:        t,
		suffix:   accountcontract.AccountSub2APIExportSuffix,
		fileName: "sub2api-data.json",
		document: document,
	}
	outputPath := filepath.Join(t.TempDir(), "claude-sub2api.json")
	runtime := transferCommandRuntime(t, transport)
	runtime.stdout = output

	if err := run(context.Background(), []string{
		"account", "transfer", "export", "claude:9",
		"--format", "sub2api", "--output", outputPath,
	}, runtime); err != nil {
		t.Fatalf("run() error = %v", err)
	}
	content, err := os.ReadFile(outputPath)
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	info, err := os.Stat(outputPath)
	if err != nil {
		t.Fatalf("Stat() error = %v", err)
	}
	if string(content) != document || info.Mode().Perm() != 0o600 ||
		transport.calls != 2 {
		t.Fatalf("content=%s mode=%#o calls=%d", content, info.Mode().Perm(), transport.calls)
	}
	if strings.Contains(output.String(), secret) ||
		!strings.Contains(output.String(), outputPath) ||
		!strings.Contains(output.String(), "sub2api") {
		t.Fatalf("export output = %q", output.String())
	}

	existing := filepath.Join(t.TempDir(), "existing.json")
	if err := os.WriteFile(existing, []byte("keep-me"), 0o600); err != nil {
		t.Fatalf("WriteFile(existing) error = %v", err)
	}
	blockedRuntime := transferCommandRuntime(t, &unexpectedAccountStateHTTPClient{t: t})
	if err := run(context.Background(), []string{
		"account", "transfer", "export", "claude:9",
		"--format", "sub2api", "--output", existing,
	}, blockedRuntime); err == nil || !strings.Contains(err.Error(), "已存在") {
		t.Fatalf("run(existing) error = %v", err)
	}
	unchanged, err := os.ReadFile(existing)
	if err != nil || string(unchanged) != "keep-me" {
		t.Fatalf("existing file = %q error=%v", unchanged, err)
	}
}

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

// TestAccountTransferImportsOneBoundedSub2APIDocument 验证导入读取显式文件，
// 原样 POST 一个标准文档并只输出 Server 返回的公开身份。
func TestAccountTransferImportsOneBoundedSub2APIDocument(t *testing.T) {
	output := &bytes.Buffer{}
	inputPath := filepath.Join(t.TempDir(), "sub2api-data.json")
	document := `{"type":"sub2api-data","exported_at":"2026-08-10T08:00:00Z","proxies":[],"accounts":[{"name":"claude","platform":"anthropic","type":"oauth","credentials":{"access_token":"synthetic-import-secret"},"concurrency":0,"priority":0}]}`
	if err := os.WriteFile(inputPath, []byte(document), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	transport := &accountImportCommandHTTPClient{t: t, expected: document}
	runtime := transferCommandRuntime(t, transport)
	runtime.stdout = output

	if err := run(context.Background(), []string{
		"account", "transfer", "import",
		"--format", "sub2api", "--input", inputPath,
	}, runtime); err != nil {
		t.Fatalf("run() error = %v", err)
	}
	if transport.calls != 1 || strings.Contains(output.String(), "synthetic-import-secret") {
		t.Fatalf("calls=%d output=%q", transport.calls, output.String())
	}
	for _, expected := range []string{
		"账号已导入", "Provider: claude", "账号别名: 9",
		"AccountRef: acct_11111111111111111111",
	} {
		if !strings.Contains(output.String(), expected) {
			t.Fatalf("import output missing %q: %s", expected, output.String())
		}
	}

	oversized := filepath.Join(t.TempDir(), "oversized.json")
	if err := os.WriteFile(oversized, bytes.Repeat([]byte{'x'}, 1024*1024+1), 0o600); err != nil {
		t.Fatalf("WriteFile(oversized) error = %v", err)
	}
	blockedRuntime := transferCommandRuntime(t, &unexpectedAccountStateHTTPClient{t: t})
	if err := run(context.Background(), []string{
		"account", "transfer", "import",
		"--format", "sub2api", "--input", oversized,
	}, blockedRuntime); err == nil || !strings.Contains(err.Error(), "过大") {
		t.Fatalf("run(oversized) error = %v", err)
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

// accountImportCommandHTTPClient 断言 sub2api 文档不经私有包装直接提交。
type accountImportCommandHTTPClient struct {
	t        *testing.T
	expected string
	calls    int
}

// Do 返回新注册账号的公开投影。
func (client *accountImportCommandHTTPClient) Do(request *http.Request) (*http.Response, error) {
	client.t.Helper()
	body, err := io.ReadAll(request.Body)
	if err != nil {
		client.t.Fatalf("ReadAll(request body) error = %v", err)
	}
	client.calls++
	if request.Method != http.MethodPost || request.URL.Path != accountcontract.Sub2APIImportsPath ||
		request.Header.Get("Authorization") != "Bearer "+commandTestManagementKey ||
		request.Header.Get("Content-Type") != "application/json" || string(body) != client.expected {
		client.t.Fatalf("import request = %s %s %s", request.Method, request.URL, body)
	}
	return commandTransferResponse(http.StatusCreated,
		commandAccountDocument("claude", true), ""), nil
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

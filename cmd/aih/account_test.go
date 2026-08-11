package main

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	accountcontract "github.com/madou1217/ai_home/internal/contracts/accountmanagement"
	"github.com/madou1217/ai_home/internal/host/aihaccount"
)

const remoteAccountJSON = `{"data":{"account_ref":"acct_11111111111111111111","provider_id":"claude","cli_account_id":9,"enabled":true,"has_credential":true,"auth_kind":"oauth","auth_mode":"subscription","has_profile":true,"display_name":"测试账号","email":"someone@example.com","subscription_kind":"plus","subscription_raw":"plus","profile_updated_at":"2026-08-10T08:00:00Z","created_at":"2026-08-09T08:00:00Z","updated_at":"2026-08-10T08:00:00Z"}}`

// TestAccountListUsesTargetServerAndPrintsPublicRows 验证列表只访问目标 Server，
// 不打开本地账号数据库，并保留稳定游标分页。
func TestAccountListUsesTargetServerAndPrintsPublicRows(t *testing.T) {
	output := &bytes.Buffer{}
	transport := &accountCatalogCommandHTTPClient{
		t:         t,
		responses: []string{`{"data":[{"account_ref":"acct_11111111111111111111","provider_id":"claude","cli_account_id":9,"enabled":true,"has_credential":true,"auth_kind":"oauth","auth_mode":"subscription","has_profile":true,"display_name":"测试账号","email":"someone@example.com","subscription_kind":"plus","subscription_raw":"plus","profile_updated_at":"2026-08-10T08:00:00Z","created_at":"2026-08-09T08:00:00Z","updated_at":"2026-08-10T08:00:00Z"}],"page":{"limit":20,"has_more":true,"next_after_ref":"acct_11111111111111111111"}}`},
	}
	runtime := testCommandRuntime(t, map[string]string{
		"AIH_SERVER_BASE_URL":       "http://127.0.0.1:19527",
		"AIH_SERVER_MANAGEMENT_KEY": commandTestManagementKey,
	})
	runtime.stdout = output
	runtime.managementAPI = transport
	runtime.newAccountApp = func(context.Context, aihaccount.Options) (accountApplication, error) {
		t.Fatal("账号列表不得打开本地数据库")
		return nil, nil
	}

	if err := run(context.Background(), []string{
		"account", "list", "--limit", "20", "--after", "acct_00000000000000000000",
	}, runtime); err != nil {
		t.Fatalf("run() error = %v", err)
	}
	if transport.calls != 1 || transport.paths[0] != accountcontract.AccountsPath+
		"?after_ref=acct_00000000000000000000&limit=20" {
		t.Fatalf("远端列表请求 = %#v", transport.paths)
	}
	for _, expected := range []string{
		"claude", "9", "oauth/subscription", "plus", "someone@example.com",
		"aih account list --limit 20 --after acct_11111111111111111111",
	} {
		if !strings.Contains(output.String(), expected) {
			t.Fatalf("账号列表输出缺少 %q: %s", expected, output.String())
		}
	}
}

// TestAccountShowUsesServerAliasAndFullProjection 验证 provider:id 先由目标
// Server 解析，再读取同一 Server 的完整公开详情。
func TestAccountShowUsesServerAliasAndFullProjection(t *testing.T) {
	output := &bytes.Buffer{}
	transport := &accountCatalogCommandHTTPClient{t: t, responses: []string{
		`{"data":{"account_ref":"acct_11111111111111111111","provider_id":"claude","cli_account_id":9,"enabled":true,"updated_at":"2026-08-10T08:00:00Z"}}`,
		remoteAccountJSON,
	}}
	runtime := testCommandRuntime(t, map[string]string{
		"AIH_SERVER_BASE_URL":       "http://127.0.0.1:19527",
		"AIH_SERVER_MANAGEMENT_KEY": commandTestManagementKey,
	})
	runtime.stdout = output
	runtime.managementAPI = transport
	runtime.newAccountApp = func(context.Context, aihaccount.Options) (accountApplication, error) {
		t.Fatal("账号详情不得打开本地数据库")
		return nil, nil
	}

	if err := run(context.Background(), []string{"account", "show", "claude:9"}, runtime); err != nil {
		t.Fatalf("run() error = %v", err)
	}
	if transport.calls != 2 || transport.paths[0] != accountcontract.AccountAliasesPath+"/claude/9" ||
		transport.paths[1] != accountcontract.AccountsPath+"/acct_11111111111111111111" {
		t.Fatalf("账号详情请求 = %#v", transport.paths)
	}
	for _, expected := range []string{
		"账号详情:", "claude", "enabled", "oauth/subscription", "测试账号", "someone@example.com", "plus",
	} {
		if !strings.Contains(output.String(), expected) {
			t.Fatalf("账号详情输出缺少 %q: %s", expected, output.String())
		}
	}
}

// TestAccountImportReadsLocalArtifactThenSubmitsToServer 验证导入只从本机官方
// artifact 读取凭据，随后把原生 envelope 发送到目标 Server，并从 Server 取回模型。
func TestAccountImportReadsLocalArtifactThenSubmitsToServer(t *testing.T) {
	output := &bytes.Buffer{}
	codexHome := t.TempDir()
	if err := os.WriteFile(filepath.Join(codexHome, "auth.json"), []byte(`{"tokens":{"id_token":"synthetic"}}`), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	transport := &accountCatalogCommandHTTPClient{t: t, responses: []string{
		`{"data":{"account_ref":"acct_11111111111111111111","provider_id":"codex","cli_account_id":9,"enabled":true,"has_credential":true,"auth_kind":"oauth","auth_mode":"refreshable","has_profile":false,"created_at":"2026-08-10T08:00:00Z","updated_at":"2026-08-10T08:00:00Z"}}`,
		`{"data":[{"model_id":"gpt-5.4","upstream_available":true,"manual_policy":"inherit","effective":true,"updated_at":"2026-08-10T08:00:00Z"}]}`,
	}}
	runtime := testCommandRuntime(t, map[string]string{
		"CODEX_HOME":                codexHome,
		"AIH_SERVER_BASE_URL":       "http://127.0.0.1:19527",
		"AIH_SERVER_MANAGEMENT_KEY": commandTestManagementKey,
	})
	runtime.stdout = output
	runtime.managementAPI = transport
	runtime.newAccountApp = func(context.Context, aihaccount.Options) (accountApplication, error) {
		t.Fatal("账号导入不得打开本地数据库")
		return nil, nil
	}

	if err := run(context.Background(), []string{"account", "import", "codex"}, runtime); err != nil {
		t.Fatalf("run() error = %v", err)
	}
	if transport.calls != 2 || transport.methods[0] != http.MethodPost ||
		transport.paths[0] != accountcontract.NativeImportsPath ||
		transport.methods[1] != http.MethodGet ||
		transport.paths[1] != accountcontract.AccountsPath+
			"/acct_11111111111111111111"+accountcontract.AccountModelsSuffix {
		t.Fatalf("导入请求 = methods=%v paths=%v", transport.methods, transport.paths)
	}
	if !strings.Contains(transport.bodies[0], `"provider_id":"codex"`) ||
		!strings.Contains(transport.bodies[0], `"auth_json"`) {
		t.Fatalf("原生导入正文不是官方 envelope: %s", transport.bodies[0])
	}
	for _, expected := range []string{
		"已导入 codex 官方登录态", "账号别名   9", "gpt-5.4", "auth.json",
	} {
		if !strings.Contains(output.String(), expected) {
			t.Fatalf("导入输出缺少 %q: %s", expected, output.String())
		}
	}
}

// TestAccountManagementRequiresManagementKeyBeforeLocalImportRead 验证没有目标
// Server 管理凭据时，导入不会先触碰本机 artifact。
func TestAccountManagementRequiresManagementKeyBeforeLocalImportRead(t *testing.T) {
	readPath := filepath.Join(t.TempDir(), "auth.json")
	runtime := testCommandRuntime(t, map[string]string{"CODEX_HOME": filepath.Dir(readPath)})
	runtime.managementAPI = &unexpectedAccountCatalogHTTPClient{t: t}
	if err := run(context.Background(), []string{"account", "import", "codex"}, runtime); err == nil ||
		!strings.Contains(err.Error(), "AIH_SERVER_MANAGEMENT_KEY") {
		t.Fatalf("run() error = %v", err)
	}
}

// accountCatalogCommandHTTPClient 提供命令级管理 API 合同的顺序响应。
type accountCatalogCommandHTTPClient struct {
	t         *testing.T
	responses []string
	calls     int
	methods   []string
	paths     []string
	bodies    []string
}

// Do 校验所有请求都带管理凭据且没有把凭据放入 URL。
func (client *accountCatalogCommandHTTPClient) Do(request *http.Request) (*http.Response, error) {
	client.t.Helper()
	body, err := io.ReadAll(request.Body)
	if err != nil {
		client.t.Fatalf("ReadAll() error = %v", err)
	}
	if request.Header.Get("Authorization") != "Bearer "+commandTestManagementKey ||
		strings.Contains(request.URL.String(), commandTestManagementKey) {
		client.t.Fatalf("管理 API 鉴权或 URL 无效: %s", request.URL)
	}
	if client.calls >= len(client.responses) {
		client.t.Fatalf("unexpected management request %d", client.calls+1)
	}
	client.methods = append(client.methods, request.Method)
	client.paths = append(client.paths, request.URL.RequestURI())
	client.bodies = append(client.bodies, string(body))
	document := client.responses[client.calls]
	client.calls++
	return &http.Response{
		StatusCode: responseStatusForPath(request.URL.Path),
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(strings.NewReader(document)),
	}, nil
}

// responseStatusForPath 区分原生导入创建和其他 JSON 查询响应。
func responseStatusForPath(path string) int {
	if path == accountcontract.NativeImportsPath {
		return http.StatusCreated
	}
	return http.StatusOK
}

// unexpectedAccountCatalogHTTPClient 确保失败关闭路径不会产生网络调用。
type unexpectedAccountCatalogHTTPClient struct{ t *testing.T }

// Do 标记不应到达目标 Server 的请求。
func (client *unexpectedAccountCatalogHTTPClient) Do(*http.Request) (*http.Response, error) {
	client.t.Fatal("缺少 Management Key 时发生了网络请求")
	return nil, nil
}

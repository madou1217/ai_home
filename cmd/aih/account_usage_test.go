package main

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	accountcontract "github.com/madou1217/ai_home/internal/contracts/accountmanagement"
	"github.com/madou1217/ai_home/internal/host/aihaccount"
)

// TestAccountUsageShowResolvesAliasAndPrintsExactPercentage 验证离线查看由
// Server 解析数字别名，并把整数基点直接格式化为百分比。
func TestAccountUsageShowResolvesAliasAndPrintsExactPercentage(t *testing.T) {
	t.Parallel()

	output := &bytes.Buffer{}
	transport := &accountUsageCommandHTTPClient{
		t:          t,
		wantMethod: http.MethodGet,
		withAlias:  true,
		stale:      true,
	}
	runtime := testCommandRuntime(t, map[string]string{
		"AIH_SERVER_BASE_URL":       "http://127.0.0.1:19527",
		"AIH_SERVER_MANAGEMENT_KEY": commandTestManagementKey,
	})
	runtime.stdout = output
	runtime.managementAPI = transport
	runtime.newAccountApp = func(
		context.Context,
		aihaccount.Options,
	) (accountApplication, error) {
		t.Fatal("账号额度命令不得打开本地数据库")
		return nil, nil
	}

	if err := run(
		context.Background(),
		[]string{"account", "usage", "show", "claude:9"},
		runtime,
	); err != nil {
		t.Fatalf("run() error = %v", err)
	}
	if transport.calls != 2 {
		t.Fatalf("management API calls = %d, want 2", transport.calls)
	}
	rendered := output.String()
	for _, expected := range []string{
		"acct_11111111111111111111",
		"provider=claude",
		"source=claude_oauth_usage",
		"stale=true",
		"72.34%",
		"account",
		"5h0m0s",
	} {
		if !strings.Contains(rendered, expected) {
			t.Fatalf("账号额度输出缺少 %q: %s", expected, rendered)
		}
	}
}

// TestAccountUsageRefreshUsesDirectAccountRefAndPrintsCompletion 验证显式刷新
// 不做多余别名查询，并使用无正文 POST 调用刷新资源。
func TestAccountUsageRefreshUsesDirectAccountRefAndPrintsCompletion(t *testing.T) {
	t.Parallel()

	output := &bytes.Buffer{}
	transport := &accountUsageCommandHTTPClient{
		t:          t,
		wantMethod: http.MethodPost,
	}
	runtime := testCommandRuntime(t, map[string]string{
		"AIH_SERVER_BASE_URL":       "http://127.0.0.1:19527",
		"AIH_SERVER_MANAGEMENT_KEY": commandTestManagementKey,
	})
	runtime.stdout = output
	runtime.managementAPI = transport

	if err := run(
		context.Background(),
		[]string{
			"account",
			"usage",
			"refresh",
			"acct_11111111111111111111",
		},
		runtime,
	); err != nil {
		t.Fatalf("run() error = %v", err)
	}
	if transport.calls != 1 {
		t.Fatalf("management API calls = %d, want 1", transport.calls)
	}
	if rendered := output.String(); !strings.Contains(rendered, "额度刷新完成。") ||
		!strings.Contains(rendered, "72.34%") {
		t.Fatalf("账号额度刷新输出无效: %s", rendered)
	}
}

// TestAccountUsageHelpDocumentsNetworkBoundary 验证命令帮助明确区分离线
// show 与真实 Provider refresh，避免用户误解请求副作用。
func TestAccountUsageHelpDocumentsNetworkBoundary(t *testing.T) {
	t.Parallel()

	output := &bytes.Buffer{}
	runtime := testCommandRuntime(t, nil)
	runtime.stdout = output
	if err := run(
		context.Background(),
		[]string{"account", "usage", "--help"},
		runtime,
	); err != nil {
		t.Fatalf("run() error = %v", err)
	}
	for _, expected := range []string{
		"show    只读取 Go Server",
		"refresh 使用 Server 内当前规范凭据真实刷新",
		"GET  /v1/management/accounts/{account_ref}/usage",
		"POST /v1/management/accounts/{account_ref}/usage/refresh",
	} {
		if !strings.Contains(output.String(), expected) {
			t.Fatalf("账号额度帮助缺少 %q: %s", expected, output.String())
		}
	}
}

// accountUsageCommandHTTPClient 断言额度 CLI 与管理 API 的线级合同。
type accountUsageCommandHTTPClient struct {
	t          *testing.T
	wantMethod string
	withAlias  bool
	stale      bool
	calls      int
}

// Do 返回确定性别名和额度投影，并拒绝管理凭据进入 URL 或请求正文。
func (client *accountUsageCommandHTTPClient) Do(
	request *http.Request,
) (*http.Response, error) {
	client.t.Helper()
	body, err := io.ReadAll(request.Body)
	if err != nil {
		client.t.Fatalf("ReadAll(request body) error = %v", err)
	}
	if request.URL.Host != "127.0.0.1:19527" ||
		request.Header.Get("Authorization") != "Bearer "+commandTestManagementKey ||
		len(body) != 0 ||
		strings.Contains(request.URL.String(), commandTestManagementKey) {
		client.t.Fatalf("额度请求目标、认证或正文无效: %s %s", request.Method, request.URL)
	}
	client.calls++
	if client.withAlias && client.calls == 1 {
		if request.Method != http.MethodGet ||
			request.URL.Path != accountcontract.AccountAliasesPath+"/claude/9" {
			client.t.Fatalf("alias request = %s %s", request.Method, request.URL)
		}
		return commandAccountResponse(false), nil
	}
	wantPath := accountcontract.AccountsPath +
		"/acct_11111111111111111111" + accountcontract.AccountUsageSuffix
	if client.wantMethod == http.MethodPost {
		wantPath = accountcontract.AccountsPath +
			"/acct_11111111111111111111" +
			accountcontract.AccountUsageRefreshSuffix
	}
	if request.Method != client.wantMethod || request.URL.Path != wantPath {
		client.t.Fatalf("usage request = %s %s, want %s %s", request.Method, request.URL, client.wantMethod, wantPath)
	}
	return commandUsageResponse(client.stale), nil
}

// commandUsageResponse 构造命令测试使用的完整非敏感额度响应。
func commandUsageResponse(stale bool) *http.Response {
	staleJSON := "false"
	if stale {
		staleJSON = "true"
	}
	document := `{"data":{` +
		`"account_ref":"acct_11111111111111111111",` +
		`"provider_id":"claude",` +
		`"source":"claude_oauth_usage",` +
		`"captured_at":"2026-08-10T08:00:00Z",` +
		`"stale":` + staleJSON + `,` +
		`"entries":[{` +
		`"limit_id":"five_hour","limit_name":"Five hour",` +
		`"bucket":"five_hour","kind":"window","scope":"account",` +
		`"scope_key":"","remaining_basis_points":7234,` +
		`"availability":"available","window_seconds":18000,` +
		`"reset_at":"2026-08-10T10:00:00Z"}]}}`
	return &http.Response{
		StatusCode: http.StatusOK,
		Header: http.Header{
			"Content-Type": []string{"application/json"},
		},
		Body: io.NopCloser(strings.NewReader(document)),
	}
}

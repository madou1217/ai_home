package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"

	accountcontract "github.com/madou1217/ai_home/internal/contracts/accountmanagement"
	"github.com/madou1217/ai_home/internal/host/aihaccount"
)

const commandTestManagementKey = "synthetic-command-management-key-2026"

// TestAccountDisableResolvesAliasOnServerAndPrintsCommittedState 验证 CLI 不用
// 本地数据库猜测别名，并展示 Server 已提交的停用结果。
func TestAccountDisableResolvesAliasOnServerAndPrintsCommittedState(t *testing.T) {
	output := &bytes.Buffer{}
	transport := &accountStateHTTPClient{t: t}
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
		t.Fatal("账号启停不得打开本地数据库")
		return nil, nil
	}

	if err := run(
		context.Background(),
		[]string{"account", "disable", "claude:9"},
		runtime,
	); err != nil {
		t.Fatalf("run() error = %v", err)
	}
	if transport.calls != 2 {
		t.Fatalf("management API calls = %d, want 2", transport.calls)
	}
	rendered := output.String()
	for _, expected := range []string{
		"账号已停用",
		"Provider: claude",
		"账号别名: 9",
		"acct_11111111111111111111",
		"用户状态: disabled",
	} {
		if !strings.Contains(rendered, expected) {
			t.Fatalf("账号停用输出缺少 %q: %s", expected, rendered)
		}
	}
}

// TestAccountEnableRequiresManagementKeyBeforeAnyIO 验证缺少管理凭据时不会
// 打开数据库或尝试网络连接。
func TestAccountEnableRequiresManagementKeyBeforeAnyIO(t *testing.T) {
	runtime := testCommandRuntime(t, nil)
	runtime.managementAPI = &unexpectedAccountStateHTTPClient{t: t}
	runtime.newAccountApp = func(
		context.Context,
		aihaccount.Options,
	) (accountApplication, error) {
		t.Fatal("缺少 Management Key 时不得打开数据库")
		return nil, nil
	}
	err := run(
		context.Background(),
		[]string{"account", "enable", "acct_11111111111111111111"},
		runtime,
	)
	if err == nil || !strings.Contains(err.Error(), "AIH_SERVER_MANAGEMENT_KEY") {
		t.Fatalf("run() error = %v", err)
	}
}

// accountStateHTTPClient 断言别名解析和 PATCH 使用同一个目标 Server。
type accountStateHTTPClient struct {
	t     *testing.T
	calls int
}

// Do 顺序返回别名投影和停用后的账号投影。
func (client *accountStateHTTPClient) Do(request *http.Request) (*http.Response, error) {
	client.t.Helper()
	body, err := io.ReadAll(request.Body)
	if err != nil {
		client.t.Fatalf("ReadAll(request body) error = %v", err)
	}
	if request.URL.Host != "127.0.0.1:19527" ||
		request.Header.Get("Authorization") != "Bearer "+commandTestManagementKey {
		client.t.Fatalf("management request target or authorization invalid: %s", request.URL)
	}
	client.calls++
	switch client.calls {
	case 1:
		if request.Method != http.MethodGet ||
			request.URL.Path != accountcontract.AccountAliasesPath+"/claude/9" ||
			len(body) != 0 {
			client.t.Fatalf("alias request = %s %s %s", request.Method, request.URL, body)
		}
		return commandAccountResponse(true), nil
	case 2:
		if request.Method != http.MethodPatch ||
			request.URL.Path != accountcontract.AccountsPath+"/acct_11111111111111111111" ||
			string(body) != `{"enabled":false}` {
			client.t.Fatalf("state request = %s %s %s", request.Method, request.URL, body)
		}
		return commandAccountResponse(false), nil
	default:
		client.t.Fatalf("unexpected request count %d", client.calls)
		return nil, nil
	}
}

// unexpectedAccountStateHTTPClient 拒绝失败关闭路径产生网络请求。
type unexpectedAccountStateHTTPClient struct {
	t *testing.T
}

// Do 标记不应发生的网络调用。
func (client *unexpectedAccountStateHTTPClient) Do(*http.Request) (*http.Response, error) {
	client.t.Fatal("账号状态命令发生了不应有的网络请求")
	return nil, nil
}

// commandAccountResponse 构造命令测试使用的公开账号响应。
func commandAccountResponse(enabled bool) *http.Response {
	document := fmt.Sprintf(
		`{"data":{"account_ref":"acct_11111111111111111111","provider_id":"claude","cli_account_id":9,"enabled":%t,"updated_at":"2026-08-09T15:00:00Z"}}`,
		enabled,
	)
	return &http.Response{
		StatusCode: http.StatusOK,
		Header: http.Header{
			"Content-Type": []string{"application/json"},
		},
		Body: io.NopCloser(strings.NewReader(document)),
	}
}

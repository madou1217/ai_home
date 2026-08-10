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

// TestAccountDefaultCommandsUseTargetServerAndPrintCommittedState 验证 set 的
// 数字别名解析、show 和 clear 全部使用同一个目标 Server，且不打开本地数据库。
func TestAccountDefaultCommandsUseTargetServerAndPrintCommittedState(t *testing.T) {
	output := &bytes.Buffer{}
	transport := &accountDefaultHTTPClient{t: t}
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
		t.Fatal("默认账号命令不得打开本地数据库")
		return nil, nil
	}

	for _, arguments := range [][]string{
		{"account", "default", "set", "codex", "codex:9"},
		{"account", "default", "show", "codex"},
		{"account", "default", "clear", "codex"},
	} {
		if err := run(context.Background(), arguments, runtime); err != nil {
			t.Fatalf("run(%v) error = %v", arguments, err)
		}
	}
	if transport.calls != 4 {
		t.Fatalf("management API calls = %d, want 4", transport.calls)
	}
	for _, expected := range []string{
		"默认账号已设置",
		"默认账号:",
		"Provider: codex",
		"AccountRef: acct_11111111111111111111",
		"默认账号已清除",
	} {
		if !strings.Contains(output.String(), expected) {
			t.Fatalf("默认账号输出缺少 %q: %s", expected, output.String())
		}
	}
}

// TestAccountDefaultRejectsInvalidCommandsBeforeAnyIO 验证参数数量、Provider
// 和显式别名归属在创建客户端前严格校验。
func TestAccountDefaultRejectsInvalidCommandsBeforeAnyIO(t *testing.T) {
	for _, arguments := range [][]string{
		{"account", "default", "show"},
		{"account", "default", "show", "gemini"},
		{"account", "default", "show", "codex", "extra"},
		{"account", "default", "set", "codex"},
		{"account", "default", "set", "codex", "claude:1"},
		{"account", "default", "set", "codex", "codex:01"},
		{"account", "default", "clear"},
		{"account", "default", "clear", "Codex"},
		{"account", "default", "clear", "codex", "extra"},
	} {
		runtime := testCommandRuntime(t, nil)
		runtime.managementAPI = &unexpectedAccountStateHTTPClient{t: t}
		runtime.newAccountApp = func(
			context.Context,
			aihaccount.Options,
		) (accountApplication, error) {
			t.Fatalf("无效默认账号命令不得打开数据库: %v", arguments)
			return nil, nil
		}
		if err := run(context.Background(), arguments, runtime); err == nil {
			t.Fatalf("run(%v) error = nil", arguments)
		}
	}
}

// accountDefaultHTTPClient 断言 CLI 到默认账号 Management API 的调用顺序。
type accountDefaultHTTPClient struct {
	t     *testing.T
	calls int
}

// Do 返回别名、设置、读取和清除的规范响应。
func (client *accountDefaultHTTPClient) Do(request *http.Request) (*http.Response, error) {
	client.t.Helper()
	body, err := io.ReadAll(request.Body)
	if err != nil {
		client.t.Fatalf("ReadAll(request body) error = %v", err)
	}
	if request.URL.Host != "127.0.0.1:19527" ||
		request.Header.Get("Authorization") != "Bearer "+commandTestManagementKey {
		client.t.Fatalf("management request invalid: %s", request.URL)
	}
	client.calls++
	switch client.calls {
	case 1:
		if request.Method != http.MethodGet ||
			request.URL.Path != accountcontract.AccountAliasesPath+"/codex/9" ||
			len(body) != 0 {
			client.t.Fatalf("alias request = %s %s %s", request.Method, request.URL, body)
		}
		return accountDefaultAccountResponse(), nil
	case 2:
		if request.Method != http.MethodPut ||
			request.URL.Path != accountcontract.ProviderDefaultsPath+"/codex" ||
			string(body) != `{"account_ref":"acct_11111111111111111111"}` {
			client.t.Fatalf("set request = %s %s %s", request.Method, request.URL, body)
		}
		return accountDefaultResponse(), nil
	case 3:
		if request.Method != http.MethodGet ||
			request.URL.Path != accountcontract.ProviderDefaultsPath+"/codex" ||
			len(body) != 0 {
			client.t.Fatalf("show request = %s %s %s", request.Method, request.URL, body)
		}
		return accountDefaultResponse(), nil
	case 4:
		if request.Method != http.MethodDelete ||
			request.URL.Path != accountcontract.ProviderDefaultsPath+"/codex" ||
			len(body) != 0 {
			client.t.Fatalf("clear request = %s %s %s", request.Method, request.URL, body)
		}
		return &http.Response{
			StatusCode: http.StatusNoContent,
			Body:       io.NopCloser(strings.NewReader("")),
		}, nil
	default:
		client.t.Fatalf("unexpected request count %d", client.calls)
		return nil, nil
	}
}

// accountDefaultAccountResponse 构造别名解析使用的公开账号快照。
func accountDefaultAccountResponse() *http.Response {
	document := `{"data":{"account_ref":"acct_11111111111111111111",` +
		`"provider_id":"codex","cli_account_id":9,"enabled":true,` +
		`"updated_at":"2026-08-10T06:00:00Z"}}`
	return &http.Response{
		StatusCode: http.StatusOK,
		Body:       io.NopCloser(strings.NewReader(document)),
	}
}

// accountDefaultResponse 构造默认关系公开响应。
func accountDefaultResponse() *http.Response {
	document := fmt.Sprintf(
		`{"data":{"provider_id":"codex","account_ref":%q,`+
			`"updated_at":"2026-08-10T06:00:00Z"}}`,
		"acct_11111111111111111111",
	)
	return &http.Response{
		StatusCode: http.StatusOK,
		Body:       io.NopCloser(strings.NewReader(document)),
	}
}

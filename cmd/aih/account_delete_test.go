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

// TestAccountDeleteResolvesAliasAndPrintsDeletedIdentity 验证删除只经过目标
// Server，并在提交成功后显示删除账号的完整公开身份。
func TestAccountDeleteResolvesAliasAndPrintsDeletedIdentity(t *testing.T) {
	output := &bytes.Buffer{}
	transport := &accountDeleteHTTPClient{t: t}
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
		t.Fatal("账号删除不得打开本地数据库")
		return nil, nil
	}

	if err := run(
		context.Background(),
		[]string{"account", "delete", "claude:9", "--yes"},
		runtime,
	); err != nil {
		t.Fatalf("run() error = %v", err)
	}
	if transport.calls != 2 {
		t.Fatalf("management API calls = %d, want 2", transport.calls)
	}
	for _, expected := range []string{
		"账号已删除",
		"Provider: claude",
		"账号别名: 9",
		"AccountRef: acct_11111111111111111111",
	} {
		if !strings.Contains(output.String(), expected) {
			t.Fatalf("账号删除输出缺少 %q: %s", expected, output.String())
		}
	}
}

// TestAccountDeleteReadsDirectRefBeforeDelete 验证 AccountRef 输入仍从目标
// Server 核实公开身份，不借用本地账号库补齐 Provider 和数字别名。
func TestAccountDeleteReadsDirectRefBeforeDelete(t *testing.T) {
	transport := &accountDeleteHTTPClient{
		t:          t,
		lookupPath: accountcontract.AccountsPath + "/acct_11111111111111111111",
	}
	runtime := testCommandRuntime(t, map[string]string{
		"AIH_SERVER_BASE_URL":       "http://127.0.0.1:19527",
		"AIH_SERVER_MANAGEMENT_KEY": commandTestManagementKey,
	})
	runtime.managementAPI = transport
	if err := run(
		context.Background(),
		[]string{
			"account",
			"delete",
			"acct_11111111111111111111",
			"--yes",
		},
		runtime,
	); err != nil {
		t.Fatalf("run() error = %v", err)
	}
	if transport.calls != 2 {
		t.Fatalf("management API calls = %d, want 2", transport.calls)
	}
}

// TestAccountDeleteRequiresExactYesBeforeAnyIO 验证危险操作确认必须精确出现
// 在目标之后，错误命令不会读取配置、连接 Server 或打开数据库。
func TestAccountDeleteRequiresExactYesBeforeAnyIO(t *testing.T) {
	for _, arguments := range [][]string{
		{"account", "delete", "claude:9"},
		{"account", "delete", "--yes", "claude:9"},
		{"account", "delete", "claude:9", "yes"},
		{"account", "delete", "claude:9", "--yes", "extra"},
	} {
		runtime := testCommandRuntime(t, nil)
		runtime.managementAPI = &unexpectedAccountStateHTTPClient{t: t}
		runtime.newAccountApp = func(
			context.Context,
			aihaccount.Options,
		) (accountApplication, error) {
			t.Fatalf("无确认删除不得打开本地数据库: %v", arguments)
			return nil, nil
		}
		if err := run(context.Background(), arguments, runtime); err == nil ||
			!strings.Contains(err.Error(), "--yes") {
			t.Fatalf("run(%v) error = %v", arguments, err)
		}
	}
}

// accountDeleteHTTPClient 断言别名解析完成后只删除解析出的稳定账号。
type accountDeleteHTTPClient struct {
	t          *testing.T
	lookupPath string
	calls      int
}

// Do 返回目标 Server 的别名快照和空 204 删除响应。
func (client *accountDeleteHTTPClient) Do(request *http.Request) (*http.Response, error) {
	client.t.Helper()
	body, err := io.ReadAll(request.Body)
	if err != nil {
		client.t.Fatalf("ReadAll(request body) error = %v", err)
	}
	if request.URL.Host != "127.0.0.1:19527" ||
		request.Header.Get("Authorization") != "Bearer "+commandTestManagementKey ||
		len(body) != 0 {
		client.t.Fatalf("management request invalid: %s %s %s", request.Method, request.URL, body)
	}
	client.calls++
	switch client.calls {
	case 1:
		lookupPath := client.lookupPath
		if lookupPath == "" {
			lookupPath = accountcontract.AccountAliasesPath + "/claude/9"
		}
		if request.Method != http.MethodGet ||
			request.URL.Path != lookupPath {
			client.t.Fatalf("alias request = %s %s", request.Method, request.URL)
		}
		return commandAccountResponse(true), nil
	case 2:
		if request.Method != http.MethodDelete ||
			request.URL.Path != accountcontract.AccountsPath+"/acct_11111111111111111111" {
			client.t.Fatalf("delete request = %s %s", request.Method, request.URL)
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

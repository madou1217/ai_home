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

const remoteModelsJSON = `{"data":[{"model_id":"claude-opus-5","upstream_available":true,"manual_policy":"inherit","effective":true,"updated_at":"2026-08-10T08:00:00Z"},{"model_id":"claude-retired","upstream_available":false,"manual_policy":"force_enable","effective":true,"updated_at":"2026-08-10T08:01:00Z"}]}`

// TestAccountModelsListUsesServerSnapshot 验证模型列表只读取目标 Server 的
// 已物化快照，并把 provider:id 解析交给目标 Server。
func TestAccountModelsListUsesServerSnapshot(t *testing.T) {
	output := &bytes.Buffer{}
	transport := &accountCatalogCommandHTTPClient{t: t, responses: []string{
		`{"data":{"account_ref":"acct_11111111111111111111","provider_id":"claude","cli_account_id":9,"enabled":true,"updated_at":"2026-08-10T08:00:00Z"}}`,
		remoteModelsJSON,
	}}
	runtime := remoteAccountCommandRuntime(t, output, transport)
	if err := run(context.Background(), []string{"account", "models", "list", "claude:9"}, runtime); err != nil {
		t.Fatalf("run() error = %v", err)
	}
	if transport.paths[0] != accountcontract.AccountAliasesPath+"/claude/9" ||
		transport.paths[1] != accountcontract.AccountsPath+
			"/acct_11111111111111111111"+accountcontract.AccountModelsSuffix {
		t.Fatalf("模型列表请求 = %#v", transport.paths)
	}
	for _, expected := range []string{
		"acct_11111111111111111111", "claude-opus-5", "available", "inherit", "enabled",
		"claude-retired", "missing", "force_enable",
	} {
		if !strings.Contains(output.String(), expected) {
			t.Fatalf("账号模型输出缺少 %q: %s", expected, output.String())
		}
	}
}

// TestAccountModelsRefreshUsesServerAction 验证 refresh 是目标 Server 上的
// 显式动作，不在 CLI 进程中读取凭据或实时访问 Provider。
func TestAccountModelsRefreshUsesServerAction(t *testing.T) {
	output := &bytes.Buffer{}
	transport := &accountCatalogCommandHTTPClient{t: t, responses: []string{remoteModelsJSON}}
	runtime := remoteAccountCommandRuntime(t, output, transport)
	if err := run(context.Background(), []string{
		"account", "models", "refresh", "acct_11111111111111111111",
	}, runtime); err != nil {
		t.Fatalf("run() error = %v", err)
	}
	if transport.methods[0] != http.MethodPost || transport.paths[0] !=
		accountcontract.AccountsPath+"/acct_11111111111111111111"+
			accountcontract.AccountModelsRefreshSuffix || transport.bodies[0] != "" {
		t.Fatalf("模型刷新请求 = methods=%v paths=%v bodies=%v", transport.methods, transport.paths, transport.bodies)
	}
	if !strings.Contains(output.String(), "模型刷新完成") ||
		!strings.Contains(output.String(), "claude-opus-5") {
		t.Fatalf("模型刷新输出无效: %s", output.String())
	}
}

// TestAccountModelsSetPolicyUsesServerPatch 验证人工策略通过精确模型 PATCH
// 写入目标 Server，且输出服务端返回的完整快照。
func TestAccountModelsSetPolicyUsesServerPatch(t *testing.T) {
	output := &bytes.Buffer{}
	transport := &accountCatalogCommandHTTPClient{t: t, responses: []string{
		`{"data":[{"model_id":"claude-opus-5","upstream_available":true,"manual_policy":"force_disable","effective":false,"updated_at":"2026-08-10T08:00:00Z"}]}`,
	}}
	runtime := remoteAccountCommandRuntime(t, output, transport)
	if err := run(context.Background(), []string{
		"account", "models", "set-policy", "acct_11111111111111111111", "claude-opus-5", "force_disable",
	}, runtime); err != nil {
		t.Fatalf("run() error = %v", err)
	}
	if transport.methods[0] != http.MethodPatch || transport.paths[0] !=
		accountcontract.AccountsPath+"/acct_11111111111111111111"+accountcontract.AccountModelsSuffix ||
		transport.bodies[0] != `{"model_id":"claude-opus-5","manual_policy":"force_disable"}` {
		t.Fatalf("模型策略请求 = methods=%v paths=%v bodies=%v", transport.methods, transport.paths, transport.bodies)
	}
	if !strings.Contains(output.String(), "模型策略已更新") ||
		!strings.Contains(output.String(), "force_disable") ||
		!strings.Contains(output.String(), "disabled") {
		t.Fatalf("模型策略输出无效: %s", output.String())
	}
}

// TestAccountModelsRejectsRemoteFailureWithoutOpeningLocalDatabase 验证 Server
// 刷新失败时保留远端错误边界，且不退回本地 SQLite。
func TestAccountModelsRejectsRemoteFailureWithoutOpeningLocalDatabase(t *testing.T) {
	runtime := remoteAccountCommandRuntime(t, &bytes.Buffer{}, &staticCatalogHTTPClient{
		status: http.StatusBadGateway,
		body:   `{"error":{"code":"upstream_temporarily_unavailable","message":"temporary"}}`,
	})
	runtime.newAccountApp = func(context.Context, aihaccount.Options) (accountApplication, error) {
		t.Fatal("模型命令不得退回本地数据库")
		return nil, nil
	}
	err := run(context.Background(), []string{
		"account", "models", "refresh", "acct_11111111111111111111",
	}, runtime)
	if err == nil || !strings.Contains(err.Error(), "upstream_temporarily_unavailable") {
		t.Fatalf("run() error = %v", err)
	}
}

// remoteAccountCommandRuntime 创建只允许访问合成目标 Server 的命令边界。
func remoteAccountCommandRuntime(
	t *testing.T,
	output *bytes.Buffer,
	transport interface {
		Do(*http.Request) (*http.Response, error)
	},
) commandRuntime {
	runtime := testCommandRuntime(t, map[string]string{
		"AIH_SERVER_BASE_URL":       "http://127.0.0.1:19527",
		"AIH_SERVER_MANAGEMENT_KEY": commandTestManagementKey,
	})
	runtime.stdout = output
	runtime.managementAPI = transport
	runtime.newAccountApp = func(context.Context, aihaccount.Options) (accountApplication, error) {
		t.Fatal("账号模型命令不得打开本地数据库")
		return nil, nil
	}
	return runtime
}

// staticCatalogHTTPClient 返回固定远端错误，避免测试连接真实上游。
type staticCatalogHTTPClient struct {
	status int
	body   string
}

// Do 返回固定错误响应并保留 JSON 错误合同。
func (client *staticCatalogHTTPClient) Do(request *http.Request) (*http.Response, error) {
	return &http.Response{
		StatusCode: client.status,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(strings.NewReader(client.body)),
	}, nil
}

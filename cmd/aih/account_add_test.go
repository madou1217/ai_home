package main

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	accountcontract "github.com/madou1217/ai_home/internal/contracts/accountmanagement"
)

// TestAccountAddCreatesAllSupportedStaticAccountKinds 验证 CLI 从官方环境变量
// 读取三种静态凭据，只调用一次账号集合 POST，且终端永不回显敏感值。
func TestAccountAddCreatesAllSupportedStaticAccountKinds(t *testing.T) {
	tests := []struct {
		name         string
		providerID   string
		environment  map[string]string
		expectedBody string
		secret       string
	}{
		{
			name:       "Codex API Key",
			providerID: "codex",
			environment: map[string]string{
				"OPENAI_API_KEY":  "synthetic-codex-key",
				"OPENAI_BASE_URL": "https://api.openai.com/v1",
			},
			expectedBody: `{"provider_id":"codex","auth":{"kind":"api_key","api_key":"synthetic-codex-key","base_url":"https://api.openai.com/v1"}}`,
			secret:       "synthetic-codex-key",
		},
		{
			name:       "Claude API Key",
			providerID: "claude",
			environment: map[string]string{
				"ANTHROPIC_API_KEY": "synthetic-claude-key",
			},
			expectedBody: `{"provider_id":"claude","auth":{"kind":"api_key","api_key":"synthetic-claude-key"}}`,
			secret:       "synthetic-claude-key",
		},
		{
			name:       "Claude Auth Token",
			providerID: "claude",
			environment: map[string]string{
				"ANTHROPIC_AUTH_TOKEN": "synthetic-claude-token",
				"ANTHROPIC_BASE_URL":   "https://api.anthropic.com",
			},
			expectedBody: `{"provider_id":"claude","auth":{"kind":"auth_token","auth_token":"synthetic-claude-token","base_url":"https://api.anthropic.com"}}`,
			secret:       "synthetic-claude-token",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			output := &bytes.Buffer{}
			environment := map[string]string{
				"AIH_SERVER_BASE_URL":       "http://127.0.0.1:19527",
				"AIH_SERVER_MANAGEMENT_KEY": commandTestManagementKey,
			}
			for name, value := range test.environment {
				environment[name] = value
			}
			transport := &accountAddCommandHTTPClient{
				t:            t,
				providerID:   test.providerID,
				expectedBody: test.expectedBody,
			}
			runtime := testCommandRuntime(t, environment)
			runtime.managementAPI = transport
			runtime.stdout = output

			if err := run(context.Background(), []string{
				"account", "add", test.providerID, "--from-env",
			}, runtime); err != nil {
				t.Fatalf("run() error = %v", err)
			}
			if transport.calls != 1 || strings.Contains(output.String(), test.secret) {
				t.Fatalf("calls=%d output=%q", transport.calls, output.String())
			}
			for _, expected := range []string{
				"静态账号已添加", "Provider: " + test.providerID,
				"账号别名: 9", "AccountRef: acct_11111111111111111111",
				"后台异步刷新",
			} {
				if !strings.Contains(output.String(), expected) {
					t.Fatalf("account add output missing %q: %s", expected, output.String())
				}
			}
		})
	}
}

// TestAccountAddValidatesSyntaxAndManagementKeyBeforeReadingSecret 验证命令格式
// 严格，且缺少管理凭据时不会先读取 Provider 密钥。
func TestAccountAddValidatesSyntaxAndManagementKeyBeforeReadingSecret(t *testing.T) {
	for _, arguments := range [][]string{
		{"account", "add"},
		{"account", "add", "grok", "--from-env"},
		{"account", "add", "codex"},
		{"account", "add", "codex", "--from-env", "extra"},
	} {
		runtime := testCommandRuntime(t, map[string]string{})
		runtime.managementAPI = &unexpectedAccountAddHTTPClient{t: t}
		if err := run(context.Background(), arguments, runtime); err == nil {
			t.Fatalf("run(%v) unexpectedly succeeded", arguments)
		}
	}

	secretRead := false
	runtime := testCommandRuntime(t, map[string]string{})
	runtime.managementAPI = &unexpectedAccountAddHTTPClient{t: t}
	runtime.lookupEnv = func(name string) (string, bool) {
		if name == "OPENAI_API_KEY" {
			secretRead = true
			return "must-not-be-read", true
		}
		return "", false
	}
	err := run(context.Background(), []string{
		"account", "add", "codex", "--from-env",
	}, runtime)
	if err == nil || !strings.Contains(err.Error(), "AIH_SERVER_MANAGEMENT_KEY") || secretRead {
		t.Fatalf("run() error=%v secretRead=%t", err, secretRead)
	}
}

// TestAccountAddHelpDocumentsEnvironmentAndAsyncModelRefresh 验证帮助可以在不
// 访问 Server 的情况下说明完整输入、API 和异步模型语义。
func TestAccountAddHelpDocumentsEnvironmentAndAsyncModelRefresh(t *testing.T) {
	output := &bytes.Buffer{}
	runtime := testCommandRuntime(t, map[string]string{})
	runtime.managementAPI = &unexpectedAccountAddHTTPClient{t: t}
	runtime.stdout = output

	if err := run(context.Background(), []string{"account", "add", "--help"}, runtime); err != nil {
		t.Fatalf("run() error = %v", err)
	}
	for _, expected := range []string{
		"aih account add <codex|claude> --from-env",
		"OPENAI_API_KEY",
		"ANTHROPIC_API_KEY",
		"ANTHROPIC_AUTH_TOKEN",
		"POST /v1/management/accounts",
		"异步",
	} {
		if !strings.Contains(output.String(), expected) {
			t.Fatalf("account add help missing %q: %s", expected, output.String())
		}
	}
}

// accountAddCommandHTTPClient 断言 add 命令只提交一次静态账号创建请求。
type accountAddCommandHTTPClient struct {
	t            *testing.T
	providerID   string
	expectedBody string
	calls        int
}

// Do 返回 Server 已提交的新账号公开投影。
func (client *accountAddCommandHTTPClient) Do(request *http.Request) (*http.Response, error) {
	client.t.Helper()
	body, err := io.ReadAll(request.Body)
	if err != nil {
		client.t.Fatalf("ReadAll(request body) error = %v", err)
	}
	client.calls++
	if request.Method != http.MethodPost ||
		request.URL.Path != accountcontract.AccountsPath ||
		request.Header.Get("Authorization") != "Bearer "+commandTestManagementKey ||
		request.Header.Get("Content-Type") != "application/json" ||
		string(body) != client.expectedBody {
		client.t.Fatalf("account add request = %s %s %s %#v", request.Method, request.URL, body, request.Header)
	}
	return commandTransferResponse(
		http.StatusCreated,
		commandAccountDocument(client.providerID, true),
		"",
	), nil
}

// unexpectedAccountAddHTTPClient 确保本地校验和帮助路径不访问网络。
type unexpectedAccountAddHTTPClient struct{ t *testing.T }

// Do 标记不应发生的账号管理请求。
func (client *unexpectedAccountAddHTTPClient) Do(*http.Request) (*http.Response, error) {
	client.t.Fatal("账号 add 本地校验失败后仍访问了 Management API")
	return nil, nil
}

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

// TestAccountCredentialUpdateUsesClaudeOfficialEnvironment 验证 Claude 静态凭据
// 只从官方环境变量读取，原地 PUT 后不回显敏感值。
func TestAccountCredentialUpdateUsesClaudeOfficialEnvironment(t *testing.T) {
	output := &bytes.Buffer{}
	secret := "synthetic-claude-auth-token"
	transport := &accountCredentialCommandHTTPClient{
		t:          t,
		providerID: "claude",
		expectedBody: `{"auth":{"kind":"auth_token","api_key":"","auth_token":"` +
			secret + `","base_url":"https://api.anthropic.com"}}`,
	}
	runtime := testCommandRuntime(t, map[string]string{
		"AIH_SERVER_BASE_URL":       "http://127.0.0.1:19527",
		"AIH_SERVER_MANAGEMENT_KEY": commandTestManagementKey,
		"ANTHROPIC_AUTH_TOKEN":      secret,
		"ANTHROPIC_BASE_URL":        "https://api.anthropic.com",
	})
	runtime.managementAPI = transport
	runtime.stdout = output

	if err := run(context.Background(), []string{
		"account", "credential", "update", "claude:9", "--from-env",
	}, runtime); err != nil {
		t.Fatalf("run() error = %v", err)
	}
	if transport.calls != 2 || strings.Contains(output.String(), secret) {
		t.Fatalf("calls=%d output=%q", transport.calls, output.String())
	}
	for _, expected := range []string{
		"静态凭据已更新", "Provider: claude", "账号别名: 9",
		"AccountRef: acct_11111111111111111111", "auth_token",
	} {
		if !strings.Contains(output.String(), expected) {
			t.Fatalf("credential output missing %q: %s", expected, output.String())
		}
	}
}

// TestAccountCredentialUpdateUsesCodexOfficialEnvironment 验证 Codex 只发送
// OPENAI_API_KEY 与 OPENAI_BASE_URL，不猜测其他 Provider 字段。
func TestAccountCredentialUpdateUsesCodexOfficialEnvironment(t *testing.T) {
	secret := "synthetic-openai-api-key"
	transport := &accountCredentialCommandHTTPClient{
		t:          t,
		providerID: "codex",
		expectedBody: `{"auth":{"kind":"api_key","api_key":"` + secret +
			`","auth_token":"","base_url":"https://api.openai.com/v1"}}`,
	}
	runtime := testCommandRuntime(t, map[string]string{
		"AIH_SERVER_BASE_URL":       "http://127.0.0.1:19527",
		"AIH_SERVER_MANAGEMENT_KEY": commandTestManagementKey,
		"OPENAI_API_KEY":            secret,
		"OPENAI_BASE_URL":           "https://api.openai.com/v1",
	})
	runtime.managementAPI = transport

	if err := run(context.Background(), []string{
		"account", "credential", "update", "acct_11111111111111111111", "--from-env",
	}, runtime); err != nil {
		t.Fatalf("run() error = %v", err)
	}
	if transport.calls != 2 {
		t.Fatalf("management API calls = %d, want 2", transport.calls)
	}
}

// TestAccountCredentialUpdateRejectsAmbiguousOrMissingEnvironment 验证 Claude
// 双凭据和 Codex 缺失密钥都不会触发 PUT。
func TestAccountCredentialUpdateRejectsAmbiguousOrMissingEnvironment(t *testing.T) {
	tests := []struct {
		name       string
		providerID string
		env        map[string]string
		expected   string
	}{
		{
			name:       "Claude ambiguous",
			providerID: "claude",
			env: map[string]string{
				"ANTHROPIC_API_KEY":    "key",
				"ANTHROPIC_AUTH_TOKEN": "token",
			},
			expected: "不能同时",
		},
		{
			name:       "Codex missing",
			providerID: "codex",
			env:        map[string]string{},
			expected:   "OPENAI_API_KEY",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			environment := map[string]string{
				"AIH_SERVER_BASE_URL":       "http://127.0.0.1:19527",
				"AIH_SERVER_MANAGEMENT_KEY": commandTestManagementKey,
			}
			for key, value := range test.env {
				environment[key] = value
			}
			transport := &accountCredentialCommandHTTPClient{
				t:          t,
				providerID: test.providerID,
				rejectPut:  true,
			}
			runtime := testCommandRuntime(t, environment)
			runtime.managementAPI = transport
			err := run(context.Background(), []string{
				"account", "credential", "update", "acct_11111111111111111111", "--from-env",
			}, runtime)
			if err == nil || !strings.Contains(err.Error(), test.expected) || transport.calls != 1 {
				t.Fatalf("run() error=%v calls=%d", err, transport.calls)
			}
		})
	}
}

// accountCredentialCommandHTTPClient 断言账号核实和凭据 PUT 的完整顺序。
type accountCredentialCommandHTTPClient struct {
	t            *testing.T
	providerID   string
	expectedBody string
	rejectPut    bool
	calls        int
}

// Do 返回目标账号，并在允许时接收一次静态凭据更新。
func (client *accountCredentialCommandHTTPClient) Do(request *http.Request) (*http.Response, error) {
	client.t.Helper()
	body, err := io.ReadAll(request.Body)
	if err != nil {
		client.t.Fatalf("ReadAll(request body) error = %v", err)
	}
	client.calls++
	switch client.calls {
	case 1:
		if request.Method != http.MethodGet ||
			(request.URL.Path != accountcontract.AccountAliasesPath+"/claude/9" &&
				request.URL.Path != accountcontract.AccountsPath+"/acct_11111111111111111111") ||
			len(body) != 0 {
			client.t.Fatalf("credential lookup = %s %s %s", request.Method, request.URL, body)
		}
		return commandTransferResponse(http.StatusOK,
			commandAccountDocument(client.providerID, true), ""), nil
	case 2:
		if client.rejectPut {
			client.t.Fatal("无效环境触发了凭据 PUT")
		}
		if request.Method != http.MethodPut || request.URL.Path !=
			accountcontract.AccountsPath+"/acct_11111111111111111111"+
				accountcontract.AccountCredentialSuffix || string(body) != client.expectedBody {
			client.t.Fatalf("credential update = %s %s %s", request.Method, request.URL, body)
		}
		return commandTransferResponse(http.StatusOK,
			commandAccountDocument(client.providerID, true), ""), nil
	default:
		client.t.Fatalf("unexpected request count %d", client.calls)
		return nil, nil
	}
}

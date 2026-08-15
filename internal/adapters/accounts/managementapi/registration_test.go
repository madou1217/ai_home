package managementapi_test

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/internal/adapters/accounts/managementapi"
	accountcontract "github.com/madou1217/ai_home/internal/contracts/accountmanagement"
)

// TestClientCreatesStaticAccountsWithStrictCollectionContract 验证三种已支持的
// 静态凭据共享同一个账号集合 POST，并且客户端格式化不会泄露凭据。
func TestClientCreatesStaticAccountsWithStrictCollectionContract(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name         string
		providerID   string
		input        managementapi.StaticCredentialInput
		expectedBody string
		secret       string
	}{
		{
			name:       "Codex API Key",
			providerID: "codex",
			input: managementapi.StaticCredentialInput{
				Kind:    "api_key",
				APIKey:  "synthetic-codex-key",
				BaseURL: "https://api.openai.com/v1",
			},
			expectedBody: `{"provider_id":"codex","auth":{"kind":"api_key","api_key":"synthetic-codex-key","base_url":"https://api.openai.com/v1"}}`,
			secret:       "synthetic-codex-key",
		},
		{
			name:       "Claude API Key",
			providerID: "claude",
			input: managementapi.StaticCredentialInput{
				Kind:    "api_key",
				APIKey:  "synthetic-claude-key",
				BaseURL: "https://api.anthropic.com",
			},
			expectedBody: `{"provider_id":"claude","auth":{"kind":"api_key","api_key":"synthetic-claude-key","base_url":"https://api.anthropic.com"}}`,
			secret:       "synthetic-claude-key",
		},
		{
			name:       "Claude Auth Token",
			providerID: "claude",
			input: managementapi.StaticCredentialInput{
				Kind:      "auth_token",
				AuthToken: "synthetic-claude-token",
				BaseURL:   "https://api.anthropic.com",
			},
			expectedBody: `{"provider_id":"claude","auth":{"kind":"auth_token","auth_token":"synthetic-claude-token","base_url":"https://api.anthropic.com"}}`,
			secret:       "synthetic-claude-token",
		},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			transport := &accountCreationHTTPClient{
				t:            t,
				providerID:   test.providerID,
				expectedBody: test.expectedBody,
			}
			client, err := managementapi.New(transport, managementapi.Config{
				BaseURL:       "http://127.0.0.1:9527",
				ManagementKey: testManagementKey,
			})
			if err != nil {
				t.Fatalf("New() error = %v", err)
			}
			created, err := client.CreateStaticAccount(
				context.Background(),
				test.providerID,
				test.input,
			)
			if err != nil {
				t.Fatalf("CreateStaticAccount() error = %v", err)
			}
			if transport.calls != 1 || created.ProviderID != test.providerID ||
				created.AccountRef.String() != "acct_11111111111111111111" ||
				created.CLIAccountID.String() != "9" || !created.Enabled {
				t.Fatalf("calls=%d created=%+v", transport.calls, created)
			}
			formatted := fmt.Sprintf("%v %#v", test.input, test.input)
			if strings.Contains(formatted, test.secret) ||
				!strings.Contains(formatted, "<redacted>") {
				t.Fatalf("StaticCredentialInput formatting leaked secret: %s", formatted)
			}
		})
	}
}

// TestClientRejectsUnsupportedStaticAccountCreationBeforeTransport 验证 Provider
// 与凭据类型的已知不兼容组合不会发送到 Server。
func TestClientRejectsUnsupportedStaticAccountCreationBeforeTransport(t *testing.T) {
	t.Parallel()

	client, err := managementapi.New(
		&unexpectedManagementHTTPClient{t: t},
		managementapi.Config{
			BaseURL:       "http://127.0.0.1:9527",
			ManagementKey: testManagementKey,
		},
	)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	tests := []struct {
		providerID string
		input      managementapi.StaticCredentialInput
	}{
		{providerID: "grok", input: managementapi.StaticCredentialInput{Kind: "api_key", APIKey: "key"}},
		{providerID: "codex", input: managementapi.StaticCredentialInput{Kind: "auth_token", AuthToken: "token"}},
		{providerID: "claude", input: managementapi.StaticCredentialInput{Kind: "api_key", APIKey: "key", AuthToken: "token"}},
	}
	for _, test := range tests {
		if _, createErr := client.CreateStaticAccount(
			context.Background(),
			test.providerID,
			test.input,
		); !errors.Is(createErr, managementapi.ErrInvalidRequest) {
			t.Fatalf("CreateStaticAccount(%q, %v) error = %v", test.providerID, test.input, createErr)
		}
	}
	if _, createErr := client.CreateStaticAccount(
		nil,
		"codex",
		managementapi.StaticCredentialInput{Kind: "api_key", APIKey: "key"},
	); !errors.Is(createErr, managementapi.ErrInvalidRequest) {
		t.Fatalf("CreateStaticAccount(nil context) error = %v", createErr)
	}
}

// TestClientRejectsInvalidStaticAccountCreationResponse 验证集合 POST 必须返回
// 201 JSON，且公开投影必须属于请求中的 Provider。
func TestClientRejectsInvalidStaticAccountCreationResponse(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		response *http.Response
	}{
		{
			name: "错误成功状态",
			response: transferResponse(
				http.StatusOK,
				"application/json",
				accountDocument("acct_11111111111111111111", "codex", 9, true),
				"",
			),
		},
		{
			name: "错误 Provider",
			response: transferResponse(
				http.StatusCreated,
				"application/json",
				accountDocument("acct_11111111111111111111", "claude", 9, true),
				"",
			),
		},
		{
			name: "错误媒体类型",
			response: transferResponse(
				http.StatusCreated,
				"text/plain",
				accountDocument("acct_11111111111111111111", "codex", 9, true),
				"",
			),
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			client, err := managementapi.New(
				&oneResponseHTTPClient{response: test.response},
				managementapi.Config{
					BaseURL:       "http://127.0.0.1:9527",
					ManagementKey: testManagementKey,
				},
			)
			if err != nil {
				t.Fatalf("New() error = %v", err)
			}
			if _, createErr := client.CreateStaticAccount(
				context.Background(),
				"codex",
				managementapi.StaticCredentialInput{Kind: "api_key", APIKey: "key"},
			); !errors.Is(createErr, managementapi.ErrInvalidResponse) {
				t.Fatalf("CreateStaticAccount() error = %v", createErr)
			}
		})
	}
}

// accountCreationHTTPClient 断言账号创建请求的鉴权、路径与敏感正文合同。
type accountCreationHTTPClient struct {
	t            *testing.T
	providerID   string
	expectedBody string
	calls        int
}

// Do 返回不含敏感字段的新账号公开投影。
func (client *accountCreationHTTPClient) Do(request *http.Request) (*http.Response, error) {
	client.t.Helper()
	body, err := io.ReadAll(request.Body)
	if err != nil {
		client.t.Fatalf("ReadAll(request body) error = %v", err)
	}
	client.calls++
	if request.Method != http.MethodPost ||
		request.URL.Path != accountcontract.AccountsPath ||
		request.Header.Get("Authorization") != "Bearer "+testManagementKey ||
		request.Header.Get("Accept") != "application/json" ||
		request.Header.Get("Content-Type") != "application/json" ||
		string(body) != client.expectedBody {
		client.t.Fatalf("account creation request = %s %s %s %#v", request.Method, request.URL, body, request.Header)
	}
	return transferResponse(
		http.StatusCreated,
		"application/json; charset=utf-8",
		accountDocument("acct_11111111111111111111", client.providerID, 9, true),
		"",
	), nil
}

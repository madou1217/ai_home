package managementapi_test

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accounts/managementapi"
	accountcontract "github.com/madou1217/ai_home/internal/contracts/accountmanagement"
)

// TestClientManagesProviderDefaultWithStrictHTTPContract 验证设置、读取和清除
// 默认关系共享同一个 Provider 资源，且不会把 Management Key 放入 URL 或正文。
func TestClientManagesProviderDefaultWithStrictHTTPContract(t *testing.T) {
	t.Parallel()

	transport := &providerDefaultHTTPClient{t: t}
	client, err := managementapi.New(transport, managementapi.Config{
		BaseURL:       "http://127.0.0.1:9527",
		ManagementKey: testManagementKey,
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	accountRef, err := accountcore.ParseAccountRef("acct_11111111111111111111")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	set, err := client.SetProviderDefault(context.Background(), "codex", accountRef)
	if err != nil {
		t.Fatalf("SetProviderDefault() error = %v", err)
	}
	get, err := client.GetProviderDefault(context.Background(), "codex")
	if err != nil {
		t.Fatalf("GetProviderDefault() error = %v", err)
	}
	if err := client.ClearProviderDefault(context.Background(), "codex"); err != nil {
		t.Fatalf("ClearProviderDefault() error = %v", err)
	}
	if set != get || set.ProviderID != "codex" || set.AccountRef != accountRef ||
		set.UpdatedAt.IsZero() || transport.calls != 3 {
		t.Fatalf("set=%+v get=%+v calls=%d", set, get, transport.calls)
	}
}

// TestClientRejectsInvalidProviderDefaultResponses 验证错 Provider、错账号和
// 非标准 DELETE 成功响应全部失败关闭。
func TestClientRejectsInvalidProviderDefaultResponses(t *testing.T) {
	t.Parallel()

	accountRef, err := accountcore.ParseAccountRef("acct_11111111111111111111")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	tests := []struct {
		name   string
		status int
		body   string
		call   func(*managementapi.Client) error
	}{
		{
			name:   "读取返回错 Provider",
			status: http.StatusOK,
			body: providerDefaultDocument(
				"claude",
				"acct_11111111111111111111",
			),
			call: func(client *managementapi.Client) error {
				_, callErr := client.GetProviderDefault(context.Background(), "codex")
				return callErr
			},
		},
		{
			name:   "设置返回错账号",
			status: http.StatusOK,
			body: providerDefaultDocument(
				"codex",
				"acct_22222222222222222222",
			),
			call: func(client *managementapi.Client) error {
				_, callErr := client.SetProviderDefault(
					context.Background(),
					"codex",
					accountRef,
				)
				return callErr
			},
		},
		{
			name:   "清除返回 200",
			status: http.StatusOK,
			call: func(client *managementapi.Client) error {
				return client.ClearProviderDefault(context.Background(), "codex")
			},
		},
		{
			name:   "清除返回非空 204",
			status: http.StatusNoContent,
			body:   `{}`,
			call: func(client *managementapi.Client) error {
				return client.ClearProviderDefault(context.Background(), "codex")
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			client, newErr := managementapi.New(&staticHTTPClient{
				status: test.status,
				body:   test.body,
			}, managementapi.Config{
				BaseURL:       "http://127.0.0.1:9527",
				ManagementKey: testManagementKey,
			})
			if newErr != nil {
				t.Fatalf("New() error = %v", newErr)
			}
			if callErr := test.call(client); !errors.Is(
				callErr,
				managementapi.ErrInvalidResponse,
			) {
				t.Fatalf("call() error = %v", callErr)
			}
		})
	}
}

// providerDefaultHTTPClient 断言默认关系三种操作的顺序和完整 HTTP 合同。
type providerDefaultHTTPClient struct {
	t     *testing.T
	calls int
}

// Do 返回设置、读取和清除默认关系的规范响应。
func (client *providerDefaultHTTPClient) Do(request *http.Request) (*http.Response, error) {
	client.t.Helper()
	body, err := io.ReadAll(request.Body)
	if err != nil {
		client.t.Fatalf("ReadAll(request body) error = %v", err)
	}
	if request.URL.Path != accountcontract.ProviderDefaultsPath+"/codex" ||
		request.Header.Get("Authorization") != "Bearer "+testManagementKey ||
		strings.Contains(request.URL.String(), testManagementKey) ||
		strings.Contains(string(body), testManagementKey) {
		client.t.Fatalf("provider default request invalid: %s %s %s", request.Method, request.URL, body)
	}
	client.calls++
	switch client.calls {
	case 1:
		if request.Method != http.MethodPut ||
			string(body) != `{"account_ref":"acct_11111111111111111111"}` ||
			request.Header.Get("Content-Type") != "application/json" {
			client.t.Fatalf("set request = %s %s", request.Method, body)
		}
		return jsonResponse(http.StatusOK, providerDefaultDocument(
			"codex",
			"acct_11111111111111111111",
		)), nil
	case 2:
		if request.Method != http.MethodGet || len(body) != 0 {
			client.t.Fatalf("get request = %s %s", request.Method, body)
		}
		return jsonResponse(http.StatusOK, providerDefaultDocument(
			"codex",
			"acct_11111111111111111111",
		)), nil
	case 3:
		if request.Method != http.MethodDelete || len(body) != 0 {
			client.t.Fatalf("clear request = %s %s", request.Method, body)
		}
		return jsonResponse(http.StatusNoContent, ""), nil
	default:
		client.t.Fatalf("unexpected request count %d", client.calls)
		return nil, nil
	}
}

// providerDefaultDocument 构造默认关系公开响应。
func providerDefaultDocument(providerID string, accountRef string) string {
	return fmt.Sprintf(
		`{"data":{"provider_id":%q,"account_ref":%q,"updated_at":"2026-08-10T06:00:00Z"}}`,
		providerID,
		accountRef,
	)
}

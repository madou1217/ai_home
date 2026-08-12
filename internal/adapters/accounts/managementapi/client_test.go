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

const testManagementKey = "synthetic-management-client-key-2026"

// TestClientResolvesAliasAndSetsEnabled 验证客户端使用目标 Server 的别名事实，
// 再以稳定 AccountRef 提交精确 PATCH，且不会把密钥放入 URL 或正文。
func TestClientResolvesAliasAndSetsEnabled(t *testing.T) {
	t.Parallel()

	transport := &recordingHTTPClient{t: t}
	client, err := managementapi.New(transport, managementapi.Config{
		BaseURL:       "http://127.0.0.1:9527/",
		ManagementKey: testManagementKey,
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	alias, err := accountcore.NewCLIAccountID(9)
	if err != nil {
		t.Fatalf("NewCLIAccountID() error = %v", err)
	}
	resolved, err := client.ResolveAlias(context.Background(), "claude", alias)
	if err != nil {
		t.Fatalf("ResolveAlias() error = %v", err)
	}
	disabled, err := client.SetEnabled(
		context.Background(),
		resolved.AccountRef,
		false,
	)
	if err != nil {
		t.Fatalf("SetEnabled() error = %v", err)
	}
	if transport.calls != 2 ||
		resolved.AccountRef.String() != "acct_11111111111111111111" ||
		disabled.AccountRef != resolved.AccountRef ||
		disabled.Enabled ||
		disabled.UpdatedAt.IsZero() {
		t.Fatalf(
			"calls=%d resolved=%+v disabled=%+v",
			transport.calls,
			resolved,
			disabled,
		)
	}
	formatted := fmt.Sprintf(
		"%v %#v %v %#v",
		client,
		client,
		managementapi.Config{
			BaseURL:       "http://127.0.0.1:9527",
			ManagementKey: testManagementKey,
		},
		managementapi.Config{
			BaseURL:       "http://127.0.0.1:9527",
			ManagementKey: testManagementKey,
		},
	)
	if strings.Contains(formatted, testManagementKey) ||
		!strings.Contains(formatted, "<redacted>") {
		t.Fatalf("Client formatting leaked key: %s", formatted)
	}
}

// TestClientRejectsInvalidConfigRemoteErrorsAndMismatchedSnapshots 验证配置、
// Server 错误和错账号响应都失败关闭，且不会回显任意正文。
func TestClientRejectsInvalidConfigRemoteErrorsAndMismatchedSnapshots(t *testing.T) {
	t.Parallel()

	for _, config := range []managementapi.Config{
		{},
		{BaseURL: "ftp://127.0.0.1", ManagementKey: testManagementKey},
		{BaseURL: "http://user@127.0.0.1", ManagementKey: testManagementKey},
		{BaseURL: "http://127.0.0.1/v1", ManagementKey: testManagementKey},
		{BaseURL: "http://127.0.0.1", ManagementKey: "too-short"},
	} {
		if _, err := managementapi.New(&staticHTTPClient{}, config); !errors.Is(
			err,
			managementapi.ErrInvalidConfig,
		) {
			t.Fatalf("New(%+v) error = %v", config, err)
		}
	}

	accountRef, err := accountcore.ParseAccountRef("acct_11111111111111111111")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	unauthorized, err := managementapi.New(&staticHTTPClient{
		status: http.StatusUnauthorized,
		body:   `{"error":{"code":"unauthorized","message":"需要有效的 Management Key"}}`,
	}, managementapi.Config{
		BaseURL:       "http://127.0.0.1:9527",
		ManagementKey: testManagementKey,
	})
	if err != nil {
		t.Fatalf("New(unauthorized) error = %v", err)
	}
	_, err = unauthorized.SetEnabled(context.Background(), accountRef, false)
	var remote managementapi.RemoteError
	if !errors.As(err, &remote) ||
		remote.StatusCode != http.StatusUnauthorized ||
		remote.Code != "unauthorized" {
		t.Fatalf("SetEnabled(remote) error = %#v", err)
	}

	mismatched, err := managementapi.New(&staticHTTPClient{
		status: http.StatusOK,
		body: accountDocument(
			"acct_22222222222222222222",
			"claude",
			9,
			false,
		),
	}, managementapi.Config{
		BaseURL:       "http://127.0.0.1:9527",
		ManagementKey: testManagementKey,
	})
	if err != nil {
		t.Fatalf("New(mismatched) error = %v", err)
	}
	if _, err := mismatched.SetEnabled(
		context.Background(),
		accountRef,
		false,
	); !errors.Is(err, managementapi.ErrInvalidResponse) {
		t.Fatalf("SetEnabled(mismatched) error = %v", err)
	}
}

// TestClientRejectsInvalidUpdatedAtWhenCreatedAtIsValid 防止新增 created_at 后
// 覆盖 updated_at 的解析错误，确保远端账号快照的两个时间字段都严格有效。
func TestClientRejectsInvalidUpdatedAtWhenCreatedAtIsValid(t *testing.T) {
	t.Parallel()

	client, err := managementapi.New(&staticHTTPClient{
		status: http.StatusOK,
		body:   `{"data":{"account_ref":"acct_11111111111111111111","provider_id":"claude","cli_account_id":9,"enabled":true,"created_at":"2026-08-01T00:00:00Z","updated_at":"not-a-timestamp"}}`,
	}, managementapi.Config{
		BaseURL:       "http://127.0.0.1:9527",
		ManagementKey: testManagementKey,
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	alias, err := accountcore.NewCLIAccountID(9)
	if err != nil {
		t.Fatalf("NewCLIAccountID() error = %v", err)
	}
	if _, err := client.ResolveAlias(context.Background(), "claude", alias); !errors.Is(
		err,
		managementapi.ErrInvalidResponse,
	) {
		t.Fatalf("ResolveAlias() error = %v, want invalid response", err)
	}
}

// TestClientGetsAndDeletesAccountWithStrictNoContentContract 验证删除前读取公开
// 快照，并且 DELETE 只接受 204 与空响应体。
func TestClientGetsAndDeletesAccountWithStrictNoContentContract(t *testing.T) {
	t.Parallel()

	transport := &accountDeletionHTTPClient{t: t}
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
	snapshot, err := client.GetAccount(context.Background(), accountRef)
	if err != nil {
		t.Fatalf("GetAccount() error = %v", err)
	}
	if snapshot.AccountRef != accountRef || snapshot.ProviderID != "claude" ||
		snapshot.CLIAccountID.String() != "9" {
		t.Fatalf("GetAccount() = %+v", snapshot)
	}
	if err := client.DeleteAccount(context.Background(), accountRef); err != nil {
		t.Fatalf("DeleteAccount() error = %v", err)
	}
	if transport.calls != 2 {
		t.Fatalf("calls = %d, want 2", transport.calls)
	}
}

// TestClientRejectsInvalidDeleteResponses 验证 200 空响应和 204 非空响应都不
// 会被误认为删除成功。
func TestClientRejectsInvalidDeleteResponses(t *testing.T) {
	t.Parallel()

	accountRef, err := accountcore.ParseAccountRef("acct_11111111111111111111")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	for _, response := range []struct {
		name   string
		status int
		body   string
	}{
		{name: "错误成功状态", status: http.StatusOK},
		{name: "非空响应体", status: http.StatusNoContent, body: `{}`},
	} {
		t.Run(response.name, func(t *testing.T) {
			t.Parallel()
			client, newErr := managementapi.New(&staticHTTPClient{
				status: response.status,
				body:   response.body,
			}, managementapi.Config{
				BaseURL:       "http://127.0.0.1:9527",
				ManagementKey: testManagementKey,
			})
			if newErr != nil {
				t.Fatalf("New() error = %v", newErr)
			}
			if deleteErr := client.DeleteAccount(
				context.Background(),
				accountRef,
			); !errors.Is(deleteErr, managementapi.ErrInvalidResponse) {
				t.Fatalf("DeleteAccount() error = %v", deleteErr)
			}
		})
	}
}

// recordingHTTPClient 断言两步账号管理请求的完整 HTTP 合同。
type recordingHTTPClient struct {
	t     *testing.T
	calls int
}

// accountDeletionHTTPClient 断言详情读取与删除共享同一稳定成员资源。
type accountDeletionHTTPClient struct {
	t     *testing.T
	calls int
}

// Do 返回公开快照和严格空的 204 删除响应。
func (client *accountDeletionHTTPClient) Do(request *http.Request) (*http.Response, error) {
	client.t.Helper()
	body, err := io.ReadAll(request.Body)
	if err != nil {
		client.t.Fatalf("ReadAll(request body) error = %v", err)
	}
	if request.URL.Path != accountcontract.AccountsPath+"/acct_11111111111111111111" ||
		request.Header.Get("Authorization") != "Bearer "+testManagementKey ||
		len(body) != 0 {
		client.t.Fatalf("account deletion request = %s %s %s", request.Method, request.URL, body)
	}
	client.calls++
	switch client.calls {
	case 1:
		if request.Method != http.MethodGet {
			client.t.Fatalf("detail method = %s", request.Method)
		}
		return jsonResponse(http.StatusOK, accountDocument(
			"acct_11111111111111111111",
			"claude",
			9,
			true,
		)), nil
	case 2:
		if request.Method != http.MethodDelete {
			client.t.Fatalf("delete method = %s", request.Method)
		}
		return jsonResponse(http.StatusNoContent, ""), nil
	default:
		client.t.Fatalf("unexpected request count %d", client.calls)
		return nil, nil
	}
}

// Do 返回两步顺序响应，并拒绝密钥进入 URL 或正文。
func (client *recordingHTTPClient) Do(request *http.Request) (*http.Response, error) {
	client.t.Helper()
	body, err := io.ReadAll(request.Body)
	if err != nil {
		client.t.Fatalf("ReadAll(request body) error = %v", err)
	}
	if request.Header.Get("Authorization") != "Bearer "+testManagementKey ||
		strings.Contains(request.URL.String(), testManagementKey) ||
		strings.Contains(string(body), testManagementKey) {
		client.t.Fatal("账号管理请求泄漏或遗漏 Management Key")
	}
	client.calls++
	switch client.calls {
	case 1:
		if request.Method != http.MethodGet ||
			request.URL.Path != accountcontract.AccountAliasesPath+"/claude/9" ||
			len(body) != 0 {
			client.t.Fatalf("alias request = %s %s %s", request.Method, request.URL, body)
		}
		return jsonResponse(http.StatusOK, accountDocument(
			"acct_11111111111111111111",
			"claude",
			9,
			true,
		)), nil
	case 2:
		if request.Method != http.MethodPatch ||
			request.URL.Path != accountcontract.AccountsPath+"/acct_11111111111111111111" ||
			string(body) != `{"enabled":false}` ||
			request.Header.Get("Content-Type") != "application/json" {
			client.t.Fatalf("update request = %s %s %s", request.Method, request.URL, body)
		}
		return jsonResponse(http.StatusOK, accountDocument(
			"acct_11111111111111111111",
			"claude",
			9,
			false,
		)), nil
	default:
		client.t.Fatalf("unexpected request count %d", client.calls)
		return nil, nil
	}
}

// staticHTTPClient 为失败路径返回一个固定 HTTP 响应。
type staticHTTPClient struct {
	status int
	body   string
}

// Do 返回不包含真实网络或凭据的固定响应。
func (client *staticHTTPClient) Do(*http.Request) (*http.Response, error) {
	status := client.status
	if status == 0 {
		status = http.StatusOK
	}
	return jsonResponse(status, client.body), nil
}

// jsonResponse 创建客户端测试使用的独立 JSON Body。
func jsonResponse(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Header: http.Header{
			"Content-Type": []string{"application/json"},
		},
		Body: io.NopCloser(strings.NewReader(body)),
	}
}

// accountDocument 构造账号管理成功 envelope。
func accountDocument(
	accountRef string,
	providerID string,
	cliAccountID int64,
	enabled bool,
) string {
	return fmt.Sprintf(
		`{"data":{"account_ref":%q,"provider_id":%q,"cli_account_id":%d,"enabled":%t,"updated_at":"2026-08-09T14:00:00Z"}}`,
		accountRef,
		providerID,
		cliAccountID,
		enabled,
	)
}

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

// TestClientTransfersOneAccountAndRotatesStaticCredential 验证迁移和静态凭据
// 更新使用精确 HTTP 合同，且成功结果不会改变目标账号身份。
func TestClientTransfersOneAccountAndRotatesStaticCredential(t *testing.T) {
	t.Parallel()

	transport := &accountTransferHTTPClient{t: t}
	client, err := managementapi.New(transport, managementapi.Config{
		BaseURL:       "http://127.0.0.1:9527",
		ManagementKey: testManagementKey,
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	accountRef := mustManagementAccountRef(t)

	sub2apiDocument, err := client.ExportSub2API(context.Background(), accountRef)
	if err != nil {
		t.Fatalf("ExportSub2API() error = %v", err)
	}
	if string(sub2apiDocument) != `{"type":"sub2api-data","accounts":[]}` {
		t.Fatalf("ExportSub2API() = %s", sub2apiDocument)
	}
	cliProxyDocument, err := client.ExportCLIProxyAPI(context.Background(), accountRef)
	if err != nil {
		t.Fatalf("ExportCLIProxyAPI() error = %v", err)
	}
	if string(cliProxyDocument) != `{"type":"claude"}` {
		t.Fatalf("ExportCLIProxyAPI() = %s", cliProxyDocument)
	}

	imported, err := client.ImportSub2API(context.Background(), sub2apiDocument)
	if err != nil {
		t.Fatalf("ImportSub2API() error = %v", err)
	}
	if !imported.Created || imported.Account.AccountRef != accountRef ||
		imported.Account.ProviderID != "claude" ||
		imported.Account.CLIAccountID.String() != "9" {
		t.Fatalf("ImportSub2API() = %+v", imported)
	}

	credential := managementapi.StaticCredentialInput{
		Kind:    "api_key",
		APIKey:  "new-static-secret",
		BaseURL: "https://api.anthropic.com",
	}
	updated, err := client.UpdateStaticCredential(
		context.Background(),
		accountRef,
		credential,
	)
	if err != nil {
		t.Fatalf("UpdateStaticCredential() error = %v", err)
	}
	if updated.AccountRef != accountRef || updated.ProviderID != "claude" ||
		updated.CLIAccountID.String() != "9" || !updated.Enabled {
		t.Fatalf("UpdateStaticCredential() = %+v", updated)
	}
	formatted := fmt.Sprintf("%v %#v", credential, credential)
	if strings.Contains(formatted, "new-static-secret") ||
		!strings.Contains(formatted, "<redacted>") {
		t.Fatalf("StaticCredentialInput formatting leaked secret: %s", formatted)
	}
	if transport.calls != 4 {
		t.Fatalf("management API calls = %d, want 4", transport.calls)
	}
}

// TestClientReportsExistingSub2APIImport 验证 200 成功响应不会被误判失败，
// 同时把“未新建”语义交给 CLI 展示。
func TestClientReportsExistingSub2APIImport(t *testing.T) {
	t.Parallel()

	response := transferResponse(
		http.StatusOK,
		"application/json",
		accountImportDocument("acct_11111111111111111111", "claude", 9, true),
		"",
	)
	client, err := managementapi.New(
		&oneResponseHTTPClient{response: response},
		managementapi.Config{
			BaseURL:       "http://127.0.0.1:9527",
			ManagementKey: testManagementKey,
		},
	)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	result, err := client.ImportSub2API(
		context.Background(),
		[]byte(`{"type":"sub2api-data"}`),
	)
	if err != nil {
		t.Fatalf("ImportSub2API(existing) error = %v", err)
	}
	if result.Created || result.Account.AccountRef != mustManagementAccountRef(t) {
		t.Fatalf("ImportSub2API(existing) = %+v", result)
	}
}

// TestStaticCredentialInputFormattingRedactsUntrustedBaseURL 验证诊断格式不会
// 回显尚未经过 Server 领域校验的 URL 用户信息、查询参数或路径密钥。
func TestStaticCredentialInputFormattingRedactsUntrustedBaseURL(t *testing.T) {
	t.Parallel()

	const secret = "base-url-secret-must-not-leak"
	input := managementapi.StaticCredentialInput{
		Kind:    "api_key",
		APIKey:  "api-key-secret-must-not-leak",
		BaseURL: "https://user:" + secret + "@example.test/v1/" + secret + "?token=" + secret,
	}
	formatted := fmt.Sprintf("%v %#v", input, input)
	if strings.Contains(formatted, secret) ||
		strings.Contains(formatted, "api-key-secret-must-not-leak") ||
		!strings.Contains(formatted, "<redacted>") {
		t.Fatalf("StaticCredentialInput formatting leaked untrusted data: %s", formatted)
	}
}

// TestClientRejectsInvalidTransferAndCredentialContracts 验证错误状态、媒体类型、
// 附件名、错账号响应和无界输入都失败关闭。
func TestClientRejectsInvalidTransferAndCredentialContracts(t *testing.T) {
	t.Parallel()

	accountRef := mustManagementAccountRef(t)
	tests := []struct {
		name string
		run  func(*managementapi.Client) error
		resp *http.Response
	}{
		{
			name: "sub2api export status",
			run: func(client *managementapi.Client) error {
				_, err := client.ExportSub2API(context.Background(), accountRef)
				return err
			},
			resp: transferResponse(http.StatusCreated, "application/json", `{"type":"sub2api-data"}`, "sub2api-data.json"),
		},
		{
			name: "cliproxy export media type",
			run: func(client *managementapi.Client) error {
				_, err := client.ExportCLIProxyAPI(context.Background(), accountRef)
				return err
			},
			resp: transferResponse(http.StatusOK, "text/plain", `{"type":"claude"}`, "cliproxyapi-auth.json"),
		},
		{
			name: "cliproxy export attachment",
			run: func(client *managementapi.Client) error {
				_, err := client.ExportCLIProxyAPI(context.Background(), accountRef)
				return err
			},
			resp: transferResponse(http.StatusOK, "application/json", `{"type":"claude"}`, "wrong.json"),
		},
		{
			name: "sub2api import status",
			run: func(client *managementapi.Client) error {
				_, err := client.ImportSub2API(context.Background(), []byte(`{"type":"sub2api-data"}`))
				return err
			},
			resp: transferResponse(http.StatusAccepted, "application/json", accountDocument(
				"acct_11111111111111111111", "claude", 9, true,
			), ""),
		},
		{
			name: "credential mismatched account",
			run: func(client *managementapi.Client) error {
				_, err := client.UpdateStaticCredential(
					context.Background(),
					accountRef,
					managementapi.StaticCredentialInput{Kind: "auth_token", AuthToken: "token"},
				)
				return err
			},
			resp: transferResponse(http.StatusOK, "application/json", accountDocument(
				"acct_22222222222222222222", "claude", 9, true,
			), ""),
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			client, err := managementapi.New(&oneResponseHTTPClient{response: test.resp}, managementapi.Config{
				BaseURL:       "http://127.0.0.1:9527",
				ManagementKey: testManagementKey,
			})
			if err != nil {
				t.Fatalf("New() error = %v", err)
			}
			if err := test.run(client); !errors.Is(err, managementapi.ErrInvalidResponse) {
				t.Fatalf("operation error = %v", err)
			}
		})
	}

	client, err := managementapi.New(&unexpectedManagementHTTPClient{t: t}, managementapi.Config{
		BaseURL:       "http://127.0.0.1:9527",
		ManagementKey: testManagementKey,
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	oversized := make([]byte, 1024*1024+1)
	if _, err := client.ImportSub2API(
		context.Background(),
		oversized,
	); !errors.Is(err, managementapi.ErrInvalidRequest) {
		t.Fatalf("ImportSub2API(oversized) error = %v", err)
	}
	for _, input := range []managementapi.StaticCredentialInput{
		{},
		{Kind: "api_key", APIKey: "key", AuthToken: "token"},
		{Kind: "oauth", APIKey: "key"},
	} {
		if _, err := client.UpdateStaticCredential(
			context.Background(),
			accountRef,
			input,
		); !errors.Is(err, managementapi.ErrInvalidRequest) {
			t.Fatalf("UpdateStaticCredential(%v) error = %v", input, err)
		}
	}
}

// accountTransferHTTPClient 断言三个迁移请求和一次凭据更新的完整线合同。
type accountTransferHTTPClient struct {
	t     *testing.T
	calls int
}

// Do 返回真实 Server 公开合同等价的 JSON 响应。
func (client *accountTransferHTTPClient) Do(request *http.Request) (*http.Response, error) {
	client.t.Helper()
	body, err := io.ReadAll(request.Body)
	if err != nil {
		client.t.Fatalf("ReadAll(request body) error = %v", err)
	}
	if request.Header.Get("Authorization") != "Bearer "+testManagementKey ||
		request.Header.Get("Accept") != "application/json" {
		client.t.Fatalf("management headers = %#v", request.Header)
	}
	client.calls++
	switch client.calls {
	case 1:
		assertManagementRequest(client.t, request, body, http.MethodGet,
			accountcontract.AccountsPath+"/acct_11111111111111111111/export", "")
		return transferResponse(http.StatusOK, "application/json; charset=utf-8",
			`{"type":"sub2api-data","accounts":[]}`, "sub2api-data.json"), nil
	case 2:
		assertManagementRequest(client.t, request, body, http.MethodGet,
			accountcontract.AccountsPath+"/acct_11111111111111111111/export/cliproxyapi", "")
		return transferResponse(http.StatusOK, "application/json; charset=utf-8",
			`{"type":"claude"}`, "cliproxyapi-auth.json"), nil
	case 3:
		assertManagementRequest(client.t, request, body, http.MethodPost,
			"/v1/management/account-imports/sub2api",
			`{"type":"sub2api-data","accounts":[]}`)
		return transferResponse(http.StatusCreated, "application/json; charset=utf-8",
			accountImportDocument("acct_11111111111111111111", "claude", 9, true), ""), nil
	case 4:
		assertManagementRequest(client.t, request, body, http.MethodPut,
			accountcontract.AccountsPath+"/acct_11111111111111111111/credential",
			`{"auth":{"kind":"api_key","api_key":"new-static-secret","base_url":"https://api.anthropic.com"}}`)
		return transferResponse(http.StatusOK, "application/json; charset=utf-8",
			accountDocument("acct_11111111111111111111", "claude", 9, true), ""), nil
	default:
		client.t.Fatalf("unexpected request count %d", client.calls)
		return nil, nil
	}
}

// accountImportDocument 构造导入资源返回的完整公开账号投影。
func accountImportDocument(
	accountRef string,
	providerID string,
	cliAccountID int64,
	enabled bool,
) string {
	return fmt.Sprintf(
		`{"data":{"account_ref":%q,"provider_id":%q,"cli_account_id":%d,"enabled":%t,"has_credential":true,"auth_kind":"oauth","auth_mode":"refreshable","has_profile":false,"created_at":"2026-08-09T14:00:00Z","updated_at":"2026-08-09T14:00:00Z"}}`,
		accountRef,
		providerID,
		cliAccountID,
		enabled,
	)
}

// oneResponseHTTPClient 返回单个预设响应。
type oneResponseHTTPClient struct {
	response *http.Response
}

// Do 返回预设响应。
func (client *oneResponseHTTPClient) Do(*http.Request) (*http.Response, error) {
	return client.response, nil
}

// unexpectedManagementHTTPClient 拒绝本地校验失败后继续访问 Server。
type unexpectedManagementHTTPClient struct {
	t *testing.T
}

// Do 标记不应发生的请求。
func (client *unexpectedManagementHTTPClient) Do(*http.Request) (*http.Response, error) {
	client.t.Fatal("本地校验失败后仍访问了 Management API")
	return nil, nil
}

// mustManagementAccountRef 创建迁移测试统一使用的稳定账号引用。
func mustManagementAccountRef(t *testing.T) accountcore.AccountRef {
	t.Helper()
	accountRef, err := accountcore.ParseAccountRef("acct_11111111111111111111")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	return accountRef
}

// assertManagementRequest 校验请求方法、路径、正文和 JSON 媒体类型。
func assertManagementRequest(
	t *testing.T,
	request *http.Request,
	body []byte,
	method string,
	path string,
	expectedBody string,
) {
	t.Helper()
	if request.Method != method || request.URL.Path != path ||
		string(body) != expectedBody {
		t.Fatalf("management request = %s %s %s", request.Method, request.URL, body)
	}
	if expectedBody != "" && request.Header.Get("Content-Type") != "application/json" {
		t.Fatalf("Content-Type = %q", request.Header.Get("Content-Type"))
	}
}

// transferResponse 构造含可选附件文件名的 Management API 响应。
func transferResponse(status int, contentType string, body string, fileName string) *http.Response {
	header := http.Header{"Content-Type": []string{contentType}}
	if fileName != "" {
		header.Set("Content-Disposition", `attachment; filename="`+fileName+`"`)
	}
	return &http.Response{
		StatusCode: status,
		Header:     header,
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}

package managementapi_test

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accounts/managementapi"
	accountcontract "github.com/madou1217/ai_home/internal/contracts/accountmanagement"
)

// TestClientReadsRemoteAccountCatalog 验证列表、详情和模型资源都沿用同一
// Management API 认证边界，并严格解析公开投影。
func TestClientReadsRemoteAccountCatalog(t *testing.T) {
	transport := &catalogSequenceHTTPClient{t: t, responses: []catalogResponse{
		{
			status: http.StatusOK,
			body:   `{"data":[{"account_ref":"acct_11111111111111111111","provider_id":"claude","cli_account_id":9,"enabled":true,"has_credential":true,"auth_kind":"oauth","auth_mode":"subscription","has_profile":false,"created_at":"2026-08-10T08:00:00Z","updated_at":"2026-08-10T08:00:00Z"}],"page":{"limit":20,"has_more":false,"next_after_ref":""}}`,
		},
		{
			status: http.StatusOK,
			body:   `{"data":{"account_ref":"acct_11111111111111111111","provider_id":"claude","cli_account_id":9,"enabled":true,"has_credential":true,"auth_kind":"oauth","auth_mode":"subscription","has_profile":false,"created_at":"2026-08-10T08:00:00Z","updated_at":"2026-08-10T08:00:00Z"}}`,
		},
		{
			status: http.StatusOK,
			body:   `{"data":[{"model_id":"claude-opus-5","upstream_available":true,"manual_policy":"inherit","effective":true,"updated_at":"2026-08-10T08:00:00Z"}]}`,
		},
	}}
	client, err := managementapi.New(transport, managementapi.Config{
		BaseURL:       "http://127.0.0.1:9527",
		ManagementKey: testManagementKey,
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	list, err := client.ListAccounts(context.Background(), managementapi.ListOptions{Limit: 20})
	if err != nil {
		t.Fatalf("ListAccounts() error = %v", err)
	}
	accountRef, err := accountcore.ParseAccountRef("acct_11111111111111111111")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	view, err := client.GetAccountView(context.Background(), accountRef)
	if err != nil {
		t.Fatalf("GetAccountView() error = %v", err)
	}
	models, err := client.ListAccountModels(context.Background(), accountRef)
	if err != nil {
		t.Fatalf("ListAccountModels() error = %v", err)
	}
	if len(list.Accounts) != 1 || list.Accounts[0].AccountRef != accountRef ||
		view.AccountRef != accountRef || view.ProviderID != "claude" ||
		len(models.Models) != 1 || models.Models[0].ModelID != "claude-opus-5" {
		t.Fatalf("远端目录结果异常: list=%+v view=%+v models=%+v", list, view, models)
	}
	if transport.paths[0] != accountcontract.AccountsPath+"?limit=20" ||
		transport.paths[1] != accountcontract.AccountsPath+"/acct_11111111111111111111" ||
		transport.paths[2] != accountcontract.AccountsPath+"/acct_11111111111111111111"+accountcontract.AccountModelsSuffix {
		t.Fatalf("远端目录路径 = %#v", transport.paths)
	}
}

// TestClientWritesModelPolicyAndNativeImport 验证模型策略和原生导入使用服务端
// 声明的 HTTP 方法、JSON 字段以及创建状态码。
func TestClientWritesModelPolicyAndNativeImport(t *testing.T) {
	transport := &catalogSequenceHTTPClient{t: t, responses: []catalogResponse{
		{status: http.StatusOK, body: `{"data":[{"model_id":"claude-opus-5","upstream_available":true,"manual_policy":"force_disable","effective":false,"updated_at":"2026-08-10T08:00:00Z"}]}`},
		{status: http.StatusCreated, body: `{"data":{"account_ref":"acct_11111111111111111111","provider_id":"codex","cli_account_id":10,"enabled":true,"has_credential":true,"auth_kind":"oauth","auth_mode":"refreshable","has_profile":false,"created_at":"2026-08-10T08:00:00Z","updated_at":"2026-08-10T08:00:00Z"}}`},
	}}
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
	if _, err := client.SetAccountModelPolicy(
		context.Background(), accountRef, "claude-opus-5", "force_disable",
	); err != nil {
		t.Fatalf("SetAccountModelPolicy() error = %v", err)
	}
	if _, err := client.ImportNative(
		context.Background(), "codex", []byte(`{"auth_json":{"tokens":{"id_token":"synthetic"}}}`),
	); err != nil {
		t.Fatalf("ImportNative() error = %v", err)
	}
	if transport.methods[0] != http.MethodPatch || transport.paths[0] !=
		accountcontract.AccountsPath+"/acct_11111111111111111111"+accountcontract.AccountModelsSuffix ||
		transport.bodies[0] != `{"model_id":"claude-opus-5","manual_policy":"force_disable"}` {
		t.Fatalf("策略请求 = methods=%v paths=%v bodies=%v", transport.methods, transport.paths, transport.bodies)
	}
	if transport.methods[1] != http.MethodPost || transport.paths[1] != accountcontract.NativeImportsPath ||
		!strings.Contains(transport.bodies[1], `"provider_id":"codex"`) ||
		!strings.Contains(transport.bodies[1], `"auth_json"`) {
		t.Fatalf("导入请求 = methods=%v paths=%v bodies=%v", transport.methods, transport.paths, transport.bodies)
	}
}

// TestClientRejectsCorruptCatalogResponses 验证损坏的分页和模型投影不会进入
// CLI 输出或路由层。
func TestClientRejectsCorruptCatalogResponses(t *testing.T) {
	accountRef, err := accountcore.ParseAccountRef("acct_11111111111111111111")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	cases := []struct {
		name     string
		response catalogResponse
		call     func(*managementapi.Client) error
	}{
		{
			name:     "分页游标缺失",
			response: catalogResponse{status: http.StatusOK, body: `{"data":[],"page":{"limit":20,"has_more":true,"next_after_ref":""}}`},
			call: func(client *managementapi.Client) error {
				_, err := client.ListAccounts(context.Background(), managementapi.ListOptions{Limit: 20})
				return err
			},
		},
		{
			name:     "模型策略未知",
			response: catalogResponse{status: http.StatusOK, body: `{"data":[{"model_id":"claude-opus-5","upstream_available":true,"manual_policy":"unknown","effective":true,"updated_at":"2026-08-10T08:00:00Z"}]}`},
			call: func(client *managementapi.Client) error {
				_, err := client.ListAccountModels(context.Background(), accountRef)
				return err
			},
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			transport := &catalogSequenceHTTPClient{t: t, responses: []catalogResponse{testCase.response}}
			client, newErr := managementapi.New(transport, managementapi.Config{
				BaseURL:       "http://127.0.0.1:9527",
				ManagementKey: testManagementKey,
			})
			if newErr != nil {
				t.Fatalf("New() error = %v", newErr)
			}
			if callErr := testCase.call(client); !errors.Is(callErr, managementapi.ErrInvalidResponse) {
				t.Fatalf("call error = %v, want ErrInvalidResponse", callErr)
			}
		})
	}
}

// catalogResponse 是管理 API 合同测试使用的固定响应。
type catalogResponse struct {
	status int
	body   string
}

// catalogSequenceHTTPClient 记录 HTTP 方法、路径、正文和认证头。
type catalogSequenceHTTPClient struct {
	t         *testing.T
	responses []catalogResponse
	calls     int
	methods   []string
	paths     []string
	bodies    []string
}

// Do 返回顺序响应，并拒绝任何请求级密钥泄漏。
func (client *catalogSequenceHTTPClient) Do(request *http.Request) (*http.Response, error) {
	client.t.Helper()
	body, err := io.ReadAll(request.Body)
	if err != nil {
		client.t.Fatalf("ReadAll() error = %v", err)
	}
	if request.Header.Get("Authorization") != "Bearer "+testManagementKey ||
		strings.Contains(request.URL.String(), testManagementKey) {
		client.t.Fatalf("认证或 URL 无效: %s", request.URL)
	}
	if client.calls >= len(client.responses) {
		client.t.Fatalf("unexpected request %d", client.calls+1)
	}
	response := client.responses[client.calls]
	client.calls++
	client.methods = append(client.methods, request.Method)
	client.paths = append(client.paths, request.URL.RequestURI())
	client.bodies = append(client.bodies, string(body))
	return &http.Response{
		StatusCode: response.status,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(strings.NewReader(response.body)),
	}, nil
}

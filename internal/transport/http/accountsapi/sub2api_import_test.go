package accountsapi_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/internal/transport/http/accountsapi"
)

// TestHandlerImportsSub2APICodexAndClaudeAccounts 验证标准文档直接进入统一注册用例。
func TestHandlerImportsSub2APICodexAndClaudeAccounts(t *testing.T) {
	t.Parallel()

	codexIDToken := nativeTestJWT(t, map[string]any{
		"sub":   "http-sub2api-codex-user",
		"email": "http-sub2api-codex@example.invalid",
		"https://api.openai.com/auth": map[string]any{
			"chatgpt_account_id": "http-sub2api-codex-workspace",
			"chatgpt_plan_type":  "team",
		},
	})
	tests := []struct {
		name          string
		platform      string
		authType      string
		credentials   map[string]any
		extra         map[string]any
		expectedEmail string
		secret        string
		assertAuth    func(*testing.T, any)
	}{
		{
			name:     "codex oauth",
			platform: "openai",
			authType: "oauth",
			credentials: map[string]any{
				"access_token":       "synthetic-http-sub2api-codex-access",
				"refresh_token":      "synthetic-http-sub2api-codex-refresh",
				"id_token":           codexIDToken,
				"chatgpt_account_id": "http-sub2api-codex-workspace",
			},
			expectedEmail: "http-sub2api-codex@example.invalid",
			secret:        "synthetic-http-sub2api-codex-access",
			assertAuth: func(t *testing.T, credential any) {
				t.Helper()
				if _, valid := credential.(*codex.OAuthAuth); !valid {
					t.Fatalf("credential = %T, want *codex.OAuthAuth", credential)
				}
			},
		},
		{
			name:     "claude oauth",
			platform: "anthropic",
			authType: "oauth",
			credentials: map[string]any{
				"access_token":  "synthetic-http-sub2api-claude-access",
				"refresh_token": "synthetic-http-sub2api-claude-refresh",
				"expires_at":    int64(4_102_444_800),
				"scope":         "user:inference user:profile",
				"account_uuid":  "123e4567-e89b-12d3-a456-426614174321",
				"email_address": "http-sub2api-claude@example.invalid",
			},
			extra: map[string]any{
				"account_uuid":  "123e4567-e89b-12d3-a456-426614174321",
				"email_address": "http-sub2api-claude@example.invalid",
			},
			expectedEmail: "http-sub2api-claude@example.invalid",
			secret:        "synthetic-http-sub2api-claude-access",
			assertAuth: func(t *testing.T, credential any) {
				t.Helper()
				if _, valid := credential.(*claude.OAuthAuth); !valid {
					t.Fatalf("credential = %T, want *claude.OAuthAuth", credential)
				}
			},
		},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			service := newAccountServiceStub(t)
			response := performAuthorizedRequest(
				t,
				newTestHandler(t, service),
				http.MethodPost,
				accountsapi.Sub2APIImportPath,
				sub2APIHTTPDocument(
					t,
					test.platform,
					test.authType,
					test.credentials,
					test.extra,
				),
			)
			if response.Code != http.StatusCreated {
				t.Fatalf(
					"POST sub2api import status=%d body=%s",
					response.Code,
					response.Body,
				)
			}
			if service.registerCalls != 1 ||
				service.registeredCredential == nil {
				t.Fatalf(
					"sub2api 注册命令错误: calls=%d credential=%T",
					service.registerCalls,
					service.registeredCredential,
				)
			}
			test.assertAuth(t, service.registeredCredential)
			var document struct {
				Data struct {
					Email      string `json:"email"`
					HasProfile bool   `json:"has_profile"`
				} `json:"data"`
			}
			decodeResponseJSON(t, response, &document)
			if !document.Data.HasProfile ||
				document.Data.Email != test.expectedEmail {
				t.Fatalf("sub2api 导入响应错误: %#v", document.Data)
			}
			if strings.Contains(response.Body.String(), test.secret) {
				t.Fatal("sub2api 导入响应泄漏凭据")
			}
			assertSafeResponseHeaders(t, response)
		})
	}
}

// TestHandlerRejectsInvalidSub2APIImports 验证 HTTP 边界拒绝非单账号合同且不进入注册。
func TestHandlerRejectsInvalidSub2APIImports(t *testing.T) {
	t.Parallel()

	const secret = "synthetic-http-sub2api-secret-must-not-leak"
	validDocument := sub2APIHTTPDocument(
		t,
		"openai",
		"apikey",
		map[string]any{"api_key": secret},
		nil,
	)
	tests := []struct {
		name   string
		method string
		path   string
		body   []byte
		status int
		code   string
	}{
		{
			name:   "unsupported provider",
			method: http.MethodPost,
			path:   accountsapi.Sub2APIImportPath,
			body: sub2APIHTTPDocument(
				t,
				"gemini",
				"oauth",
				map[string]any{"access_token": secret},
				nil,
			),
			status: http.StatusUnprocessableEntity,
			code:   "invalid_sub2api_document",
		},
		{
			name:   "format version",
			method: http.MethodPost,
			path:   accountsapi.Sub2APIImportPath,
			body: []byte(
				`{"type":"sub2api-data","version":1,` +
					`"exported_at":"2026-07-31T08:09:10Z",` +
					`"proxies":[],"accounts":[]}`,
			),
			status: http.StatusUnprocessableEntity,
			code:   "invalid_sub2api_document",
		},
		{
			name:   "duplicate credential key",
			method: http.MethodPost,
			path:   accountsapi.Sub2APIImportPath,
			body: []byte(
				`{"type":"sub2api-data","exported_at":"2026-07-31T08:09:10Z",` +
					`"proxies":[],"accounts":[{"name":"duplicate",` +
					`"platform":"openai","type":"apikey","credentials":{` +
					`"api_key":"` + secret + `","api_key":"second"},` +
					`"concurrency":0,"priority":0}]}`,
			),
			status: http.StatusBadRequest,
			code:   "invalid_request",
		},
		{
			name:   "unexpected query",
			method: http.MethodPost,
			path:   accountsapi.Sub2APIImportPath + "?replace=true",
			body:   validDocument,
			status: http.StatusBadRequest,
			code:   "invalid_query",
		},
		{
			name:   "method not allowed",
			method: http.MethodGet,
			path:   accountsapi.Sub2APIImportPath,
			status: http.StatusMethodNotAllowed,
			code:   "method_not_allowed",
		},
		{
			name:   "request too large",
			method: http.MethodPost,
			path:   accountsapi.Sub2APIImportPath,
			body: []byte(
				`{"type":"sub2api-data","padding":"` +
					strings.Repeat("x", 1024*1024) +
					`"}`,
			),
			status: http.StatusRequestEntityTooLarge,
			code:   "request_too_large",
		},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			service := newAccountServiceStub(t)
			response := performAuthorizedRequest(
				t,
				newTestHandler(t, service),
				test.method,
				test.path,
				test.body,
			)
			assertAPIError(t, response, test.status, test.code)
			if service.registerCalls != 0 {
				t.Fatalf("无效 sub2api 导入进入注册用例: calls=%d", service.registerCalls)
			}
			if strings.Contains(response.Body.String(), secret) {
				t.Fatal("sub2api 导入错误响应泄漏凭据")
			}
			if test.method == http.MethodGet &&
				response.Header().Get("Allow") != http.MethodPost {
				t.Fatalf("Allow = %q, want POST", response.Header().Get("Allow"))
			}
		})
	}
}

// sub2APIHTTPDocument 创建 HTTP 测试使用的现行单账号迁移文档。
func sub2APIHTTPDocument(
	t *testing.T,
	platform string,
	authType string,
	credentials map[string]any,
	extra map[string]any,
) []byte {
	t.Helper()

	account := map[string]any{
		"name":        "synthetic-http-sub2api-account",
		"platform":    platform,
		"type":        authType,
		"credentials": credentials,
		"concurrency": 0,
		"priority":    0,
	}
	if extra != nil {
		account["extra"] = extra
	}
	return marshalRequestJSON(t, map[string]any{
		"type":        "sub2api-data",
		"exported_at": "2026-07-31T08:09:10Z",
		"proxies":     []any{},
		"accounts":    []any{account},
	})
}

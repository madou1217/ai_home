package accountsapi_test

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/internal/transport/http/accountsapi"
)

const (
	nativeCodexAccessToken   = "synthetic-http-native-codex-access"
	nativeCodexRefreshToken  = "synthetic-http-native-codex-refresh"
	nativeClaudeAccessToken  = "sk-ant-oat01-synthetic-http-native-access"
	nativeClaudeRefreshToken = "sk-ant-ort01-synthetic-http-native-refresh"
)

// TestHandlerImportsNativeCodexAndClaudeAccounts 验证官方 artifact 进入统一原子注册链路。
func TestHandlerImportsNativeCodexAndClaudeAccounts(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name             string
		providerID       string
		payload          func(*testing.T) []byte
		expectedEmail    string
		expectedMode     string
		expectedPlanKind string
		secrets          []string
	}{
		{
			name:             "codex oauth",
			providerID:       "codex",
			payload:          nativeCodexImportPayload,
			expectedEmail:    "http-native-codex@example.invalid",
			expectedPlanKind: "business",
			secrets: []string{
				nativeCodexAccessToken,
				nativeCodexRefreshToken,
			},
		},
		{
			name:             "claude oauth",
			providerID:       "claude",
			payload:          nativeClaudeImportPayload,
			expectedEmail:    "http-native-claude@example.invalid",
			expectedMode:     "refreshable",
			expectedPlanKind: "max",
			secrets: []string{
				nativeClaudeAccessToken,
				nativeClaudeRefreshToken,
			},
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			service := newAccountServiceStub(t)
			handler := newTestHandler(t, service)
			response := performAuthorizedRequest(
				t,
				handler,
				http.MethodPost,
				accountsapi.NativeImportPath,
				test.payload(t),
			)
			if response.Code != http.StatusCreated {
				t.Fatalf(
					"POST native import status=%d body=%s",
					response.Code,
					response.Body,
				)
			}
			if service.registerCalls != 1 ||
				service.registeredCredential == nil ||
				service.registeredCredential.ProviderID() != test.providerID ||
				service.registeredProfile == nil {
				t.Fatalf(
					"原生注册命令错误: calls=%d credential=%T profile=%T",
					service.registerCalls,
					service.registeredCredential,
					service.registeredProfile,
				)
			}
			var document struct {
				Data struct {
					ProviderID       string `json:"provider_id"`
					AuthKind         string `json:"auth_kind"`
					AuthMode         string `json:"auth_mode"`
					HasProfile       bool   `json:"has_profile"`
					Email            string `json:"email"`
					SubscriptionKind string `json:"subscription_kind"`
				} `json:"data"`
			}
			decodeResponseJSON(t, response, &document)
			if document.Data.ProviderID != test.providerID ||
				document.Data.AuthKind != "oauth" ||
				document.Data.AuthMode != test.expectedMode ||
				!document.Data.HasProfile ||
				document.Data.Email != test.expectedEmail ||
				document.Data.SubscriptionKind != test.expectedPlanKind {
				t.Fatalf("原生导入响应错误: %#v", document.Data)
			}
			for _, secret := range test.secrets {
				if strings.Contains(response.Body.String(), secret) {
					t.Fatal("原生导入响应泄漏凭据")
				}
			}
			assertSafeResponseHeaders(t, response)
		})
	}
}

// TestHandlerRejectsInvalidNativeImportRequests 验证路由、DTO 和 artifact 组合均失败关闭。
func TestHandlerRejectsInvalidNativeImportRequests(t *testing.T) {
	t.Parallel()

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
			path:   accountsapi.NativeImportPath,
			body: marshalRequestJSON(t, map[string]any{
				"provider_id": "gemini",
				"artifacts": map[string]any{
					"auth_json": map[string]any{},
				},
			}),
			status: http.StatusUnprocessableEntity,
			code:   "unsupported_provider",
		},
		{
			name:   "codex mixed artifacts",
			method: http.MethodPost,
			path:   accountsapi.NativeImportPath,
			body: marshalRequestJSON(t, map[string]any{
				"provider_id": "codex",
				"artifacts": map[string]any{
					"auth_json":        map[string]any{},
					"credentials_json": map[string]any{},
				},
			}),
			status: http.StatusUnprocessableEntity,
			code:   "invalid_native_artifacts",
		},
		{
			name:   "claude missing global config",
			method: http.MethodPost,
			path:   accountsapi.NativeImportPath,
			body: marshalRequestJSON(t, map[string]any{
				"provider_id": "claude",
				"artifacts": map[string]any{
					"credentials_json": map[string]any{},
				},
			}),
			status: http.StatusUnprocessableEntity,
			code:   "invalid_native_artifacts",
		},
		{
			name:   "invalid codex artifact",
			method: http.MethodPost,
			path:   accountsapi.NativeImportPath,
			body: []byte(
				`{"provider_id":"codex","artifacts":{` +
					`"auth_json":{"token":"must-not-leak"}}}`,
			),
			status: http.StatusUnprocessableEntity,
			code:   "invalid_native_artifacts",
		},
		{
			name:   "unexpected query",
			method: http.MethodPost,
			path:   accountsapi.NativeImportPath + "?replace=true",
			body:   nativeCodexImportPayload(t),
			status: http.StatusBadRequest,
			code:   "invalid_query",
		},
		{
			name:   "method not allowed",
			method: http.MethodGet,
			path:   accountsapi.NativeImportPath,
			status: http.StatusMethodNotAllowed,
			code:   "method_not_allowed",
		},
		{
			name:   "unknown request field",
			method: http.MethodPost,
			path:   accountsapi.NativeImportPath,
			body: []byte(
				`{"provider_id":"codex","replace":true,` +
					`"artifacts":{"auth_json":{}}}`,
			),
			status: http.StatusBadRequest,
			code:   "invalid_request",
		},
		{
			name:   "request too large",
			method: http.MethodPost,
			path:   accountsapi.NativeImportPath,
			body: []byte(
				`{"provider_id":"codex","artifacts":{"auth_json":{},` +
					`"padding":"` + strings.Repeat("x", 1024*1024) + `"}}`,
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
				t.Fatalf("无效导入进入注册用例: calls=%d", service.registerCalls)
			}
			if strings.Contains(response.Body.String(), "must-not-leak") {
				t.Fatal("原生导入错误响应泄漏 artifact")
			}
			if test.method == http.MethodGet &&
				response.Header().Get("Allow") != http.MethodPost {
				t.Fatalf("Allow = %q, want POST", response.Header().Get("Allow"))
			}
		})
	}
}

// nativeCodexImportPayload 创建携带官方 auth.json 对象的导入请求。
func nativeCodexImportPayload(t *testing.T) []byte {
	t.Helper()

	idToken := nativeTestJWT(t, map[string]any{
		"sub":   "http-native-codex-user",
		"email": "http-native-codex@example.invalid",
		"https://api.openai.com/auth": map[string]any{
			"chatgpt_account_id": "http-native-codex-workspace",
			"chatgpt_plan_type":  "team",
		},
	})
	return marshalRequestJSON(t, map[string]any{
		"provider_id": "codex",
		"artifacts": map[string]any{
			"auth_json": map[string]any{
				"auth_mode":      "chatgpt",
				"OPENAI_API_KEY": nil,
				"tokens": map[string]any{
					"id_token":      idToken,
					"access_token":  nativeCodexAccessToken,
					"refresh_token": nativeCodexRefreshToken,
					"account_id":    "http-native-codex-workspace",
				},
				"last_refresh": "2026-07-27T10:00:00Z",
			},
		},
	})
}

// nativeClaudeImportPayload 创建携带两个官方 Claude JSON 对象的导入请求。
func nativeClaudeImportPayload(t *testing.T) []byte {
	t.Helper()

	return marshalRequestJSON(t, map[string]any{
		"provider_id": "claude",
		"artifacts": map[string]any{
			"credentials_json": map[string]any{
				"claudeAiOauth": map[string]any{
					"accessToken":      nativeClaudeAccessToken,
					"refreshToken":     nativeClaudeRefreshToken,
					"expiresAt":        int64(4_102_444_800_000),
					"scopes":           []string{"user:inference", "user:profile"},
					"subscriptionType": "max",
					"rateLimitTier":    "default_claude_max_20x",
				},
			},
			"global_config_json": map[string]any{
				"oauthAccount": map[string]any{
					"accountUuid":  "123e4567-e89b-12d3-a456-426614174222",
					"emailAddress": "http-native-claude@example.invalid",
					"displayName":  "HTTP Native Claude",
				},
			},
		},
	})
}

// nativeTestJWT 创建可信本地 artifact 解析测试使用的无签名 JWT。
func nativeTestJWT(t *testing.T, payload map[string]any) string {
	t.Helper()

	header, err := json.Marshal(map[string]any{
		"alg": "none",
		"typ": "JWT",
	})
	if err != nil {
		t.Fatalf("json.Marshal(header) error = %v", err)
	}
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("json.Marshal(payload) error = %v", err)
	}
	return base64.RawURLEncoding.EncodeToString(header) + "." +
		base64.RawURLEncoding.EncodeToString(body) +
		".signature"
}

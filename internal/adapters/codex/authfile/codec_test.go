package authfile

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/core/accounts/codex"
)

const (
	testAccessToken  = "access-token-that-must-not-leak"
	testRefreshToken = "refresh-token-that-must-not-leak"
	testAPIKey       = "sk-api-key-that-must-not-leak"
)

func TestDecodeOAuthAuthFile(t *testing.T) {
	// 当前 Codex 原生文件允许 OAuth 省略可选 OPENAI_API_KEY。
	idToken := buildJWT(map[string]any{
		"sub":   "fallback-user",
		"email": "person@example.com",
		"https://api.openai.com/auth": map[string]any{
			"chatgpt_user_id":            "user-123",
			"chatgpt_account_id":         "workspace-456",
			"chatgpt_plan_type":          "team",
			"chatgpt_account_is_fedramp": true,
		},
	})
	accessToken := buildJWT(map[string]any{"exp": 2_000_000_000})
	data := mustJSON(t, map[string]any{
		"auth_mode": "chatgpt",
		"tokens": map[string]any{
			"id_token":      idToken,
			"access_token":  accessToken,
			"refresh_token": testRefreshToken,
			"account_id":    "workspace-456",
		},
		"last_refresh": "2023-11-14T22:13:20Z",
	})

	auth, err := Decode(data, DecodeOptions{})
	if err != nil {
		t.Fatalf("解析 OAuth auth.json 失败: %v", err)
	}
	oauth, ok := auth.(*codex.OAuthAuth)
	if !ok {
		t.Fatalf("认证类型错误: %T", auth)
	}
	if oauth.Kind() != codex.AuthKindOAuth {
		t.Fatalf("认证类型错误: %q", oauth.Kind())
	}
	if got, want := oauth.IdentitySeed(), "oauth:codex:user-123:workspace-456"; got != want {
		t.Fatalf("身份种子错误: got=%q want=%q", got, want)
	}
	if got, want := oauth.RefreshedAtMS(), int64(1_700_000_000_000); got != want {
		t.Fatalf("刷新时间错误: got=%d want=%d", got, want)
	}
	if !oauth.IsFedRAMP() {
		t.Fatal("应保留 FedRAMP 账号标记")
	}
}

func TestDecodeInfersOfficialAuthMode(t *testing.T) {
	// 官方 Codex 在 auth_mode 缺失或为 null 时，根据实际认证材料推导模式。
	idToken := buildJWT(map[string]any{"sub": "inferred-user"})
	tests := []struct {
		name     string
		document map[string]any
		wantKind codex.AuthKind
	}{
		{
			name: "缺少模式时由 tokens 推导 ChatGPT",
			document: map[string]any{
				"tokens": map[string]any{
					"id_token":      idToken,
					"access_token":  testAccessToken,
					"refresh_token": testRefreshToken,
				},
				"last_refresh": "2023-11-14T22:13:20Z",
			},
			wantKind: codex.AuthKindOAuth,
		},
		{
			name: "缺少模式时由 API Key 推导",
			document: map[string]any{
				"OPENAI_API_KEY": testAPIKey,
			},
			wantKind: codex.AuthKindAPIKey,
		},
		{
			name: "null 模式仍由 API Key 推导",
			document: map[string]any{
				"auth_mode":      nil,
				"OPENAI_API_KEY": testAPIKey,
			},
			wantKind: codex.AuthKindAPIKey,
		},
	}

	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			auth, err := Decode(mustJSON(t, testCase.document), DecodeOptions{})
			if err != nil {
				t.Fatalf("按官方规则推导认证模式失败: %v", err)
			}
			if got := auth.Kind(); got != testCase.wantKind {
				t.Fatalf("认证类型错误: got=%q want=%q", got, testCase.wantKind)
			}
		})
	}
}

func TestDecodeIgnoresUnknownOfficialExtensions(t *testing.T) {
	// 官方 Serde 允许新增字段；AIH 只读取已支持认证所需的固定子集。
	data := mustJSON(t, map[string]any{
		"tokens": map[string]any{
			"id_token":        buildJWT(map[string]any{"sub": "extended-user"}),
			"access_token":    testAccessToken,
			"refresh_token":   testRefreshToken,
			"future_metadata": map[string]any{"generation": 2},
		},
		"last_refresh":   "2023-11-14T22:13:20Z",
		"expired":        "legacy-export-metadata",
		"future_storage": map[string]any{"enabled": true},
	})

	auth, err := Decode(data, DecodeOptions{})
	if err != nil {
		t.Fatalf("新增可选字段破坏了 OAuth 解码: %v", err)
	}
	if auth.Kind() != codex.AuthKindOAuth {
		t.Fatalf("认证类型错误: %q", auth.Kind())
	}
}

func TestDecodeOAuthAllowsMissingOptionalMetadata(t *testing.T) {
	// 官方 TokenData.account_id 与 AuthDotJson.last_refresh 都是 Option。
	data := mustJSON(t, map[string]any{
		"auth_mode": "chatgpt",
		"tokens": map[string]any{
			"id_token":      buildJWT(map[string]any{"sub": "optional-user"}),
			"access_token":  testAccessToken,
			"refresh_token": testRefreshToken,
		},
	})

	auth, err := Decode(data, DecodeOptions{})
	if err != nil {
		t.Fatalf("可选 OAuth 元数据缺失时解码失败: %v", err)
	}
	oauth := auth.(*codex.OAuthAuth)
	if oauth.RefreshedAtMS() != 0 || oauth.AccountID() != codex.PersonalAccountID {
		t.Fatalf(
			"可选元数据语义错误: refreshed_at_ms=%d account_id=%q",
			oauth.RefreshedAtMS(),
			oauth.AccountID(),
		)
	}
	encoded, err := Encode(oauth)
	if err != nil {
		t.Fatalf("未知刷新时间无法重新编码: %v", err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &fields); err != nil {
		t.Fatalf("重新编码结果不是 JSON: %v", err)
	}
	if _, found := fields["last_refresh"]; found {
		t.Fatalf("未知刷新时间不应伪造成 last_refresh: %s", encoded)
	}
}

func TestDecodeAPIKeyAllowsOfficialNullableMetadata(t *testing.T) {
	// API Key 文件可以保留合法 last_refresh，null tokens 不构成混合凭据。
	data := mustJSON(t, map[string]any{
		"auth_mode":      "apikey",
		"OPENAI_API_KEY": testAPIKey,
		"tokens":         nil,
		"last_refresh":   "2023-11-14T22:13:20Z",
	})

	auth, err := Decode(data, DecodeOptions{})
	if err != nil {
		t.Fatalf("解析官方 API Key 元数据失败: %v", err)
	}
	if auth.Kind() != codex.AuthKindAPIKey {
		t.Fatalf("认证类型错误: %q", auth.Kind())
	}
}

func TestDecodeRejectsUnsupportedOfficialAuthModes(t *testing.T) {
	// AIH 当前只实现 ChatGPT OAuth 与 API Key，不把其他官方模式误判成已支持。
	for _, mode := range []string{
		"chatgptAuthTokens",
		"headers",
		"agentIdentity",
		"personalAccessToken",
		"bedrockApiKey",
	} {
		t.Run(mode, func(t *testing.T) {
			_, err := Decode(mustJSON(t, map[string]any{"auth_mode": mode}), DecodeOptions{})
			if !errors.Is(err, ErrInvalidAuthFile) {
				t.Fatalf("不支持模式错误不稳定: %v", err)
			}
		})
	}

	for _, document := range []map[string]any{
		{"personal_access_token": "pat-secret-that-must-not-leak"},
		{"bedrock_api_key": map[string]any{"secret": "bedrock-secret-that-must-not-leak"}},
		{
			"personal_access_token": "pat-secret-that-must-not-leak",
			"OPENAI_API_KEY":        testAPIKey,
		},
	} {
		_, err := Decode(mustJSON(t, document), DecodeOptions{})
		if !errors.Is(err, ErrInvalidAuthFile) {
			t.Fatalf("推导出的不支持模式错误不稳定: %v", err)
		}
		if !strings.Contains(err.Error(), "auth_mode 不受支持") {
			t.Fatalf("不支持模式被误判为结构错误: %v", err)
		}
	}
}

func TestDecodePersonalOAuthAuthFile(t *testing.T) {
	// account_id=null 且 ID Token 也没有工作区时，领域身份才回落到 personal。
	data := mustJSON(t, map[string]any{
		"auth_mode":      "chatgpt",
		"OPENAI_API_KEY": nil,
		"tokens": map[string]any{
			"id_token":      buildJWT(map[string]any{"sub": "personal-user"}),
			"access_token":  testAccessToken,
			"refresh_token": testRefreshToken,
			"account_id":    nil,
		},
		"last_refresh": "2023-11-14T22:13:20+00:00",
	})

	auth, err := Decode(data, DecodeOptions{})
	if err != nil {
		t.Fatalf("解析 personal OAuth auth.json 失败: %v", err)
	}
	oauth := auth.(*codex.OAuthAuth)
	if got, want := oauth.AccountID(), codex.PersonalAccountID; got != want {
		t.Fatalf("personal 上下文错误: got=%q want=%q", got, want)
	}
}

func TestDecodeNullAccountIDKeepsJWTWorkspace(t *testing.T) {
	// account_id=null 只表示没有显式值，ID Token claim 仍是工作区真相。
	data := mustJSON(t, map[string]any{
		"auth_mode":      "chatgpt",
		"OPENAI_API_KEY": nil,
		"tokens": map[string]any{
			"id_token": buildJWT(map[string]any{
				"sub": "workspace-user",
				"https://api.openai.com/auth": map[string]any{
					"chatgpt_account_id": "claim-workspace",
				},
			}),
			"access_token":  testAccessToken,
			"refresh_token": testRefreshToken,
			"account_id":    nil,
		},
		"last_refresh": "2023-11-14T22:13:20Z",
	})

	auth, err := Decode(data, DecodeOptions{})
	if err != nil {
		t.Fatalf("解析 claim 工作区失败: %v", err)
	}
	oauth := auth.(*codex.OAuthAuth)
	if got, want := oauth.AccountID(), "claim-workspace"; got != want {
		t.Fatalf("JWT 工作区丢失: got=%q want=%q", got, want)
	}
}

func TestDecodeAPIKeyAuthFileUsesOptionBaseURL(t *testing.T) {
	// 官方 auth.json 不保存 endpoint，适配器必须从显式选项注入。
	data := []byte(`{"auth_mode":"apikey","OPENAI_API_KEY":"sk-api-key-that-must-not-leak"}`)
	auth, err := Decode(data, DecodeOptions{APIKeyBaseURL: "HTTPS://API.EXAMPLE.COM:443/v1/"})
	if err != nil {
		t.Fatalf("解析 API Key auth.json 失败: %v", err)
	}
	apiKey, ok := auth.(*codex.APIKeyAuth)
	if !ok {
		t.Fatalf("认证类型错误: %T", auth)
	}
	if got, want := apiKey.BaseURL(), "https://api.example.com/v1"; got != want {
		t.Fatalf("Base URL 错误: got=%q want=%q", got, want)
	}
	if apiKey.APIKey() != testAPIKey {
		t.Fatal("API Key 没有按官方字段解码")
	}

	defaultAuth, err := Decode(data, DecodeOptions{})
	if err != nil {
		t.Fatalf("使用默认 Base URL 解析失败: %v", err)
	}
	if got, want := defaultAuth.(*codex.APIKeyAuth).BaseURL(), codex.DefaultAPIBaseURL; got != want {
		t.Fatalf("默认 Base URL 错误: got=%q want=%q", got, want)
	}
}

func TestEncodeOAuthAuthFile(t *testing.T) {
	// 编码结果只包含官方 OAuth 字段，并把毫秒时间转换成 RFC3339。
	idToken := buildJWT(map[string]any{
		"sub": "user-123",
		"https://api.openai.com/auth": map[string]any{
			"chatgpt_account_id": "workspace-456",
		},
	})
	oauth, err := codex.NewOAuthAuth(codex.OAuthInput{
		AccessToken:       testAccessToken,
		RefreshToken:      testRefreshToken,
		IDToken:           idToken,
		RefreshedAtMS:     1_700_000_000_123,
		ExplicitAccountID: "workspace-456",
	})
	if err != nil {
		t.Fatalf("构建 OAuth 认证失败: %v", err)
	}

	data, err := Encode(oauth)
	if err != nil {
		t.Fatalf("编码 OAuth auth.json 失败: %v", err)
	}
	var document map[string]json.RawMessage
	if err := json.Unmarshal(data, &document); err != nil {
		t.Fatalf("编码结果不是 JSON: %v", err)
	}
	assertJSONKeys(t, document, "auth_mode", "OPENAI_API_KEY", "tokens", "last_refresh")
	if got := string(document["OPENAI_API_KEY"]); got != "null" {
		t.Fatalf("OAuth OPENAI_API_KEY 必须为 null: %s", got)
	}
	var lastRefresh string
	if err := json.Unmarshal(document["last_refresh"], &lastRefresh); err != nil {
		t.Fatalf("last_refresh 类型错误: %v", err)
	}
	if got, want := lastRefresh, "2023-11-14T22:13:20.123Z"; got != want {
		t.Fatalf("last_refresh 错误: got=%q want=%q", got, want)
	}

	roundTrip, err := Decode(data, DecodeOptions{})
	if err != nil {
		t.Fatalf("OAuth 编码结果无法解码: %v", err)
	}
	if got, want := roundTrip.IdentitySeed(), oauth.IdentitySeed(); got != want {
		t.Fatalf("OAuth 往返身份变化: got=%q want=%q", got, want)
	}
}

func TestEncodePersonalOAuthUsesNullAccountID(t *testing.T) {
	// personal 上下文在线格式中必须还原成 account_id=null。
	oauth, err := codex.NewOAuthAuth(codex.OAuthInput{
		AccessToken:   testAccessToken,
		RefreshToken:  testRefreshToken,
		IDToken:       buildJWT(map[string]any{"sub": "personal-user"}),
		RefreshedAtMS: 1,
	})
	if err != nil {
		t.Fatalf("构建 personal OAuth 认证失败: %v", err)
	}
	data, err := Encode(oauth)
	if err != nil {
		t.Fatalf("编码 personal OAuth auth.json 失败: %v", err)
	}
	var document struct {
		Tokens map[string]json.RawMessage `json:"tokens"`
	}
	if err := json.Unmarshal(data, &document); err != nil {
		t.Fatalf("编码结果不是 JSON: %v", err)
	}
	if got := string(document.Tokens["account_id"]); got != "null" {
		t.Fatalf("personal account_id 必须为 null: %s", got)
	}
}

func TestEncodeAPIKeyAuthFileOmitsEndpoint(t *testing.T) {
	// API Key endpoint 属于 AIH 领域配置，不能污染官方 auth.json。
	apiKey, err := codex.NewAPIKeyAuth(codex.APIKeyInput{
		APIKey:  testAPIKey,
		BaseURL: "https://api.example.com/v1",
	})
	if err != nil {
		t.Fatalf("构建 API Key 认证失败: %v", err)
	}
	data, err := Encode(apiKey)
	if err != nil {
		t.Fatalf("编码 API Key auth.json 失败: %v", err)
	}
	var document map[string]json.RawMessage
	if err := json.Unmarshal(data, &document); err != nil {
		t.Fatalf("编码结果不是 JSON: %v", err)
	}
	assertJSONKeys(t, document, "auth_mode", "OPENAI_API_KEY")
	if strings.Contains(string(data), "api.example.com") {
		t.Fatal("官方 auth.json 泄漏了 AIH endpoint")
	}

	roundTrip, err := Decode(data, DecodeOptions{APIKeyBaseURL: apiKey.BaseURL()})
	if err != nil {
		t.Fatalf("API Key 编码结果无法解码: %v", err)
	}
	if got, want := roundTrip.IdentitySeed(), apiKey.IdentitySeed(); got != want {
		t.Fatalf("API Key 往返身份变化: got=%q want=%q", got, want)
	}
}

func TestDecodeRejectsInvalidAndMixedAuthFiles(t *testing.T) {
	// 严格适配器拒绝已知字段拼写错误、重复字段和混合凭证。
	validIDToken := buildJWT(map[string]any{"sub": "user-123"})
	validTokens := map[string]any{
		"id_token":      validIDToken,
		"access_token":  testAccessToken,
		"refresh_token": testRefreshToken,
		"account_id":    nil,
	}
	tests := []struct {
		name string
		data []byte
	}{
		{name: "畸形 JSON", data: []byte(`{"auth_mode":`)},
		{name: "非法 UTF-8", data: []byte{'{', '"', 0xff, '"', ':', '1', '}'}},
		{name: "尾随 JSON", data: []byte(`{"auth_mode":"apikey","OPENAI_API_KEY":"key"}{}`)},
		{name: "未知模式", data: mustJSON(t, map[string]any{"auth_mode": "oauth", "OPENAI_API_KEY": nil})},
		{name: "顶层字段大小写不匹配", data: []byte(`{"AUTH_MODE":"apikey","OPENAI_API_KEY":"key"}`)},
		{name: "重复认证模式", data: []byte(`{"auth_mode":"apikey","auth_mode":"chatgpt","OPENAI_API_KEY":"key"}`)},
		{name: "OAuth 混入 API Key", data: mustJSON(t, map[string]any{"auth_mode": "chatgpt", "OPENAI_API_KEY": testAPIKey, "tokens": validTokens, "last_refresh": "2023-11-14T22:13:20Z"})},
		{name: "OAuth 混入 Agent Identity", data: mustJSON(t, map[string]any{"auth_mode": "chatgpt", "agent_identity": "agent-secret", "tokens": validTokens, "last_refresh": "2023-11-14T22:13:20Z"})},
		{name: "OAuth 混入 PAT", data: mustJSON(t, map[string]any{"auth_mode": "chatgpt", "personal_access_token": "pat-secret", "tokens": validTokens, "last_refresh": "2023-11-14T22:13:20Z"})},
		{name: "OAuth 混入 Bedrock Key", data: mustJSON(t, map[string]any{"auth_mode": "chatgpt", "bedrock_api_key": map[string]any{"secret": "bedrock-secret"}, "tokens": validTokens, "last_refresh": "2023-11-14T22:13:20Z"})},
		{name: "OAuth 缺少 tokens", data: mustJSON(t, map[string]any{"auth_mode": "chatgpt", "OPENAI_API_KEY": nil, "last_refresh": "2023-11-14T22:13:20Z"})},
		{name: "OAuth tokens 为 null", data: mustJSON(t, map[string]any{"auth_mode": "chatgpt", "OPENAI_API_KEY": nil, "tokens": nil, "last_refresh": "2023-11-14T22:13:20Z"})},
		{name: "OAuth token 字段大小写不匹配", data: []byte(`{"auth_mode":"chatgpt","OPENAI_API_KEY":null,"tokens":{"ID_TOKEN":"` + validIDToken + `","access_token":"token","refresh_token":"refresh","account_id":null},"last_refresh":"2023-11-14T22:13:20Z"}`)},
		{name: "OAuth 重复 access token", data: []byte(`{"auth_mode":"chatgpt","OPENAI_API_KEY":null,"tokens":{"id_token":"` + validIDToken + `","access_token":"first","access_token":"second","refresh_token":"refresh","account_id":null},"last_refresh":"2023-11-14T22:13:20Z"}`)},
		{name: "OAuth 空 token", data: mustJSON(t, map[string]any{"auth_mode": "chatgpt", "OPENAI_API_KEY": nil, "tokens": map[string]any{"id_token": validIDToken, "access_token": "", "refresh_token": testRefreshToken, "account_id": nil}, "last_refresh": "2023-11-14T22:13:20Z"})},
		{name: "OAuth 空 account_id", data: mustJSON(t, map[string]any{"auth_mode": "chatgpt", "OPENAI_API_KEY": nil, "tokens": map[string]any{"id_token": validIDToken, "access_token": testAccessToken, "refresh_token": testRefreshToken, "account_id": ""}, "last_refresh": "2023-11-14T22:13:20Z"})},
		{name: "OAuth 非法刷新时间", data: mustJSON(t, map[string]any{"auth_mode": "chatgpt", "OPENAI_API_KEY": nil, "tokens": validTokens, "last_refresh": "yesterday"})},
		{name: "API Key 缺失", data: mustJSON(t, map[string]any{"auth_mode": "apikey"})},
		{name: "API Key 为 null", data: mustJSON(t, map[string]any{"auth_mode": "apikey", "OPENAI_API_KEY": nil})},
		{name: "API Key 为空", data: mustJSON(t, map[string]any{"auth_mode": "apikey", "OPENAI_API_KEY": ""})},
		{name: "API Key 包含未配对代理项", data: []byte(`{"auth_mode":"apikey","OPENAI_API_KEY":"\ud800"}`)},
		{name: "API Key 混入 tokens", data: mustJSON(t, map[string]any{"auth_mode": "apikey", "OPENAI_API_KEY": testAPIKey, "tokens": validTokens})},
		{name: "API Key 混入 Agent Identity", data: mustJSON(t, map[string]any{"auth_mode": "apikey", "OPENAI_API_KEY": testAPIKey, "agent_identity": "agent-secret"})},
		{name: "API Key 混入 PAT", data: mustJSON(t, map[string]any{"auth_mode": "apikey", "OPENAI_API_KEY": testAPIKey, "personal_access_token": "pat-secret"})},
		{name: "API Key 混入 Bedrock Key", data: mustJSON(t, map[string]any{"auth_mode": "apikey", "OPENAI_API_KEY": testAPIKey, "bedrock_api_key": map[string]any{"secret": "bedrock-secret"}})},
		{name: "API Key 非法刷新时间", data: mustJSON(t, map[string]any{"auth_mode": "apikey", "OPENAI_API_KEY": testAPIKey, "last_refresh": "yesterday"})},
	}

	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			_, err := Decode(testCase.data, DecodeOptions{})
			if err == nil {
				t.Fatal("无效 auth.json 应被拒绝")
			}
			if !errors.Is(err, ErrInvalidAuthFile) {
				t.Fatalf("错误类型不稳定: %v", err)
			}
			assertDoesNotContain(t, err.Error(), testAPIKey, testAccessToken, testRefreshToken, validIDToken)
		})
	}
}

func TestDecodeRejectsWorkspaceMismatchWithoutLeakingTokens(t *testing.T) {
	// 领域一致性错误也必须经过不泄密的适配器错误边界。
	idToken := buildJWT(map[string]any{
		"sub": "user-123",
		"https://api.openai.com/auth": map[string]any{
			"chatgpt_account_id": "claim-workspace",
		},
	})
	data := mustJSON(t, map[string]any{
		"auth_mode":      "chatgpt",
		"OPENAI_API_KEY": nil,
		"tokens": map[string]any{
			"id_token":      idToken,
			"access_token":  testAccessToken,
			"refresh_token": testRefreshToken,
			"account_id":    "explicit-workspace",
		},
		"last_refresh": "2023-11-14T22:13:20Z",
	})

	_, err := Decode(data, DecodeOptions{})
	if err == nil {
		t.Fatal("工作区不一致必须被拒绝")
	}
	assertDoesNotContain(t, err.Error(), idToken, testAccessToken, testRefreshToken)
}

func TestEncodeRejectsNilAuth(t *testing.T) {
	// 编码器不接受缺失或带类型的 nil 领域对象。
	if _, err := Encode(nil); !errors.Is(err, ErrInvalidAuthFile) {
		t.Fatalf("nil Auth 错误不稳定: %v", err)
	}
	var oauth *codex.OAuthAuth
	if _, err := Encode(oauth); !errors.Is(err, ErrInvalidAuthFile) {
		t.Fatalf("typed nil Auth 错误不稳定: %v", err)
	}
	if _, err := Encode(&codex.OAuthAuth{}); !errors.Is(err, ErrInvalidAuthFile) {
		t.Fatalf("OAuth 零值错误不稳定: %v", err)
	}
	var apiKey *codex.APIKeyAuth
	if _, err := Encode(apiKey); !errors.Is(err, ErrInvalidAuthFile) {
		t.Fatalf("typed nil API Key 错误不稳定: %v", err)
	}
	if _, err := Encode(&codex.APIKeyAuth{}); !errors.Is(err, ErrInvalidAuthFile) {
		t.Fatalf("API Key 零值错误不稳定: %v", err)
	}
}

func FuzzDecodeDoesNotPanicOrLeakSecrets(f *testing.F) {
	// 模糊输入只能得到领域对象或脱敏错误，不能触发 panic。
	f.Add([]byte(`{"auth_mode":"apikey","OPENAI_API_KEY":"sk-fuzz-secret-that-must-not-leak"}`), "https://api.openai.com/v1")
	f.Add([]byte(`{"auth_mode":"chatgpt","OPENAI_API_KEY":null,"tokens":{}}`), "")
	f.Add([]byte(`{"auth_mode":"chatgpt","OPENAI_API_KEY":null,"tokens":{"id_token":"malformed-jwt-secret-marker","access_token":"access","refresh_token":"refresh","account_id":null},"last_refresh":"2023-11-14T22:13:20Z"}`), "")
	f.Add([]byte(`not-json`), "https://example.com/v1")

	f.Fuzz(func(t *testing.T, data []byte, baseURL string) {
		_, err := Decode(data, DecodeOptions{APIKeyBaseURL: baseURL})
		if err != nil {
			assertDoesNotContain(t, err.Error(), "sk-fuzz-secret-that-must-not-leak", "malformed-jwt-secret-marker")
		}
	})
}

func buildJWT(payload map[string]any) string {
	// 测试 JWT 不签名；领域层这里只解析可信登录产物的 claims。
	headerJSON, _ := json.Marshal(map[string]any{"alg": "none", "typ": "JWT"})
	payloadJSON, _ := json.Marshal(payload)
	return base64.RawURLEncoding.EncodeToString(headerJSON) + "." +
		base64.RawURLEncoding.EncodeToString(payloadJSON) + ".signature"
}

func mustJSON(t *testing.T, value any) []byte {
	// 测试夹具编码失败属于测试本身错误。
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("构建 JSON 夹具失败: %v", err)
	}
	return data
}

func assertJSONKeys(t *testing.T, document map[string]json.RawMessage, expected ...string) {
	// 精确键集合可以阻止领域字段意外泄漏到官方文件。
	t.Helper()
	if len(document) != len(expected) {
		t.Fatalf("JSON 字段数量错误: got=%d want=%d", len(document), len(expected))
	}
	for _, key := range expected {
		if _, ok := document[key]; !ok {
			t.Fatalf("JSON 缺少字段 %q", key)
		}
	}
}

func assertDoesNotContain(t *testing.T, text string, secrets ...string) {
	// 错误和摘要不能回显任何原始凭证。
	t.Helper()
	for _, secret := range secrets {
		if secret != "" && strings.Contains(text, secret) {
			t.Fatalf("文本泄漏秘密: %q", text)
		}
	}
}

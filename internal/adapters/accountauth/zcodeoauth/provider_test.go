package zcodeoauth

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/application/accountauth"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
)

// newTestProvider 用可注入端点与固定随机源创建 Provider。
func newTestProvider(t *testing.T, endpoint string, regionID string) *Provider {
	t.Helper()
	provider, err := newProvider(providerOptions{
		client:        &http.Client{},
		random:        bytes.NewReader(bytes.Repeat([]byte{0x2a}, 64)),
		region:        resolveRegion(regionID),
		tokenEndpoint: endpoint,
	})
	if err != nil {
		t.Fatalf("newProvider() error = %v", err)
	}
	return provider
}

// beginFlow 创建一次待完成的授权流程。
func beginFlow(t *testing.T, provider *Provider) *flow {
	t.Helper()
	flowValue, err := provider.Begin(context.Background())
	if err != nil {
		t.Fatalf("Begin() error = %v", err)
	}
	typed, ok := flowValue.(*flow)
	if !ok {
		t.Fatalf("Begin() flow type = %T", flowValue)
	}
	return typed
}

// fakeJWT 生成只用于身份一致性校验的 JWT（签名段是占位，解码器不验签）。
func fakeJWT(t *testing.T, claims map[string]any) string {
	t.Helper()
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatalf("marshal claims: %v", err)
	}
	return "eyJhbGciOiJub25lIn0." + base64.RawURLEncoding.EncodeToString(payload) + ".sig"
}

func TestProviderImplementsOAuthProvider(t *testing.T) {
	var provider accountauth.OAuthProvider = newTestProvider(t, "https://example.test/token", "zai")
	if provider.ProviderID() != "zcode" {
		t.Fatalf("ProviderID() = %q, want zcode", provider.ProviderID())
	}
}

func TestBeginBuildsOfficialAuthorizationURL(t *testing.T) {
	cases := []struct {
		name       string
		region     string
		wantHost   string
		wantPath   string
		wantParams map[string]string
		absent     []string
	}{
		{
			name:     "zai",
			region:   "zai",
			wantHost: "chat.z.ai",
			wantPath: "/api/oauth/authorize",
			wantParams: map[string]string{
				"response_type": "code",
				"client_id":     "client_P8X5CMWmlaRO9gyO-KSqtg",
				"redirect_uri":  "zcode://oauth/callback",
			},
			absent: []string{"appId", "redirect"},
		},
		{
			name:     "bigmodel",
			region:   "bigmodel",
			wantHost: "bigmodel.cn",
			wantPath: "/login",
			wantParams: map[string]string{
				"appId":    "zcode",
				"redirect": "zcode://oauth/callback",
			},
			absent: []string{"client_id", "redirect_uri", "response_type"},
		},
		{
			name:     "unknown region falls back to zai",
			region:   "mars",
			wantHost: "chat.z.ai",
			wantPath: "/api/oauth/authorize",
			wantParams: map[string]string{
				"client_id": "client_P8X5CMWmlaRO9gyO-KSqtg",
			},
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			provider := newTestProvider(t, "https://example.test/token", testCase.region)
			flowValue := beginFlow(t, provider)
			parsed, err := url.Parse(flowValue.AuthorizationURL())
			if err != nil {
				t.Fatalf("authorization URL 无效: %v", err)
			}
			if parsed.Host != testCase.wantHost || parsed.Path != testCase.wantPath {
				t.Fatalf("authorization = %s%s, want %s%s",
					parsed.Host, parsed.Path, testCase.wantHost, testCase.wantPath)
			}
			for key, want := range testCase.wantParams {
				if got := parsed.Query().Get(key); got != want {
					t.Fatalf("%s = %q, want %q", key, got, want)
				}
			}
			for _, key := range testCase.absent {
				if got := parsed.Query().Get(key); got != "" {
					t.Fatalf("%s = %q, want absent", key, got)
				}
			}
			// state 必须是 32 字节 base64url（与 Node 的 createOauthState 同长度）。
			state := parsed.Query().Get("state")
			decoded, err := base64.RawURLEncoding.DecodeString(state)
			if err != nil || len(decoded) != 32 {
				t.Fatalf("state = %q (bytes %d, err %v)", state, len(decoded), err)
			}
		})
	}
}

func TestNewRejectsInvalidDependencies(t *testing.T) {
	if _, err := New(nil); err == nil {
		t.Fatal("New(nil) 必须失败")
	}
	if _, err := newProvider(providerOptions{
		client:        &http.Client{},
		random:        bytes.NewReader([]byte{1}),
		region:        regions["zai"],
		tokenEndpoint: "http://user:pass@example.test/token",
	}); err == nil {
		t.Fatal("带凭据的 token endpoint 必须失败")
	}
}

func TestBuildArtifactsStayCompatibleWithNativeDecoder(t *testing.T) {
	const userID = "4a1c9d2e-0000-4000-8000-000000000001"
	flowValue := beginFlow(t, newTestProvider(t, "https://example.test/token", "zai"))
	artifacts, err := flowValue.buildArtifacts(exchangeResult{
		accessToken:  "zai-access",
		refreshToken: "zai-refresh",
		zcodeJWToken: fakeJWT(t, map[string]any{"user_id": userID}),
		user: map[string]any{
			"user_id": userID,
			"email":   "user@example.test",
			"name":    "ZCode User",
		},
	})
	if err != nil {
		t.Fatalf("buildArtifacts() error = %v", err)
	}
	// 用真实解码器验证：artifact 必须能注册成账号，且身份取 user_id。
	if _, _, err := nativeaccount.NewDecoder().Decode("zcode", artifacts); err != nil {
		t.Fatalf("native decoder 拒绝 artifact: %v", err)
	}
	var envelope struct {
		NativeAuth struct {
			Credentials map[string]any `json:"credentials"`
		} `json:"native_auth_json"`
	}
	if err := json.Unmarshal(artifacts, &envelope); err != nil {
		t.Fatalf("artifact 不是合法 JSON: %v", err)
	}
	credentials := envelope.NativeAuth.Credentials
	for key, want := range map[string]string{
		"oauth:active_provider":   "zai",
		"oauth:zai:access_token":  "zai-access",
		"oauth:zai:refresh_token": "zai-refresh",
	} {
		if got, _ := credentials[key].(string); got != want {
			t.Fatalf("%s = %q, want %q", key, got, want)
		}
	}
	userInfo, ok := credentials["oauth:zai:user_info"].(string)
	if !ok {
		t.Fatalf("user_info = %T, want string", credentials["oauth:zai:user_info"])
	}
	var profile map[string]any
	if err := json.Unmarshal([]byte(userInfo), &profile); err != nil {
		t.Fatalf("user_info 不是 JSON: %v", err)
	}
	if profile["user_id"] != userID || profile["displayName"] != "ZCode User" {
		t.Fatalf("user_info = %v", profile)
	}
	// 凭据不能以密文形式出现：解码器会拒绝 enc:v1:。
	for key, value := range credentials {
		if text, _ := value.(string); strings.HasPrefix(text, "enc:v1:") {
			t.Fatalf("%s 是密文，账号注册链无法解码", key)
		}
	}
	if claims := flowValue.AccountClaims(); claims.Email != "user@example.test" || claims.DisplayName != "ZCode User" {
		t.Fatalf("AccountClaims() = %+v", claims)
	}
}

func TestBuildArtifactsUseRegionKeyPrefix(t *testing.T) {
	const userID = "user-bigmodel"
	flowValue := beginFlow(t, newTestProvider(t, "https://example.test/token", "bigmodel"))
	artifacts, err := flowValue.buildArtifacts(exchangeResult{
		accessToken:  "bm-access",
		zcodeJWToken: fakeJWT(t, map[string]any{"user_id": userID}),
		user:         map[string]any{"user_id": userID, "email": "bm@example.test"},
	})
	if err != nil {
		t.Fatalf("buildArtifacts() error = %v", err)
	}
	if _, _, err := nativeaccount.NewDecoder().Decode("zcode", artifacts); err != nil {
		t.Fatalf("native decoder 拒绝 bigmodel artifact: %v", err)
	}
	var envelope struct {
		NativeAuth struct {
			Credentials map[string]any `json:"credentials"`
		} `json:"native_auth_json"`
	}
	if err := json.Unmarshal(artifacts, &envelope); err != nil {
		t.Fatalf("artifact 不是合法 JSON: %v", err)
	}
	credentials := envelope.NativeAuth.Credentials
	if credentials["oauth:active_provider"] != "bigmodel" || credentials["oauth:bigmodel:access_token"] != "bm-access" {
		t.Fatalf("bigmodel credentials = %v", credentials)
	}
	if _, found := credentials["oauth:zai:access_token"]; found {
		t.Fatal("bigmodel 不应写入 zai 键")
	}
}


func TestBeginWithOptionsSwitchesRegionAndExposesState(t *testing.T) {
	for _, tc := range []struct {
		name         string
		strategy     string
		wantHost     string
		wantStrategy string
	}{
		{name: "bigmodel_custom", strategy: "bigmodel:custom-scheme", wantHost: "bigmodel.cn", wantStrategy: "bigmodel:custom-scheme"},
		{name: "bigmodel_cli", strategy: "bigmodel:cli-flow", wantHost: "bigmodel.cn", wantStrategy: "bigmodel:custom-scheme"},
		{name: "zai_cli", strategy: "zai:cli-flow", wantHost: "chat.z.ai", wantStrategy: "zai:custom-scheme"},
		{name: "empty", strategy: "", wantHost: "chat.z.ai", wantStrategy: ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			provider := newTestProvider(t, "https://example.test/token", "zai")
			flowValue, err := provider.BeginWithOptions(context.Background(), accountauth.BeginOptions{
				AuthStrategy: tc.strategy,
			})
			if err != nil {
				t.Fatalf("BeginWithOptions(%q) error = %v", tc.strategy, err)
			}
			parsed, err := url.Parse(flowValue.AuthorizationURL())
			if err != nil {
				t.Fatalf("url.Parse() error = %v", err)
			}
			if parsed.Host != tc.wantHost {
				t.Fatalf("Host = %q, want %q", parsed.Host, tc.wantHost)
			}
			if sp, ok := flowValue.(accountauth.StateProvider); !ok || sp.OAuthState() == "" {
				t.Fatalf("OAuthState() missing or empty on %T", flowValue)
			} else if parsed.Query().Get("state") != sp.OAuthState() {
				t.Fatalf("url state %q != OAuthState() %q", parsed.Query().Get("state"), sp.OAuthState())
			}
			if asp, ok := flowValue.(accountauth.AuthStrategyProvider); !ok || asp.AuthStrategy() != tc.wantStrategy {
				t.Fatalf("AuthStrategy() = %q, want %q", asp.AuthStrategy(), tc.wantStrategy)
			}
		})
	}

	provider := newTestProvider(t, "https://example.test/token", "zai")
	if _, err := provider.BeginWithOptions(context.Background(), accountauth.BeginOptions{AuthStrategy: "unknown"}); !errors.Is(err, accountauth.ErrUnsupportedAuthStrategy) {
		t.Fatalf("unknown strategy error = %v, want ErrUnsupportedAuthStrategy", err)
	}
	if _, err := provider.BeginWithOptions(context.Background(), accountauth.BeginOptions{LoginProvider: "Google"}); !errors.Is(err, accountauth.ErrUnsupportedLoginProvider) {
		t.Fatalf("loginProvider error = %v, want ErrUnsupportedLoginProvider", err)
	}
}

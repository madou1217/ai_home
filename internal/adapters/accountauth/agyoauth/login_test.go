package agyoauth

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountauth"
	"github.com/madou1217/ai_home/core/accounts/agy"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
)

// agyTestNow 固定 artifact 时间。
func agyTestNow() time.Time {
	return time.Date(2026, time.November, 8, 16, 0, 0, 0, time.UTC)
}

// agyFakeGoogle 记录 token 请求并按 secret 决定成功或 invalid_client。
//
// tokenResponse / userInfoStatus / userInfoBody 可替换成功响应，用于覆盖
// id_token、缺字段与 userinfo 失败等分支；默认值即 Node 生产响应的最小形状。
type agyFakeGoogle struct {
	mu                sync.Mutex
	server            *httptest.Server
	acceptSecretIndex int
	tokenCalls        int
	secrets           []string
	forms             []url.Values
	userInfoHit       int
	tokenResponse     string
	userInfoStatus    int
	userInfoBody      string
}

func newAgyFakeGoogle(t *testing.T, acceptSecretIndex int) *agyFakeGoogle {
	t.Helper()
	fake := &agyFakeGoogle{acceptSecretIndex: acceptSecretIndex, userInfoStatus: http.StatusOK}
	fake.server = httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/token":
			fake.mu.Lock()
			fake.tokenCalls++
			index := fake.tokenCalls - 1
			_ = request.ParseForm()
			fake.forms = append(fake.forms, request.PostForm)
			fake.secrets = append(fake.secrets, request.PostForm.Get("client_secret"))
			fake.mu.Unlock()
			writer.Header().Set("Content-Type", "application/json")
			if index != fake.acceptSecretIndex {
				writer.WriteHeader(http.StatusBadRequest)
				_, _ = io.WriteString(writer, `{"error":"invalid_client"}`)
				return
			}
			payload := fake.tokenResponse
			if payload == "" {
				payload = `{"access_token":"agy-access","refresh_token":"agy-refresh","expires_in":3600,"token_type":"Bearer"}`
			}
			_, _ = io.WriteString(writer, payload)
		case "/userinfo":
			fake.mu.Lock()
			fake.userInfoHit++
			auth := request.Header.Get("Authorization")
			status := fake.userInfoStatus
			body := fake.userInfoBody
			fake.mu.Unlock()
			if status != http.StatusOK {
				writer.WriteHeader(status)
				return
			}
			if auth != "Bearer agy-access" {
				writer.WriteHeader(http.StatusUnauthorized)
				return
			}
			writer.Header().Set("Content-Type", "application/json")
			if body == "" {
				body = `{"email":"agy@example.test"}`
			}
			_, _ = io.WriteString(writer, body)
		default:
			writer.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(fake.server.Close)
	return fake
}

func newAgyFlow(t *testing.T, fake *agyFakeGoogle) *loginFlow {
	t.Helper()
	provider, err := newLoginProvider(loginOptions{
		client:            fake.server.Client(),
		clock:             agyTestNow,
		random:            rand.Reader,
		authorizeEndpoint: fake.server.URL + "/authorize",
		tokenEndpoint:     fake.server.URL + "/token",
		userInfoEndpoint:  fake.server.URL + "/userinfo",
		redirectURI:       defaultLoginRedirect,
		clientID:          "agy-client",
		clientSecrets:     []string{"secret-old", "secret-new"},
	})
	if err != nil {
		t.Fatalf("newLoginProvider() error = %v", err)
	}
	value, err := provider.Begin(context.Background())
	if err != nil {
		t.Fatalf("Begin() error = %v", err)
	}
	typed, ok := value.(*loginFlow)
	if !ok {
		t.Fatalf("Begin() flow type = %T", value)
	}
	return typed
}

// TestAgyBeginBuildsGoogleAuthorizationURL 验证与 Node 生产路径一致的授权参数。
func TestAgyBeginBuildsGoogleAuthorizationURL(t *testing.T) {
	fake := newAgyFakeGoogle(t, 0)
	flowValue := newAgyFlow(t, fake)
	parsed, err := url.Parse(flowValue.AuthorizationURL())
	if err != nil {
		t.Fatalf("parse url: %v", err)
	}
	query := parsed.Query()
	if query.Get("client_id") != "agy-client" ||
		query.Get("redirect_uri") != defaultLoginRedirect ||
		query.Get("response_type") != "code" ||
		query.Get("access_type") != "offline" ||
		query.Get("prompt") != "consent" ||
		query.Get("scope") != loginScope ||
		query.Get("state") == "" ||
		query.Get("code_challenge") != "" {
		t.Fatalf("authorization query = %v", query)
	}
}

// TestAgyExchangeFallsBackToRotatedSecret 验证 invalid_client 时换 secret 重试。
func TestAgyExchangeFallsBackToRotatedSecret(t *testing.T) {
	fake := newAgyFakeGoogle(t, 1)
	flowValue := newAgyFlow(t, fake)
	state := flowValue.state
	callback := defaultLoginRedirect + "?code=agy-code&state=" + url.QueryEscape(state) + "&authuser=0&prompt=consent"

	artifacts, err := flowValue.Exchange(context.Background(), callback)
	if err != nil {
		t.Fatalf("Exchange() error = %v", err)
	}
	if fake.tokenCalls != 2 {
		t.Fatalf("token calls = %d, want 2", fake.tokenCalls)
	}
	if fake.secrets[0] != "secret-old" || fake.secrets[1] != "secret-new" {
		t.Fatalf("secret order = %v", fake.secrets)
	}
	if fake.forms[1].Get("code") != "agy-code" ||
		fake.forms[1].Get("grant_type") != "authorization_code" ||
		fake.forms[1].Get("redirect_uri") != defaultLoginRedirect {
		t.Fatalf("token form = %v", fake.forms[1])
	}
	if fake.userInfoHit != 1 {
		t.Fatalf("userinfo hits = %d, want 1（无 id_token 时应补邮箱）", fake.userInfoHit)
	}
	if claims := flowValue.AccountClaims(); claims.Email != "agy@example.test" {
		t.Fatalf("AccountClaims() = %+v", claims)
	}
	// artifact 必须能被生产 decoder 严格解析（字段形状即合同）。
	credential, profile, err := nativeaccount.NewDecoder().Decode("agy", artifacts)
	if err != nil {
		t.Fatalf("Decode() error = %v: %s", err, artifacts)
	}
	if credential.ProviderID() != "agy" {
		t.Fatalf("credential provider = %q", credential.ProviderID())
	}
	if profile != nil && profile.Email() != "agy@example.test" {
		t.Fatalf("profile email = %q", profile.Email())
	}
}

// TestAgyExchangeRejectsStateMismatch 验证 state 不一致时不打 token 端点。
func TestAgyExchangeRejectsStateMismatch(t *testing.T) {
	fake := newAgyFakeGoogle(t, 0)
	flowValue := newAgyFlow(t, fake)
	callback := defaultLoginRedirect + "?code=agy-code&state=forged"
	if _, err := flowValue.Exchange(context.Background(), callback); !errors.Is(err, accountauth.ErrStateMismatch) {
		t.Fatalf("Exchange() error = %v, want ErrStateMismatch", err)
	}
	if fake.tokenCalls != 0 {
		t.Fatalf("state 不匹配时不得调用 token endpoint: %d", fake.tokenCalls)
	}
}

// TestAgyExchangeRejectsInvalidClient 验证两个 secret 都被拒绝时收敛为 provider_rejected。
func TestAgyExchangeRejectsInvalidClient(t *testing.T) {
	fake := newAgyFakeGoogle(t, -1)
	flowValue := newAgyFlow(t, fake)
	callback := defaultLoginRedirect + "?code=agy-code&state=" + url.QueryEscape(flowValue.state)
	if _, err := flowValue.Exchange(context.Background(), callback); !errors.Is(err, accountauth.ErrProviderRejected) {
		t.Fatalf("Exchange() error = %v, want ErrProviderRejected", err)
	}
	if fake.tokenCalls != 2 {
		t.Fatalf("token calls = %d, want 2", fake.tokenCalls)
	}
	if fake.forms[1].Get("client_secret") != "secret-new" {
		t.Fatalf("第二个 secret = %q, want secret-new", fake.forms[1].Get("client_secret"))
	}
}

// TestAgyExchangeKeepsTransportCause 验证换码的网络原因留在错误链里。
//
// 生产事故（2026-11-11）：宿主 HTTPS_PROXY 指向未监听的本机端口时换码立刻被拒，
// Job 公开快照只有 provider_unavailable；服务端日志必须还能读出 connection refused。
func TestAgyExchangeKeepsTransportCause(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	// 立刻关闭：该回环端口必定拒绝连接，且不会被别的进程占走。
	deadEndpoint := "http://" + listener.Addr().String()
	_ = listener.Close()

	provider, err := newLoginProvider(loginOptions{
		client:            &http.Client{Timeout: 2 * time.Second},
		clock:             agyTestNow,
		random:            rand.Reader,
		authorizeEndpoint: deadEndpoint + "/authorize",
		tokenEndpoint:     deadEndpoint + "/token",
		userInfoEndpoint:  deadEndpoint + "/userinfo",
		redirectURI:       defaultLoginRedirect,
		clientID:          "agy-client",
		clientSecrets:     []string{"secret-old"},
	})
	if err != nil {
		t.Fatalf("newLoginProvider() error = %v", err)
	}
	value, err := provider.Begin(context.Background())
	if err != nil {
		t.Fatalf("Begin() error = %v", err)
	}
	flowValue, ok := value.(*loginFlow)
	if !ok {
		t.Fatalf("Begin() flow type = %T", value)
	}
	callback := defaultLoginRedirect + "?code=agy-code&state=" + url.QueryEscape(flowValue.state)
	_, err = flowValue.Exchange(context.Background(), callback)
	if !errors.Is(err, accountauth.ErrProviderUnavailable) {
		t.Fatalf("Exchange() error = %v, want ErrProviderUnavailable", err)
	}
	if !strings.Contains(err.Error(), "connection refused") {
		t.Fatalf("错误链必须保留底层原因（connection refused），got %v", err)
	}
}

// agyTestJWT 构造 payload 可控的未签名 JWT。
//
// Node 的 decodeJwtPayloadUnsafe 只解 payload、不验签；登录路径维持同一行为，
// 账号身份最终仍由 decoder 的邮箱校验兜底。
func agyTestJWT(t *testing.T, claims map[string]any) string {
	t.Helper()
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatalf("marshal claims: %v", err)
	}
	return "eyJhbGciOiJub25lIn0." + base64.RawURLEncoding.EncodeToString(payload) + ".signature"
}

// agyTestCallback 用当前 flow 的 state 组装完整回调地址。
func agyTestCallback(flow *loginFlow) string {
	return defaultLoginRedirect + "?code=agy-code&state=" + url.QueryEscape(flow.state)
}

// TestAgyBeginStateMatchesNodeEncoding 验证 state 与 Node createOauthState 同形：
// 32 字节随机数的 base64url（43 字符，无补齐）。
func TestAgyBeginStateMatchesNodeEncoding(t *testing.T) {
	fake := newAgyFakeGoogle(t, 0)
	flowValue := newAgyFlow(t, fake)
	state := flowValue.state
	if len(state) != 43 {
		t.Fatalf("state length = %d, want 43: %q", len(state), state)
	}
	decoded, err := base64.RawURLEncoding.DecodeString(state)
	if err != nil || len(decoded) != 32 {
		t.Fatalf("state 不是 32 字节 base64url: %q, err=%v", state, err)
	}
}

// TestAgyEmailFromIDTokenAcceptsPaddedPayload 验证带 '=' 补齐的 base64url payload
// 仍能解析：Node 的 Buffer.from(x, 'base64') 同样接受补齐。
func TestAgyEmailFromIDTokenAcceptsPaddedPayload(t *testing.T) {
	payload, err := json.Marshal(map[string]any{"email": "padded@example.test"})
	if err != nil {
		t.Fatalf("marshal claims: %v", err)
	}
	encoded := base64.URLEncoding.EncodeToString(payload)
	if !strings.Contains(encoded, "=") {
		t.Fatalf("payload 未产生补齐，测试前提不成立: %q", encoded)
	}
	if got := emailFromIDToken("header." + encoded + ".signature"); got != "padded@example.test" {
		t.Fatalf("emailFromIDToken() = %q", got)
	}
}

// TestAgyLoginCallbackAcceptsPastedForms 覆盖 Node parseBrowserCallbackInput 接受的所有
// 粘贴形态：完整地址、裸查询串、裸路径、两端空白、尾部 fragment。
func TestAgyLoginCallbackAcceptsPastedForms(t *testing.T) {
	cases := []struct {
		name     string
		callback func(flow *loginFlow) string
	}{
		{
			name:     "完整回调地址",
			callback: agyTestCallback,
		},
		{
			name: "裸查询串",
			callback: func(flow *loginFlow) string {
				return "?code=agy-code&state=" + url.QueryEscape(flow.state)
			},
		},
		{
			name: "裸路径加查询串",
			callback: func(flow *loginFlow) string {
				return "/oauth-callback?code=agy-code&state=" + url.QueryEscape(flow.state)
			},
		},
		{
			name: "两端空白",
			callback: func(flow *loginFlow) string {
				return "\n  " + agyTestCallback(flow) + "  \n"
			},
		},
		{
			name: "尾部 fragment",
			callback: func(flow *loginFlow) string {
				return agyTestCallback(flow) + "#_=_"
			},
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			fake := newAgyFakeGoogle(t, 0)
			flowValue := newAgyFlow(t, fake)
			artifacts, err := flowValue.Exchange(context.Background(), testCase.callback(flowValue))
			if err != nil {
				t.Fatalf("Exchange() error = %v", err)
			}
			if fake.tokenCalls != 1 {
				t.Fatalf("token calls = %d, want 1", fake.tokenCalls)
			}
			if fake.forms[0].Get("code") != "agy-code" {
				t.Fatalf("code = %q", fake.forms[0].Get("code"))
			}
			if _, _, err := nativeaccount.NewDecoder().Decode("agy", artifacts); err != nil {
				t.Fatalf("Decode() error = %v", err)
			}
		})
	}
}

// TestAgyLoginCallbackRejectsBareCode 验证只粘 code 时拒绝：没有 state 可比对，
// Node 的 native OAuth 路径同样返回 invalid_callback_url。
func TestAgyLoginCallbackRejectsBareCode(t *testing.T) {
	fake := newAgyFakeGoogle(t, 0)
	flowValue := newAgyFlow(t, fake)
	if _, err := flowValue.Exchange(context.Background(), "agy-code"); !errors.Is(err, accountauth.ErrInvalidCallback) {
		t.Fatalf("Exchange() error = %v, want ErrInvalidCallback", err)
	}
	if fake.tokenCalls != 0 {
		t.Fatalf("无效回调不得调用 token endpoint: %d", fake.tokenCalls)
	}
}

// TestAgyLoginCallbackRejectsForeignRedirect 验证 endpoint 不一致时拒绝。
func TestAgyLoginCallbackRejectsForeignRedirect(t *testing.T) {
	cases := []string{
		"http://localhost:9999/oauth-callback",
		"http://localhost:51121/callback",
		"https://localhost:51121/oauth-callback",
	}
	for _, prefix := range cases {
		t.Run(prefix, func(t *testing.T) {
			fake := newAgyFakeGoogle(t, 0)
			flowValue := newAgyFlow(t, fake)
			callback := prefix + "?code=agy-code&state=" + url.QueryEscape(flowValue.state)
			if _, err := flowValue.Exchange(context.Background(), callback); !errors.Is(err, accountauth.ErrInvalidCallback) {
				t.Fatalf("Exchange() error = %v, want ErrInvalidCallback", err)
			}
			if fake.tokenCalls != 0 {
				t.Fatalf("endpoint 不一致不得换码: %d", fake.tokenCalls)
			}
		})
	}
}

// TestAgyLoginCallbackRejectsDuplicateState 固定 Go 的严格边界：Node 取第一个 state，
// Go 拒绝重复键（重复参数只有攻击者会发）。
func TestAgyLoginCallbackRejectsDuplicateState(t *testing.T) {
	fake := newAgyFakeGoogle(t, 0)
	flowValue := newAgyFlow(t, fake)
	state := url.QueryEscape(flowValue.state)
	callback := defaultLoginRedirect + "?code=agy-code&state=" + state + "&state=" + state
	if _, err := flowValue.Exchange(context.Background(), callback); !errors.Is(err, accountauth.ErrStateMismatch) {
		t.Fatalf("Exchange() error = %v, want ErrStateMismatch", err)
	}
	if fake.tokenCalls != 0 {
		t.Fatalf("重复 state 不得换码: %d", fake.tokenCalls)
	}
}

// TestAgyLoginCallbackSurfacesProviderError 验证 Google 的 error / error_description
// 单独出现时都归类为 provider_rejected（Node 用 error || error_description）。
func TestAgyLoginCallbackSurfacesProviderError(t *testing.T) {
	cases := []string{"error=access_denied", "error_description=access_denied"}
	for _, query := range cases {
		t.Run(query, func(t *testing.T) {
			fake := newAgyFakeGoogle(t, 0)
			flowValue := newAgyFlow(t, fake)
			callback := defaultLoginRedirect + "?code=agy-code&state=" + url.QueryEscape(flowValue.state) + "&" + query
			if _, err := flowValue.Exchange(context.Background(), callback); !errors.Is(err, accountauth.ErrProviderRejected) {
				t.Fatalf("Exchange() error = %v, want ErrProviderRejected", err)
			}
			if fake.tokenCalls != 0 {
				t.Fatalf("上游拒绝不得换码: %d", fake.tokenCalls)
			}
		})
	}
}

// TestAgyExchangePrefersIDTokenEmail 验证 id_token 有 email claim 时不打 userinfo。
func TestAgyExchangePrefersIDTokenEmail(t *testing.T) {
	fake := newAgyFakeGoogle(t, 0)
	idToken := agyTestJWT(t, map[string]any{"email": "id-token@example.test"})
	fake.tokenResponse = `{"access_token":"agy-access","refresh_token":"agy-refresh","id_token":"` + idToken + `"}`
	flowValue := newAgyFlow(t, fake)
	if _, err := flowValue.Exchange(context.Background(), agyTestCallback(flowValue)); err != nil {
		t.Fatalf("Exchange() error = %v", err)
	}
	if fake.userInfoHit != 0 {
		t.Fatalf("id_token 已含邮箱时不应打 userinfo: %d", fake.userInfoHit)
	}
	if claims := flowValue.AccountClaims(); claims.Email != "id-token@example.test" {
		t.Fatalf("AccountClaims() = %+v", claims)
	}
}

// TestAgyExchangeUsesAccessTokenClaims 验证没有 id_token 时回落到 access_token 的
// JWT claim（Node: decodeJwtPayloadUnsafe(idToken) || decodeJwtPayloadUnsafe(accessToken)）。
func TestAgyExchangeUsesAccessTokenClaims(t *testing.T) {
	fake := newAgyFakeGoogle(t, 0)
	accessToken := agyTestJWT(t, map[string]any{"emailAddress": "access-claims@example.test"})
	fake.tokenResponse = `{"access_token":"` + accessToken + `","refresh_token":"agy-refresh"}`
	flowValue := newAgyFlow(t, fake)
	artifacts, err := flowValue.Exchange(context.Background(), agyTestCallback(flowValue))
	if err != nil {
		t.Fatalf("Exchange() error = %v", err)
	}
	if fake.userInfoHit != 0 {
		t.Fatalf("access_token 已含邮箱时不应打 userinfo: %d", fake.userInfoHit)
	}
	_, profile, err := nativeaccount.NewDecoder().Decode("agy", artifacts)
	if err != nil || profile.Email() != "access-claims@example.test" {
		t.Fatalf("profile = %v, err = %v", profile, err)
	}
}

// TestAgyExchangeRequiresEmail 验证 userinfo 失败时整次登录失败。
//
// 与 Node 的差异是故意的：Node 允许没有邮箱也判成功（账号随后靠 email.cache 补），
// 但 Go 的 agy 凭据以邮箱为稳定身份，缺邮箱的 artifact 会被 decoder 判无效。
func TestAgyExchangeRequiresEmail(t *testing.T) {
	fake := newAgyFakeGoogle(t, 0)
	fake.userInfoStatus = http.StatusInternalServerError
	flowValue := newAgyFlow(t, fake)
	if _, err := flowValue.Exchange(context.Background(), agyTestCallback(flowValue)); !errors.Is(err, accountauth.ErrProviderRejected) {
		t.Fatalf("Exchange() error = %v, want ErrProviderRejected", err)
	}
	if fake.userInfoHit != 1 {
		t.Fatalf("userinfo hits = %d, want 1", fake.userInfoHit)
	}
}

// TestAgyExchangeRejectsMissingTokens 验证 200 响应缺 access/refresh token 时拒绝。
func TestAgyExchangeRejectsMissingTokens(t *testing.T) {
	cases := []string{
		`{"refresh_token":"agy-refresh"}`,
		`{"access_token":"agy-access"}`,
		`{"access_token":"  ","refresh_token":"agy-refresh"}`,
	}
	for _, payload := range cases {
		t.Run(payload, func(t *testing.T) {
			fake := newAgyFakeGoogle(t, 0)
			fake.tokenResponse = payload
			flowValue := newAgyFlow(t, fake)
			if _, err := flowValue.Exchange(context.Background(), agyTestCallback(flowValue)); !errors.Is(err, accountauth.ErrProviderRejected) {
				t.Fatalf("Exchange() error = %v, want ErrProviderRejected", err)
			}
		})
	}
}

// TestAgyExchangeRejectsMalformedTokenResponse 验证 200 但不是 JSON 时归为
// provider_unavailable（上游协议异常，不是用户凭据被拒）。
func TestAgyExchangeRejectsMalformedTokenResponse(t *testing.T) {
	fake := newAgyFakeGoogle(t, 0)
	fake.tokenResponse = "not-json"
	flowValue := newAgyFlow(t, fake)
	if _, err := flowValue.Exchange(context.Background(), agyTestCallback(flowValue)); !errors.Is(err, accountauth.ErrProviderUnavailable) {
		t.Fatalf("Exchange() error = %v, want ErrProviderUnavailable", err)
	}
}

// TestAgyExchangeArtifactCarriesNodeTokenFields 固定落库前 artifact 的字段合同：
// auth_method=consumer、email、access/refresh token、token_type 缺省 Bearer、
// expiry/expires_at_ms 由 expires_in 推导、refreshed_at_ms 取当前时钟、id_token 原样保留。
func TestAgyExchangeArtifactCarriesNodeTokenFields(t *testing.T) {
	fake := newAgyFakeGoogle(t, 0)
	idToken := agyTestJWT(t, map[string]any{"email": "agy@example.test"})
	fake.tokenResponse = `{"access_token":"agy-access","refresh_token":"agy-refresh","id_token":"` + idToken + `"}`
	flowValue := newAgyFlow(t, fake)
	artifacts, err := flowValue.Exchange(context.Background(), agyTestCallback(flowValue))
	if err != nil {
		t.Fatalf("Exchange() error = %v", err)
	}
	var envelope struct {
		NativeAuthJSON json.RawMessage `json:"native_auth_json"`
	}
	if err := json.Unmarshal(artifacts, &envelope); err != nil {
		t.Fatalf("unmarshal envelope: %v", err)
	}
	var native struct {
		Email      string `json:"email"`
		OAuthToken struct {
			AuthMethod string `json:"auth_method"`
			Token      struct {
				AccessToken   string `json:"access_token"`
				RefreshToken  string `json:"refresh_token"`
				IDToken       string `json:"id_token"`
				TokenType     string `json:"token_type"`
				Expiry        string `json:"expiry"`
				ExpiresAtMS   int64  `json:"expires_at_ms"`
				RefreshedAtMS int64  `json:"refreshed_at_ms"`
			} `json:"token"`
		} `json:"oauthToken"`
	}
	if err := json.Unmarshal(envelope.NativeAuthJSON, &native); err != nil {
		t.Fatalf("unmarshal native auth: %v", err)
	}
	now := agyTestNow()
	wantExpiry := now.Add(time.Hour)
	if native.Email != "agy@example.test" ||
		native.OAuthToken.AuthMethod != "consumer" ||
		native.OAuthToken.Token.AccessToken != "agy-access" ||
		native.OAuthToken.Token.RefreshToken != "agy-refresh" ||
		native.OAuthToken.Token.IDToken != idToken ||
		native.OAuthToken.Token.TokenType != "Bearer" ||
		native.OAuthToken.Token.ExpiresAtMS != wantExpiry.UnixMilli() ||
		native.OAuthToken.Token.RefreshedAtMS != now.UnixMilli() {
		t.Fatalf("native auth = %+v", native)
	}
	expiry, err := time.Parse(time.RFC3339, native.OAuthToken.Token.Expiry)
	if err != nil || !expiry.Equal(wantExpiry) {
		t.Fatalf("expiry = %q, err = %v, want %v", native.OAuthToken.Token.Expiry, err, wantExpiry)
	}
	// 落库合同：decoder 必须把同一组字段还原成领域凭据，auth_method 归一为 consumer。
	credential, _, err := nativeaccount.NewDecoder().Decode("agy", artifacts)
	if err != nil {
		t.Fatalf("Decode() error = %v", err)
	}
	auth, ok := credential.(*agy.OAuthAuth)
	if !ok {
		t.Fatalf("credential = %T, want *agy.OAuthAuth", credential)
	}
	if auth.Email() != "agy@example.test" ||
		auth.AuthMethod() != agy.AuthMethodConsumer ||
		auth.TokenType() != "Bearer" ||
		auth.ExpiresAtMS() != wantExpiry.UnixMilli() ||
		auth.RefreshedAtMS() != now.UnixMilli() {
		t.Fatalf("credential = %v, authMethod=%q tokenType=%q expiresAt=%d refreshedAt=%d",
			auth, auth.AuthMethod(), auth.TokenType(), auth.ExpiresAtMS(), auth.RefreshedAtMS())
	}
}

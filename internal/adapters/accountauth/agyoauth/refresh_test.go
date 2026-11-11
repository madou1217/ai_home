package agyoauth

import (
	"context"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/agy"
)

// agyRefreshStub 按 client_secret 决定 token 端点的响应，并记录尝试顺序。
type agyRefreshStub struct {
	mu            sync.Mutex
	secrets       []string
	status        map[string]int
	body          map[string]string
	networkErrors map[string]bool
}

func (stub *agyRefreshStub) Do(request *http.Request) (*http.Response, error) {
	raw, err := io.ReadAll(request.Body)
	if err != nil {
		return nil, err
	}
	form, err := url.ParseQuery(string(raw))
	if err != nil {
		return nil, err
	}
	secret := form.Get("client_secret")
	stub.mu.Lock()
	stub.secrets = append(stub.secrets, secret)
	failsAtNetwork := stub.networkErrors[secret]
	status := stub.status[secret]
	body := stub.body[secret]
	stub.mu.Unlock()
	if failsAtNetwork {
		return nil, errors.New("dial tcp: connection refused")
	}
	if status == 0 {
		status = http.StatusOK
	}
	if body == "" {
		body = `{"access_token":"agy-access","refresh_token":"agy-refresh","expires_in":3600,"token_type":"Bearer"}`
	}
	return &http.Response{
		StatusCode: status,
		Header:     make(http.Header),
		Body:       io.NopCloser(strings.NewReader(body)),
	}, nil
}

func (stub *agyRefreshStub) attempts() []string {
	stub.mu.Lock()
	defer stub.mu.Unlock()
	return append([]string(nil), stub.secrets...)
}

func newAgyRefreshTestCredential(t *testing.T) *agy.OAuthAuth {
	t.Helper()
	auth, err := agy.NewOAuthAuth(agy.OAuthInput{
		Email:         "agy@example.test",
		AccessToken:   "old-access",
		RefreshToken:  "old-refresh",
		ExpiresAtMS:   agyTestNow().Add(time.Hour).UnixMilli(),
		RefreshedAtMS: agyTestNow().UnixMilli(),
		TokenType:     "Bearer",
		AuthMethod:    agy.AuthMethodConsumer,
	})
	if err != nil {
		t.Fatalf("NewOAuthAuth() error = %v", err)
	}
	return auth
}

func newAgyRefreshTestProvider(t *testing.T, client HTTPClient) *Provider {
	t.Helper()
	provider, err := newProvider(client, "https://oauth2.googleapis.com/token")
	if err != nil {
		t.Fatalf("newProvider() error = %v", err)
	}
	return provider
}

// 登录可能落在轮换后的 secret 上；刷新必须先试当前 secret，再在 invalid_client
// 时回退到轮换 secret，否则 refresh_token 永远换不出 access_token。
func TestRefreshFallsBackToRotatedClientSecretOnInvalidClient(t *testing.T) {
	primary := defaultClientCredential()
	stub := &agyRefreshStub{
		status: map[string]int{primary.clientSecret: http.StatusUnauthorized},
		body:   map[string]string{primary.clientSecret: `{"error":"invalid_client"}`},
	}
	provider := newAgyRefreshTestProvider(t, stub)
	refreshed, err := provider.Refresh(
		context.Background(),
		newAgyRefreshTestCredential(t),
		agyTestNow(),
	)
	if err != nil {
		t.Fatalf("Refresh() error = %v", err)
	}
	if refreshed == nil {
		t.Fatal("Refresh() returned nil credential")
	}
	attempts := stub.attempts()
	if len(attempts) != 2 {
		t.Fatalf("token endpoint attempts = %d, want 2", len(attempts))
	}
	if attempts[0] != primary.clientSecret ||
		attempts[1] != rotatedLoginClientSecret {
		t.Fatalf("secret order = %v, want [primary rotated]", attempts)
	}
}

// invalid_grant 表示 refresh_token 本身失效，换 secret 没有意义。
func TestRefreshDoesNotRetryOnInvalidGrant(t *testing.T) {
	primary := defaultClientCredential()
	stub := &agyRefreshStub{
		status: map[string]int{primary.clientSecret: http.StatusBadRequest},
		body:   map[string]string{primary.clientSecret: `{"error":"invalid_grant"}`},
	}
	provider := newAgyRefreshTestProvider(t, stub)
	_, err := provider.Refresh(
		context.Background(),
		newAgyRefreshTestCredential(t),
		agyTestNow(),
	)
	if !errors.Is(err, accountcredentials.ErrReauthenticationRequired) {
		t.Fatalf("Refresh() error = %v, want ErrReauthenticationRequired", err)
	}
	if attempts := stub.attempts(); len(attempts) != 1 {
		t.Fatalf("token endpoint attempts = %d, want 1", len(attempts))
	}
}

// 单个 client 的网络失败不能终止候选链：换 secret 后仍可能成功。
func TestRefreshContinuesToNextCredentialOnTransportError(t *testing.T) {
	primary := defaultClientCredential()
	stub := &agyRefreshStub{
		networkErrors: map[string]bool{primary.clientSecret: true},
	}
	provider := newAgyRefreshTestProvider(t, stub)
	refreshed, err := provider.Refresh(
		context.Background(),
		newAgyRefreshTestCredential(t),
		agyTestNow(),
	)
	if err != nil || refreshed == nil {
		t.Fatalf("Refresh() = %v, %v; want refreshed credential", refreshed, err)
	}
	attempts := stub.attempts()
	if len(attempts) != 2 || attempts[1] != rotatedLoginClientSecret {
		t.Fatalf("attempts = %v, want primary then rotated secret", attempts)
	}
}

// 上游拒绝必须保留 status 与机器码，否则 invalid_client / invalid_grant
// 在日志里都会显示成「账号需要重新认证」。

// 账号邮箱可能在 Google 侧被改名；刷新必须采用 id_token 里的新身份，
// 才能让 Resolver 触发账号 re-key，而不是继续用旧邮箱。
func TestRefreshUsesIdentityFromIDToken(t *testing.T) {
	primary := defaultClientCredential()
	stub := &agyRefreshStub{
		body: map[string]string{
			primary.clientSecret: "{\"access_token\":\"agy-access\",\"refresh_token\":\"agy-refresh\",\"expires_in\":3600,\"token_type\":\"Bearer\",\"id_token\":\"" + testIDToken("after@example.test") + "\"}",
		},
	}
	provider := newAgyRefreshTestProvider(t, stub)
	refreshed, err := provider.Refresh(
		context.Background(),
		newAgyRefreshTestCredential(t),
		agyTestNow(),
	)
	if err != nil {
		t.Fatalf("Refresh() error = %v", err)
	}
	auth, ok := refreshed.(*agy.OAuthAuth)
	if !ok || auth.Email() != "after@example.test" {
		t.Fatalf("refreshed email = %v, want after@example.test", refreshed)
	}
}

func TestRefreshKeepsStoredEmailWhenIDTokenInvalid(t *testing.T) {
	primary := defaultClientCredential()
	stub := &agyRefreshStub{
		body: map[string]string{
			primary.clientSecret: "{\"access_token\":\"agy-access\",\"refresh_token\":\"agy-refresh\",\"expires_in\":3600,\"token_type\":\"Bearer\",\"id_token\":\"not-a-jwt\"}",
		},
	}
	provider := newAgyRefreshTestProvider(t, stub)
	refreshed, err := provider.Refresh(
		context.Background(),
		newAgyRefreshTestCredential(t),
		agyTestNow(),
	)
	if err != nil {
		t.Fatalf("Refresh() error = %v", err)
	}
	auth, ok := refreshed.(*agy.OAuthAuth)
	if !ok || auth.Email() != "agy@example.test" {
		t.Fatalf("refreshed email = %v, want stored email", refreshed)
	}
}

func testIDToken(email string) string {
	payload := base64.RawURLEncoding.EncodeToString(
		[]byte("{\"email\":\"" + email + "\"}"),
	)
	return "header." + payload + ".signature"
}

func TestRefreshErrorKeepsUpstreamStatusAndCode(t *testing.T) {
	primary := defaultClientCredential()
	stub := &agyRefreshStub{
		status: map[string]int{primary.clientSecret: http.StatusBadRequest},
		body:   map[string]string{primary.clientSecret: `{"error":"invalid_grant"}`},
	}
	provider := newAgyRefreshTestProvider(t, stub)
	_, err := provider.Refresh(
		context.Background(),
		newAgyRefreshTestCredential(t),
		agyTestNow(),
	)
	if err == nil {
		t.Fatal("Refresh() error = nil, want failure")
	}
	message := err.Error()
	if !strings.Contains(message, "status=400") ||
		!strings.Contains(message, "invalid_grant") {
		t.Fatalf("error = %q, want upstream status and code", message)
	}
}

// 5xx 是上游暂时故障，不能当成客户端凭据问题重试。
func TestRefreshDoesNotRetryOnServerError(t *testing.T) {
	primary := defaultClientCredential()
	stub := &agyRefreshStub{
		status: map[string]int{primary.clientSecret: http.StatusInternalServerError},
		body:   map[string]string{primary.clientSecret: `{"error":"internal_failure"}`},
	}
	provider := newAgyRefreshTestProvider(t, stub)
	if _, err := provider.Refresh(
		context.Background(),
		newAgyRefreshTestCredential(t),
		agyTestNow(),
	); err == nil {
		t.Fatal("Refresh() error = nil, want failure")
	}
	if attempts := stub.attempts(); len(attempts) != 1 {
		t.Fatalf("token endpoint attempts = %d, want 1", len(attempts))
	}
}

// 账号自带的 OAuth 客户端必须排在默认候选之前（Node 同一顺序）。
func TestRefreshPrefersCredentialProvidedClient(t *testing.T) {
	primary := defaultClientCredential()
	stub := &agyRefreshStub{
		status: map[string]int{primary.clientSecret: http.StatusUnauthorized},
		body:   map[string]string{primary.clientSecret: `{"error":"invalid_client"}`},
	}
	provider := newAgyRefreshTestProvider(t, stub)
	refreshedAt := time.Date(2026, time.November, 8, 16, 0, 0, 0, time.UTC)
	custom, err := agy.NewOAuthAuth(agy.OAuthInput{
		Email:         "agy@example.test",
		AccessToken:   "old-access",
		RefreshToken:  "old-refresh",
		ExpiresAtMS:   refreshedAt.Add(time.Hour).UnixMilli(),
		RefreshedAtMS: refreshedAt.UnixMilli(),
		TokenType:     "Bearer",
		AuthMethod:    agy.AuthMethodConsumer,
		ClientID:      "custom.apps.googleusercontent.com",
		ClientSecret:  "custom-secret",
	})
	if err != nil {
		t.Fatalf("NewOAuthAuth() error = %v", err)
	}
	refreshed, err := provider.Refresh(context.Background(), custom, agyTestNow())
	if err != nil {
		t.Fatalf("Refresh() error = %v", err)
	}
	attempts := stub.attempts()
	if len(attempts) != 1 || attempts[0] != "custom-secret" {
		t.Fatalf("attempts = %v, want only the credential-provided client", attempts)
	}
	auth, ok := refreshed.(*agy.OAuthAuth)
	if !ok || auth.ClientID() != "custom.apps.googleusercontent.com" ||
		auth.ClientSecret() != "custom-secret" {
		t.Fatalf("refreshed client = %v", refreshed)
	}
}

// 账号级出口：direct/proxy 由 factory 生成专用传输，pool/tun 明确拒绝。
func TestRefreshWithAccountResolvesEgress(t *testing.T) {
	primary := defaultClientCredential()
	accepted := &agyRefreshStub{}
	refused := &agyRefreshStub{
		status: map[string]int{primary.clientSecret: http.StatusUnauthorized,
			rotatedLoginClientSecret: http.StatusUnauthorized},
		body: map[string]string{
			primary.clientSecret:     `{"error":"invalid_client"}`,
			rotatedLoginClientSecret: `{"error":"invalid_client"}`,
		},
	}
	var factoryURLs []string
	newProviderWithEgress := func(binding Egress) *Provider {
		provider, err := NewWithEgress(
			refused,
			func(proxyURL string) HTTPClient {
				factoryURLs = append(factoryURLs, proxyURL)
				return accepted
			},
			func(context.Context, accountcore.AccountRef) (Egress, error) {
				return binding, nil
			},
		)
		if err != nil {
			t.Fatalf("NewWithEgress() error = %v", err)
		}
		return provider
	}
	ref := accountcore.AccountRef("acct_0123456789abcdef0123")
	cases := []struct {
		name      string
		binding   Egress
		wantProxy string
		wantURLs  []string
	}{
		{
			name:      "direct 走直连传输",
			binding:   Egress{Mode: "direct"},
			wantProxy: "",
			wantURLs:  []string{""},
		},
		{
			name:      "proxy 使用绑定地址",
			binding:   Egress{Mode: "proxy", ProxyURL: "socks5://127.0.0.1:1080"},
			wantProxy: "socks5://127.0.0.1:1080",
			wantURLs:  []string{"socks5://127.0.0.1:1080"},
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			factoryURLs = nil
			provider := newProviderWithEgress(testCase.binding)
			if _, err := provider.RefreshWithAccount(
				context.Background(),
				ref,
				newAgyRefreshTestCredential(t),
				agyTestNow(),
			); err != nil {
				t.Fatalf("RefreshWithAccount() error = %v", err)
			}
			if len(factoryURLs) != 1 || factoryURLs[0] != testCase.wantProxy {
				t.Fatalf("factory calls = %v, want %q", factoryURLs, testCase.wantProxy)
			}
		})
	}

	factoryURLs = nil
	provider := newProviderWithEgress(Egress{Mode: "pool"})
	if _, err := provider.RefreshWithAccount(
		context.Background(),
		ref,
		newAgyRefreshTestCredential(t),
		agyTestNow(),
	); !errors.Is(err, accountcredentials.ErrRefreshUnavailable) {
		t.Fatalf("pool egress error = %v, want ErrRefreshUnavailable", err)
	}
	if len(factoryURLs) != 0 {
		t.Fatalf("pool egress must not build a client: %v", factoryURLs)
	}
}

package agyoauth

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"reflect"
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
	// hang 让该 secret 的请求一直等到上下文结束，用来验证候选级超时与父上下文取消。
	hang map[string]bool
	// stallBody 让响应头正常返回、响应体卡住，验证读体超时同样换下一个候选。
	stallBody map[string]bool
}

// agyStallingBody 先回一段 JSON，再阻塞到请求上下文结束，模拟「头部已到、
// 响应体不再推进」的上游。
type agyStallingBody struct {
	ctx     context.Context
	payload string
	sent    bool
}

func (body *agyStallingBody) Read(buffer []byte) (int, error) {
	if !body.sent {
		body.sent = true
		return copy(buffer, body.payload), nil
	}
	<-body.ctx.Done()
	return 0, body.ctx.Err()
}

func (*agyStallingBody) Close() error { return nil }

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
	hangs := stub.hang[secret]
	stalls := stub.stallBody[secret]
	stub.mu.Unlock()
	if hangs {
		<-request.Context().Done()
		return nil, request.Context().Err()
	}
	if stalls {
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body: &agyStallingBody{
				ctx:     request.Context(),
				payload: `{"access_token":"stalled-access"}`,
			},
		}, nil
	}
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

// 账号自带的客户端与内置默认完全相同时不能对同一个 client 连发两次。
func TestRefreshDeduplicatesIdenticalClientCandidates(t *testing.T) {
	primary := defaultClientCredential()
	stub := &agyRefreshStub{
		status: map[string]int{primary.clientSecret: http.StatusUnauthorized},
		body:   map[string]string{primary.clientSecret: `{"error":"invalid_client"}`},
	}
	provider := newAgyRefreshTestProvider(t, stub)
	refreshedAt := time.Date(2026, time.November, 8, 16, 0, 0, 0, time.UTC)
	auth, err := agy.NewOAuthAuth(agy.OAuthInput{
		Email:         "agy@example.test",
		AccessToken:   "old-access",
		RefreshToken:  "old-refresh",
		ExpiresAtMS:   refreshedAt.Add(time.Hour).UnixMilli(),
		RefreshedAtMS: refreshedAt.UnixMilli(),
		TokenType:     "Bearer",
		AuthMethod:    agy.AuthMethodConsumer,
		ClientID:      primary.clientID,
		ClientSecret:  primary.clientSecret,
	})
	if err != nil {
		t.Fatalf("NewOAuthAuth() error = %v", err)
	}
	if _, err := provider.Refresh(context.Background(), auth, agyTestNow()); err != nil {
		t.Fatalf("Refresh() error = %v", err)
	}
	attempts := stub.attempts()
	if len(attempts) != 2 || attempts[0] != primary.clientSecret ||
		attempts[1] != rotatedLoginClientSecret {
		t.Fatalf("attempts = %v, want primary then rotated", attempts)
	}
}

// Google 认证错误把机器码放在 error.status（Node parseOAuthErrorPayload 读
// error.status || error.code）。只读 code 会得到空码，丢掉 legacy secret 回退。
func TestRefreshRetriesNextCredentialOnNestedOAuthErrorObject(t *testing.T) {
	primary := defaultClientCredential()
	bodies := map[string]string{
		"status 字段": `{"error":{"status":"invalid_client","message":"Unauthorized"}}`,
		"code 字段":   `{"error":{"code":"invalid_client","message":"Unauthorized"}}`,
	}
	for name, body := range bodies {
		t.Run(name, func(t *testing.T) {
			stub := &agyRefreshStub{
				status: map[string]int{primary.clientSecret: http.StatusUnauthorized},
				body:   map[string]string{primary.clientSecret: body},
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
				t.Fatalf("attempts = %v, want primary then legacy secret", attempts)
			}
		})
	}
}

// 上游把 refresh_token 回显在 description 里时，写进错误前必须脱敏。
func TestRefreshErrorDetailRedactsKnownSecrets(t *testing.T) {
	primary := defaultClientCredential()
	stub := &agyRefreshStub{
		status: map[string]int{primary.clientSecret: http.StatusBadRequest},
		body: map[string]string{
			primary.clientSecret: `{"error":"invalid_grant","error_description":"refresh token old-refresh was revoked"}`,
		},
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
	if strings.Contains(message, "old-refresh") {
		t.Fatalf("error = %q, must not leak the refresh token", message)
	}
	if !strings.Contains(message, "[redacted]") ||
		!strings.Contains(message, "invalid_grant") ||
		!strings.Contains(message, "status=400") {
		t.Fatalf("error = %q, want redacted detail with status and code", message)
	}
}

// description 超过 320 字符必须截断（Node sanitizeResponseText 同值）。
func TestRefreshErrorDetailIsTruncated(t *testing.T) {
	primary := defaultClientCredential()
	stub := &agyRefreshStub{
		status: map[string]int{primary.clientSecret: http.StatusBadRequest},
		body: map[string]string{
			primary.clientSecret: `{"error":"invalid_grant","error_description":"` +
				strings.Repeat("a", 1000) + `"}`,
		},
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
	if strings.Contains(err.Error(), strings.Repeat("a", 321)) {
		t.Fatalf("error detail longer than 320 characters: %d", len(err.Error()))
	}
	if !strings.Contains(err.Error(), strings.Repeat("a", 320)) {
		t.Fatal("error detail lost the truncated description")
	}
}

// 非 JSON 错误体（网关 HTML）也要保留 status 与截断后的原文，且不换候选。
func TestRefreshPlainTextErrorBodyKeepsStatus(t *testing.T) {
	primary := defaultClientCredential()
	stub := &agyRefreshStub{
		status: map[string]int{primary.clientSecret: http.StatusBadGateway},
		body:   map[string]string{primary.clientSecret: "<html>bad gateway</html>"},
	}
	provider := newAgyRefreshTestProvider(t, stub)
	_, err := provider.Refresh(
		context.Background(),
		newAgyRefreshTestCredential(t),
		agyTestNow(),
	)
	if !errors.Is(err, accountcredentials.ErrRefreshUnavailable) {
		t.Fatalf("Refresh() error = %v, want ErrRefreshUnavailable", err)
	}
	if !strings.Contains(err.Error(), "status=502") ||
		!strings.Contains(err.Error(), "bad gateway") {
		t.Fatalf("error = %q, want status and body detail", err.Error())
	}
	if attempts := stub.attempts(); len(attempts) != 1 {
		t.Fatalf("token endpoint attempts = %d, want 1", len(attempts))
	}
}

// 候选级超时属于「换下一个候选」的失败，不是终态（Node fetchWithTimeout 后
// 捕获异常 continue，legacy secret 仍会被尝试）。
func TestRefreshFallsBackToNextCredentialOnAttemptTimeout(t *testing.T) {
	primary := defaultClientCredential()
	stub := &agyRefreshStub{
		hang: map[string]bool{primary.clientSecret: true},
	}
	provider := newAgyRefreshTestProvider(t, stub)
	provider.attemptTimeout = 20 * time.Millisecond
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
		t.Fatalf("attempts = %v, want primary then legacy secret", attempts)
	}
}

// 响应体卡住同样属于候选级超时：Node 的 fetch 超时覆盖 body 读取，Go 必须换
// 下一个候选，而不是把整次刷新判成「结果无效」。
func TestRefreshFallsBackToNextCredentialOnStalledBody(t *testing.T) {
	primary := defaultClientCredential()
	stub := &agyRefreshStub{
		stallBody: map[string]bool{primary.clientSecret: true},
	}
	provider := newAgyRefreshTestProvider(t, stub)
	provider.attemptTimeout = 20 * time.Millisecond
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
		t.Fatalf("attempts = %v, want primary then legacy secret", attempts)
	}
}

// 调用方自己的截止时间到了必须终止：父上下文取消不能当成候选失败继续重试。
func TestRefreshStopsOnParentContextDeadline(t *testing.T) {
	primary := defaultClientCredential()
	stub := &agyRefreshStub{
		hang: map[string]bool{
			primary.clientSecret:     true,
			rotatedLoginClientSecret: true,
		},
	}
	provider := newAgyRefreshTestProvider(t, stub)
	provider.attemptTimeout = 5 * time.Second
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	_, err := provider.Refresh(ctx, newAgyRefreshTestCredential(t), agyTestNow())
	if !errors.Is(err, accountcredentials.ErrRefreshUnavailable) ||
		!errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Refresh() error = %v, want ErrRefreshUnavailable with context deadline", err)
	}
	if attempts := stub.attempts(); len(attempts) != 1 {
		t.Fatalf("token endpoint attempts = %d, want 1", len(attempts))
	}
}

// 轮换后的 refresh_token 按 Node sanitizeAccessToken 处理：控制字符/空值视为
// 未轮换并保留旧值，首尾空白则采用 trim 后的值；都不能让整次刷新失败。
func TestRefreshSanitizesRotatedRefreshToken(t *testing.T) {
	primary := defaultClientCredential()
	cases := []struct {
		name    string
		rotated string
		want    string
	}{
		{name: "控制字符保留旧值", rotated: "bad" + string(rune(10)) + "token", want: "old-refresh"},
		{name: "空值保留旧值", rotated: "", want: "old-refresh"},
		{name: "首尾空白先 trim", rotated: "  agy-rotated  ", want: "agy-rotated"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			stub := &agyRefreshStub{
				body: map[string]string{
					primary.clientSecret: fmt.Sprintf(
						`{"access_token":"agy-access","refresh_token":%q,"expires_in":3600}`,
						testCase.rotated,
					),
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
			if !ok || auth.AccessToken() != "agy-access" {
				t.Fatalf("refreshed credential = %v, want new access token", refreshed)
			}
			if auth.RefreshToken() != testCase.want {
				t.Fatalf("refresh token = %q, want %q", auth.RefreshToken(), testCase.want)
			}
		})
	}
}

// camelCase 字段名与 Node 的 payload.accessToken 等兜底读取一致。
func TestRefreshAcceptsCamelCaseTokenFields(t *testing.T) {
	primary := defaultClientCredential()
	stub := &agyRefreshStub{
		body: map[string]string{
			primary.clientSecret: `{"accessToken":"agy-access","refreshToken":"agy-refresh","expiresIn":1800,"tokenType":"Bearer"}`,
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
	if !ok || auth.AccessToken() != "agy-access" ||
		auth.RefreshToken() != "agy-refresh" ||
		auth.TokenType() != "Bearer" {
		t.Fatalf("refreshed credential = %v", refreshed)
	}
	wantExpiry := agyTestNow().Add(1800 * time.Second).UnixMilli()
	if auth.ExpiresAtMS() != wantExpiry {
		t.Fatalf("expires at = %d, want %d", auth.ExpiresAtMS(), wantExpiry)
	}
}

// Provider 被所有账号共享：一次刷新不能改掉默认候选列表的顺序或内容。
func TestRefreshDoesNotMutateProviderCandidates(t *testing.T) {
	stub := &agyRefreshStub{}
	provider := newAgyRefreshTestProvider(t, stub)
	before := append([]clientCredential(nil), provider.clientCredentials...)
	auth, err := agy.NewOAuthAuth(agy.OAuthInput{
		Email:         "agy@example.test",
		AccessToken:   "old-access",
		RefreshToken:  "old-refresh",
		ExpiresAtMS:   agyTestNow().Add(time.Hour).UnixMilli(),
		RefreshedAtMS: agyTestNow().UnixMilli(),
		TokenType:     "Bearer",
		AuthMethod:    agy.AuthMethodConsumer,
		ClientID:      "custom.apps.googleusercontent.com",
		ClientSecret:  "custom-secret",
	})
	if err != nil {
		t.Fatalf("NewOAuthAuth() error = %v", err)
	}
	if _, err := provider.Refresh(context.Background(), auth, agyTestNow()); err != nil {
		t.Fatalf("Refresh() error = %v", err)
	}
	if !reflect.DeepEqual(before, provider.clientCredentials) {
		t.Fatalf("provider candidates = %v, want unchanged %v", provider.clientCredentials, before)
	}
}

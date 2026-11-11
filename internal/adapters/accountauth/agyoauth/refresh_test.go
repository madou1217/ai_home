package agyoauth

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	"github.com/madou1217/ai_home/core/accounts/agy"
)

// agyRefreshStub 按 client_secret 决定 token 端点的响应，并记录尝试顺序。
type agyRefreshStub struct {
	mu      sync.Mutex
	secrets []string
	status  map[string]int
	body    map[string]string
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
	status := stub.status[secret]
	body := stub.body[secret]
	stub.mu.Unlock()
	if status == 0 {
		status = http.StatusOK
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

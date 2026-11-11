package agyoauth

import (
	"context"
	"crypto/rand"
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
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
)

// agyTestNow 固定 artifact 时间。
func agyTestNow() time.Time {
	return time.Date(2026, time.November, 8, 16, 0, 0, 0, time.UTC)
}

// agyFakeGoogle 记录 token 请求并按 secret 决定成功或 invalid_client。
type agyFakeGoogle struct {
	mu                sync.Mutex
	server            *httptest.Server
	acceptSecretIndex int
	tokenCalls        int
	secrets           []string
	forms             []url.Values
	userInfoHit       int
}

func newAgyFakeGoogle(t *testing.T, acceptSecretIndex int) *agyFakeGoogle {
	t.Helper()
	fake := &agyFakeGoogle{acceptSecretIndex: acceptSecretIndex}
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
			_, _ = io.WriteString(writer, `{"access_token":"agy-access","refresh_token":"agy-refresh","expires_in":3600,"token_type":"Bearer"}`)
		case "/userinfo":
			fake.mu.Lock()
			fake.userInfoHit++
			auth := request.Header.Get("Authorization")
			fake.mu.Unlock()
			if auth != "Bearer agy-access" {
				writer.WriteHeader(http.StatusUnauthorized)
				return
			}
			writer.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(writer, `{"email":"agy@example.test"}`)
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

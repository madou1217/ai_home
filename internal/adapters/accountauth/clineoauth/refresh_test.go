package clineoauth

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/tokenrefresh"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
)

var testNow = time.Unix(1_760_000_000, 0).UTC()

// testJWT 构造只有 sub 声明有意义的未签名 JWT；clineIdentity 只认裸 JWT 的 sub。
func testJWT(t *testing.T, subject string) string {
	t.Helper()
	claims, err := json.Marshal(map[string]any{"sub": subject, "external_id": "usr-1"})
	if err != nil {
		t.Fatalf("marshal claims: %v", err)
	}
	return "eyJhbGciOiJub25lIn0." +
		base64.RawURLEncoding.EncodeToString(claims) + ".sig"
}

// testPayload 生成双槽位文档；passExpiry 为空时与 cline 槽位同有效期。
func testPayload(t *testing.T, expiry time.Time, passExpiry *time.Time) string {
	t.Helper()
	access := "workos:" + testJWT(t, "user_1")
	pass := expiry
	if passExpiry != nil {
		pass = *passExpiry
	}
	return fmt.Sprintf(
		`{"auth":{"version":1,"lastUsedProvider":"cline","providers":{
			"cline":{"settings":{"auth":{"accessToken":%q,"refreshToken":"cline-refresh","expiresAt":%d,"accountId":"usr-1"},"model":"anthropic/x"},"updatedAt":"2026-01-01T00:00:00.000Z"},
			"cline-pass":{"settings":{"auth":{"accessToken":%q,"refreshToken":"pass-refresh","expiresAt":%d,"accountId":"usr-1"}}},
			"anthropic":{"settings":{"apiKey":"must-not-be-touched"}}
		}}}`,
		access, expiry.UnixMilli(), access, pass.UnixMilli(),
	)
}

func newCredential(t *testing.T, payload string) *accountcore.NativeCredential {
	t.Helper()
	credential, err := nativeaccount.NewDecoder().DecodeNativeAuth(providerID, []byte(payload))
	if err != nil {
		t.Fatalf("DecodeNativeAuth() error = %v", err)
	}
	native, ok := credential.(*accountcore.NativeCredential)
	if !ok || native == nil {
		t.Fatalf("credential type = %T", credential)
	}
	return native
}

func documentOf(t *testing.T, credential accountapp.Credential) map[string]any {
	t.Helper()
	native := credential.(*accountcore.NativeCredential)
	document, err := tokenrefresh.DecodeDocument(native.Payload())
	if err != nil {
		t.Fatalf("DecodeDocument() error = %v", err)
	}
	return document
}

func slotAuthOf(t *testing.T, document map[string]any, slotID string) map[string]any {
	t.Helper()
	root := tokenrefresh.Object(document["auth"])
	if root == nil {
		t.Fatalf("auth missing: %#v", document)
	}
	providers := tokenrefresh.Object(root["providers"])
	slot := tokenrefresh.Object(providers[slotID])
	settings := tokenrefresh.Object(slot["settings"])
	auth := tokenrefresh.Object(settings["auth"])
	if auth == nil {
		t.Fatalf("slot %q auth missing", slotID)
	}
	return auth
}

func newTestProvider(t *testing.T, baseURL string) *Provider {
	t.Helper()
	provider, err := New(
		&http.Client{Timeout: 5 * time.Second},
		Options{BaseURL: baseURL, Clock: func() time.Time { return testNow }},
	)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	return provider
}

func TestRefreshWritesBothSlots(t *testing.T) {
	newToken := "workos:" + testJWT(t, "user_1")
	var body map[string]string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		raw, _ := io.ReadAll(io.LimitReader(request.Body, 1<<20))
		body = map[string]string{}
		_ = json.Unmarshal(raw, &body)
		if request.Method != http.MethodPost || request.URL.Path != "/api/v1/auth/refresh" {
			t.Errorf("request = %s %s", request.Method, request.URL.Path)
		}
		response := map[string]any{
			"success": true,
			"data": map[string]any{
				"accessToken":  testJWT(t, "user_1"),
				"refreshToken": "new-refresh",
				"expiresAt":    tokenrefresh.ISOString(testNow.Add(time.Hour)),
			},
		}
		encoded, _ := json.Marshal(response)
		_, _ = writer.Write(encoded)
	}))
	defer server.Close()

	original := newCredential(t, testPayload(t, testNow.Add(-10*time.Minute), nil))
	identityBefore := original.IdentitySeed()
	refreshed, err := newTestProvider(t, server.URL+"/api/v1").
		Refresh(context.Background(), original)
	if err != nil {
		t.Fatalf("Refresh() error = %v", err)
	}
	if refreshed.IdentitySeed() != identityBefore {
		t.Fatalf("identity changed: %q -> %q", identityBefore, refreshed.IdentitySeed())
	}
	document := documentOf(t, refreshed)
	for _, slotID := range []string{primarySlot, passSlot} {
		auth := slotAuthOf(t, document, slotID)
		if auth["accessToken"] != newToken ||
			auth["refreshToken"] != "new-refresh" ||
			auth["accountId"] != "usr-1" {
			t.Fatalf("slot %q auth = %#v", slotID, auth)
		}
		if got, ok := tokenrefresh.TimestampMS(auth["expiresAt"]); !ok ||
			!got.Equal(testNow.Add(time.Hour)) {
			t.Fatalf("slot %q expiresAt = %#v", slotID, auth["expiresAt"])
		}
	}
	// 其它 provider 的槽位与 cline 自己的非凭据设置必须原样保留。
	root := tokenrefresh.Object(document["auth"])
	providers := tokenrefresh.Object(root["providers"])
	anthropic := tokenrefresh.Object(tokenrefresh.Object(providers["anthropic"])["settings"])
	if anthropic["apiKey"] != "must-not-be-touched" {
		t.Fatalf("anthropic slot was modified: %#v", anthropic)
	}
	clineSettings := tokenrefresh.Object(tokenrefresh.Object(providers[primarySlot])["settings"])
	if clineSettings["model"] != "anthropic/x" {
		t.Fatalf("cline settings were modified: %#v", clineSettings)
	}
	if body["refreshToken"] != "cline-refresh" || body["grantType"] != "refresh_token" {
		t.Fatalf("request body = %#v", body)
	}
}

func TestRefreshUsesLongerLivedSlot(t *testing.T) {
	passExpiry := testNow.Add(30 * time.Minute)
	var body map[string]string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		raw, _ := io.ReadAll(io.LimitReader(request.Body, 1<<20))
		body = map[string]string{}
		_ = json.Unmarshal(raw, &body)
		_, _ = io.WriteString(writer, `{"success":true,"data":{"accessToken":"`+testJWT(t, "user_1")+`","refreshToken":"new-refresh"}}`)
	}))
	defer server.Close()

	// cline 槽位已过期，cline-pass 还有 30 分钟：ExpiresAt 与刷新都必须看 cline-pass。
	original := newCredential(t, testPayload(t, testNow.Add(-time.Hour), &passExpiry))
	provider := newTestProvider(t, server.URL)
	expiresAt, ok := provider.ExpiresAt(original)
	if !ok || !expiresAt.Equal(passExpiry) {
		t.Fatalf("expiresAt = %s, ok = %v", expiresAt, ok)
	}
	if _, err := provider.Refresh(context.Background(), original); err != nil {
		t.Fatalf("Refresh() error = %v", err)
	}
	if body["refreshToken"] != "pass-refresh" {
		t.Fatalf("refreshToken = %q", body["refreshToken"])
	}
}

func TestRefreshUnknownExpiryIsNotDue(t *testing.T) {
	payload := `{"auth":{"version":1,"providers":{"cline":{"settings":{"auth":{"accessToken":%q,"refreshToken":"r"}}}}}}`
	if _, ok := newTestProvider(t, "http://127.0.0.1:1").
		ExpiresAt(newCredential(t, fmt.Sprintf(payload, "workos:"+testJWT(t, "user_1")))); ok {
		t.Fatal("unknown expiry must not be reported as due")
	}
}

func TestRefreshClassifiesInvalidGrantText(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(writer, `{"success":false,"error":"Refresh token expired, please re-authenticate"}`)
	}))
	defer server.Close()

	_, err := newTestProvider(t, server.URL).Refresh(
		context.Background(),
		newCredential(t, testPayload(t, testNow.Add(-10*time.Minute), nil)),
	)
	if !errors.Is(err, accountcredentials.ErrReauthenticationRequired) {
		t.Fatalf("error = %v", err)
	}
}

func TestRefreshRequiresRefreshToken(t *testing.T) {
	payload := `{"auth":{"version":1,"providers":{"cline":{"settings":{"auth":{"accessToken":%q,"expiresAt":%d}}}}}}`
	_, err := newTestProvider(t, "http://127.0.0.1:1").Refresh(
		context.Background(),
		newCredential(t, fmt.Sprintf(payload, "workos:"+testJWT(t, "user_1"), testNow.Add(-time.Minute).UnixMilli())),
	)
	if !errors.Is(err, accountcredentials.ErrReauthenticationRequired) {
		t.Fatalf("error = %v", err)
	}
}

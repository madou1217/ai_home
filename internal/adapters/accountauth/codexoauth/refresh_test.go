package codexoauth

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/madou1217/ai_home/core/accounts/codex"
)

func fakeJWT(payload string) string {
	encode := base64.RawURLEncoding.EncodeToString
	return encode([]byte(`{"alg":"none","typ":"JWT"}`)) + "." + encode([]byte(payload)) + ".sig"
}

// 回归守卫（2026-11-06）：Go 的 Codex refresh 必须和 Node 一样带 openid scope。
// 缺 scope 时 OpenAI 的 refresh 响应可能不再返回 id_token，订阅到期等 id_token
// 快照字段就永远停留在旧 token 上。
func TestRefreshSendsOpenIDScope(t *testing.T) {
	idToken := fakeJWT(`{"sub":"user-test","email":"test@example.com","https://api.openai.com/auth":{"chatgpt_user_id":"user-test","chatgpt_plan_type":"plus"}}`)
	accessToken := fakeJWT(`{"sub":"user-test","exp":4102444800}`)
	refreshToken := fakeJWT(`{"sub":"user-test","exp":4102444800}`)
	fixed := time.Date(2026, 11, 6, 0, 0, 0, 0, time.UTC)

	var received map[string]string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Errorf("decode refresh body: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w,
			`{"access_token":%q,"refresh_token":%q,"id_token":%q}`,
			accessToken, refreshToken, idToken,
		)
	}))
	defer server.Close()

	provider, err := newProvider(providerOptions{
		client:            server.Client(),
		clock:             func() time.Time { return fixed },
		random:            rand.Reader,
		authorizeEndpoint: "https://auth.openai.com/oauth/authorize",
		tokenEndpoint:     server.URL,
		redirectURI:       "http://localhost:1455/auth/callback",
	})
	if err != nil {
		t.Fatalf("newProvider: %v", err)
	}
	auth, err := codex.NewOAuthAuth(codex.OAuthInput{
		AccessToken:   accessToken,
		RefreshToken:  refreshToken,
		IDToken:       idToken,
		RefreshedAtMS: fixed.UnixMilli(),
	})
	if err != nil {
		t.Fatalf("NewOAuthAuth: %v", err)
	}
	if _, err := provider.Refresh(context.Background(), auth, fixed.Add(time.Minute)); err != nil {
		t.Fatalf("Refresh: %v", err)
	}
	if received["grant_type"] != "refresh_token" {
		t.Fatalf("grant_type = %q", received["grant_type"])
	}
	if received["scope"] != refreshScope {
		t.Fatalf("scope = %q, want %q", received["scope"], refreshScope)
	}
	if received["refresh_token"] != refreshToken {
		t.Fatalf("refresh_token was not forwarded")
	}
}

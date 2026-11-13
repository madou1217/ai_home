package agystorage

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/application/accountprojection"
	"github.com/madou1217/ai_home/core/accounts/agy"
)

func testAuth(t *testing.T, expiryMS int64) *agy.OAuthAuth {
	t.Helper()
	auth, err := agy.NewNativeOAuthAuth(agy.OAuthInput{
		Email:        "agy.test@example.com",
		AccessToken:  "ya29.agy-token-value",
		RefreshToken: "1//agy-refresh-value",
		ExpiresAtMS:  expiryMS,
		TokenType:    "Bearer",
		AuthMethod:   agy.AuthMethodConsumer,
	})
	if err != nil {
		t.Fatalf("credential: %v", err)
	}
	return auth
}

func TestPolicyShape(t *testing.T) {
	policy := Policy()
	if policy.Provider != "agy" || policy.Mode != accountprojection.ModeFakeHome {
		t.Fatalf("policy = %s/%s", policy.Provider, policy.Mode)
	}
	if len(policy.NativeRoot) != 2 || policy.NativeRoot[1] != "antigravity-cli" {
		t.Fatalf("native root = %v", policy.NativeRoot)
	}
	if len(policy.AuthArtifacts) != 2 || policy.AuthArtifacts[0].Field != "oauthToken" {
		t.Fatalf("artifacts = %#v", policy.AuthArtifacts)
	}
	if len(policy.Env) != 7 {
		t.Fatalf("env = %d", len(policy.Env))
	}
	if len(policy.ProjectionRoots) != 2 || len(policy.ProjectionRoots[1].To) != 4 {
		t.Fatalf("projection roots = %#v", policy.ProjectionRoots)
	}
}

func TestMaterializeWritesProjectionFiles(t *testing.T) {
	root := t.TempDir()
	request := accountprojection.Request{ProviderID: "agy", Credential: testAuth(t, 4070903045000)}
	if _, err := (Materializer{}).Materialize(context.Background(), request, Policy(), root); err != nil {
		t.Fatalf("Materialize: %v", err)
	}
	for _, path := range []string{
		filepath.Join(root, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
		filepath.Join(root, ".gemini", "antigravity-cli", "email.cache"),
		filepath.Join(root, ".gemini", "oauth_creds.json"),
		filepath.Join(root, ".gemini", "google_accounts.json"),
	} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("%s: %v", path, err)
		}
	}
}

func TestCaptureReadsRefreshedToken(t *testing.T) {
	root := t.TempDir()
	request := accountprojection.Request{ProviderID: "agy", Credential: testAuth(t, 4070903045000)}
	if _, err := (Materializer{}).Materialize(context.Background(), request, Policy(), root); err != nil {
		t.Fatalf("Materialize: %v", err)
	}
	current := request.Credential.(*agy.OAuthAuth)
	next, changed, err := (Materializer{}).Capture(context.Background(), request, Policy(), root)
	if err != nil || !changed {
		t.Fatalf("Capture: changed=%v err=%v", changed, err)
	}
	if (Materializer{}).ShouldAdopt(current, next) {
		t.Fatal("同一 expiry 不应回写")
	}
	// 模拟 CLI 续期：换成更晚的 expiry。
	if _, err := (Materializer{}).Materialize(context.Background(), accountprojection.Request{
		ProviderID: "agy",
		Credential: testAuth(t, 4070903046000),
	}, Policy(), root); err != nil {
		t.Fatalf("refresh materialize: %v", err)
	}
	next, _, err = (Materializer{}).Capture(context.Background(), request, Policy(), root)
	if err != nil {
		t.Fatalf("Capture refreshed: %v", err)
	}
	if !(Materializer{}).ShouldAdopt(current, next) {
		t.Fatal("更晚的 expiry 应回写")
	}
}

func TestCaptureRejectsIdentityMismatch(t *testing.T) {
	root := t.TempDir()
	request := accountprojection.Request{ProviderID: "agy", Credential: testAuth(t, 4070903045000)}
	if _, err := (Materializer{}).Materialize(context.Background(), request, Policy(), root); err != nil {
		t.Fatalf("Materialize: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, ".gemini", "antigravity-cli", "email.cache"), []byte("other@example.com"), 0o600); err != nil {
		t.Fatal(err)
	}
	tokenPath := filepath.Join(root, ".gemini", "antigravity-cli", "antigravity-oauth-token")
	raw, err := os.ReadFile(tokenPath)
	if err != nil {
		t.Fatal(err)
	}
	replaced := strings.Replace(string(raw), "agy.test@example.com", "other@example.com", 1)
	if err := os.WriteFile(tokenPath, []byte(replaced), 0o600); err != nil {
		t.Fatal(err)
	}
	_, _, err = (Materializer{}).Capture(context.Background(), request, Policy(), root)
	if !errors.Is(err, ErrIdentityMismatch) {
		t.Fatalf("err = %v，想要 ErrIdentityMismatch", err)
	}
}

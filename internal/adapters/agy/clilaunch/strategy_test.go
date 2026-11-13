package clilaunch

import (
	"slices"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/providerlaunch"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/agy"
)

func testAccountRef(t *testing.T) accountcore.AccountRef {
	t.Helper()
	ref, err := accountcore.ParseAccountRef("acct_00000000000000000002")
	if err != nil {
		t.Fatalf("account ref: %v", err)
	}
	return ref
}

func testOAuth(t *testing.T) *agy.OAuthAuth {
	t.Helper()
	auth, err := agy.NewNativeOAuthAuth(agy.OAuthInput{
		Email:        "agy.test@example.com",
		AccessToken:  "ya29.agy-token-value",
		RefreshToken: "1//agy-refresh-value",
		ExpiresAtMS:  4070903045000,
		TokenType:    "Bearer",
		AuthMethod:   agy.AuthMethodConsumer,
	})
	if err != nil {
		t.Fatalf("credential: %v", err)
	}
	return auth
}

func TestBuildOAuthUsesFakeHomeProjection(t *testing.T) {
	binding, err := accountapp.NewCredentialBinding(testAccountRef(t), "agy", testOAuth(t))
	if err != nil {
		t.Fatalf("binding: %v", err)
	}
	result, err := NewStrategy().Build(binding)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if result.Binary() != "agy" {
		t.Fatalf("binary = %s", result.Binary())
	}
	projection := result.Projection()
	if projection.Mode() != providerlaunch.ProjectionModeFakeHome || projection.PolicyID() != "agy" {
		t.Fatalf("projection = %s/%s", projection.Mode(), projection.PolicyID())
	}
	if result.Environment().RevealSet()["SSH_CONNECTION"] == "" {
		t.Fatal("Keychain 绕过变量缺失")
	}
	if !slices.Contains(result.Environment().UnsetNames(), "AGY_ACCESS_TOKEN") {
		t.Fatalf("unset = %v", result.Environment().UnsetNames())
	}
}

func TestBuildAccessTokenInjectsEnvironment(t *testing.T) {
	credential, err := accountcore.NewStaticAPIKeyAuth(accountcore.StaticAPIKeyInput{
		ProviderID: "agy",
		APIKey:     "agy-access-token-value",
	})
	if err != nil {
		t.Fatalf("api key: %v", err)
	}
	binding, err := accountapp.NewCredentialBinding(testAccountRef(t), "agy", credential)
	if err != nil {
		t.Fatalf("binding: %v", err)
	}
	result, err := NewStrategy().Build(binding)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if result.Projection().Mode() != providerlaunch.ProjectionModeNone {
		t.Fatalf("projection = %s", result.Projection().Mode())
	}
	if result.Environment().RevealSet()["AGY_ACCESS_TOKEN"] != "agy-access-token-value" {
		t.Fatalf("set = %#v", result.Environment().RevealSet())
	}
}

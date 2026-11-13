package clilaunch

import (
	"slices"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/providerlaunch"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

const geminiPayload = `{"googleAccounts":{"active":"gemini.test@example.com","old":[]},"oauthCreds":{"access_token":"ya29.test-token","refresh_token":"1//test-refresh","expiry_date":4070903045000}}`

func testAccountRef(t *testing.T) accountcore.AccountRef {
	t.Helper()
	ref, err := accountcore.ParseAccountRef("acct_00000000000000000001")
	if err != nil {
		t.Fatalf("account ref: %v", err)
	}
	return ref
}

func nativeGeminiCredential(t *testing.T) *accountcore.NativeCredential {
	t.Helper()
	identity, err := accountcore.NewNativeEmailIdentity("gemini", "gemini.test@example.com")
	if err != nil {
		t.Fatalf("identity: %v", err)
	}
	credential, err := accountcore.NewNativeCredential(identity, []byte(geminiPayload), accountcore.NativeGeneration{Scope: "google.expiry_date", Value: 4070903045000})
	if err != nil {
		t.Fatalf("credential: %v", err)
	}
	return credential
}

func TestBuildOAuthUsesConfigDirProjection(t *testing.T) {
	binding, err := accountapp.NewCredentialBinding(testAccountRef(t), "gemini", nativeGeminiCredential(t))
	if err != nil {
		t.Fatalf("binding: %v", err)
	}
	result, err := NewStrategy().Build(binding)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if result.Binary() != "gemini" || result.ProviderID() != "gemini" {
		t.Fatalf("result = %s/%s", result.ProviderID(), result.Binary())
	}
	projection := result.Projection()
	if projection.Mode() != providerlaunch.ProjectionModeConfigDir || projection.PolicyID() != "gemini" {
		t.Fatalf("projection = %s/%s", projection.Mode(), projection.PolicyID())
	}
	if !slices.Contains(result.Environment().UnsetNames(), "GEMINI_API_KEY") {
		t.Fatalf("unset = %v", result.Environment().UnsetNames())
	}
	if result.Credential().Kind() != "oauth" {
		t.Fatalf("kind = %s", result.Credential().Kind())
	}
}

func TestBuildAPIKeyInjectsEndpointWithoutProjection(t *testing.T) {
	credential, err := accountcore.NewStaticAPIKeyAuth(accountcore.StaticAPIKeyInput{
		ProviderID: "gemini",
		APIKey:     "gemini-api-key-value",
		BaseURL:    "https://gemini.example.test",
	})
	if err != nil {
		t.Fatalf("api key: %v", err)
	}
	binding, err := accountapp.NewCredentialBinding(testAccountRef(t), "gemini", credential)
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
	set := result.Environment().RevealSet()
	if set["GEMINI_API_KEY"] != "gemini-api-key-value" || set["GOOGLE_GEMINI_BASE_URL"] != "https://gemini.example.test" {
		t.Fatalf("set = %#v", set)
	}
	if !slices.Contains(result.Environment().UnsetNames(), "GEMINI_CLI_HOME") {
		t.Fatalf("unset = %v", result.Environment().UnsetNames())
	}
}

func TestBuildRejectsForeignCredential(t *testing.T) {
	identity, err := accountcore.NewNativeEmailIdentity("agy", "agy.test@example.com")
	if err != nil {
		t.Fatalf("identity: %v", err)
	}
	credential, err := accountcore.NewNativeCredential(identity, []byte(`{"email":"agy.test@example.com"}`))
	if err != nil {
		t.Fatalf("credential: %v", err)
	}
	binding, err := accountapp.NewCredentialBinding(testAccountRef(t), "agy", credential)
	if err != nil {
		t.Fatalf("binding: %v", err)
	}
	if _, err := NewStrategy().Build(binding); err == nil {
		t.Fatal("agy 凭据不应被 Gemini 策略接受")
	}
}

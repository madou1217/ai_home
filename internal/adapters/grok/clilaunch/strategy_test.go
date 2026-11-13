package clilaunch

import (
	"slices"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/providerlaunch"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

func testAccountRef(t *testing.T) accountcore.AccountRef {
	t.Helper()
	ref, err := accountcore.ParseAccountRef("acct_00000000000000000003")
	if err != nil {
		t.Fatalf("account ref: %v", err)
	}
	return ref
}

func nativeCredential(t *testing.T) *accountcore.NativeCredential {
	t.Helper()
	identity, err := accountcore.NewNativeGrokIdentity([]string{"grok-user-1"})
	if err != nil {
		t.Fatalf("identity: %v", err)
	}
	credential, err := accountcore.NewNativeCredential(identity, []byte(`{"auth":{"user_id":"grok-user-1","key":"xai-key-value","refresh_token":"xai-refresh-value"}}`))
	if err != nil {
		t.Fatalf("credential: %v", err)
	}
	return credential
}

func TestBuildOAuthUsesConfigDirProjection(t *testing.T) {
	binding, err := accountapp.NewCredentialBinding(testAccountRef(t), "grok", nativeCredential(t))
	if err != nil {
		t.Fatalf("binding: %v", err)
	}
	result, err := NewStrategy().Build(binding)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if result.Binary() != "grok" {
		t.Fatalf("binary = %s", result.Binary())
	}
	projection := result.Projection()
	if projection.Mode() != providerlaunch.ProjectionModeConfigDir || projection.PolicyID() != "grok" {
		t.Fatalf("projection = %s/%s", projection.Mode(), projection.PolicyID())
	}
	if !slices.Contains(result.Environment().UnsetNames(), "XAI_API_KEY") {
		t.Fatalf("unset = %v", result.Environment().UnsetNames())
	}
}

func TestBuildAPIKeyInjectsEndpointWithoutProjection(t *testing.T) {
	credential, err := accountcore.NewStaticAPIKeyAuth(accountcore.StaticAPIKeyInput{
		ProviderID: "grok",
		APIKey:     "xai-api-key-value",
		BaseURL:    "https://api.x.ai",
	})
	if err != nil {
		t.Fatalf("api key: %v", err)
	}
	binding, err := accountapp.NewCredentialBinding(testAccountRef(t), "grok", credential)
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
	if set["XAI_API_KEY"] != "xai-api-key-value" || set["XAI_BASE_URL"] != "https://api.x.ai" {
		t.Fatalf("set = %#v", set)
	}
}

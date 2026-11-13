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
	ref, err := accountcore.ParseAccountRef("acct_00000000000000000006")
	if err != nil {
		t.Fatalf("account ref: %v", err)
	}
	return ref
}

func TestBuildOAuthUsesBridgeProjection(t *testing.T) {
	identity, err := accountcore.NewNativeOpenCodeIdentity([]accountcore.NativeOpenCodeGrant{
		{Upstream: "opencode", Type: "oauth", Subject: "opencode-user-1"},
	})
	if err != nil {
		t.Fatalf("identity: %v", err)
	}
	payload := []byte(`{"auth":{"opencode":{"type":"oauth","access":"access-1","refresh":"refresh-1","account_id":"opencode-user-1"}}}`)
	credential, err := accountcore.NewNativeCredential(identity, payload)
	if err != nil {
		t.Fatalf("credential: %v", err)
	}
	binding, err := accountapp.NewCredentialBinding(testAccountRef(t), "opencode", credential)
	if err != nil {
		t.Fatalf("binding: %v", err)
	}
	result, err := NewStrategy().Build(binding)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	projection := result.Projection()
	if projection.Mode() != providerlaunch.ProjectionModeConfigDir || projection.PolicyID() != "opencode" {
		t.Fatalf("projection = %s/%s", projection.Mode(), projection.PolicyID())
	}
	if !slices.Contains(result.Environment().UnsetNames(), "OPENCODE_API_KEY") {
		t.Fatalf("unset = %v", result.Environment().UnsetNames())
	}
}

func TestBuildAPIKeyInjectsEnv(t *testing.T) {
	credential, err := accountcore.NewStaticAPIKeyAuth(accountcore.StaticAPIKeyInput{
		ProviderID: "opencode",
		APIKey:     "opencode-api-key-value",
	})
	if err != nil {
		t.Fatalf("api key: %v", err)
	}
	binding, err := accountapp.NewCredentialBinding(testAccountRef(t), "opencode", credential)
	if err != nil {
		t.Fatalf("binding: %v", err)
	}
	result, err := NewStrategy().Build(binding)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if result.Environment().RevealSet()["OPENCODE_API_KEY"] != "opencode-api-key-value" {
		t.Fatalf("set = %#v", result.Environment().RevealSet())
	}
}

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
	ref, err := accountcore.ParseAccountRef("acct_00000000000000000005")
	if err != nil {
		t.Fatalf("account ref: %v", err)
	}
	return ref
}

func TestBuildOAuthUsesConfigDirProjection(t *testing.T) {
	identity, err := accountcore.NewNativeSubjectIdentity("kimi", "kimi-user-1")
	if err != nil {
		t.Fatalf("identity: %v", err)
	}
	credential, err := accountcore.NewNativeCredential(identity, []byte(`{"credentials":{"access_token":"access-1","refresh_token":"refresh-1","user_id":"kimi-user-1"}}`))
	if err != nil {
		t.Fatalf("credential: %v", err)
	}
	binding, err := accountapp.NewCredentialBinding(testAccountRef(t), "kimi", credential)
	if err != nil {
		t.Fatalf("binding: %v", err)
	}
	result, err := NewStrategy().Build(binding)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	projection := result.Projection()
	if projection.Mode() != providerlaunch.ProjectionModeConfigDir || projection.PolicyID() != "kimi" {
		t.Fatalf("projection = %s/%s", projection.Mode(), projection.PolicyID())
	}
	if !slices.Contains(result.Environment().UnsetNames(), "MOONSHOT_API_KEY") {
		t.Fatalf("unset = %v", result.Environment().UnsetNames())
	}
}

func TestBuildAPIKeyInjectsMoonshotKey(t *testing.T) {
	credential, err := accountcore.NewStaticAPIKeyAuth(accountcore.StaticAPIKeyInput{
		ProviderID: "kimi",
		APIKey:     "moonshot-key-value",
		BaseURL:    "https://api.moonshot.test",
	})
	if err != nil {
		t.Fatalf("api key: %v", err)
	}
	binding, err := accountapp.NewCredentialBinding(testAccountRef(t), "kimi", credential)
	if err != nil {
		t.Fatalf("binding: %v", err)
	}
	result, err := NewStrategy().Build(binding)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if result.Projection().Mode() != providerlaunch.ProjectionModeConfigDir {
		t.Fatalf("projection = %s（API Key 账号也必须有配置根隔离）", result.Projection().Mode())
	}
	set := result.Environment().RevealSet()
	if set["MOONSHOT_API_KEY"] != "moonshot-key-value" || set["KIMI_BASE_URL"] != "https://api.moonshot.test" {
		t.Fatalf("set = %#v", set)
	}
}

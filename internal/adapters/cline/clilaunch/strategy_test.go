package clilaunch

import (
	"slices"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/providerlaunch"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

const clineToken = "workos.eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJ1c2VyX2NsaW5lXzEiLCJpYXQiOjE3MDAwMDAwMDB9.sig"

func testAccountRef(t *testing.T) accountcore.AccountRef {
	t.Helper()
	ref, err := accountcore.ParseAccountRef("acct_00000000000000000004")
	if err != nil {
		t.Fatalf("account ref: %v", err)
	}
	return ref
}

func nativeCredential(t *testing.T) *accountcore.NativeCredential {
	t.Helper()
	identity, err := accountcore.NewNativeSubjectIdentity("cline", "user_cline_1")
	if err != nil {
		t.Fatalf("identity: %v", err)
	}
	payload := `{"auth":{"version":1,"lastUsedProvider":"cline","providers":{"cline":{"settings":{"auth":{"accessToken":"` + clineToken + `","refreshToken":"refresh-1"}}}}}}`
	credential, err := accountcore.NewNativeCredential(identity, []byte(payload))
	if err != nil {
		t.Fatalf("credential: %v", err)
	}
	return credential
}

func TestBuildOAuthUsesConfigDirProjection(t *testing.T) {
	binding, err := accountapp.NewCredentialBinding(testAccountRef(t), "cline", nativeCredential(t))
	if err != nil {
		t.Fatalf("binding: %v", err)
	}
	result, err := NewStrategy().Build(binding)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if result.Binary() != "cline" {
		t.Fatalf("binary = %s", result.Binary())
	}
	projection := result.Projection()
	if projection.Mode() != providerlaunch.ProjectionModeConfigDir || projection.PolicyID() != "cline" {
		t.Fatalf("projection = %s/%s", projection.Mode(), projection.PolicyID())
	}
	if !slices.Contains(result.Environment().UnsetNames(), "CLINE_API_KEY") {
		t.Fatalf("unset = %v", result.Environment().UnsetNames())
	}
}

func TestBuildAPIKeyInjectsEndpoint(t *testing.T) {
	credential, err := accountcore.NewStaticAPIKeyAuth(accountcore.StaticAPIKeyInput{
		ProviderID: "cline",
		APIKey:     "cline-api-key-value",
		BaseURL:    "https://cline.example.test",
	})
	if err != nil {
		t.Fatalf("api key: %v", err)
	}
	binding, err := accountapp.NewCredentialBinding(testAccountRef(t), "cline", credential)
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
	if set["CLINE_API_KEY"] != "cline-api-key-value" || set["CLINE_API_BASE_URL"] != "https://cline.example.test" {
		t.Fatalf("set = %#v", set)
	}
}

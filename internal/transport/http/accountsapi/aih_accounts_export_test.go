package accountsapi

import (
	"testing"

	"github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/core/accounts/codex"
)

func TestExportStaticEnvCodex(t *testing.T) {
	credential, err := codex.NewAPIKeyAuth(codex.APIKeyInput{
		APIKey:  "sk-export",
		BaseURL: "https://export.example/v1",
	})
	if err != nil {
		t.Fatal(err)
	}
	env, err := exportStaticEnv(credential)
	if err != nil {
		t.Fatal(err)
	}
	if env["OPENAI_API_KEY"] != "sk-export" || env["OPENAI_BASE_URL"] != "https://export.example/v1" {
		t.Fatalf("env = %#v", env)
	}
}

func TestExportStaticEnvClaudeAuthToken(t *testing.T) {
	credential, err := claude.NewAuthTokenAuth(claude.AuthTokenInput{
		AuthToken: "tok-export",
		BaseURL:   "https://export.example",
	})
	if err != nil {
		t.Fatal(err)
	}
	env, err := exportStaticEnv(credential)
	if err != nil {
		t.Fatal(err)
	}
	if env["ANTHROPIC_AUTH_TOKEN"] != "tok-export" ||
		env["ANTHROPIC_BASE_URL"] != "https://export.example" ||
		env["AIH_CLAUDE_CREDENTIAL_TYPE"] != "auth-token" {
		t.Fatalf("env = %#v", env)
	}
}

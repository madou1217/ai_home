package accounts

import (
	"testing"

	"github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/core/accounts/codex"
)

// TestIsStaticSecretCredentialRecognizesNonRefreshableSecrets 验证 API Key / Auth Token
// 被识别为静态密钥，未知或空凭据不被误判。
func TestIsStaticSecretCredentialRecognizesNonRefreshableSecrets(t *testing.T) {
	t.Parallel()

	codexKey, err := codex.NewAPIKeyAuth(codex.APIKeyInput{APIKey: "sk-static", BaseURL: "https://relay.example.com/v1"})
	if err != nil {
		t.Fatalf("codex.NewAPIKeyAuth() error = %v", err)
	}
	claudeKey, err := claude.NewAPIKeyAuth(claude.APIKeyInput{APIKey: "sk-ant-static"})
	if err != nil {
		t.Fatalf("claude.NewAPIKeyAuth() error = %v", err)
	}
	for name, credential := range map[string]Credential{"codex api key": codexKey, "claude api key": claudeKey} {
		if !IsStaticSecretCredential(credential) {
			t.Fatalf("%s: IsStaticSecretCredential() = false", name)
		}
	}
	if IsStaticSecretCredential(nil) {
		t.Fatal("nil credential must not be static")
	}
}

package claudegateway_test

import (
	"errors"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/claudegateway"
	claudeauth "github.com/madou1217/ai_home/core/accounts/claude"
	codexauth "github.com/madou1217/ai_home/core/accounts/codex"
)

// TestCanonicalPolicyKeepsCodexOAuthOnCanonicalPath 验证 Codex 凭据不会被
// 错误投影为 Claude Native OAuth 租约。
func TestCanonicalPolicyKeepsCodexOAuthOnCanonicalPath(t *testing.T) {
	codexCredential, err := codexauth.NewAPIKeyAuth(codexauth.APIKeyInput{
		APIKey: "sk-codex-canonical-policy-test",
	})
	if err != nil {
		t.Fatalf("codex.NewAPIKeyAuth() error = %v", err)
	}
	claudeCredential, err := claudeauth.NewAPIKeyAuth(claudeauth.APIKeyInput{
		APIKey: "sk-ant-api03-canonical-policy-test",
	})
	if err != nil {
		t.Fatalf("claude.NewAPIKeyAuth() error = %v", err)
	}
	policy, err := claudegateway.NewCanonicalPolicy(
		codexauth.ProviderID,
		credentialCapabilityStub{providerID: codexauth.ProviderID},
	)
	if err != nil {
		t.Fatalf("NewCanonicalPolicy() error = %v", err)
	}
	if !policy.SupportsCredential(codexCredential) {
		t.Fatal("Codex 凭据未被 Canonical 策略接受")
	}
	transport, err := policy.TransportFor(codexCredential)
	if err != nil || transport != claudegateway.TransportCanonical {
		t.Fatalf("Codex TransportFor() = %s, %v", transport, err)
	}
	if policy.SupportsCredential(claudeCredential) {
		t.Fatal("Claude 凭据错误进入 Codex Canonical 策略")
	}
	if _, err := policy.TransportFor(claudeCredential); !errors.Is(
		err,
		claudegateway.ErrInvalidCanonicalPolicy,
	) {
		t.Fatalf("Claude TransportFor() error = %v", err)
	}
}

// credentialCapabilityStub 仅模拟已经由目标 Provider Adapter 声明的能力。
type credentialCapabilityStub struct {
	providerID string
}

// SupportsCredential 返回指定 Provider 凭据的能力结果。
func (stub credentialCapabilityStub) SupportsCredential(
	credential accountapp.Credential,
) bool {
	return credential != nil && credential.ProviderID() == stub.providerID
}

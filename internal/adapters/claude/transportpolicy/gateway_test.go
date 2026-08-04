package transportpolicy_test

import (
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/claudegateway"
	claudeauth "github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/internal/adapters/claude/transportpolicy"
)

// TestGatewayPolicyDelegatesCanonicalCapabilityAndPreservesNativeOAuth 验证
// 组合策略不复制 Messages Adapter 的 Canonical 凭据判断。
func TestGatewayPolicyDelegatesCanonicalCapabilityAndPreservesNativeOAuth(
	t *testing.T,
) {
	t.Parallel()

	oauth, err := claudeauth.NewOAuthAuth(claudeauth.OAuthInput{
		AccessToken:  "sk-ant-oat01-gateway-policy",
		RefreshToken: "sk-ant-ort01-gateway-policy",
		ExpiresAtMS:  time.Date(2100, 1, 1, 0, 0, 0, 0, time.UTC).UnixMilli(),
		Scopes:       []string{claudeauth.InferenceScope},
		Identity: claudeauth.OAuthIdentity{
			AccountUUID: "123e4567-e89b-12d3-a456-426614174000",
		},
	})
	if err != nil {
		t.Fatalf("claude.NewOAuthAuth() error = %v", err)
	}
	apiKey, err := claudeauth.NewAPIKeyAuth(claudeauth.APIKeyInput{
		APIKey: "sk-ant-api03-gateway-policy",
	})
	if err != nil {
		t.Fatalf("claude.NewAPIKeyAuth() error = %v", err)
	}
	canonical := &canonicalPolicyStub{supported: apiKey}
	policy, err := transportpolicy.NewGatewayPolicy(canonical)
	if err != nil {
		t.Fatalf("NewGatewayPolicy() error = %v", err)
	}
	oauthTransport, err := policy.TransportFor(oauth)
	if err != nil {
		t.Fatalf("TransportFor(oauth) error = %v", err)
	}
	apiKeyTransport, err := policy.TransportFor(apiKey)
	if err != nil {
		t.Fatalf("TransportFor(api key) error = %v", err)
	}
	if !policy.SupportsCredential(oauth) ||
		!policy.SupportsCredential(apiKey) ||
		oauthTransport != claudegateway.TransportNativeOAuth ||
		apiKeyTransport != claudegateway.TransportCanonical ||
		canonical.calls != 2 {
		t.Fatalf(
			"oauth=%s api_key=%s canonical_calls=%d",
			oauthTransport,
			apiKeyTransport,
			canonical.calls,
		)
	}
}

type canonicalPolicyStub struct {
	supported accountapp.Credential
	calls     int
}

func (policy *canonicalPolicyStub) SupportsCredential(
	credential accountapp.Credential,
) bool {
	policy.calls++
	return credential == policy.supported
}

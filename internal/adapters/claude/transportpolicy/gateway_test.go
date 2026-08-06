package transportpolicy_test

import (
	"net/http"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/claudegateway"
	claudeauth "github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/internal/adapters/claude/messages"
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

// TestGatewayPolicyKeepsNativeOAuthWithRealCanonicalAdapter 用真实 Messages
// Adapter 而非能力桩组合策略，锁定放开 Canonical 订阅 OAuth 之后官方 Claude
// 客户端仍然走 Native Relay：能力并集不得把原生字节证明降级成转码传输。
func TestGatewayPolicyKeepsNativeOAuthWithRealCanonicalAdapter(t *testing.T) {
	t.Parallel()

	oauth, err := claudeauth.NewOAuthAuth(claudeauth.OAuthInput{
		AccessToken:  "sk-ant-oat01-real-canonical",
		RefreshToken: "sk-ant-ort01-real-canonical",
		ExpiresAtMS:  time.Date(2100, 1, 1, 0, 0, 0, 0, time.UTC).UnixMilli(),
		Scopes:       []string{claudeauth.InferenceScope},
		Identity: claudeauth.OAuthIdentity{
			AccountUUID: "123e4567-e89b-12d3-a456-426614174111",
		},
	})
	if err != nil {
		t.Fatalf("claude.NewOAuthAuth() error = %v", err)
	}
	canonical, err := messages.NewAdapter(
		refusingHTTPClient{t: t},
		time.Now,
	)
	if err != nil {
		t.Fatalf("messages.NewAdapter() error = %v", err)
	}
	policy, err := transportpolicy.NewGatewayPolicy(canonical)
	if err != nil {
		t.Fatalf("NewGatewayPolicy() error = %v", err)
	}
	transport, err := policy.TransportFor(oauth)
	if err != nil {
		t.Fatalf("TransportFor(oauth) error = %v", err)
	}
	if !canonical.SupportsCredential(oauth) {
		t.Fatal("Canonical Adapter 必须能承载订阅 OAuth，跨协议客户端才有通道")
	}
	if transport != claudegateway.TransportNativeOAuth {
		t.Fatalf("官方 Claude 客户端订阅 OAuth 传输 = %s", transport)
	}
}

// refusingHTTPClient 保证传输选择过程完全不触碰网络。
type refusingHTTPClient struct {
	t *testing.T
}

func (client refusingHTTPClient) Do(*http.Request) (*http.Response, error) {
	client.t.Helper()
	client.t.Fatal("传输策略判定不得发起上游请求")
	return nil, nil
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

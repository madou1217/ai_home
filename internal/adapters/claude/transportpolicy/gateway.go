package transportpolicy

import (
	"errors"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/claudegateway"
)

// ErrInvalidGatewayPolicy 表示 Canonical Claude Adapter 缺失或凭据不受支持。
var ErrInvalidGatewayPolicy = errors.New("Claude Gateway 凭据传输策略无效")

// CanonicalPolicy 是 Go Messages Adapter 暴露的最小凭据能力端口。
type CanonicalPolicy interface {
	SupportsCredential(credential accountapp.Credential) bool
}

// GatewayPolicy 用策略模式统一 Native OAuth 与 Canonical 凭据选择。
type GatewayPolicy struct {
	canonical CanonicalPolicy
}

// NewGatewayPolicy 创建只依赖真实 Canonical Adapter 能力的组合策略。
func NewGatewayPolicy(canonical CanonicalPolicy) (*GatewayPolicy, error) {
	if canonical == nil {
		return nil, ErrInvalidGatewayPolicy
	}
	return &GatewayPolicy{canonical: canonical}, nil
}

// SupportsCredential 返回 Claude CLI Gateway 能安全承载的凭据并集。
func (policy *GatewayPolicy) SupportsCredential(
	credential accountapp.Credential,
) bool {
	return policy != nil && policy.canonical != nil &&
		(RequiresNativeOAuth(credential) ||
			policy.canonical.SupportsCredential(credential))
}

// TransportFor 对已选凭据返回唯一传输；官方 OAuth 优先保留原生证明。
func (policy *GatewayPolicy) TransportFor(
	credential accountapp.Credential,
) (claudegateway.Transport, error) {
	if policy == nil || policy.canonical == nil || credential == nil {
		return "", ErrInvalidGatewayPolicy
	}
	if RequiresNativeOAuth(credential) {
		return claudegateway.TransportNativeOAuth, nil
	}
	if policy.canonical.SupportsCredential(credential) {
		return claudegateway.TransportCanonical, nil
	}
	return "", ErrInvalidGatewayPolicy
}

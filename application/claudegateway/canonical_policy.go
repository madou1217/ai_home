package claudegateway

import (
	"errors"

	"github.com/madou1217/ai_home/application/accountrouting"
	accountapp "github.com/madou1217/ai_home/application/accounts"
)

// ErrInvalidCanonicalPolicy 表示目标 Provider 的 Canonical 能力端口无效。
var ErrInvalidCanonicalPolicy = errors.New("Canonical Provider 传输策略无效")

// CanonicalPolicy 把任意 Provider 的上游 Adapter 能力投影为 Gateway 选择策略。
//
// Claude OAuth 的 Native Relay 由 Claude 专用策略处理；其它 Provider（例如
// Codex OAuth）只能走 Canonical，因此不应复用 Claude 的原生租约逻辑。
type CanonicalPolicy struct {
	providerID string
	canonical  accountrouting.CredentialTransportPolicy
}

// NewCanonicalPolicy 创建指定 Provider 的纯 Canonical 传输策略。
func NewCanonicalPolicy(
	providerID string,
	canonical accountrouting.CredentialTransportPolicy,
) (*CanonicalPolicy, error) {
	if !isProviderToken(providerID) || canonical == nil {
		return nil, ErrInvalidCanonicalPolicy
	}
	return &CanonicalPolicy{
		providerID: providerID,
		canonical:  canonical,
	}, nil
}

// SupportsCredential 只接受目标 Provider 且已被对应 Adapter 声明支持的凭据。
func (policy *CanonicalPolicy) SupportsCredential(
	credential accountapp.Credential,
) bool {
	return policy != nil &&
		policy.canonical != nil &&
		credential != nil &&
		credential.ProviderID() == policy.providerID &&
		policy.canonical.SupportsCredential(credential)
}

// TransportFor 把已验证的目标 Provider 凭据固定投影为 Canonical。
func (policy *CanonicalPolicy) TransportFor(
	credential accountapp.Credential,
) (Transport, error) {
	if !policy.SupportsCredential(credential) {
		return "", ErrInvalidCanonicalPolicy
	}
	return TransportCanonical, nil
}

// isProviderToken 只接受进入注册表的简单 Provider ID，具体归属由 Catalog 复核。
func isProviderToken(value string) bool {
	if value == "" {
		return false
	}
	for _, character := range value {
		if character < 'a' || character > 'z' {
			return false
		}
	}
	return true
}

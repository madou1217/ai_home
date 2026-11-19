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

// GatewayPolicy 用策略模式统一 Native 透传与 Canonical 凭据选择。
//
// 「能否原生透传」只问 MessagesUpstream 投影，不再在这里复制凭据类型判断：
// 官方 OAuth 与厂商 Anthropic 兼容端点都是原生 Messages 上游，未来新增凭据
// 形态只增加一个投影实现，本策略与 relay 一起自动跟随。
type GatewayPolicy struct {
	canonical CanonicalPolicy
	upstream  MessagesUpstream
}

// NewGatewayPolicy 组合 Canonical 能力与原生 Messages 投影。
//
// upstream 为空时退化为「官方 OAuth 才能原生透传」的默认链，保持旧装配可用。
func NewGatewayPolicy(
	canonical CanonicalPolicy,
	upstream MessagesUpstream,
) (*GatewayPolicy, error) {
	if canonical == nil {
		return nil, ErrInvalidGatewayPolicy
	}
	if upstream == nil {
		upstream = NewDefaultMessagesUpstream()
	}
	return &GatewayPolicy{canonical: canonical, upstream: upstream}, nil
}

// SupportsCredential 返回 Claude CLI Gateway 能安全承载的凭据并集。
func (policy *GatewayPolicy) SupportsCredential(
	credential accountapp.Credential,
) bool {
	return policy != nil && policy.canonical != nil &&
		(projectableMessagesTarget(policy.upstream, credential) ||
			policy.canonical.SupportsCredential(credential))
}

// TransportFor 对已选凭据返回唯一传输；可原生透传的凭据优先保留原生语义。
func (policy *GatewayPolicy) TransportFor(
	credential accountapp.Credential,
) (claudegateway.Transport, error) {
	if policy == nil || policy.canonical == nil || credential == nil {
		return "", ErrInvalidGatewayPolicy
	}
	if projectableMessagesTarget(policy.upstream, credential) {
		// TransportNativeOAuth 的取值保持既有协议不变；语义是「原生 Messages
		// 透传」，当前覆盖官方 OAuth 与厂商 Anthropic 兼容端点。
		return claudegateway.TransportNativeOAuth, nil
	}
	if policy.canonical.SupportsCredential(credential) {
		return claudegateway.TransportCanonical, nil
	}
	return "", ErrInvalidGatewayPolicy
}

// projectableMessagesTarget 判断凭据能否投影成原生 Messages 上游。
func projectableMessagesTarget(
	upstream MessagesUpstream,
	credential accountapp.Credential,
) bool {
	if upstream == nil || credential == nil {
		return false
	}
	target, ok := upstream.Project(credential)
	return ok && target.IsValid()
}

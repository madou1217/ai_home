package inferencegateway

import (
	"context"
	"errors"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/core/inference"
)

var (
	// ErrInvalidRoute 表示 Provider、上游协议、真实模型或能力不一致。
	ErrInvalidRoute = errors.New("Canonical 推理路由无效")
	// ErrRouteNotFound 表示当前请求没有明确可用的 Provider 路由。
	ErrRouteNotFound = errors.New("Canonical 推理路由不存在")
	// ErrUnsupportedRouteCapabilities 表示路由不能完整表达请求能力。
	ErrUnsupportedRouteCapabilities = errors.New("Canonical 推理路由能力不足")
)

// Route 是完成别名和能力选择后的单一上游执行计划。
type Route struct {
	providerID     inference.ProviderID
	protocolID     inference.ProtocolID
	effectiveModel string
	capabilities   inference.CapabilitySet
}

// NewRoute 创建当前 Codex 或 Claude 原生上游路由。
func NewRoute(
	providerID inference.ProviderID,
	protocolID inference.ProtocolID,
	effectiveModel string,
	capabilities inference.CapabilitySet,
) (Route, error) {
	if !providerID.IsValid() ||
		!protocolID.IsValid() ||
		!capabilities.IsValid() ||
		!providerOwnsProtocol(providerID, protocolID) {
		return Route{}, ErrInvalidRoute
	}
	modelID, err := runtimecore.NewModelID(effectiveModel)
	if err != nil {
		return Route{}, ErrInvalidRoute
	}
	return Route{
		providerID:     providerID,
		protocolID:     protocolID,
		effectiveModel: modelID.String(),
		capabilities:   capabilities,
	}, nil
}

// ProviderID 返回账号和认证归属。
func (route Route) ProviderID() inference.ProviderID {
	return route.providerID
}

// ProtocolID 返回真实上游线协议。
func (route Route) ProtocolID() inference.ProtocolID {
	return route.protocolID
}

// EffectiveModel 返回别名解析后的真实上游模型。
func (route Route) EffectiveModel() string {
	return route.effectiveModel
}

// Capabilities 返回上游 Adapter 明确支持的能力位图。
func (route Route) Capabilities() inference.CapabilitySet {
	return route.capabilities
}

// Supports 判断路由是否完整覆盖当前请求能力。
func (route Route) Supports(required inference.CapabilitySet) bool {
	return route.IsValid() &&
		required.IsValid() &&
		route.capabilities.ContainsAll(required)
}

// IsValid 重新检查跨层传递后的路由不变量。
func (route Route) IsValid() bool {
	restored, err := NewRoute(
		route.providerID,
		route.protocolID,
		route.effectiveModel,
		route.capabilities,
	)
	return err == nil && restored == route
}

// RouteResolver 把客户端模型、别名和能力解析为唯一上游路由。
type RouteResolver interface {
	Resolve(
		ctx context.Context,
		request inference.Request,
	) (Route, error)
}

// providerOwnsProtocol 固化当前阶段两个 Provider 的原生上游协议。
func providerOwnsProtocol(
	providerID inference.ProviderID,
	protocolID inference.ProtocolID,
) bool {
	return (providerID == inference.ProviderCodex &&
		protocolID == inference.ProtocolCodexResponses) ||
		(providerID == inference.ProviderClaude &&
			protocolID == inference.ProtocolClaudeMessages)
}

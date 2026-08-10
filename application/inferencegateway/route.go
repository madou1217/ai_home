package inferencegateway

import (
	"context"
	"errors"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/core/inference"
)

const (
	// MaxRouteCandidates 限制一次请求可尝试的有序路由候选数量。
	MaxRouteCandidates = 8
)

var (
	// ErrInvalidRoute 表示 Provider、上游协议、真实模型或能力不一致。
	ErrInvalidRoute = errors.New("Canonical 推理路由无效")
	// ErrInvalidRoutePlan 表示路由计划含无效、重复或过多候选。
	ErrInvalidRoutePlan = errors.New("Canonical 推理路由计划无效")
	// ErrRouteNotFound 表示当前请求没有明确可用的 Provider 路由。
	ErrRouteNotFound = errors.New("Canonical 推理路由不存在")
	// ErrUnsupportedRouteCapabilities 表示路由不能完整表达请求能力。
	ErrUnsupportedRouteCapabilities = errors.New("Canonical 推理路由能力不足")
)

// Route 是完成别名和能力选择后的单一上游执行候选。
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

// RoutePlan 保存按优先级排列且数量有界的不可变路由候选。
type RoutePlan struct {
	candidates [MaxRouteCandidates]Route
	count      uint8
}

// NewRoutePlan 创建拒绝空集合、重复身份和无界输入的路由计划。
func NewRoutePlan(routes ...Route) (RoutePlan, error) {
	if len(routes) == 0 {
		return RoutePlan{}, ErrRouteNotFound
	}
	if !validRouteCandidates(routes) {
		return RoutePlan{}, ErrInvalidRoutePlan
	}
	var plan RoutePlan
	copy(plan.candidates[:], routes)
	plan.count = uint8(len(routes))
	return plan, nil
}

// Candidates 返回不会修改计划内部顺序的候选副本。
func (plan RoutePlan) Candidates() []Route {
	if plan.count > MaxRouteCandidates {
		return nil
	}
	return append([]Route(nil), plan.candidates[:plan.count]...)
}

// IsValid 重新检查跨层传递后的计划不变量。
func (plan RoutePlan) IsValid() bool {
	return plan.count <= MaxRouteCandidates &&
		validRouteCandidates(plan.candidates[:plan.count])
}

// RouteResolver 把客户端模型、别名和能力解析为有序上游路由计划。
type RouteResolver interface {
	Resolve(
		ctx context.Context,
		request inference.Request,
	) (RoutePlan, error)
}

// ProtocolRouteResolver 为保持原生线协议的传输查询单一精确路由。
//
// 该端口只做模型别名和作用域解析，不构造虚假的 Canonical Request，也不按
// Canonical 能力位过滤原生协议字段。
type ProtocolRouteResolver interface {
	ResolveProtocolRoute(
		ctx context.Context,
		clientProtocol inference.ClientProtocolID,
		model string,
		providerID inference.ProviderID,
		protocolID inference.ProtocolID,
	) (Route, error)
}

// validRouteCandidates 验证候选上限、路由不变量和真实目标唯一性。
func validRouteCandidates(routes []Route) bool {
	if len(routes) == 0 || len(routes) > MaxRouteCandidates {
		return false
	}
	for index, route := range routes {
		if !route.IsValid() {
			return false
		}
		for previous := range index {
			if sameRouteIdentity(route, routes[previous]) {
				return false
			}
		}
	}
	return true
}

// sameRouteIdentity 判断两个候选是否指向同一个真实上游模型。
func sameRouteIdentity(left Route, right Route) bool {
	return left.ProviderID() == right.ProviderID() &&
		left.ProtocolID() == right.ProtocolID() &&
		left.EffectiveModel() == right.EffectiveModel()
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

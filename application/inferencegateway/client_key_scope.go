package inferencegateway

import (
	"context"
	"errors"
	"strings"

	coreclientkeys "github.com/madou1217/ai_home/core/clientkeys"
	"github.com/madou1217/ai_home/core/inference"
)

var (
	// ErrClientKeyModelForbidden 表示这把客户端 Key 的模型池不包含请求模型。
	ErrClientKeyModelForbidden = errors.New("客户端 API Key 不允许该模型")
	// ErrClientKeyProviderForbidden 表示这把客户端 Key 的账号池不包含任何可用路由。
	ErrClientKeyProviderForbidden = errors.New("客户端 API Key 不允许该账号池")
)

// ClientKeyLimitsSource 返回托管 Key 的生效限制；第二返回值表示 Key 是否在活动快照里。
//
// 总 key 不在托管快照中，由调用方按 Master 身份直接放行。
type ClientKeyLimitsSource func(keyID string) (coreclientkeys.Limits, bool)

// routeScope 是一次请求的账号池/模型池限制；空集合表示不限制。
type routeScope struct {
	providers map[string]struct{}
	models    map[string]struct{}
}

// ScopedRoutes 在路由解析之上执行客户端 Key 的账号池与模型池白名单。
//
// 路由本身（模型别名、Provider、协议、能力）仍由内层 Resolver 决定；本类型只
// 剔除白名单外的候选，不发明候选、不改变候选顺序。没有 Key 限制时逐字节透传。
type ScopedRoutes struct {
	routes RouteResolver
	limits ClientKeyLimitsSource
}

// 编译期确认作用域解析器同时满足 Canonical 与原生传输的路由端口。
var (
	_ RouteResolver         = (*ScopedRoutes)(nil)
	_ ProtocolRouteResolver = (*ScopedRoutes)(nil)
)

// NewScopedRoutes 用托管 Key 限制包装一个路由解析器；limits 为 nil 时返回 nil。
func NewScopedRoutes(
	routes RouteResolver,
	limits ClientKeyLimitsSource,
) *ScopedRoutes {
	if routes == nil || limits == nil {
		return nil
	}
	return &ScopedRoutes{routes: routes, limits: limits}
}

// Resolve 先按内层目录解析，再按当前 Key 的白名单过滤候选。
func (scoped *ScopedRoutes) Resolve(
	ctx context.Context,
	request inference.Request,
) (RoutePlan, error) {
	if scoped == nil || scoped.routes == nil {
		return RoutePlan{}, ErrRouteNotFound
	}
	plan, err := scoped.routes.Resolve(ctx, request)
	if err != nil {
		return RoutePlan{}, err
	}
	scope, restricted := scoped.scopeFromContext(ctx)
	if !restricted {
		return plan, nil
	}
	return scope.filterPlan(request, plan)
}

// ResolveProtocolRoute 为原生传输执行同一份账号池/模型池判定。
func (scoped *ScopedRoutes) ResolveProtocolRoute(
	ctx context.Context,
	clientProtocol inference.ClientProtocolID,
	model string,
	providerID inference.ProviderID,
	protocolID inference.ProtocolID,
) (Route, error) {
	if scoped == nil || scoped.routes == nil {
		return Route{}, ErrRouteNotFound
	}
	protocols, ok := scoped.routes.(ProtocolRouteResolver)
	if !ok {
		return Route{}, ErrInvalidRouteResolution
	}
	route, err := protocols.ResolveProtocolRoute(ctx, clientProtocol, model, providerID, protocolID)
	if err != nil {
		return Route{}, err
	}
	scope, restricted := scoped.scopeFromContext(ctx)
	if !restricted {
		return route, nil
	}
	if !scope.providerAllowed(route.ProviderID()) {
		return Route{}, ErrClientKeyProviderForbidden
	}
	if !scope.modelAllowed(model) && !scope.modelAllowed(route.EffectiveModel()) {
		return Route{}, ErrClientKeyModelForbidden
	}
	return route, nil
}

func (scoped *ScopedRoutes) scopeFromContext(ctx context.Context) (routeScope, bool) {
	identity, ok := coreclientkeys.IdentityFromContext(ctx)
	if !ok || identity.Master {
		return routeScope{}, false
	}
	limits, ok := scoped.limits(identity.KeyID)
	if !ok {
		return routeScope{}, false
	}
	scope := routeScope{
		providers: stringSet(limits.AllowedProviders),
		models:    stringSet(limits.AllowedModels),
	}
	if len(scope.providers) == 0 && len(scope.models) == 0 {
		return routeScope{}, false
	}
	return scope, true
}

func (scope routeScope) providerAllowed(providerID inference.ProviderID) bool {
	if len(scope.providers) == 0 {
		return true
	}
	_, allowed := scope.providers[strings.TrimSpace(string(providerID))]
	return allowed
}

func (scope routeScope) modelAllowed(model string) bool {
	if len(scope.models) == 0 {
		return true
	}
	_, allowed := scope.models[strings.TrimSpace(model)]
	return allowed
}

// filterPlan 按白名单保留原顺序与真实目标唯一性。
func (scope routeScope) filterPlan(
	request inference.Request,
	plan RoutePlan,
) (RoutePlan, error) {
	candidates := plan.Candidates()
	requestedAllowed := scope.modelAllowed(request.Model())
	filtered := make([]Route, 0, len(candidates))
	for _, route := range candidates {
		if !scope.providerAllowed(route.ProviderID()) {
			continue
		}
		if !requestedAllowed && !scope.modelAllowed(route.EffectiveModel()) {
			continue
		}
		filtered = append(filtered, route)
	}
	if len(filtered) == 0 {
		if len(scope.models) > 0 && !requestedAllowed {
			return RoutePlan{}, ErrClientKeyModelForbidden
		}
		if len(scope.providers) > 0 {
			return RoutePlan{}, ErrClientKeyProviderForbidden
		}
		return RoutePlan{}, ErrClientKeyModelForbidden
	}
	restricted, err := NewRoutePlan(filtered...)
	if err != nil {
		return RoutePlan{}, err
	}
	return restricted, nil
}

func stringSet(values []string) map[string]struct{} {
	if len(values) == 0 {
		return nil
	}
	set := make(map[string]struct{}, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			continue
		}
		set[trimmed] = struct{}{}
	}
	if len(set) == 0 {
		return nil
	}
	return set
}

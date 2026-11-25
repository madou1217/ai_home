package inferencegateway

import (
	"context"
	"errors"

	coreclientkeys "github.com/madou1217/ai_home/core/clientkeys"
	"github.com/madou1217/ai_home/core/inference"
)

var (
	// ErrClientKeyModelForbidden 表示这把客户端 Key 的模型池不包含请求模型。
	ErrClientKeyModelForbidden = errors.New("客户端 API Key 不允许该模型")
	// ErrClientKeyProviderForbidden 表示这把客户端 Key 的账号池不包含任何可用路由。
	ErrClientKeyProviderForbidden = errors.New("客户端 API Key 不允许该账号池")
)

// ScopedRoutes 在路由解析之上执行客户端 Key 的账号池与模型池白名单。
//
// 路由本身（模型别名、Provider、协议、能力）仍由内层 Resolver 决定；本类型只
// 剔除白名单外的候选，不发明候选、不改变候选顺序。请求未携带 Key 限制时逐字节透传。
//
// 限制由鉴权边界写入请求上下文（core/clientkeys.WithLimits），因此本层不依赖
// 存储、HTTP 或管理面，可被 Canonical、原生与透传通道共同复用。
type ScopedRoutes struct {
	routes RouteResolver
}

// 编译期确认作用域解析器同时满足 Canonical 与原生传输的路由端口。
var (
	_ RouteResolver         = (*ScopedRoutes)(nil)
	_ ProtocolRouteResolver = (*ScopedRoutes)(nil)
)

// NewScopedRoutes 包装一个路由解析器；routes 为 nil 时返回 nil。
func NewScopedRoutes(routes RouteResolver) *ScopedRoutes {
	if routes == nil {
		return nil
	}
	return &ScopedRoutes{routes: routes}
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
	limits, restricted := clientKeyLimits(ctx)
	if !restricted {
		return plan, nil
	}
	return filterPlan(limits, request, plan)
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
	limits, restricted := clientKeyLimits(ctx)
	if !restricted {
		return route, nil
	}
	if !limits.AllowsProvider(string(route.ProviderID())) {
		return Route{}, ErrClientKeyProviderForbidden
	}
	if !limits.AllowsModel(model) && !limits.AllowsModel(route.EffectiveModel()) {
		return Route{}, ErrClientKeyModelForbidden
	}
	return route, nil
}

// clientKeyLimits 返回当前请求生效的 Key 限制；未携带或未配置白名单时 restricted=false。
func clientKeyLimits(ctx context.Context) (coreclientkeys.Limits, bool) {
	limits, ok := coreclientkeys.LimitsFromContext(ctx)
	if !ok || !limits.Restricted() {
		return coreclientkeys.Limits{}, false
	}
	return limits, true
}

// filterPlan 按白名单保留原顺序与真实目标唯一性。
func filterPlan(
	limits coreclientkeys.Limits,
	request inference.Request,
	plan RoutePlan,
) (RoutePlan, error) {
	candidates := plan.Candidates()
	requestedAllowed := limits.AllowsModel(request.Model())
	filtered := make([]Route, 0, len(candidates))
	for _, route := range candidates {
		if !limits.AllowsProvider(string(route.ProviderID())) {
			continue
		}
		if !requestedAllowed && !limits.AllowsModel(route.EffectiveModel()) {
			continue
		}
		filtered = append(filtered, route)
	}
	if len(filtered) == 0 {
		if !requestedAllowed {
			return RoutePlan{}, ErrClientKeyModelForbidden
		}
		return RoutePlan{}, ErrClientKeyProviderForbidden
	}
	restricted, err := NewRoutePlan(filtered...)
	if err != nil {
		return RoutePlan{}, err
	}
	return restricted, nil
}

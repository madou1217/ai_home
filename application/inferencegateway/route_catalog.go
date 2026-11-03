package inferencegateway

import (
	"context"
	"sort"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/core/inference"
)

// RouteCatalog 是按精确模型索引并预排序通配符规则的不可变 Resolver。
type RouteCatalog struct {
	exact     map[string][]RouteRule
	wildcards []RouteRule
}

// 编译期确认生产目录完整实现路由解析端口。
var _ RouteResolver = (*RouteCatalog)(nil)
var _ ProtocolRouteResolver = (*RouteCatalog)(nil)

// NewRouteCatalog 构建只读索引，并拒绝空、无界或重复规则集合。
func NewRouteCatalog(rules ...RouteRule) (*RouteCatalog, error) {
	if len(rules) == 0 || len(rules) > MaxRouteRules {
		return nil, ErrInvalidRouteCatalog
	}
	catalog := &RouteCatalog{
		exact: make(map[string][]RouteRule),
	}
	identities := make(map[routeRuleIdentity]struct{}, len(rules))
	for _, rule := range rules {
		if err := catalog.addRule(rule, identities); err != nil {
			return nil, err
		}
	}
	catalog.sortRules()
	return catalog, nil
}

// Resolve 按精确组、通配符组和能力约束生成有界执行计划。
func (catalog *RouteCatalog) Resolve(
	ctx context.Context,
	request inference.Request,
) (RoutePlan, error) {
	if !catalog.canResolve(ctx, request) {
		return RoutePlan{}, ErrInvalidRouteResolution
	}
	if err := ctx.Err(); err != nil {
		return RoutePlan{}, err
	}
	collector := routeCollector{
		required: request.RequiredCapabilities(),
	}
	collector.addRules(
		catalog.exact[request.Model()],
		request.Model(),
		request.ClientProtocol(),
	)
	if !collector.full() {
		collector.addRules(
			catalog.wildcards,
			request.Model(),
			request.ClientProtocol(),
		)
	}
	return collector.plan()
}

// ResolveProtocolRoute 为原生同协议传输返回第一个精确 Provider/协议路由。
//
// 查询沿用普通目录的精确匹配、最长前缀、优先级和客户端作用域顺序；区别是
// 原生传输保留 Provider 全量字段，因此不使用 Canonical 能力集合做筛选。
func (catalog *RouteCatalog) ResolveProtocolRoute(
	ctx context.Context,
	clientProtocol inference.ClientProtocolID,
	model string,
	providerID inference.ProviderID,
	protocolID inference.ProtocolID,
) (Route, error) {
	modelID, modelErr := runtimecore.NewModelID(model)
	if catalog == nil ||
		len(catalog.exact)+len(catalog.wildcards) == 0 ||
		ctx == nil ||
		!clientProtocol.IsValid() ||
		modelErr != nil ||
		modelID.String() != model ||
		!providerID.IsValid() ||
		!protocolID.IsValid() ||
		!providerOwnsProtocol(providerID, protocolID) {
		return Route{}, ErrInvalidRouteResolution
	}
	if err := ctx.Err(); err != nil {
		return Route{}, err
	}
	if route, found := resolveProtocolRules(
		catalog.exact[model],
		model,
		clientProtocol,
		providerID,
		protocolID,
	); found {
		return route, nil
	}
	if route, found := resolveProtocolRules(
		catalog.wildcards,
		model,
		clientProtocol,
		providerID,
		protocolID,
	); found {
		return route, nil
	}
	return Route{}, ErrRouteNotFound
}

// resolveProtocolRules 在构造期排好序的规则中完成无分配精确传输查询。
func resolveProtocolRules(
	rules []RouteRule,
	model string,
	clientProtocol inference.ClientProtocolID,
	providerID inference.ProviderID,
	protocolID inference.ProtocolID,
) (Route, bool) {
	for _, rule := range rules {
		if !rule.matches(model, clientProtocol) {
			continue
		}
		route := rule.Route()
		if route.ProviderID() == providerID &&
			route.ProtocolID() == protocolID {
			return route, true
		}
	}
	return Route{}, false
}

// routeRuleIdentity 标识不能在目录中重复声明的匹配目标。
type routeRuleIdentity struct {
	pattern        string
	scope          RouteScope
	providerID     inference.ProviderID
	protocolID     inference.ProtocolID
	effectiveModel string
}

// addRule 把一条规则加入对应索引。
func (catalog *RouteCatalog) addRule(
	rule RouteRule,
	identities map[routeRuleIdentity]struct{},
) error {
	if !rule.IsValid() {
		return ErrInvalidRouteCatalog
	}
	identity := routeRuleIdentity{
		pattern:        rule.Pattern(),
		scope:          rule.Scope(),
		providerID:     rule.Route().ProviderID(),
		protocolID:     rule.Route().ProtocolID(),
		effectiveModel: rule.Route().EffectiveModel(),
	}
	if _, found := identities[identity]; found {
		return ErrDuplicateRouteRule
	}
	identities[identity] = struct{}{}
	if rule.matchKind == routeMatchExact {
		catalog.exact[rule.Pattern()] = append(
			catalog.exact[rule.Pattern()],
			rule,
		)
		return nil
	}
	catalog.wildcards = append(catalog.wildcards, rule)
	return nil
}

// sortRules 只在构造阶段排序，解析热路径不执行排序或写共享状态。
func (catalog *RouteCatalog) sortRules() {
	for pattern := range catalog.exact {
		rules := catalog.exact[pattern]
		sort.SliceStable(rules, func(left int, right int) bool {
			return rules[left].Priority() > rules[right].Priority()
		})
		catalog.exact[pattern] = rules
	}
	sort.SliceStable(
		catalog.wildcards,
		func(left int, right int) bool {
			leftRule := catalog.wildcards[left]
			rightRule := catalog.wildcards[right]
			if leftRule.prefixLength != rightRule.prefixLength {
				return leftRule.prefixLength > rightRule.prefixLength
			}
			return leftRule.Priority() > rightRule.Priority()
		},
	)
}

// canResolve 在访问目录索引前拒绝零值依赖和不完整请求。
func (catalog *RouteCatalog) canResolve(
	ctx context.Context,
	request inference.Request,
) bool {
	return catalog != nil &&
		len(catalog.exact)+len(catalog.wildcards) > 0 &&
		ctx != nil &&
		request.ClientProtocol().IsValid() &&
		request.Model() != "" &&
		request.RequiredCapabilities().IsValid()
}

// routeCollector 在固定八个槽位内完成能力过滤和真实目标去重。
type routeCollector struct {
	routes   [MaxRouteCandidates]Route
	count    int
	matched  bool
	required inference.CapabilitySet
}

// addRules 按目录顺序收集当前模型可用的路由。
func (collector *routeCollector) addRules(
	rules []RouteRule,
	model string,
	protocolID inference.ClientProtocolID,
) {
	for _, rule := range rules {
		if collector.full() {
			return
		}
		if !rule.matches(model, protocolID) {
			continue
		}
		collector.matched = true
		route := rule.Route()
		if !route.Supports(collector.required) ||
			collector.contains(route) {
			continue
		}
		collector.routes[collector.count] = route
		collector.count++
	}
}

// contains 在最多八个候选内用线性比较避免热路径 map 分配。
func (collector *routeCollector) contains(route Route) bool {
	for index := range collector.count {
		if sameRouteIdentity(collector.routes[index], route) {
			return true
		}
	}
	return false
}

// full 判断执行计划是否已达到固定候选上限。
func (collector *routeCollector) full() bool {
	return collector.count == MaxRouteCandidates
}

// plan 返回不可变计划，并保留未知模型与能力不足的错误区别。
func (collector *routeCollector) plan() (RoutePlan, error) {
	if collector.count > 0 {
		return NewRoutePlan(collector.routes[:collector.count]...)
	}
	if collector.matched {
		return RoutePlan{}, ErrUnsupportedRouteCapabilities
	}
	return RoutePlan{}, ErrRouteNotFound
}

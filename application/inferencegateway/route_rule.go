package inferencegateway

import (
	"errors"
	"strings"
	"unicode/utf8"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/core/inference"
)

const (
	// MaxRouteRules 限制单个不可变目录可接收的规则数量。
	MaxRouteRules = 4096
)

var (
	// ErrInvalidRouteRule 表示匹配模式、作用域或真实路由无效。
	ErrInvalidRouteRule = errors.New("模型路由规则无效")
	// ErrInvalidRouteCatalog 表示目录为空、无界或包含无效规则。
	ErrInvalidRouteCatalog = errors.New("模型路由目录无效")
	// ErrDuplicateRouteRule 表示相同匹配入口重复指向同一真实目标。
	ErrDuplicateRouteRule = errors.New("模型路由规则重复")
	// ErrInvalidRouteResolution 表示上下文或 Canonical 请求不完整。
	ErrInvalidRouteResolution = errors.New("模型路由解析请求无效")
)

// RouteScope 表示规则允许进入的客户端协议默认 Provider。
type RouteScope string

const (
	// RouteScopeAll 表示规则可供任意客户端协议入口使用。
	RouteScopeAll RouteScope = "all"
	// RouteScopeCodex 表示规则只供 OpenAI 默认入口使用。
	RouteScopeCodex RouteScope = "codex"
	// RouteScopeClaude 表示规则只供 Anthropic 默认入口使用。
	RouteScopeClaude RouteScope = "claude"
)

// IsValid 判断作用域是否属于当前 Codex/Claude 重构范围。
func (scope RouteScope) IsValid() bool {
	return scope == RouteScopeAll ||
		scope == RouteScopeCodex ||
		scope == RouteScopeClaude
}

// accepts 判断客户端协议的默认 Provider 是否满足规则作用域。
func (scope RouteScope) accepts(protocolID inference.ClientProtocolID) bool {
	if scope == RouteScopeAll {
		return protocolID.IsValid()
	}
	switch protocolID {
	case inference.ClientProtocolOpenAIResponses,
		inference.ClientProtocolOpenAIChatCompletions:
		return scope == RouteScopeCodex
	case inference.ClientProtocolAnthropicMessages:
		return scope == RouteScopeClaude
	default:
		return false
	}
}

// routeMatchKind 区分精确模型名和仅允许尾部星号的前缀规则。
type routeMatchKind uint8

const (
	// routeMatchExact 表示客户端模型必须完全相等。
	routeMatchExact routeMatchKind = iota + 1
	// routeMatchPrefix 表示客户端模型必须拥有指定前缀。
	routeMatchPrefix
)

// RouteRuleInput 是创建模型路由规则的显式输入。
type RouteRuleInput struct {
	// Pattern 是精确模型名或以单个星号结尾的前缀模式。
	Pattern string
	// Scope 限制规则可匹配的客户端默认 Provider。
	Scope RouteScope
	// Route 是匹配后要执行的真实 Provider、协议和模型。
	Route Route
	// Priority 是同类、同长度规则的降序优先级。
	Priority int32
}

// RouteRule 是声明式匹配入口到真实上游路由的不可变映射。
type RouteRule struct {
	pattern      string
	prefix       string
	prefixLength int
	scope        RouteScope
	route        Route
	priority     int32
	matchKind    routeMatchKind
}

// NewRouteRule 创建不猜测 Provider 且不改写模型大小写的路由规则。
func NewRouteRule(input RouteRuleInput) (RouteRule, error) {
	prefix, matchKind, err := parseRoutePattern(input.Pattern)
	if err != nil || !input.Scope.IsValid() || !input.Route.IsValid() {
		return RouteRule{}, ErrInvalidRouteRule
	}
	return RouteRule{
		pattern:      input.Pattern,
		prefix:       prefix,
		prefixLength: utf8.RuneCountInString(prefix),
		scope:        input.Scope,
		route:        input.Route,
		priority:     input.Priority,
		matchKind:    matchKind,
	}, nil
}

// Pattern 返回未经修剪或大小写改写的匹配模式。
func (rule RouteRule) Pattern() string {
	return rule.pattern
}

// Scope 返回客户端默认 Provider 作用域。
func (rule RouteRule) Scope() RouteScope {
	return rule.scope
}

// Route 返回规则指向的真实上游路由。
func (rule RouteRule) Route() Route {
	return rule.route
}

// Priority 返回同组候选的降序优先级。
func (rule RouteRule) Priority() int32 {
	return rule.priority
}

// IsValid 重新检查跨层传递后的规则不变量。
func (rule RouteRule) IsValid() bool {
	restored, err := NewRouteRule(RouteRuleInput{
		Pattern:  rule.pattern,
		Scope:    rule.scope,
		Route:    rule.route,
		Priority: rule.priority,
	})
	return err == nil && restored == rule
}

// matches 判断规则是否接受当前模型且满足客户端作用域。
func (rule RouteRule) matches(
	model string,
	protocolID inference.ClientProtocolID,
) bool {
	if !rule.scope.accepts(protocolID) {
		return false
	}
	if rule.matchKind == routeMatchExact {
		return rule.pattern == model
	}
	return rule.matchKind == routeMatchPrefix &&
		strings.HasPrefix(model, rule.prefix)
}

// parseRoutePattern 校验精确模型名或单尾星号前缀。
func parseRoutePattern(pattern string) (string, routeMatchKind, error) {
	starCount := strings.Count(pattern, "*")
	if starCount == 0 {
		if _, err := runtimecore.NewModelID(pattern); err != nil {
			return "", 0, ErrInvalidRouteRule
		}
		return pattern, routeMatchExact, nil
	}
	if starCount != 1 || !strings.HasSuffix(pattern, "*") {
		return "", 0, ErrInvalidRouteRule
	}
	prefix := strings.TrimSuffix(pattern, "*")
	if utf8.RuneCountInString(prefix) < 2 {
		return "", 0, ErrInvalidRouteRule
	}
	if _, err := runtimecore.NewModelID(prefix); err != nil {
		return "", 0, ErrInvalidRouteRule
	}
	return prefix, routeMatchPrefix, nil
}

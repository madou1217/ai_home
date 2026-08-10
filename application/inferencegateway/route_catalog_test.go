package inferencegateway_test

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/madou1217/ai_home/application/inferencegateway"
	"github.com/madou1217/ai_home/core/inference"
)

// TestRouteCatalogOrdersExactAndWildcardCandidates 验证精确匹配始终优先，
// 同组分别遵守 priority、最长前缀和声明顺序。
func TestRouteCatalogOrdersExactAndWildcardCandidates(t *testing.T) {
	t.Parallel()

	capabilities := testRouteCapabilities(
		t,
		inference.CapabilityTextGeneration,
		inference.CapabilityStreaming,
	)
	expected := []inferencegateway.Route{
		testRoute(t, inference.ProviderCodex, "gpt-exact-high", capabilities),
		testRoute(t, inference.ProviderClaude, "claude-exact-low", capabilities),
		testRoute(t, inference.ProviderCodex, "gpt-long-prefix-high", capabilities),
		testRoute(t, inference.ProviderClaude, "claude-long-prefix", capabilities),
		testRoute(t, inference.ProviderCodex, "gpt-short-prefix", capabilities),
	}
	catalog := testRouteCatalog(
		t,
		testRouteRule(t, "claude-*", inferencegateway.RouteScopeAll, expected[4], 100),
		testRouteRule(t, "claude-opus-*", inferencegateway.RouteScopeAll, expected[3], 0),
		testRouteRule(t, "claude-opus-*", inferencegateway.RouteScopeAll, expected[2], 10),
		testRouteRule(t, "claude-opus-4-8", inferencegateway.RouteScopeAll, expected[1], 0),
		testRouteRule(t, "claude-opus-4-8", inferencegateway.RouteScopeAll, expected[0], 10),
	)

	plan, err := catalog.Resolve(
		context.Background(),
		newTextRequest(t, "claude-opus-4-8", true),
	)
	if err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
	assertRouteOrder(t, plan.Candidates(), expected)
}

// TestRouteCatalogResolvesExactNativeProtocolWithoutCanonicalCapabilities 验证原生
// 协议查询只选择目标 Provider/协议，同时沿用作用域和优先级规则。
func TestRouteCatalogResolvesExactNativeProtocolWithoutCanonicalCapabilities(
	t *testing.T,
) {
	t.Parallel()

	textOnly := testRouteCapabilities(t, inference.CapabilityTextGeneration)
	claudeRoute := testRoute(
		t,
		inference.ProviderClaude,
		"claude-opus-5",
		textOnly,
	)
	codexRoute := testRoute(
		t,
		inference.ProviderCodex,
		"gpt-5.6-sol",
		textOnly,
	)
	catalog := testRouteCatalog(
		t,
		testRouteRule(
			t,
			"shared-model",
			inferencegateway.RouteScopeAll,
			claudeRoute,
			100,
		),
		testRouteRule(
			t,
			"shared-model",
			inferencegateway.RouteScopeCodex,
			codexRoute,
			10,
		),
	)

	resolved, err := catalog.ResolveProtocolRoute(
		context.Background(),
		inference.ClientProtocolOpenAIResponses,
		"shared-model",
		inference.ProviderCodex,
		inference.ProtocolCodexResponses,
	)
	if err != nil {
		t.Fatalf("ResolveProtocolRoute() error = %v", err)
	}
	if resolved != codexRoute {
		t.Fatalf("ResolveProtocolRoute() = %#v, want %#v", resolved, codexRoute)
	}
	if _, err := catalog.ResolveProtocolRoute(
		context.Background(),
		inference.ClientProtocolAnthropicMessages,
		"shared-model",
		inference.ProviderCodex,
		inference.ProtocolCodexResponses,
	); !errors.Is(err, inferencegateway.ErrRouteNotFound) {
		t.Fatalf("ResolveProtocolRoute(wrong scope) error = %v", err)
	}
}

// TestRouteCatalogKeepsStableOrderAndDeduplicatesTargets 验证同 priority 保持声明
// 顺序，并且重叠规则不会让同一真实模型被重复执行。
func TestRouteCatalogKeepsStableOrderAndDeduplicatesTargets(t *testing.T) {
	t.Parallel()

	capabilities := testRouteCapabilities(
		t,
		inference.CapabilityTextGeneration,
	)
	first := testRoute(t, inference.ProviderClaude, "claude-first", capabilities)
	second := testRoute(t, inference.ProviderCodex, "gpt-second", capabilities)
	catalog := testRouteCatalog(
		t,
		testRouteRule(t, "stable-model", inferencegateway.RouteScopeAll, first, 5),
		testRouteRule(t, "stable-model", inferencegateway.RouteScopeAll, second, 5),
		testRouteRule(t, "stable-*", inferencegateway.RouteScopeAll, first, 99),
	)

	plan, err := catalog.Resolve(
		context.Background(),
		newTextRequest(t, "stable-model", false),
	)
	if err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
	assertRouteOrder(
		t,
		plan.Candidates(),
		[]inferencegateway.Route{first, second},
	)
}

// TestRouteCatalogFiltersScopeAndCapabilitiesBeforeBound 验证无关协议作用域和
// 能力不足的高优先级规则不会占用八个执行候选名额。
func TestRouteCatalogFiltersScopeAndCapabilitiesBeforeBound(t *testing.T) {
	t.Parallel()

	textOnly := testRouteCapabilities(
		t,
		inference.CapabilityTextGeneration,
	)
	toolCapable := testRouteCapabilities(
		t,
		inference.CapabilityTextGeneration,
		inference.CapabilityTools,
	)
	rules := make(
		[]inferencegateway.RouteRule,
		0,
		inferencegateway.MaxRouteCandidates+2,
	)
	for index := range inferencegateway.MaxRouteCandidates {
		route := testRoute(
			t,
			inference.ProviderCodex,
			fmt.Sprintf("gpt-text-only-%d", index),
			textOnly,
		)
		rules = append(
			rules,
			testRouteRule(
				t,
				"gpt-5.6-sol",
				inferencegateway.RouteScopeAll,
				route,
				int32(100-index),
			),
		)
	}
	rules = append(
		rules,
		testRouteRule(
			t,
			"gpt-5.6-sol",
			inferencegateway.RouteScopeCodex,
			testRoute(t, inference.ProviderCodex, "gpt-wrong-scope", toolCapable),
			50,
		),
		testRouteRule(
			t,
			"gpt-5.6-sol",
			inferencegateway.RouteScopeClaude,
			testRoute(t, inference.ProviderClaude, "claude-right-scope", toolCapable),
			0,
		),
	)
	catalog := testRouteCatalog(t, rules...)

	plan, err := catalog.Resolve(context.Background(), newToolRequest(t))
	if err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
	candidates := plan.Candidates()
	if len(candidates) != 1 ||
		candidates[0].ProviderID() != inference.ProviderClaude ||
		candidates[0].EffectiveModel() != "claude-right-scope" {
		t.Fatalf("candidates = %#v", candidates)
	}
}

// TestRouteCatalogDistinguishesUnknownAndUnsupportedModels 验证未知模型、
// 能力不足和取消请求不会被压缩为同一个错误。
func TestRouteCatalogDistinguishesUnknownAndUnsupportedModels(t *testing.T) {
	t.Parallel()

	textOnly := testRouteCapabilities(
		t,
		inference.CapabilityTextGeneration,
	)
	catalog := testRouteCatalog(
		t,
		testRouteRule(
			t,
			"known-model",
			inferencegateway.RouteScopeAll,
			testRoute(t, inference.ProviderCodex, "gpt-known", textOnly),
			0,
		),
	)
	if _, err := catalog.Resolve(
		context.Background(),
		newTextRequest(t, "unknown-model", false),
	); !errors.Is(err, inferencegateway.ErrRouteNotFound) {
		t.Fatalf("Resolve(unknown) error = %v", err)
	}
	if _, err := catalog.Resolve(
		context.Background(),
		newToolRequestForModel(t, "known-model"),
	); !errors.Is(err, inferencegateway.ErrUnsupportedRouteCapabilities) {
		t.Fatalf("Resolve(unsupported) error = %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := catalog.Resolve(
		ctx,
		newTextRequest(t, "known-model", false),
	); !errors.Is(err, context.Canceled) {
		t.Fatalf("Resolve(canceled) error = %v", err)
	}
}

// TestRouteCatalogRejectsInvalidAndDuplicateRules 验证目录边界拒绝空目录、
// 非法通配符、非法作用域、零值路由、重复规则和无界规则集合。
func TestRouteCatalogRejectsInvalidAndDuplicateRules(t *testing.T) {
	t.Parallel()

	capabilities := testRouteCapabilities(
		t,
		inference.CapabilityTextGeneration,
	)
	route := testRoute(t, inference.ProviderCodex, "gpt-valid", capabilities)
	invalidInputs := []inferencegateway.RouteRuleInput{
		{
			Pattern:  "a*",
			Scope:    inferencegateway.RouteScopeAll,
			Route:    route,
			Priority: 0,
		},
		{
			Pattern:  "bad*pattern",
			Scope:    inferencegateway.RouteScopeAll,
			Route:    route,
			Priority: 0,
		},
		{
			Pattern:  "valid-model",
			Scope:    inferencegateway.RouteScope("future"),
			Route:    route,
			Priority: 0,
		},
		{
			Pattern:  "valid-model",
			Scope:    inferencegateway.RouteScopeAll,
			Route:    inferencegateway.Route{},
			Priority: 0,
		},
	}
	for index, input := range invalidInputs {
		if _, err := inferencegateway.NewRouteRule(input); !errors.Is(
			err,
			inferencegateway.ErrInvalidRouteRule,
		) {
			t.Fatalf("NewRouteRule(%d) error = %v", index, err)
		}
	}
	if _, err := inferencegateway.NewRouteCatalog(); !errors.Is(
		err,
		inferencegateway.ErrInvalidRouteCatalog,
	) {
		t.Fatalf("NewRouteCatalog(empty) error = %v", err)
	}
	rule := testRouteRule(
		t,
		"valid-model",
		inferencegateway.RouteScopeAll,
		route,
		0,
	)
	if _, err := inferencegateway.NewRouteCatalog(rule, rule); !errors.Is(
		err,
		inferencegateway.ErrDuplicateRouteRule,
	) {
		t.Fatalf("NewRouteCatalog(duplicate) error = %v", err)
	}
	tooMany := make(
		[]inferencegateway.RouteRule,
		inferencegateway.MaxRouteRules+1,
	)
	for index := range tooMany {
		target := testRoute(
			t,
			inference.ProviderCodex,
			fmt.Sprintf("gpt-catalog-%d", index),
			capabilities,
		)
		tooMany[index] = testRouteRule(
			t,
			fmt.Sprintf("catalog-model-%d", index),
			inferencegateway.RouteScopeAll,
			target,
			0,
		)
	}
	if _, err := inferencegateway.NewRouteCatalog(tooMany...); !errors.Is(
		err,
		inferencegateway.ErrInvalidRouteCatalog,
	) {
		t.Fatalf("NewRouteCatalog(too many) error = %v", err)
	}
}

// testRouteCapabilities 创建测试明确声明的模型能力位图。
func testRouteCapabilities(
	t testing.TB,
	capabilities ...inference.Capability,
) inference.CapabilitySet {
	t.Helper()

	set, err := inference.NewCapabilitySet(capabilities...)
	if err != nil {
		t.Fatalf("NewCapabilitySet() error = %v", err)
	}
	return set
}

// testRoute 创建 Provider 和原生协议严格对应的测试路由。
func testRoute(
	t testing.TB,
	providerID inference.ProviderID,
	model string,
	capabilities inference.CapabilitySet,
) inferencegateway.Route {
	t.Helper()

	protocolID := inference.ProtocolCodexResponses
	if providerID == inference.ProviderClaude {
		protocolID = inference.ProtocolClaudeMessages
	}
	route, err := inferencegateway.NewRoute(
		providerID,
		protocolID,
		model,
		capabilities,
	)
	if err != nil {
		t.Fatalf("NewRoute() error = %v", err)
	}
	return route
}

// testRouteRule 创建通过生产构造器校验的测试规则。
func testRouteRule(
	t testing.TB,
	pattern string,
	scope inferencegateway.RouteScope,
	route inferencegateway.Route,
	priority int32,
) inferencegateway.RouteRule {
	t.Helper()

	rule, err := inferencegateway.NewRouteRule(
		inferencegateway.RouteRuleInput{
			Pattern:  pattern,
			Scope:    scope,
			Route:    route,
			Priority: priority,
		},
	)
	if err != nil {
		t.Fatalf("NewRouteRule() error = %v", err)
	}
	return rule
}

// testRouteCatalog 创建不可变测试目录。
func testRouteCatalog(
	t testing.TB,
	rules ...inferencegateway.RouteRule,
) *inferencegateway.RouteCatalog {
	t.Helper()

	catalog, err := inferencegateway.NewRouteCatalog(rules...)
	if err != nil {
		t.Fatalf("NewRouteCatalog() error = %v", err)
	}
	return catalog
}

// assertRouteOrder 比较解析结果的完整路由顺序。
func assertRouteOrder(
	t testing.TB,
	actual []inferencegateway.Route,
	expected []inferencegateway.Route,
) {
	t.Helper()

	if len(actual) != len(expected) {
		t.Fatalf("route count = %d, want %d", len(actual), len(expected))
	}
	for index := range expected {
		if actual[index] != expected[index] {
			t.Fatalf(
				"route[%d] = %#v, want %#v",
				index,
				actual[index],
				expected[index],
			)
		}
	}
}

// newToolRequestForModel 创建指定客户端模型的工具请求。
func newToolRequestForModel(t *testing.T, model string) inference.Request {
	t.Helper()

	text, err := inference.NewTextContent("查询账号")
	if err != nil {
		t.Fatalf("NewTextContent() error = %v", err)
	}
	message, err := inference.NewMessage(inference.RoleUser, text)
	if err != nil {
		t.Fatalf("NewMessage() error = %v", err)
	}
	tool, err := inference.NewToolDefinition(
		"lookup_account",
		"查询账号",
		[]byte(`{"type":"object"}`),
	)
	if err != nil {
		t.Fatalf("NewToolDefinition() error = %v", err)
	}
	request, err := inference.NewRequest(inference.RequestInput{
		ClientProtocol: inference.ClientProtocolAnthropicMessages,
		Model:          model,
		Messages:       []inference.Message{message},
		Tools:          []inference.ToolDefinition{tool},
	})
	if err != nil {
		t.Fatalf("NewRequest() error = %v", err)
	}
	return request
}

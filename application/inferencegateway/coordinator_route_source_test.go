package inferencegateway

import (
	"testing"

	"github.com/madou1217/ai_home/core/inference"
)

// TestOrderRoutePlanKeepsAliasPriority 验证 source 公平只改变 alias/native
// 两组的起点，不会把低优先级 alias 提到高优先级 alias 前面。
func TestOrderRoutePlanKeepsAliasPriority(t *testing.T) {
	t.Parallel()

	capabilities, err := inference.NewCapabilitySet(
		inference.CapabilityTextGeneration,
	)
	if err != nil {
		t.Fatalf("NewCapabilitySet() error = %v", err)
	}
	highAlias := mustRoute(
		t,
		inference.ProviderAgy,
		inference.ProtocolAgyCodeAssist,
		"claude-opus-4-6-thinking",
		capabilities,
	)
	lowAlias := mustRoute(
		t,
		inference.ProviderAgy,
		inference.ProtocolAgyCodeAssist,
		"claude-sonnet-4-6",
		capabilities,
	)
	native := mustRoute(
		t,
		inference.ProviderClaude,
		inference.ProtocolClaudeMessages,
		"claude-opus-4-8",
		capabilities,
	)
	plan, err := NewRoutePlan(highAlias, lowAlias, native)
	if err != nil {
		t.Fatalf("NewRoutePlan() error = %v", err)
	}
	coordinator := &Coordinator{}

	assertInternalRouteOrder(
		t,
		coordinator.orderRoutePlan(native.EffectiveModel(), plan).Candidates(),
		[]Route{highAlias, lowAlias, native},
	)
	assertInternalRouteOrder(
		t,
		coordinator.orderRoutePlan(native.EffectiveModel(), plan).Candidates(),
		[]Route{native, highAlias, lowAlias},
	)
}

func mustRoute(
	t testing.TB,
	providerID inference.ProviderID,
	protocolID inference.ProtocolID,
	model string,
	capabilities inference.CapabilitySet,
) Route {
	t.Helper()
	route, err := NewRoute(providerID, protocolID, model, capabilities)
	if err != nil {
		t.Fatalf("NewRoute(%s) error = %v", model, err)
	}
	return route
}

func assertInternalRouteOrder(
	t testing.TB,
	actual []Route,
	expected []Route,
) {
	t.Helper()
	if len(actual) != len(expected) {
		t.Fatalf("route count = %d, want %d", len(actual), len(expected))
	}
	for index := range expected {
		if actual[index] != expected[index] {
			t.Fatalf("route[%d] = %#v, want %#v", index, actual[index], expected[index])
		}
	}
}

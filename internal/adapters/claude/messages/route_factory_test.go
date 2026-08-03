package messages

import (
	"testing"
	"time"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/core/inference"
)

// TestAdapterBuildRouteDeclaresCompleteClaudeContract 验证目录路由身份、
// 真实模型和九项双向协议能力全部来自 Adapter 自身。
func TestAdapterBuildRouteDeclaresCompleteClaudeContract(t *testing.T) {
	t.Parallel()

	adapter, err := NewAdapter(&claudeRecordingHTTPClient{}, time.Now)
	if err != nil {
		t.Fatalf("NewAdapter() error = %v", err)
	}
	modelID, err := runtimecore.NewModelID("claude-opus-5")
	if err != nil {
		t.Fatalf("NewModelID() error = %v", err)
	}
	route, err := adapter.BuildRoute(modelID)
	if err != nil {
		t.Fatalf("BuildRoute() error = %v", err)
	}
	if route.ProviderID() != inference.ProviderClaude ||
		route.ProtocolID() != inference.ProtocolClaudeMessages ||
		route.EffectiveModel() != modelID.String() {
		t.Fatalf("route = %#v", route)
	}
	for _, capability := range allRouteCapabilities() {
		if !route.Capabilities().Has(capability) {
			t.Errorf("route capabilities missing %q", capability)
		}
	}
}

// allRouteCapabilities 返回当前 Canonical 路由注册的完整能力列表。
func allRouteCapabilities() []inference.Capability {
	return []inference.Capability{
		inference.CapabilityTextGeneration,
		inference.CapabilityImageInput,
		inference.CapabilityDocumentInput,
		inference.CapabilityTools,
		inference.CapabilityReasoning,
		inference.CapabilityStructuredOutput,
		inference.CapabilityStreaming,
		inference.CapabilityWebSearch,
		inference.CapabilityContextManagement,
	}
}

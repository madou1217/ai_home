package codeassist

import (
	"net/http"
	"testing"
	"time"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/core/inference"
)

type noopHTTPClient struct{}

func (noopHTTPClient) Do(*http.Request) (*http.Response, error) { return nil, nil }

func fixedClock() time.Time {
	return time.Date(2026, 8, 14, 1, 0, 0, 0, time.UTC)
}

func TestAdapterBuildsAgyCodeAssistRouteWithToolIdentityCapability(t *testing.T) {
	t.Parallel()

	adapter, err := NewAdapter(noopHTTPClient{}, fixedClock)
	if err != nil {
		t.Fatalf("NewAdapter() error = %v", err)
	}
	modelID, err := runtimecore.NewModelID("claude-opus-4-6-thinking")
	if err != nil {
		t.Fatalf("NewModelID() error = %v", err)
	}
	route, err := adapter.BuildRoute(modelID)
	if err != nil {
		t.Fatalf("BuildRoute() error = %v", err)
	}
	if route.ProviderID() != inference.ProviderAgy ||
		route.ProtocolID() != inference.ProtocolAgyCodeAssist ||
		route.EffectiveModel() != modelID.String() ||
		!route.Capabilities().Has(inference.CapabilityTextGeneration) ||
		!route.Capabilities().Has(inference.CapabilityTools) ||
		!route.Capabilities().Has(inference.CapabilityStreaming) ||
		route.Capabilities().Has(inference.CapabilityImageInput) ||
		route.Capabilities().Has(inference.CapabilityReasoning) {
		t.Fatalf("route = %#v", route)
	}
}

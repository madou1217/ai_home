package accounts

import (
	"context"
	"testing"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/core/providers"
)

type fakeRoutableSource struct {
	models []RoutableModel
}

func (source fakeRoutableSource) ListRoutableModels(context.Context) ([]RoutableModel, error) {
	return source.models, nil
}

type fakeEndpointCredential struct {
	base string
}

func (credential fakeEndpointCredential) BaseURL() string { return credential.base }

func TestGatewayBaseURL(t *testing.T) {
	if got := gatewayBaseURL(fakeEndpointCredential{base: "https://proxy.meadeo.com/v1/"}); got != "https://proxy.meadeo.com/v1" {
		t.Fatalf("gatewayBaseURL(custom) = %q", got)
	}
	if got := gatewayBaseURL(fakeEndpointCredential{base: codex.DefaultAPIBaseURL}); got != "" {
		t.Fatalf("gatewayBaseURL(official) = %q, want empty", got)
	}
	if got := gatewayBaseURL(struct{}{}); got != "" {
		t.Fatalf("gatewayBaseURL(no base url) = %q, want empty", got)
	}
}

func TestMergeRoutableModelsAddsLocalCatalog(t *testing.T) {
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	tiered, err := NewRoutableModel(catalog, "agy", "gemini-3.8-flash-tiered")
	if err != nil {
		t.Fatalf("NewRoutableModel(tiered) error = %v", err)
	}
	high, err := NewRoutableModel(catalog, "agy", "gemini-3.8-flash-high")
	if err != nil {
		t.Fatalf("NewRoutableModel(high) error = %v", err)
	}
	management := &ModelManagement{routable: fakeRoutableSource{models: []RoutableModel{tiered, high}}}
	discovered := []runtimecore.ModelID{tiered.ModelID()}
	merged := management.mergeRoutableModels(
		context.Background(),
		"https://proxy.example/v1",
		discovered,
	)
	if len(merged) != 2 {
		t.Fatalf("merged = %v, want tiered + high", merged)
	}
	if merged[0].String() != "gemini-3.8-flash-high" || merged[1].String() != "gemini-3.8-flash-tiered" {
		t.Fatalf("merged order = %v", merged)
	}
}

func TestMergeRoutableModelsSkipsOfficialAccount(t *testing.T) {
	management := &ModelManagement{routable: fakeRoutableSource{}}
	discovered := []runtimecore.ModelID{}
	merged := management.mergeRoutableModels(context.Background(), "", discovered)
	if len(merged) != 0 {
		t.Fatalf("official account must not merge local models: %v", merged)
	}
}

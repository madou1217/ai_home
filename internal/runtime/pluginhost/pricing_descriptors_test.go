package pluginhost

import (
	"context"
	"encoding/json"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	appplugins "github.com/madou1217/ai_home/application/pluginruntime"
	"github.com/madou1217/ai_home/internal/runtime/pricingcatalog"
)

func TestPricingSyncCollectsFromPluginAndTriggersOnApplied(t *testing.T) {
	aiHomeDir := t.TempDir()
	pStore, err := pricingcatalog.NewStore(aiHomeDir)
	if err != nil {
		t.Fatalf("pricingcatalog.NewStore: %v", err)
	}
	pSvc, err := pricingcatalog.NewService(pricingcatalog.ServiceDependencies{
		Store:            pStore,
		CommunitySources: []pricingcatalog.CommunitySource{},
	})
	if err != nil {
		t.Fatalf("pricingcatalog.NewService: %v", err)
	}

	fakeHost := &fakeHostClient{
		invHook: func(gen int64, cid string, val any) (json.RawMessage, error) {
			if cid == "pricing.ok" {
				return json.RawMessage(`{
  "source": {"id": "plugin-official-test", "kind": "official", "name": "Test Pricing"},
  "generatedAt": "2026-11-13T10:00:00Z",
  "quotes": [
    {
      "provider": "openai",
      "model": "gpt-5-test",
      "inputUsdPer1M": 2.5,
      "outputUsdPer1M": 10.0
    }
  ]
}`), nil
			}
			return nil, errors.New("plugin price source unreachable")
		},
	}

	rt, err := NewRuntime(RuntimeOptions{
		SupervisorFactory: func(seq int64) (HostClient, error) {
			return fakeHost, nil
		},
	})
	if err != nil {
		t.Fatalf("NewRuntime: %v", err)
	}
	defer func() { _ = rt.Stop(context.Background()) }()

	pricingPlugin := PluginSpec{
		InstanceID: "pricing-inst",
		PluginID:   "pricing-plug",
		Version:    "1.0.0",
		EntryPath:  "/tmp/pricing.mjs",
		Manifest: map[string]any{
			"pluginId": "pricing-plug",
			"contributes": []any{
				map[string]any{"id": "pricing.ok", "capability": PricingCatalogCapability, "order": 1, "failurePolicy": "delegate"},
				map[string]any{"id": "pricing.fail", "capability": PricingCatalogCapability, "order": 2, "failurePolicy": "delegate"},
			},
		},
	}
	if _, err := rt.Publish(context.Background(), []PluginSpec{pricingPlugin}, nil); err != nil {
		t.Fatalf("Publish: %v", err)
	}

	var appliedCount atomic.Int32
	ps, err := NewPricingSync(PricingSyncOptions{
		Runtime:        rt,
		PricingService: pSvc,
		OnApplied: func(ctx context.Context) {
			appliedCount.Add(1)
		},
	})
	if err != nil {
		t.Fatalf("NewPricingSync: %v", err)
	}
	defer ps.Stop()

	if err := ps.SyncNow(context.Background()); err != nil {
		t.Fatalf("SyncNow failed: %v", err)
	}
	if appliedCount.Load() != 1 {
		t.Fatalf("expected OnApplied called once on first snapshot, got %d", appliedCount.Load())
	}

	report := ps.LastReport()
	if report == nil || !report.RuntimeActive || len(report.Attempts) != 2 || len(report.Sources) != 1 {
		t.Fatalf("unexpected pricing report: %+v", report)
	}
	if !report.Attempts[0].OK || report.Attempts[1].OK {
		t.Fatalf("expected one ok and one failed attempt, got %+v", report.Attempts)
	}
	savedSources, err := pStore.ListSources()
	if err != nil || len(savedSources) != 1 || savedSources[0].SourceID != "plugin-official-test" {
		t.Fatalf("expected persisted source in store, got %+v (err=%v)", savedSources, err)
	}
}

func validTestDescriptor(id string, handler string) map[string]any {
	return map[string]any{
		"contractVersion": 1,
		"id":              id,
		"capabilities": map[string]any{
			"quota": map[string]any{
				"supported": true,
				"kind":      "codex_oauth_status",
				"source":    "api",
				"strategies": []any{
					map[string]any{
						"id":              "primary",
						"transport":       "http",
						"clientDependent": false,
						"handler":         handler,
					},
				},
			},
		},
	}
}

func TestCollectProviderDescriptorsValidationAndFailurePolicy(t *testing.T) {
	proj := appplugins.Projection{
		Generation: 1,
		Contributions: []appplugins.Contribution{
			{ID: "desc.bad.delegate", Capability: ProviderDescriptorCapability, Order: 1, FailurePolicy: "delegate", InstanceID: "p-bad"},
			{ID: "desc.good", Capability: ProviderDescriptorCapability, Order: 2, FailurePolicy: "deny", InstanceID: "p-good"},
		},
	}

	invoke := func(ctx context.Context, gen int64, cid string, val any, timeout time.Duration) (json.RawMessage, error) {
		if cid == "desc.bad.delegate" {
			return json.RawMessage(`{"descriptor":{"contractVersion":1,"id":"broken","capabilities":{}}}`), nil
		}
		raw, _ := json.Marshal(map[string]any{
			"kind":  ProviderDescriptorCapability,
			"value": validTestDescriptor("acme", "acme-quota"),
		})
		return raw, nil
	}

	resolve := func(handlerID string) bool { return handlerID == "acme-quota" }

	res, err := CollectProviderDescriptors(context.Background(), proj, invoke, resolve)
	if err != nil {
		t.Fatalf("expected delegate failure not to abort collection, got %v", err)
	}
	if len(res.Descriptors) != 1 || res.Descriptors[0]["id"] != "acme" {
		t.Fatalf("expected valid descriptor collected, got %+v", res.Descriptors)
	}
	if len(res.Errors) != 1 || res.Errors[0].Code != "provider_descriptor_quota_missing" {
		t.Fatalf("expected recorded descriptor error, got %+v", res.Errors)
	}

	// Deny policy must abort when invalid or missing handler.
	denyProj := appplugins.Projection{
		Generation: 2,
		Contributions: []appplugins.Contribution{
			{ID: "desc.missing.handler", Capability: ProviderDescriptorCapability, Order: 1, FailurePolicy: "deny", InstanceID: "p-deny"},
		},
	}
	_, err = CollectProviderDescriptors(context.Background(), denyProj, func(ctx context.Context, gen int64, cid string, val any, timeout time.Duration) (json.RawMessage, error) {
		raw, _ := json.Marshal(validTestDescriptor("beta", "unknown-handler"))
		return raw, nil
	}, resolve)
	if errorCode(err) != CodeDescriptorHandlerUnavailable {
		t.Fatalf("expected %s under deny policy, got %v", CodeDescriptorHandlerUnavailable, err)
	}

	// Duplicate provider id rejection across contributions.
	dupProj := appplugins.Projection{
		Generation: 3,
		Contributions: []appplugins.Contribution{
			{ID: "c1", Capability: ProviderDescriptorCapability, Order: 1, FailurePolicy: "deny", InstanceID: "i1"},
			{ID: "c2", Capability: ProviderDescriptorCapability, Order: 2, FailurePolicy: "deny", InstanceID: "i2"},
		},
	}
	_, err = CollectProviderDescriptors(context.Background(), dupProj, func(ctx context.Context, gen int64, cid string, val any, timeout time.Duration) (json.RawMessage, error) {
		raw, _ := json.Marshal(validTestDescriptor("acme", "acme-quota"))
		return raw, nil
	}, resolve)
	if errorCode(err) != CodeDescriptorDuplicate {
		t.Fatalf("expected %s, got %v", CodeDescriptorDuplicate, err)
	}
}

func TestCollectCatalogAliasesAndConflictRejection(t *testing.T) {
	proj := appplugins.Projection{
		Generation: 1,
		Contributions: []appplugins.Contribution{
			{ID: "cat.1", Capability: ModelCatalogCapability, Order: 1, FailurePolicy: "deny", InstanceID: "i1"},
			{ID: "cat.2", Capability: ModelCatalogCapability, Order: 2, FailurePolicy: "deny", InstanceID: "i2"},
		},
	}
	aliases, err := CollectCatalogAliases(context.Background(), proj, func(ctx context.Context, gen int64, cid string, val any, timeout time.Duration) (json.RawMessage, error) {
		if cid == "cat.1" {
			return json.RawMessage(`{"aliases":[{"alias":"fast-model","target":"gpt-5-mini","description":"Fast"}]}`), nil
		}
		return json.RawMessage(`{"aliases":[{"alias":"smart-model","target":"gpt-5"}]}`), nil
	})
	if err != nil || len(aliases) != 2 {
		t.Fatalf("expected 2 aliases, got %+v (err=%v)", aliases, err)
	}

	_, err = CollectCatalogAliases(context.Background(), proj, func(ctx context.Context, gen int64, cid string, val any, timeout time.Duration) (json.RawMessage, error) {
		return json.RawMessage(`{"aliases":[{"alias":"SharedAlias","target":"gpt-5"}]}`), nil
	})
	if err == nil {
		t.Fatalf("expected case-insensitive conflict error")
	}
}

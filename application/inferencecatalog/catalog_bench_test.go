package inferencecatalog_test

import (
	"context"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/inferencecatalog"
	"github.com/madou1217/ai_home/core/inference"
)

// BenchmarkAtomicCatalogResolve 测量生产原子快照的精确模型热路径。
func BenchmarkAtomicCatalogResolve(benchmark *testing.B) {
	catalog := newProviderCatalog(benchmark)
	models := []accountapp.RoutableModel{
		newRoutableModel(
			benchmark,
			catalog,
			"codex",
			"gpt-5.6-sol",
		),
	}
	snapshot := buildSnapshot(benchmark, models)
	active, err := inferencecatalog.NewAtomicCatalog(newTestClock().Now)
	if err != nil {
		benchmark.Fatalf("NewAtomicCatalog() error = %v", err)
	}
	if err := active.Publish(snapshot); err != nil {
		benchmark.Fatalf("Publish() error = %v", err)
	}
	request := newTextRequest(
		benchmark,
		inference.ClientProtocolOpenAIResponses,
		"gpt-5.6-sol",
	)
	ctx := context.Background()
	benchmark.ReportAllocs()
	benchmark.ResetTimer()
	for range benchmark.N {
		plan, resolveErr := active.Resolve(ctx, request)
		if resolveErr != nil || !plan.IsValid() {
			benchmark.Fatalf(
				"Resolve() plan=%#v error=%v",
				plan,
				resolveErr,
			)
		}
	}
}

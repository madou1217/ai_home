package inferencegateway_test

import (
	"context"
	"fmt"
	"testing"

	"github.com/madou1217/ai_home/application/inferencegateway"
	"github.com/madou1217/ai_home/core/inference"
)

// BenchmarkRouteCatalogResolve 测量目录大小增长后的纯内存解析开销。
func BenchmarkRouteCatalogResolve(benchmark *testing.B) {
	capabilities := testRouteCapabilities(
		benchmark,
		inference.CapabilityTextGeneration,
		inference.CapabilityStreaming,
	)
	benchmark.Run("exact_1000_rules", func(benchmark *testing.B) {
		rules := make([]inferencegateway.RouteRule, 0, 1000)
		for index := range 1000 {
			model := fmt.Sprintf("benchmark-model-%04d", index)
			rules = append(
				rules,
				testRouteRule(
					benchmark,
					model,
					inferencegateway.RouteScopeAll,
					testRoute(
						benchmark,
						inference.ProviderCodex,
						model,
						capabilities,
					),
					0,
				),
			)
		}
		benchmarkCatalogResolve(
			benchmark,
			testRouteCatalog(benchmark, rules...),
			newTextRequest(benchmark, "benchmark-model-0999", true),
		)
	})
	benchmark.Run("wildcard_64_rules", func(benchmark *testing.B) {
		rules := make([]inferencegateway.RouteRule, 0, 64)
		for index := range 63 {
			pattern := fmt.Sprintf("unrelated-%02d-*", index)
			model := fmt.Sprintf("gpt-unrelated-%02d", index)
			rules = append(
				rules,
				testRouteRule(
					benchmark,
					pattern,
					inferencegateway.RouteScopeAll,
					testRoute(
						benchmark,
						inference.ProviderCodex,
						model,
						capabilities,
					),
					0,
				),
			)
		}
		rules = append(
			rules,
			testRouteRule(
				benchmark,
				"wildcard-*",
				inferencegateway.RouteScopeAll,
				testRoute(
					benchmark,
					inference.ProviderClaude,
					"claude-wildcard-target",
					capabilities,
				),
				0,
			),
		)
		benchmarkCatalogResolve(
			benchmark,
			testRouteCatalog(benchmark, rules...),
			newTextRequest(benchmark, "wildcard-hit-model", true),
		)
	})
}

// benchmarkCatalogResolve 测量 Resolver 和 Coordinator 会执行的计划校验路径。
func benchmarkCatalogResolve(
	benchmark *testing.B,
	catalog *inferencegateway.RouteCatalog,
	request inference.Request,
) {
	benchmark.Helper()
	benchmark.ReportAllocs()
	benchmark.ResetTimer()

	for range benchmark.N {
		plan, err := catalog.Resolve(context.Background(), request)
		if err != nil || !plan.IsValid() {
			benchmark.Fatalf(
				"Resolve() valid=%t error=%v",
				plan.IsValid(),
				err,
			)
		}
	}
}

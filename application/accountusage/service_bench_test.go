package accountusage_test

import (
	"context"
	"testing"
	"time"

	usagecore "github.com/madou1217/ai_home/core/accountusage"
)

// BenchmarkUsageService 测量离线读取和单账号刷新编排的应用层开销。
func BenchmarkUsageService(benchmark *testing.B) {
	now := serviceTestTime()
	credential := serviceCredential{
		providerID: "codex",
		identity:   "api_key:codex:usage-benchmark",
	}
	accountRef := deriveServiceRef(benchmark, credential)
	buildSnapshot := func(capturedAt time.Time) usagecore.Snapshot {
		return mustServiceSnapshot(benchmark, usagecore.SnapshotInput{
			AccountRef: accountRef,
			ProviderID: "codex",
			Source:     "codex_wham_usage",
			CapturedAt: capturedAt,
			Entries: []usagecore.EntryInput{{
				Bucket:               "primary",
				Kind:                 usagecore.KindWindow,
				Scope:                usagecore.ScopeAccount,
				HasRemaining:         true,
				RemainingBasisPoints: 7_500,
				WindowSeconds:        18_000,
				Availability:         usagecore.AvailabilityAvailable,
			}},
		})
	}
	store := &serviceStore{snapshot: buildSnapshot(now)}
	strategy := &strategyStub{
		providerID: "codex",
		build:      buildSnapshot,
	}
	service := newServiceSubject(
		benchmark,
		store,
		credentialResolverStub{credential: credential},
		modelReaderStub{},
		&runtimeProjectionStub{},
		strategy,
		func() time.Time { return now },
	)
	ctx := context.Background()

	benchmark.Run("offline_get", func(benchmark *testing.B) {
		benchmark.ReportAllocs()
		benchmark.ResetTimer()
		for range benchmark.N {
			result, err := service.GetUsage(ctx, accountRef)
			if err != nil ||
				result.Stale() ||
				result.Snapshot().AccountRef() != accountRef {
				benchmark.Fatalf(
					"GetUsage() result=%#v error=%v",
					result,
					err,
				)
			}
		}
	})
	benchmark.Run("refresh_orchestration", func(benchmark *testing.B) {
		benchmark.ReportAllocs()
		benchmark.ResetTimer()
		for range benchmark.N {
			result, err := service.RefreshUsage(ctx, accountRef)
			if err != nil ||
				result.Stale() ||
				result.Snapshot().AccountRef() != accountRef {
				benchmark.Fatalf(
					"RefreshUsage() result=%#v error=%v",
					result,
					err,
				)
			}
		}
	})
}

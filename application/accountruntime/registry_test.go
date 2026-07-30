package accountruntime

import (
	"context"
	"sync"
	"testing"
	"time"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// TestRegistryScopesCooldownByAccountAndModel 验证 cooldown 不会影响同账号其他模型。
func TestRegistryScopesCooldownByAccountAndModel(t *testing.T) {
	t.Parallel()

	now := registryTestTime()
	registry := newRegistryTestSubject(t, now)
	coolingRoute := registryTestRoute(t, 1, "gpt-5.6-sol")
	siblingRoute := registryTestRoute(t, 1, "gpt-5.4")

	transition, err := registry.RecordFailure(
		context.Background(),
		coolingRoute,
		runtimecore.FailureRateLimited,
		2*time.Minute,
	)
	if err != nil {
		t.Fatalf("RecordFailure() error = %v", err)
	}
	if !transition.CoolingDown() {
		t.Fatalf("RecordFailure() transition = %#v", transition)
	}

	cooling, err := registry.CheckEligibility(
		context.Background(),
		coolingRoute,
	)
	if err != nil {
		t.Fatalf("CheckEligibility(cooling) error = %v", err)
	}
	sibling, err := registry.CheckEligibility(
		context.Background(),
		siblingRoute,
	)
	if err != nil {
		t.Fatalf("CheckEligibility(sibling) error = %v", err)
	}
	if cooling.Eligible() || !sibling.Eligible() || registry.Len() != 1 {
		t.Fatalf(
			"eligibility cooling=%#v sibling=%#v len=%d",
			cooling,
			sibling,
			registry.Len(),
		)
	}
}

// TestRegistrySuccessClearsOnlyCurrentModel 验证成功不会清除兄弟模型的 cooldown。
func TestRegistrySuccessClearsOnlyCurrentModel(t *testing.T) {
	t.Parallel()

	now := registryTestTime()
	registry := newRegistryTestSubject(t, now)
	first := registryTestRoute(t, 1, "gpt-5.6-sol")
	second := registryTestRoute(t, 1, "gpt-5.4")
	for _, route := range []runtimecore.ModelRoute{first, second} {
		if _, err := registry.RecordFailure(
			context.Background(),
			route,
			runtimecore.FailureModelOverloaded,
			0,
		); err != nil {
			t.Fatalf("RecordFailure() error = %v", err)
		}
	}

	if err := registry.RecordSuccess(context.Background(), first); err != nil {
		t.Fatalf("RecordSuccess() error = %v", err)
	}
	firstEligibility, _ := registry.CheckEligibility(context.Background(), first)
	secondEligibility, _ := registry.CheckEligibility(context.Background(), second)
	if !firstEligibility.Eligible() ||
		secondEligibility.Eligible() ||
		registry.Len() != 1 {
		t.Fatalf(
			"eligibility first=%#v second=%#v len=%d",
			firstEligibility,
			secondEligibility,
			registry.Len(),
		)
	}
}

// TestRegistryPrunesExpiredState 验证读取时主动删除过期 cooldown。
func TestRegistryPrunesExpiredState(t *testing.T) {
	t.Parallel()

	now := registryTestTime()
	current := now
	registry, err := NewRegistry(func() time.Time { return current })
	if err != nil {
		t.Fatalf("NewRegistry() error = %v", err)
	}
	route := registryTestRoute(t, 1, "claude-opus-4-1")
	if _, err := registry.RecordFailure(
		context.Background(),
		route,
		runtimecore.FailureUpstreamUnavailable,
		10*time.Second,
	); err != nil {
		t.Fatalf("RecordFailure() error = %v", err)
	}

	current = now.Add(10 * time.Second)
	eligibility, err := registry.CheckEligibility(context.Background(), route)
	if err != nil {
		t.Fatalf("CheckEligibility() error = %v", err)
	}
	if !eligibility.Eligible() || registry.Len() != 0 {
		t.Fatalf(
			"CheckEligibility() eligibility=%#v len=%d",
			eligibility,
			registry.Len(),
		)
	}
}

// TestRegistryForgetsOnlyTargetAccount 验证账号删除会清理其全部模型 cooldown 且不影响其他账号。
func TestRegistryForgetsOnlyTargetAccount(t *testing.T) {
	t.Parallel()

	registry := newRegistryTestSubject(t, registryTestTime())
	first := registryTestRoute(t, 1, "gpt-5.6-sol")
	second := registryTestRoute(t, 1, "gpt-5.4")
	other := registryTestRoute(t, 2, "gpt-5.6-sol")
	for _, route := range []runtimecore.ModelRoute{first, second, other} {
		if _, err := registry.RecordFailure(
			context.Background(),
			route,
			runtimecore.FailureRateLimited,
			time.Minute,
		); err != nil {
			t.Fatalf("RecordFailure() error = %v", err)
		}
	}

	registry.ForgetAccount(first.AccountRef())
	if registry.Len() != 1 {
		t.Fatalf("ForgetAccount() len = %d, want 1", registry.Len())
	}
	for _, route := range []runtimecore.ModelRoute{first, second} {
		eligibility, err := registry.CheckEligibility(context.Background(), route)
		if err != nil || !eligibility.Eligible() {
			t.Fatalf(
				"target eligibility=%#v error=%v",
				eligibility,
				err,
			)
		}
	}
	otherEligibility, err := registry.CheckEligibility(
		context.Background(),
		other,
	)
	if err != nil || otherEligibility.Eligible() {
		t.Fatalf(
			"other eligibility=%#v error=%v",
			otherEligibility,
			err,
		)
	}
}

// TestRegistrySerializesConcurrentFailures 验证并发同类故障不会丢失 streak。
func TestRegistrySerializesConcurrentFailures(t *testing.T) {
	t.Parallel()

	registry := newRegistryTestSubject(t, registryTestTime())
	route := registryTestRoute(t, 1, "claude-sonnet-4")
	start := make(chan struct{})
	var waitGroup sync.WaitGroup
	errorsByCall := make(chan error, 2)
	waitGroup.Add(2)
	for range 2 {
		go func() {
			defer waitGroup.Done()
			<-start
			_, err := registry.RecordFailure(
				context.Background(),
				route,
				runtimecore.FailureConnectionReset,
				0,
			)
			errorsByCall <- err
		}()
	}
	close(start)
	waitGroup.Wait()
	close(errorsByCall)
	for err := range errorsByCall {
		if err != nil {
			t.Fatalf("RecordFailure() error = %v", err)
		}
	}
	eligibility, err := registry.CheckEligibility(
		context.Background(),
		route,
	)
	if err != nil {
		t.Fatalf("CheckEligibility() error = %v", err)
	}
	if eligibility.Eligible() {
		t.Fatalf("CheckEligibility() eligibility = %#v", eligibility)
	}
}

// BenchmarkRegistryCheckEligibilityHealthy 测量健康账号的无分配读取热路径。
func BenchmarkRegistryCheckEligibilityHealthy(benchmark *testing.B) {
	registry := newRegistryBenchmarkSubject(benchmark)
	route := registryBenchmarkRoute(benchmark, "gpt-5.6-sol")
	ctx := context.Background()

	benchmark.ReportAllocs()
	for range benchmark.N {
		eligibility, err := registry.CheckEligibility(ctx, route)
		if err != nil || !eligibility.Eligible() {
			benchmark.Fatalf(
				"CheckEligibility() eligibility=%#v error=%v",
				eligibility,
				err,
			)
		}
	}
}

// BenchmarkRegistryCheckEligibilityCooldown 测量稀疏 cooldown 命中的读取热路径。
func BenchmarkRegistryCheckEligibilityCooldown(benchmark *testing.B) {
	registry := newRegistryBenchmarkSubject(benchmark)
	route := registryBenchmarkRoute(benchmark, "claude-sonnet-4")
	ctx := context.Background()
	if _, err := registry.RecordFailure(
		ctx,
		route,
		runtimecore.FailureModelOverloaded,
		time.Hour,
	); err != nil {
		benchmark.Fatalf("RecordFailure() error = %v", err)
	}

	benchmark.ResetTimer()
	benchmark.ReportAllocs()
	for range benchmark.N {
		eligibility, err := registry.CheckEligibility(ctx, route)
		if err != nil || eligibility.Eligible() {
			benchmark.Fatalf(
				"CheckEligibility() eligibility=%#v error=%v",
				eligibility,
				err,
			)
		}
	}
}

// newRegistryTestSubject 创建使用固定时钟的稀疏运行态索引。
func newRegistryTestSubject(t *testing.T, now time.Time) *Registry {
	t.Helper()

	registry, err := NewRegistry(func() time.Time { return now })
	if err != nil {
		t.Fatalf("NewRegistry() error = %v", err)
	}
	return registry
}

// registryTestRoute 创建确定性账号与模型元组。
func registryTestRoute(
	t *testing.T,
	accountID int,
	modelID string,
) runtimecore.ModelRoute {
	t.Helper()

	accountRef, err := accountcore.ParseAccountRef(
		"acct_0000000000000000000" + string(rune('0'+accountID)),
	)
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	route, err := runtimecore.NewModelRoute(accountRef, modelID)
	if err != nil {
		t.Fatalf("NewModelRoute() error = %v", err)
	}
	return route
}

// registryTestTime 返回注册表测试共享的确定性时间。
func registryTestTime() time.Time {
	return time.Date(2026, 7, 28, 13, 0, 0, 0, time.UTC)
}

// newRegistryBenchmarkSubject 创建基准专用固定时钟索引。
func newRegistryBenchmarkSubject(benchmark *testing.B) *Registry {
	benchmark.Helper()

	registry, err := NewRegistry(registryTestTime)
	if err != nil {
		benchmark.Fatalf("NewRegistry() error = %v", err)
	}
	return registry
}

// registryBenchmarkRoute 创建基准专用账号模型元组。
func registryBenchmarkRoute(
	benchmark *testing.B,
	modelID string,
) runtimecore.ModelRoute {
	benchmark.Helper()

	accountRef, err := accountcore.ParseAccountRef(
		"acct_00000000000000000001",
	)
	if err != nil {
		benchmark.Fatalf("ParseAccountRef() error = %v", err)
	}
	route, err := runtimecore.NewModelRoute(accountRef, modelID)
	if err != nil {
		benchmark.Fatalf("NewModelRoute() error = %v", err)
	}
	return route
}

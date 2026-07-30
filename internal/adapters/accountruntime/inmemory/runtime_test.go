package inmemory

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/inference"
)

// TestRuntimeCredentialBlockCoversSiblingModels 验证账号凭据阻塞会在凭据读取前
// 排除所有兄弟模型，并能由一次凭据更新显式解除。
func TestRuntimeCredentialBlockCoversSiblingModels(t *testing.T) {
	t.Parallel()

	runtime := newTestRuntime(t, runtimeTestTime)
	first := newTestRoute(t, 1, "gpt-5.6-sol")
	second := newTestRoute(t, 1, "gpt-5.4")
	failure := newBlockingFailure(
		t,
		runtimecore.FailureCredentialRejected,
		runtimecore.BlockScopeAccount,
	)

	if err := runtime.RecordFailure(
		context.Background(),
		first,
		failure,
	); err != nil {
		t.Fatalf("RecordFailure() error = %v", err)
	}
	assertEligibilityStatus(
		t,
		runtime,
		first,
		runtimecore.EligibilityCredentialBlocked,
	)
	assertEligibilityStatus(
		t,
		runtime,
		second,
		runtimecore.EligibilityCredentialBlocked,
	)

	if err := runtime.ClearAccountBlock(
		context.Background(),
		first.AccountRef(),
		runtimecore.RecoveryCredentialsUpdated,
	); err != nil {
		t.Fatalf("ClearAccountBlock() error = %v", err)
	}
	assertEligibilityStatus(
		t,
		runtime,
		first,
		runtimecore.EligibilityAvailable,
	)
	assertEligibilityStatus(
		t,
		runtime,
		second,
		runtimecore.EligibilityAvailable,
	)
}

// TestRuntimeModelBlockDoesNotCoverSiblingModel 验证模型目录问题只排除发生失败的
// 账号模型元组，兄弟模型仍然可以继续征召。
func TestRuntimeModelBlockDoesNotCoverSiblingModel(t *testing.T) {
	t.Parallel()

	runtime := newTestRuntime(t, runtimeTestTime)
	blocked := newTestRoute(t, 2, "claude-opus-4-6")
	sibling := newTestRoute(t, 2, "claude-sonnet-4-5")
	failure := newBlockingFailure(
		t,
		runtimecore.FailureModelUnsupported,
		runtimecore.BlockScopeAccountModel,
	)

	if err := runtime.RecordFailure(
		context.Background(),
		blocked,
		failure,
	); err != nil {
		t.Fatalf("RecordFailure() error = %v", err)
	}
	assertEligibilityStatus(
		t,
		runtime,
		blocked,
		runtimecore.EligibilityPolicyBlocked,
	)
	assertEligibilityStatus(
		t,
		runtime,
		sibling,
		runtimecore.EligibilityAvailable,
	)

	if err := runtime.ClearModelBlock(
		context.Background(),
		blocked,
		runtimecore.RecoveryModelCatalog,
	); err != nil {
		t.Fatalf("ClearModelBlock() error = %v", err)
	}
	assertEligibilityStatus(
		t,
		runtime,
		blocked,
		runtimecore.EligibilityAvailable,
	)
}

// TestRuntimeClearsModelBlocksAsValidatedBatch 验证模型目录恢复可以在一次写锁内
// 精确清理多个已确认可用模型，并在批次无效时保持原状态。
func TestRuntimeClearsModelBlocksAsValidatedBatch(t *testing.T) {
	t.Parallel()

	runtime := newTestRuntime(t, runtimeTestTime)
	first := newTestRoute(t, 2, "claude-opus-4-6")
	second := newTestRoute(t, 2, "claude-sonnet-4-5")
	failure := newBlockingFailure(
		t,
		runtimecore.FailureModelUnsupported,
		runtimecore.BlockScopeAccountModel,
	)
	for _, route := range []runtimecore.ModelRoute{first, second} {
		if err := runtime.RecordFailure(
			context.Background(),
			route,
			failure,
		); err != nil {
			t.Fatalf("RecordFailure() error = %v", err)
		}
	}

	if err := runtime.ClearModelBlocks(
		context.Background(),
		first.AccountRef(),
		[]runtimecore.ModelID{first.ModelID()},
		runtimecore.RecoveryModelCatalog,
	); err != nil {
		t.Fatalf("ClearModelBlocks(first) error = %v", err)
	}
	assertEligibilityStatus(
		t,
		runtime,
		first,
		runtimecore.EligibilityAvailable,
	)
	assertEligibilityStatus(
		t,
		runtime,
		second,
		runtimecore.EligibilityPolicyBlocked,
	)

	if err := runtime.ClearModelBlocks(
		context.Background(),
		first.AccountRef(),
		[]runtimecore.ModelID{second.ModelID(), ""},
		runtimecore.RecoveryModelCatalog,
	); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("ClearModelBlocks(invalid) error = %v", err)
	}
	assertEligibilityStatus(
		t,
		runtime,
		second,
		runtimecore.EligibilityPolicyBlocked,
	)
}

// TestRuntimeClearsOnlyMatchingBlock 验证同一账号多个硬阻塞共存时，
// 一个真相源更新不会误删另一个真相源负责的阻塞。
func TestRuntimeClearsOnlyMatchingBlock(t *testing.T) {
	t.Parallel()

	runtime := newTestRuntime(t, runtimeTestTime)
	route := newTestRoute(t, 3, "gpt-5.6-sol")
	for _, failure := range []inferencegateway.AttemptFailure{
		newBlockingFailure(
			t,
			runtimecore.FailureCredentialRejected,
			runtimecore.BlockScopeAccount,
		),
		newBlockingFailure(
			t,
			runtimecore.FailureBillingBlocked,
			runtimecore.BlockScopeAccount,
		),
	} {
		if err := runtime.RecordFailure(
			context.Background(),
			route,
			failure,
		); err != nil {
			t.Fatalf("RecordFailure() error = %v", err)
		}
	}
	assertEligibilityStatus(
		t,
		runtime,
		route,
		runtimecore.EligibilityCredentialBlocked,
	)

	if err := runtime.ClearAccountBlock(
		context.Background(),
		route.AccountRef(),
		runtimecore.RecoveryCredentialsUpdated,
	); err != nil {
		t.Fatalf("ClearAccountBlock(credentials) error = %v", err)
	}
	assertEligibilityStatus(
		t,
		runtime,
		route,
		runtimecore.EligibilityQuotaBlocked,
	)

	if err := runtime.ClearAccountBlock(
		context.Background(),
		route.AccountRef(),
		runtimecore.RecoveryBillingSnapshot,
	); err != nil {
		t.Fatalf("ClearAccountBlock(billing) error = %v", err)
	}
	assertEligibilityStatus(
		t,
		runtime,
		route,
		runtimecore.EligibilityAvailable,
	)
}

// TestRuntimeRejectsWrongRecoveryScope 验证错误作用域的恢复信号失败关闭，
// 且不会改变已经记录的硬阻塞。
func TestRuntimeRejectsWrongRecoveryScope(t *testing.T) {
	t.Parallel()

	runtime := newTestRuntime(t, runtimeTestTime)
	route := newTestRoute(t, 4, "gpt-5.6-sol")
	failure := newBlockingFailure(
		t,
		runtimecore.FailureCredentialRejected,
		runtimecore.BlockScopeAccount,
	)
	if err := runtime.RecordFailure(
		context.Background(),
		route,
		failure,
	); err != nil {
		t.Fatalf("RecordFailure() error = %v", err)
	}

	if err := runtime.ClearModelBlock(
		context.Background(),
		route,
		runtimecore.RecoveryCredentialsUpdated,
	); !errors.Is(err, ErrInvalidRecovery) {
		t.Fatalf("ClearModelBlock(credentials) error = %v", err)
	}
	if err := runtime.ClearAccountBlock(
		context.Background(),
		route.AccountRef(),
		runtimecore.RecoveryModelCatalog,
	); !errors.Is(err, ErrInvalidRecovery) {
		t.Fatalf("ClearAccountBlock(model catalog) error = %v", err)
	}
	assertEligibilityStatus(
		t,
		runtime,
		route,
		runtimecore.EligibilityCredentialBlocked,
	)
}

// TestRuntimeRecoveryIsIdempotentAndKeepsHealthyStateSparse 验证合法恢复事件
// 在没有对应阻塞时幂等成功，并且健康读取不会创建任何状态条目。
func TestRuntimeRecoveryIsIdempotentAndKeepsHealthyStateSparse(t *testing.T) {
	t.Parallel()

	runtime := newTestRuntime(t, runtimeTestTime)
	route := newTestRoute(t, 9, "gpt-5.6-sol")
	for range 2 {
		if err := runtime.ClearAccountBlock(
			context.Background(),
			route.AccountRef(),
			runtimecore.RecoveryUsageSnapshot,
		); err != nil {
			t.Fatalf("ClearAccountBlock() error = %v", err)
		}
		if err := runtime.ClearModelBlock(
			context.Background(),
			route,
			runtimecore.RecoveryModelCatalog,
		); err != nil {
			t.Fatalf("ClearModelBlock() error = %v", err)
		}
		assertEligibilityStatus(
			t,
			runtime,
			route,
			runtimecore.EligibilityAvailable,
		)
	}
	if len(runtime.accountBlocks) != 0 ||
		len(runtime.modelBlocks) != 0 ||
		runtime.cooldowns.Len() != 0 {
		t.Fatalf(
			"healthy state account=%d model=%d cooldown=%d",
			len(runtime.accountBlocks),
			len(runtime.modelBlocks),
			runtime.cooldowns.Len(),
		)
	}
}

// TestRuntimeReplacesAuthoritativeUsageProjection 验证新快照精确替换账号级和模型级额度阻塞。
func TestRuntimeReplacesAuthoritativeUsageProjection(t *testing.T) {
	t.Parallel()

	runtime := newTestRuntime(t, runtimeTestTime)
	accountRef := newTestRoute(t, 9, "claude-opus-5").AccountRef()
	opus := mustUsageModelID(t, "claude-opus-5")
	sonnet := mustUsageModelID(t, "claude-sonnet-4-6")
	if err := runtime.ReplaceUsageProjection(
		context.Background(),
		accountRef,
		true,
		[]runtimecore.ModelID{opus},
	); err != nil {
		t.Fatalf("ReplaceUsageProjection(block) error = %v", err)
	}
	for _, model := range []runtimecore.ModelID{opus, sonnet} {
		route, _ := runtimecore.NewModelRoute(accountRef, model.String())
		eligibility, err := runtime.CheckEligibility(context.Background(), route)
		if err != nil || eligibility.Status() != runtimecore.EligibilityQuotaBlocked {
			t.Fatalf(
				"account blocked model=%s eligibility=%#v error=%v",
				model,
				eligibility,
				err,
			)
		}
	}

	if err := runtime.ReplaceUsageProjection(
		context.Background(),
		accountRef,
		false,
		[]runtimecore.ModelID{sonnet},
	); err != nil {
		t.Fatalf("ReplaceUsageProjection(replace) error = %v", err)
	}
	opusRoute, _ := runtimecore.NewModelRoute(accountRef, opus.String())
	sonnetRoute, _ := runtimecore.NewModelRoute(accountRef, sonnet.String())
	opusEligibility, _ := runtime.CheckEligibility(context.Background(), opusRoute)
	sonnetEligibility, _ := runtime.CheckEligibility(context.Background(), sonnetRoute)
	if !opusEligibility.Eligible() ||
		sonnetEligibility.Status() != runtimecore.EligibilityQuotaBlocked {
		t.Fatalf(
			"replaced usage opus=%#v sonnet=%#v",
			opusEligibility,
			sonnetEligibility,
		)
	}

	if err := runtime.ReplaceUsageProjection(
		context.Background(),
		accountRef,
		false,
		nil,
	); err != nil {
		t.Fatalf("ReplaceUsageProjection(clear) error = %v", err)
	}
	sonnetEligibility, _ = runtime.CheckEligibility(context.Background(), sonnetRoute)
	if !sonnetEligibility.Eligible() {
		t.Fatalf("cleared usage eligibility = %#v", sonnetEligibility)
	}
}

// TestRuntimeUsageProjectionPreservesOtherBlocks 验证额度恢复不会清除凭据或策略阻塞。
func TestRuntimeUsageProjectionPreservesOtherBlocks(t *testing.T) {
	t.Parallel()

	runtime := newTestRuntime(t, runtimeTestTime)
	route := newTestRoute(t, 8, "gpt-5.6-sol")
	failure := newBlockingFailure(
		t,
		runtimecore.FailureCredentialRejected,
		runtimecore.BlockScopeAccount,
	)
	if err := runtime.RecordFailure(context.Background(), route, failure); err != nil {
		t.Fatalf("RecordFailure() error = %v", err)
	}
	if err := runtime.ReplaceUsageProjection(
		context.Background(),
		route.AccountRef(),
		true,
		nil,
	); err != nil {
		t.Fatalf("ReplaceUsageProjection(block) error = %v", err)
	}
	if err := runtime.ReplaceUsageProjection(
		context.Background(),
		route.AccountRef(),
		false,
		nil,
	); err != nil {
		t.Fatalf("ReplaceUsageProjection(clear) error = %v", err)
	}
	eligibility, err := runtime.CheckEligibility(context.Background(), route)
	if err != nil ||
		eligibility.Status() != runtimecore.EligibilityCredentialBlocked {
		t.Fatalf("credential block lost: eligibility=%#v error=%v", eligibility, err)
	}
}

// mustUsageModelID 创建额度投影测试使用的真实模型 ID。
func mustUsageModelID(t *testing.T, value string) runtimecore.ModelID {
	t.Helper()

	modelID, err := runtimecore.NewModelID(value)
	if err != nil {
		t.Fatalf("NewModelID(%q) error = %v", value, err)
	}
	return modelID
}

// TestRuntimeRejectsInvalidAttemptFailure 验证零值或跨层损坏的失败
// 不会进入 cooldown 或硬阻塞索引。
func TestRuntimeRejectsInvalidAttemptFailure(t *testing.T) {
	t.Parallel()

	runtime := newTestRuntime(t, runtimeTestTime)
	route := newTestRoute(t, 1, "claude-opus-4-6")
	if err := runtime.RecordFailure(
		context.Background(),
		route,
		inferencegateway.AttemptFailure{},
	); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("RecordFailure(zero) error = %v", err)
	}
	assertEligibilityStatus(
		t,
		runtime,
		route,
		runtimecore.EligibilityAvailable,
	)
}

// TestRuntimeSuccessDoesNotClearHardBlock 验证成功只清理模型 streak/cooldown，
// 不能绕过凭据、额度或策略真相源直接解除硬阻塞。
func TestRuntimeSuccessDoesNotClearHardBlock(t *testing.T) {
	t.Parallel()

	runtime := newTestRuntime(t, runtimeTestTime)
	route := newTestRoute(t, 5, "claude-opus-4-6")
	if err := runtime.RecordFailure(
		context.Background(),
		route,
		newBlockingFailure(
			t,
			runtimecore.FailureCredentialRejected,
			runtimecore.BlockScopeAccount,
		),
	); err != nil {
		t.Fatalf("RecordFailure(block) error = %v", err)
	}
	if err := runtime.RecordFailure(
		context.Background(),
		route,
		newCooldownFailure(
			t,
			runtimecore.FailureRateLimited,
			time.Minute,
		),
	); err != nil {
		t.Fatalf("RecordFailure(cooldown) error = %v", err)
	}
	if err := runtime.RecordSuccess(context.Background(), route); err != nil {
		t.Fatalf("RecordSuccess() error = %v", err)
	}
	assertEligibilityStatus(
		t,
		runtime,
		route,
		runtimecore.EligibilityCredentialBlocked,
	)

	if err := runtime.ClearAccountBlock(
		context.Background(),
		route.AccountRef(),
		runtimecore.RecoveryCredentialsUpdated,
	); err != nil {
		t.Fatalf("ClearAccountBlock() error = %v", err)
	}
	assertEligibilityStatus(
		t,
		runtime,
		route,
		runtimecore.EligibilityAvailable,
	)
}

// TestRuntimePrunesExpiredCooldown 验证有限 cooldown 到期仍由既有稀疏 Registry
// 在读取路径自动回收，不依赖后台定时任务。
func TestRuntimePrunesExpiredCooldown(t *testing.T) {
	t.Parallel()

	now := runtimeTestTime()
	runtime := newTestRuntime(t, func() time.Time { return now })
	route := newTestRoute(t, 6, "gpt-5.6-sol")
	if err := runtime.RecordFailure(
		context.Background(),
		route,
		newCooldownFailure(
			t,
			runtimecore.FailureRateLimited,
			10*time.Second,
		),
	); err != nil {
		t.Fatalf("RecordFailure() error = %v", err)
	}
	assertEligibilityStatus(
		t,
		runtime,
		route,
		runtimecore.EligibilityModelCooldown,
	)

	now = now.Add(10 * time.Second)
	assertEligibilityStatus(
		t,
		runtime,
		route,
		runtimecore.EligibilityAvailable,
	)
}

// TestRuntimeSupportsConcurrentRecordCheckAndClear 验证并发记录、读取与恢复
// 不产生竞态、丢失结构不变量或留下无法清理的状态。
func TestRuntimeSupportsConcurrentRecordCheckAndClear(t *testing.T) {
	t.Parallel()

	runtime := newTestRuntime(t, runtimeTestTime)
	routes := []runtimecore.ModelRoute{
		newTestRoute(t, 7, "gpt-5.6-sol"),
		newTestRoute(t, 7, "gpt-5.4"),
		newTestRoute(t, 8, "claude-opus-4-6"),
		newTestRoute(t, 8, "claude-sonnet-4-5"),
	}
	cooldown := newCooldownFailure(
		t,
		runtimecore.FailureModelOverloaded,
		time.Minute,
	)
	modelBlock := newBlockingFailure(
		t,
		runtimecore.FailureModelUnsupported,
		runtimecore.BlockScopeAccountModel,
	)

	const workers = 16
	const iterations = 100
	start := make(chan struct{})
	errs := make(chan error, workers)
	var waitGroup sync.WaitGroup
	waitGroup.Add(workers)
	for worker := range workers {
		worker := worker
		go func() {
			defer waitGroup.Done()
			<-start
			route := routes[worker%len(routes)]
			for range iterations {
				if err := runtime.RecordFailure(
					context.Background(),
					route,
					cooldown,
				); err != nil {
					errs <- err
					return
				}
				if _, err := runtime.CheckEligibility(
					context.Background(),
					route,
				); err != nil {
					errs <- err
					return
				}
				if err := runtime.RecordFailure(
					context.Background(),
					route,
					modelBlock,
				); err != nil {
					errs <- err
					return
				}
				if err := runtime.ClearModelBlock(
					context.Background(),
					route,
					runtimecore.RecoveryModelCatalog,
				); err != nil {
					errs <- err
					return
				}
				if err := runtime.RecordSuccess(
					context.Background(),
					route,
				); err != nil {
					errs <- err
					return
				}
			}
		}()
	}
	close(start)
	waitGroup.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent operation error = %v", err)
	}
	for _, route := range routes {
		if err := runtime.ClearModelBlock(
			context.Background(),
			route,
			runtimecore.RecoveryModelCatalog,
		); err != nil {
			t.Fatalf("ClearModelBlock(final) error = %v", err)
		}
		if err := runtime.RecordSuccess(
			context.Background(),
			route,
		); err != nil {
			t.Fatalf("RecordSuccess(final) error = %v", err)
		}
		assertEligibilityStatus(
			t,
			runtime,
			route,
			runtimecore.EligibilityAvailable,
		)
	}
}

// BenchmarkRuntimeCheckEligibilityHealthy 测量健康账号不预分配状态的读取热路径。
func BenchmarkRuntimeCheckEligibilityHealthy(benchmark *testing.B) {
	runtime := newBenchmarkRuntime(benchmark)
	route := newBenchmarkRoute(benchmark, "gpt-5.6-sol")
	ctx := context.Background()

	benchmark.ReportAllocs()
	for range benchmark.N {
		eligibility, err := runtime.CheckEligibility(ctx, route)
		if err != nil || !eligibility.Eligible() {
			benchmark.Fatalf(
				"CheckEligibility() eligibility=%#v error=%v",
				eligibility,
				err,
			)
		}
	}
}

// newTestRuntime 创建测试使用的纯内存运行态。
func newTestRuntime(
	t *testing.T,
	clock func() time.Time,
) *Runtime {
	t.Helper()

	runtime, err := New(clock)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	return runtime
}

// newTestRoute 创建具有确定性账号身份的真实模型路由键。
func newTestRoute(
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

// newBlockingFailure 创建只包含低敏分类与明确作用域的硬阻塞失败。
func newBlockingFailure(
	t *testing.T,
	kind runtimecore.FailureKind,
	scope runtimecore.BlockScope,
) inferencegateway.AttemptFailure {
	t.Helper()

	directive, err := runtimecore.NewBlockDirective(kind, scope)
	if err != nil {
		t.Fatalf("NewBlockDirective() error = %v", err)
	}
	return newTestFailure(t, kind, 0, directive)
}

// newCooldownFailure 创建携带有限恢复提示的模型瞬态失败。
func newCooldownFailure(
	t *testing.T,
	kind runtimecore.FailureKind,
	retryAfter time.Duration,
) inferencegateway.AttemptFailure {
	t.Helper()

	return newTestFailure(
		t,
		kind,
		retryAfter,
		runtimecore.BlockDirective{},
	)
}

// newTestFailure 创建不会泄漏 Provider 原文的 Canonical 失败。
func newTestFailure(
	t *testing.T,
	kind runtimecore.FailureKind,
	retryAfter time.Duration,
	directive runtimecore.BlockDirective,
) inferencegateway.AttemptFailure {
	t.Helper()

	responseFailure, err := inference.NewResponseFailure(
		string(kind),
		"合成上游失败",
		true,
	)
	if err != nil {
		t.Fatalf("NewResponseFailure() error = %v", err)
	}
	failure, err := inferencegateway.NewAttemptFailure(
		inferencegateway.AttemptFailureInput{
			ResponseFailure: responseFailure,
			RuntimeKind:     kind,
			RetryAfter:      retryAfter,
			BlockDirective:  directive,
		},
	)
	if err != nil {
		t.Fatalf("NewAttemptFailure() error = %v", err)
	}
	return failure
}

// assertEligibilityStatus 验证目标元组的稳定资格状态。
func assertEligibilityStatus(
	t *testing.T,
	runtime *Runtime,
	route runtimecore.ModelRoute,
	want runtimecore.EligibilityStatus,
) {
	t.Helper()

	eligibility, err := runtime.CheckEligibility(
		context.Background(),
		route,
	)
	if err != nil {
		t.Fatalf("CheckEligibility() error = %v", err)
	}
	if !eligibility.IsValid() || eligibility.Status() != want {
		t.Fatalf(
			"CheckEligibility() status=%q, want %q",
			eligibility.Status(),
			want,
		)
	}
}

// runtimeTestTime 返回测试共享的确定性 UTC 毫秒时间。
func runtimeTestTime() time.Time {
	return time.Date(2026, 7, 30, 20, 30, 0, 0, time.UTC)
}

// newBenchmarkRuntime 创建基准测试使用的纯内存运行态。
func newBenchmarkRuntime(benchmark *testing.B) *Runtime {
	benchmark.Helper()

	runtime, err := New(runtimeTestTime)
	if err != nil {
		benchmark.Fatalf("New() error = %v", err)
	}
	return runtime
}

// newBenchmarkRoute 创建基准测试使用的真实模型路由键。
func newBenchmarkRoute(
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

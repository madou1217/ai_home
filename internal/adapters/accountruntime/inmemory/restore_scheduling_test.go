package inmemory

import (
	"context"
	"errors"
	"testing"
	"time"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

func testRef(t *testing.T, value string) accountcore.AccountRef {
	t.Helper()
	ref, err := accountcore.ParseAccountRef(value)
	if err != nil {
		t.Fatalf("ParseAccountRef(%q) error = %v", value, err)
	}
	return ref
}

func testRoute(t *testing.T, ref accountcore.AccountRef, model string) runtimecore.ModelRoute {
	t.Helper()
	route, err := runtimecore.NewModelRoute(ref, model)
	if err != nil {
		t.Fatalf("NewModelRoute() error = %v", err)
	}
	return route
}

// 人工恢复调度必须清空账号与模型两级全部阻塞和 cooldown，但保留额度权重。
func TestRestoreSchedulingClearsRuntimeBlocks(t *testing.T) {
	now := time.UnixMilli(1_800_000_000_000)
	runtimeInstance, err := New(func() time.Time { return now })
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	ctx := context.Background()
	ref := testRef(t, "acct_00000000000000000001")
	route := testRoute(t, ref, "test-model")

	runtimeInstance.mu.Lock()
	runtimeInstance.accountBlocks[ref] = blockBillingSnapshot
	runtimeInstance.accountFailures[ref] =
		failureBlock{}.observe(blockCredentialsUpdated, now, now.Add(time.Hour))
	runtimeInstance.persistedFailures[ref] =
		failureBlock{}.observe(blockAccountStatus, now, now.Add(time.Hour))
	runtimeInstance.modelBlocks[route] = blockModelCatalog
	runtimeInstance.modelFailures[route] =
		failureBlock{}.observe(blockPolicySnapshot, now, now.Add(time.Hour))
	runtimeInstance.remaining[ref] = 4321
	runtimeInstance.mu.Unlock()

	if _, err := runtimeInstance.cooldowns.RecordFailure(
		ctx,
		route,
		runtimecore.FailureRateLimited,
		time.Minute,
	); err != nil {
		t.Fatalf("RecordFailure() error = %v", err)
	}
	eligibility, err := runtimeInstance.CheckEligibility(ctx, route)
	if err != nil {
		t.Fatalf("CheckEligibility() error = %v", err)
	}
	if eligibility.Eligible() {
		t.Fatal("恢复前账号必须处于被阻塞状态")
	}

	if err := runtimeInstance.RestoreScheduling(ctx, ref); err != nil {
		t.Fatalf("RestoreScheduling() error = %v", err)
	}

	eligibility, err = runtimeInstance.CheckEligibility(ctx, route)
	if err != nil {
		t.Fatalf("CheckEligibility() after restore error = %v", err)
	}
	if !eligibility.Eligible() {
		t.Fatalf("恢复调度后必须重新可征召，实际 = %v", eligibility.Status())
	}
	if cooldowns := runtimeInstance.cooldowns.ActiveCooldowns(); len(cooldowns) != 0 {
		t.Fatalf("恢复调度后模型 cooldown 必须清空，实际 %d 条", len(cooldowns))
	}
	remaining := runtimeInstance.AccountRemaining(ref)
	if !remaining.Known || remaining.BasisPoints != 4321 {
		t.Fatalf("恢复调度不能清除额度权重，实际 = %+v", remaining)
	}
}

// 人工恢复只作用于目标账号，其它账号的阻塞不能被顺带清掉。
func TestRestoreSchedulingLeavesOtherAccountsBlocked(t *testing.T) {
	now := time.UnixMilli(1_800_000_000_000)
	runtimeInstance, err := New(func() time.Time { return now })
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	ctx := context.Background()
	target := testRef(t, "acct_00000000000000000001")
	other := testRef(t, "acct_00000000000000000002")
	targetRoute := testRoute(t, target, "test-model")
	otherRoute := testRoute(t, other, "test-model")

	runtimeInstance.mu.Lock()
	runtimeInstance.accountBlocks[target] = blockBillingSnapshot
	runtimeInstance.accountBlocks[other] = blockBillingSnapshot
	runtimeInstance.modelBlocks[targetRoute] = blockModelCatalog
	runtimeInstance.modelBlocks[otherRoute] = blockModelCatalog
	runtimeInstance.mu.Unlock()

	if err := runtimeInstance.RestoreScheduling(ctx, target); err != nil {
		t.Fatalf("RestoreScheduling() error = %v", err)
	}

	eligibility, err := runtimeInstance.CheckEligibility(ctx, otherRoute)
	if err != nil {
		t.Fatalf("CheckEligibility() error = %v", err)
	}
	if eligibility.Eligible() {
		t.Fatal("恢复目标账号不能解除其它账号的阻塞")
	}
}

func TestRestoreSchedulingRejectsInvalidRequest(t *testing.T) {
	runtimeInstance, err := New(func() time.Time { return time.UnixMilli(1_800_000_000_000) })
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	validRef := testRef(t, "acct_00000000000000000001")

	if err := runtimeInstance.RestoreScheduling(nil, validRef); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("nil ctx error = %v, want ErrInvalidRequest", err)
	}
	if err := runtimeInstance.RestoreScheduling(context.Background(), accountcore.AccountRef("acct_short")); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("invalid ref error = %v, want ErrInvalidRequest", err)
	}
	var nilRuntime *Runtime
	if err := nilRuntime.RestoreScheduling(context.Background(), validRef); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("nil runtime error = %v, want ErrInvalidRequest", err)
	}
}

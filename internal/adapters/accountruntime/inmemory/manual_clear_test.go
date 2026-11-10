package inmemory

import (
	"context"
	"errors"
	"testing"
	"time"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// 人工清空（manual_admin_clear）必须清掉门禁的每一层来源：真相源阻塞、上游失败观察、
// 持久化投影、模型 cooldown，并回报证据名。
func TestClearManualAdminBlocksClearsEveryRuntimeLayer(t *testing.T) {
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
		t.Fatal("清空前账号必须处于被阻塞状态")
	}

	evidence, err := runtimeInstance.ClearManualAdminBlocks(ctx, ref)
	if err != nil {
		t.Fatalf("ClearManualAdminBlocks() error = %v", err)
	}
	if evidence != accountcore.StatusEventManualAdminClear {
		t.Fatalf("evidence = %q, want %q", evidence, accountcore.StatusEventManualAdminClear)
	}
	if evidence != ManualAdminClearEvidence {
		t.Fatalf("evidence = %q, want ManualAdminClearEvidence", evidence)
	}

	runtimeInstance.mu.RLock()
	_, hasAccountBlocks := runtimeInstance.accountBlocks[ref]
	_, hasAccountFailures := runtimeInstance.accountFailures[ref]
	_, hasPersistedFailures := runtimeInstance.persistedFailures[ref]
	_, hasModelBlocks := runtimeInstance.modelBlocks[route]
	_, hasModelFailures := runtimeInstance.modelFailures[route]
	runtimeInstance.mu.RUnlock()
	if hasAccountBlocks || hasAccountFailures || hasPersistedFailures {
		t.Fatalf("账号级状态未清空: blocks=%v failures=%v persisted=%v",
			hasAccountBlocks, hasAccountFailures, hasPersistedFailures)
	}
	if hasModelBlocks || hasModelFailures {
		t.Fatalf("模型级状态未清空: blocks=%v failures=%v", hasModelBlocks, hasModelFailures)
	}
	if cooldowns := runtimeInstance.cooldowns.ActiveCooldowns(); len(cooldowns) != 0 {
		t.Fatalf("模型 cooldown 必须清空，实际 %d 条", len(cooldowns))
	}

	eligibility, err = runtimeInstance.CheckEligibility(ctx, route)
	if err != nil {
		t.Fatalf("CheckEligibility() after clear error = %v", err)
	}
	if !eligibility.Eligible() {
		t.Fatalf("人工清空后必须重新可征召，实际 = %v", eligibility.Status())
	}
	remaining := runtimeInstance.AccountRemaining(ref)
	if !remaining.Known || remaining.BasisPoints != 4321 {
		t.Fatalf("人工清空不能清除额度权重，实际 = %+v", remaining)
	}
}

// 人工清空只作用于目标账号：其它账号的账号级与模型级阻塞都不能被顺带清掉。
func TestClearManualAdminBlocksLeavesOtherAccountsBlocked(t *testing.T) {
	now := time.UnixMilli(1_800_000_000_000)
	runtimeInstance, err := New(func() time.Time { return now })
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	ctx := context.Background()
	target := testRef(t, "acct_00000000000000000001")
	other := testRef(t, "acct_00000000000000000002")
	otherRoute := testRoute(t, other, "test-model")

	runtimeInstance.mu.Lock()
	runtimeInstance.accountBlocks[target] = blockBillingSnapshot
	runtimeInstance.accountBlocks[other] = blockBillingSnapshot
	runtimeInstance.modelBlocks[otherRoute] = blockModelCatalog
	runtimeInstance.mu.Unlock()

	if _, err := runtimeInstance.ClearManualAdminBlocks(ctx, target); err != nil {
		t.Fatalf("ClearManualAdminBlocks() error = %v", err)
	}

	eligibility, err := runtimeInstance.CheckEligibility(ctx, otherRoute)
	if err != nil {
		t.Fatalf("CheckEligibility() error = %v", err)
	}
	if eligibility.Eligible() {
		t.Fatal("清空目标账号不能解除其它账号的阻塞")
	}
}

// 人工清空只清内存投影：持久化文档仍是真相源，重新投影后阻塞必须回来。
func TestClearManualAdminBlocksDoesNotRewriteTruthSource(t *testing.T) {
	now := time.UnixMilli(1_800_000_000_000)
	runtimeInstance, err := New(func() time.Time { return now })
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	ctx := context.Background()
	ref := testRef(t, "acct_00000000000000000001")
	route := testRoute(t, ref, "test-model")
	state := testPersistedAccountState(t, "auth_invalid", now.Add(-time.Minute), now.Add(time.Hour))

	if err := runtimeInstance.ApplyAccountState(ctx, state); err != nil {
		t.Fatalf("ApplyAccountState() error = %v", err)
	}
	if _, err := runtimeInstance.ClearManualAdminBlocks(ctx, ref); err != nil {
		t.Fatalf("ClearManualAdminBlocks() error = %v", err)
	}
	if err := runtimeInstance.ApplyAccountState(ctx, state); err != nil {
		t.Fatalf("ApplyAccountState() after clear error = %v", err)
	}

	eligibility, err := runtimeInstance.CheckEligibility(ctx, route)
	if err != nil {
		t.Fatalf("CheckEligibility() error = %v", err)
	}
	if eligibility.Eligible() {
		t.Fatal("真相源仍记录 auth_invalid 时，重新投影必须再次挡住征召")
	}
}

func TestClearManualAdminBlocksRejectsInvalidRequest(t *testing.T) {
	runtimeInstance, err := New(func() time.Time { return time.UnixMilli(1_800_000_000_000) })
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	validRef := testRef(t, "acct_00000000000000000001")

	if _, err := runtimeInstance.ClearManualAdminBlocks(nil, validRef); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("nil ctx error = %v, want ErrInvalidRequest", err)
	}
	if _, err := runtimeInstance.ClearManualAdminBlocks(
		context.Background(),
		accountcore.AccountRef("acct_short"),
	); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("invalid ref error = %v, want ErrInvalidRequest", err)
	}
	var nilRuntime *Runtime
	if _, err := nilRuntime.ClearManualAdminBlocks(context.Background(), validRef); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("nil runtime error = %v, want ErrInvalidRequest", err)
	}
}

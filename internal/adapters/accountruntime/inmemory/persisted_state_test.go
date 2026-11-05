package inmemory

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

func testPersistedAccountState(
	t *testing.T,
	kind string,
	observedAt time.Time,
	until time.Time,
) runtimecore.AccountState {
	t.Helper()
	ref, err := accountcore.ParseAccountRef("acct_00000000000000000001")
	if err != nil {
		t.Fatal(err)
	}
	document, err := json.Marshal(map[string]any{
		"lastFailureKind":   kind,
		"lastFailureReason": "account_recovery_required:auth_invalid",
		"lastFailureAt":     observedAt.UnixMilli(),
		"authInvalidUntil":  until.UnixMilli(),
	})
	if err != nil {
		t.Fatal(err)
	}
	state, err := runtimecore.NewAccountState(runtimecore.AccountStateInput{
		AccountRef: ref,
		Document:   document,
		UpdatedAt:  observedAt,
	})
	if err != nil {
		t.Fatal(err)
	}
	return state
}

// 2026-11-06 Phase 2：enabled 只表示用户意图，持久化运行态必须单独挡住征召。
func TestApplyAccountStateBlocksEligibilityUntilExpiry(t *testing.T) {
	now := time.UnixMilli(1_800_000_000_000)
	clock := func() time.Time { return now }
	runtime, err := New(clock)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	ref, _ := accountcore.ParseAccountRef("acct_00000000000000000001")
	route, err := runtimecore.NewModelRoute(ref, "test-model")
	if err != nil {
		t.Fatal(err)
	}

	state := testPersistedAccountState(t, "auth_invalid", now.Add(-time.Minute), now.Add(time.Hour))
	if err := runtime.ApplyAccountState(ctx, state); err != nil {
		t.Fatalf("ApplyAccountState() error = %v", err)
	}
	eligibility, err := runtime.CheckEligibility(ctx, route)
	if err != nil {
		t.Fatal(err)
	}
	if eligibility.Eligible() {
		t.Fatal("auth_invalid 运行态在 until 之前必须挡住征召")
	}

	// 到 until 之后，下一次请求就是复核：阻塞不再生效。
	now = now.Add(2 * time.Hour)
	eligibility, err = runtime.CheckEligibility(ctx, route)
	if err != nil {
		t.Fatal(err)
	}
	if !eligibility.Eligible() {
		t.Fatal("until 过后应重新放行，由请求自己验证")
	}
}

func TestApplyAccountStateWithoutBlockClears(t *testing.T) {
	now := time.UnixMilli(1_800_000_000_000)
	clock := func() time.Time { return now }
	runtime, err := New(clock)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	ref, _ := accountcore.ParseAccountRef("acct_00000000000000000001")
	route, _ := runtimecore.NewModelRoute(ref, "test-model")

	blocked := testPersistedAccountState(t, "auth_invalid", now.Add(-time.Minute), now.Add(time.Hour))
	if err := runtime.ApplyAccountState(ctx, blocked); err != nil {
		t.Fatal(err)
	}

	healthyDocument, _ := json.Marshal(map[string]any{"lastFailureKind": ""})
	healthy, err := runtimecore.NewAccountState(runtimecore.AccountStateInput{
		AccountRef: ref,
		Document:   healthyDocument,
		UpdatedAt:  now,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := runtime.ApplyAccountState(ctx, healthy); err != nil {
		t.Fatal(err)
	}
	eligibility, err := runtime.CheckEligibility(ctx, route)
	if err != nil {
		t.Fatal(err)
	}
	if !eligibility.Eligible() {
		t.Fatal("运行态文档没有阻塞时必须解除内存阻塞")
	}

	if err := runtime.ApplyAccountState(ctx, blocked); err != nil {
		t.Fatal(err)
	}
	if err := runtime.ClearAccountState(ctx, ref); err != nil {
		t.Fatal(err)
	}
	eligibility, _ = runtime.CheckEligibility(ctx, route)
	if !eligibility.Eligible() {
		t.Fatal("ClearAccountState 必须解除内存阻塞")
	}
}

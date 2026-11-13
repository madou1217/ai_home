package codexresetcredit

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

type fakeTransport struct {
	availableCount int
	credits        []any
	consumeOutcome string
	consumeErr     error
	consumeCalls   atomic.Int32
	lastConsumeID  string
	omitCreditID   bool
}

func (f *fakeTransport) AssertOAuthAccount(_ context.Context, _ string) error {
	return nil
}

func (f *fakeTransport) ReadRateLimits(_ context.Context, _ string) (map[string]any, error) {
	return map[string]any{
		"rateLimitResetCredits": map[string]any{
			"availableCount": f.availableCount,
			"credits":        f.credits,
		},
	}, nil
}

func (f *fakeTransport) ConsumeCredit(_ context.Context, _ string, operationID string, creditID string) (map[string]any, error) {
	f.consumeCalls.Add(1)
	f.lastConsumeID = creditID
	if creditID == "" {
		f.omitCreditID = true
	}
	if f.consumeErr != nil {
		return nil, f.consumeErr
	}
	if f.availableCount > 0 && f.consumeOutcome == "reset" {
		f.availableCount--
	}
	return map[string]any{"outcome": f.consumeOutcome}, nil
}

func TestModelNormalizationAndInventoryVersion(t *testing.T) {
	expSec := int64(1799999999)
	inv := NormalizeInventory(map[string]any{
		"availableCount": 1,
		"credits": []any{
			map[string]any{
				"id":        "crd-1",
				"resetType": "codex_rate_limits",
				"status":    "available",
				"expiresAt": float64(expSec),
			},
		},
	})
	if !inv.DetailsComplete || inv.AvailableCount != 1 || len(inv.Credits) != 1 {
		t.Fatalf("unexpected inventory: %+v", inv)
	}
	if inv.Credits[0].ExpiresAt == nil || *inv.Credits[0].ExpiresAt != expSec*1000 {
		t.Fatalf("expected seconds scaled to ms, got %v", inv.Credits[0].ExpiresAt)
	}

	v1 := BuildInventoryVersion(1, []CreditRecord{{
		CreditID:  "crd-1",
		Status:    "available",
		ExpiresAt: inv.Credits[0].ExpiresAt,
	}})
	if len(v1) != 64 {
		t.Fatalf("expected sha256 hex, got %q", v1)
	}
}

func TestConsumeIdempotencyUnknownAndReconcile(t *testing.T) {
	home := t.TempDir()
	ref := "acct_0123456789abcdef0123"
	opID := "11111111-1111-4111-8111-111111111111"
	now := time.UnixMilli(1700000000000)

	tr := &fakeTransport{
		availableCount: 1,
		credits: []any{
			map[string]any{
				"id":        "crd-earliest",
				"resetType": "codexRateLimits",
				"status":    "available",
				"expiresAt": float64(1800000000000),
			},
		},
		consumeErr: context.DeadlineExceeded,
	}
	var refreshed atomic.Int32
	svc, err := NewService(ServiceDependencies{
		AIHomeDir: home,
		Transport: tr,
		Now:       func() time.Time { return now },
		OnResetConfirmed: func(_ context.Context, gotRef string) {
			if gotRef == ref {
				refreshed.Add(1)
			}
		},
	})
	if err != nil {
		t.Fatalf("NewService failed: %v", err)
	}

	listed, err := svc.List(context.Background(), ref)
	if err != nil {
		t.Fatalf("List failed: %v", err)
	}
	if listed.SelectionMode != "local" || listed.NextCreditID != "crd-earliest" || listed.AvailableCount != 1 {
		t.Fatalf("unexpected list result: %+v", listed)
	}

	// 首次消费超时 -> status=unknown, reconciliationRequired=true
	env1, err := svc.Consume(context.Background(), ref, opID, listed.InventoryVersion)
	if err != nil {
		t.Fatalf("Consume returned unexpected error: %v", err)
	}
	if !env1.ReconciliationRequired || env1.Operation.Status != "unknown" {
		t.Fatalf("expected unknown operation, got %+v", env1)
	}
	if refreshed.Load() != 0 {
		t.Fatalf("should not refresh when unknown")
	}

	// 同操作幂等重放 -> 不再打消费 RPC
	envReplay, err := svc.Consume(context.Background(), ref, opID, listed.InventoryVersion)
	if err != nil {
		t.Fatalf("Replay failed: %v", err)
	}
	if envReplay.Operation.OperationID != opID || tr.consumeCalls.Load() != 1 {
		t.Fatalf("expected replay without extra RPC, calls=%d", tr.consumeCalls.Load())
	}

	// 核对成功 -> status=succeeded, outcome=reset, 触发刷新回调
	tr.consumeErr = nil
	tr.consumeOutcome = "reset"
	envReconciled, err := svc.Reconcile(context.Background(), ref, opID)
	if err != nil {
		t.Fatalf("Reconcile failed: %v", err)
	}
	if envReconciled.ReconciliationRequired || envReconciled.Operation.Status != "succeeded" || envReconciled.Operation.Outcome != "reset" {
		t.Fatalf("expected succeeded reconcile, got %+v", envReconciled)
	}
	if refreshed.Load() != 1 {
		t.Fatalf("expected post-reset hook called once, got %d", refreshed.Load())
	}
}

func TestUpstreamSelectionOmitsCreditID(t *testing.T) {
	home := t.TempDir()
	ref := "acct_abcdef0123456789abcd"
	opID := "22222222-2222-4222-8222-222222222222"
	tr := &fakeTransport{
		availableCount: 2,
		credits:        nil,
		consumeOutcome: "alreadyRedeemed",
	}
	svc, err := NewService(ServiceDependencies{
		AIHomeDir: home,
		Transport: tr,
	})
	if err != nil {
		t.Fatalf("NewService failed: %v", err)
	}
	listed, err := svc.List(context.Background(), ref)
	if err != nil || listed.SelectionMode != "upstream" {
		t.Fatalf("expected upstream mode, got %+v err=%v", listed, err)
	}
	env, err := svc.Consume(context.Background(), ref, opID, listed.InventoryVersion)
	if err != nil {
		t.Fatalf("Consume failed: %v", err)
	}
	if !tr.omitCreditID || env.Operation.Status != "succeeded" {
		t.Fatalf("expected empty creditId sent in upstream mode, omit=%v op=%+v", tr.omitCreditID, env.Operation)
	}

	// 无效操作 ID 校验
	if _, err := svc.GetOperation(context.Background(), ref, "not-uuid"); !errors.Is(err, err) {
		code, _, status := ExtractError(err, "")
		if code != "codex_reset_operation_invalid" || status != 400 {
			t.Fatalf("expected 400 codex_reset_operation_invalid, got %d %s", status, code)
		}
	}
}

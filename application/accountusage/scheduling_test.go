package accountusage

import (
	"context"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
)

type schedulingTestStrategy struct {
	family string
}

func (schedulingTestStrategy) ProviderID() string { return "agy" }

func (schedulingTestStrategy) FetchUsage(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	credential accountapp.Credential,
	capturedAt time.Time,
) (usagecore.Snapshot, error) {
	return usagecore.Snapshot{}, nil
}

func (strategy schedulingTestStrategy) MatchesModelFamily(scopeKey string, modelID runtimecore.ModelID) bool {
	return scopeKey == strategy.family
}

func schedulingTestSnapshot(t *testing.T, entries ...usagecore.EntryInput) usagecore.Snapshot {
	t.Helper()
	ref, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	snapshot, err := usagecore.NewSnapshot(usagecore.SnapshotInput{
		AccountRef: ref,
		ProviderID: "agy",
		Source:     "test",
		PlanType:   "free",
		CapturedAt: time.UnixMilli(1_800_000_000_000).UTC(),
		Entries:    entries,
	})
	if err != nil {
		t.Fatalf("NewSnapshot() error = %v", err)
	}
	return snapshot
}

func windowEntry(scope usagecore.Scope, key string, bps uint16, availability usagecore.Availability) usagecore.EntryInput {
	return usagecore.EntryInput{
		Bucket:               key,
		Kind:                 usagecore.KindWindow,
		Scope:                scope,
		ScopeKey:             key,
		HasRemaining:         true,
		RemainingBasisPoints: bps,
		WindowSeconds:        18_000,
		ResetAt:              time.UnixMilli(1_800_000_000_000).UTC().Add(time.Hour),
		Availability:         availability,
	}
}

func TestEvaluateSchedulingBlocksExhaustedAccountWindow(t *testing.T) {
	model, _ := runtimecore.NewModelID("gemini-3.8-flash-tiered")
	snapshot := schedulingTestSnapshot(t, usagecore.EntryInput{
		Bucket:               "account",
		Kind:                 usagecore.KindWindow,
		Scope:                usagecore.ScopeAccount,
		ScopeKey:             "",
		HasRemaining:         true,
		RemainingBasisPoints: 0,
		WindowSeconds:        18_000,
		ResetAt:              time.UnixMilli(1_800_000_000_000).UTC().Add(time.Hour),
		Availability:         usagecore.AvailabilityExhausted,
	})
	decision := evaluateSchedulingSnapshot(schedulingTestStrategy{}, snapshot, model, 500)
	if !decision.Blocked || decision.Status != SchedulingBlockedByQuota ||
		decision.Reason != SchedulingReasonExhausted {
		t.Fatalf("decision = %#v, want blocked_by_quota", decision)
	}
}

func TestEvaluateSchedulingBlocksBelowServerThreshold(t *testing.T) {
	model, _ := runtimecore.NewModelID("gemini-3.8-flash-tiered")
	snapshot := schedulingTestSnapshot(t,
		windowEntry(usagecore.ScopeModelFamily, "gemini-3.8-flash-tiered", 300, usagecore.AvailabilityAvailable),
	)
	decision := evaluateSchedulingSnapshot(schedulingTestStrategy{family: "gemini-3.8-flash-tiered"}, snapshot, model, 500)
	if !decision.Blocked || decision.Status != SchedulingBlockedByPolicy ||
		decision.Reason != SchedulingReasonBelowThreshold {
		t.Fatalf("decision = %#v, want blocked_by_policy", decision)
	}
}

func TestEvaluateSchedulingAllowsAboveThreshold(t *testing.T) {
	model, _ := runtimecore.NewModelID("gemini-3.8-flash-tiered")
	snapshot := schedulingTestSnapshot(t,
		windowEntry(usagecore.ScopeModelFamily, "gemini-3.8-flash-tiered", 1200, usagecore.AvailabilityAvailable),
	)
	decision := evaluateSchedulingSnapshot(schedulingTestStrategy{family: "gemini-3.8-flash-tiered"}, snapshot, model, 500)
	if decision.Blocked {
		t.Fatalf("decision = %#v, want allowed", decision)
	}
}

// 其他模型族的耗尽不能误伤当前模型。
func TestEvaluateSchedulingIgnoresOtherModelFamilies(t *testing.T) {
	model, _ := runtimecore.NewModelID("gemini-3.8-flash-tiered")
	snapshot := schedulingTestSnapshot(t,
		windowEntry(usagecore.ScopeModelFamily, "claude-opus-5-5", 0, usagecore.AvailabilityExhausted),
	)
	decision := evaluateSchedulingSnapshot(schedulingTestStrategy{family: "gemini-3.8-flash-tiered"}, snapshot, model, 500)
	if decision.Blocked {
		t.Fatalf("decision = %#v, want allowed", decision)
	}
}

func TestMinimumRemainingBasisPoints(t *testing.T) {
	cases := []struct {
		threshold float64
		want      uint16
	}{
		{threshold: 95, want: 500},
		{threshold: 100, want: 0},
		{threshold: 90, want: 1000},
		{threshold: 0, want: 500},
		{threshold: 120, want: 500},
	}
	for _, testCase := range cases {
		if got := MinimumRemainingBasisPoints(testCase.threshold); got != testCase.want {
			t.Fatalf("MinimumRemainingBasisPoints(%v) = %d, want %d", testCase.threshold, got, testCase.want)
		}
	}
}

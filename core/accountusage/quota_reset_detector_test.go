package accountusage

import "testing"

func pctPtr(value float64) *float64 { return &value }

func detectorObservation(
	capturedAtMS int64,
	remainingPct float64,
	resetAtMS int64,
) QuotaWindowSample {
	return QuotaWindowSample{
		QuotaKey:          "rate_limit:primary",
		WindowLabel:       "5h",
		WindowMinutes:     300,
		RemainingPct:      pctPtr(remainingPct),
		ExpectedResetAtMS: resetAtMS,
		CapturedAtMS:      capturedAtMS,
	}
}

func TestQuotaDetectorFirstObservationIsBaseline(t *testing.T) {
	state, event := AdvanceQuotaDetector(
		QuotaDetectorState{}, false, "acct_x", "codex",
		detectorObservation(1_000_000, 40, 2_000_000),
	)
	if event != nil {
		t.Fatalf("first observation must not emit event: %+v", event)
	}
	if !state.IsArmed || state.RearmGeneration != 1 {
		t.Fatalf("state = %+v, want armed with generation 1", state)
	}
}

func TestQuotaDetectorCycleRollover(t *testing.T) {
	base := int64(1_800_000_000_000)
	state, _ := AdvanceQuotaDetector(
		QuotaDetectorState{}, false, "acct_x", "codex",
		detectorObservation(base, 40, base+5*MS_PER_MINUTE),
	)
	// 原定关窗时刻之后观察到回满 → 自然滚动，发生时刻取原定关窗时刻。
	next, event := AdvanceQuotaDetector(
		state, true, "acct_x", "codex",
		detectorObservation(base+6*MS_PER_MINUTE, 100, base+6*MS_PER_MINUTE+300*MS_PER_MINUTE),
	)
	if event == nil {
		t.Fatal("cycle rollover event missing")
	}
	if event.EventKind != QuotaResetKindCycleRollover || event.Classification != "natural" {
		t.Fatalf("event = %+v, want cycle_rollover/natural", event)
	}
	if event.OccurredAtMS != base+5*MS_PER_MINUTE {
		t.Fatalf("occurred = %d, want %d", event.OccurredAtMS, base+5*MS_PER_MINUTE)
	}
	if event.PreviousRemainingPct == nil || *event.PreviousRemainingPct != 40 {
		t.Fatalf("previous remaining = %v, want 40", event.PreviousRemainingPct)
	}
	if next.IsArmed {
		t.Fatalf("state should be disarmed after full replenishment: %+v", next)
	}
}

func TestQuotaDetectorEarlyReplenishment(t *testing.T) {
	base := int64(1_800_000_000_000)
	state, _ := AdvanceQuotaDetector(
		QuotaDetectorState{}, false, "acct_x", "codex",
		detectorObservation(base, 30, base+5*60*MS_PER_MINUTE),
	)
	// 原定关窗还有 4 小时，额度已经回满 → 提前回血。
	next, event := AdvanceQuotaDetector(
		state, true, "acct_x", "codex",
		detectorObservation(base+60*MS_PER_MINUTE, 100, base+60*MS_PER_MINUTE+300*MS_PER_MINUTE),
	)
	if event == nil {
		t.Fatal("replenishment event missing")
	}
	if event.EventKind != QuotaResetKindReplenishment || event.Classification != "early_inferred" {
		t.Fatalf("event = %+v, want replenishment/early_inferred", event)
	}
	if event.OccurredAtMS != base+60*MS_PER_MINUTE {
		t.Fatalf("occurred = %d, want detection time", event.OccurredAtMS)
	}
	if event.EarlyDurationMS != 4*60*MS_PER_MINUTE {
		t.Fatalf("early duration = %d, want 4h", event.EarlyDurationMS)
	}
	if next.IsArmed {
		t.Fatalf("state should be disarmed: %+v", next)
	}
}

func TestQuotaDetectorIgnoresConsumptionAndFlatObservation(t *testing.T) {
	base := int64(1_800_000_000_000)
	// 100% → 100%：无消耗空转，不是重置。
	state, event := AdvanceQuotaDetector(
		QuotaDetectorState{}, false, "acct_x", "codex",
		detectorObservation(base, 100, base+300*MS_PER_MINUTE),
	)
	if event != nil {
		t.Fatalf("flat 100%% must not emit event: %+v", event)
	}
	// 100% → 42%：纯消耗，不是重置。
	state, event = AdvanceQuotaDetector(
		state, true, "acct_x", "codex",
		detectorObservation(base+MS_PER_MINUTE, 42, base+300*MS_PER_MINUTE),
	)
	if event != nil {
		t.Fatalf("consumption must not emit event: %+v", event)
	}
	if !state.IsArmed {
		t.Fatalf("consumption should arm detector: %+v", state)
	}
	// 42% → 91%：只回升没有回满，不是重置。
	state, event = AdvanceQuotaDetector(
		state, true, "acct_x", "codex",
		detectorObservation(base+2*MS_PER_MINUTE, 91, base+300*MS_PER_MINUTE),
	)
	if event != nil {
		t.Fatalf("partial rise must not emit event: %+v", event)
	}
	if state.LastRemainingPct == nil || *state.LastRemainingPct != 91 {
		t.Fatalf("baseline not updated: %+v", state)
	}
}

func TestQuotaDetectorDiscardsOutOfOrderObservation(t *testing.T) {
	base := int64(1_800_000_000_000)
	state, _ := AdvanceQuotaDetector(
		QuotaDetectorState{}, false, "acct_x", "codex",
		detectorObservation(base, 40, base+300*MS_PER_MINUTE),
	)
	next, event := AdvanceQuotaDetector(
		state, true, "acct_x", "codex",
		detectorObservation(base-1000, 100, base+600*MS_PER_MINUTE),
	)
	if event != nil {
		t.Fatalf("out-of-order observation must not emit event: %+v", event)
	}
	if next != state {
		t.Fatalf("out-of-order observation must not change state: %+v", next)
	}
}

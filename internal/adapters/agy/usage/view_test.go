package usage

import (
	"encoding/json"
	"testing"
)

func decodeViewPayload(t *testing.T, payload []byte) map[string]any {
	t.Helper()
	if payload == nil {
		t.Fatal("view payload is nil")
	}
	var document map[string]any
	if err := json.Unmarshal(payload, &document); err != nil {
		t.Fatalf("decode view payload: %v", err)
	}
	return document
}

func freeAccountDocument(t *testing.T, nowMS int64) []byte {
	t.Helper()
	return usageDocumentPayload(t, map[string]any{
		"account": map[string]any{
			"email":            "demo@example.com",
			"planType":         "free",
			"subscriptionTier": "Free",
			"project":          "proj-1",
		},
		"models": []any{
			map[string]any{"model": "claude-sonnet-4-5", "remainingPct": 42.5},
			map[string]any{"model": "gemini-3-pro", "remainingPct": 60.0},
		},
	})
}

func TestNormalizePlanType(t *testing.T) {
	t.Parallel()
	cases := []struct {
		tier     string
		fallback string
		want     string
	}{
		{tier: "Google AI Ultra", want: "ultra"},
		{tier: "Google AI Pro", want: "pro"},
		{tier: "Starter", want: "free"},
		{tier: "Free", want: "free"},
		{tier: "Default", want: "free"},
		{tier: "Gemini Fable", want: "oauth"},
		{tier: "", want: "oauth"},
		{tier: "Gemini Fable", fallback: "free", want: "free"},
		{tier: "Gemini Fable", fallback: "starter", want: "free"},
		{tier: "Gemini Fable", fallback: "default", want: "free"},
		{tier: "Gemini Fable", fallback: "Pro", want: "pro"},
		{tier: "Gemini Fable", fallback: "Gemini Fable", want: "Gemini Fable"},
		{tier: "", fallback: "  ", want: "oauth"},
	}
	for _, testCase := range cases {
		if got := NormalizePlanType(testCase.tier, testCase.fallback); got != testCase.want {
			t.Fatalf("NormalizePlanType(%q, %q) = %q, want %q",
				testCase.tier, testCase.fallback, got, testCase.want)
		}
	}
}

func TestEffectiveUsageViewMasksFreePlanCooldown(t *testing.T) {
	t.Parallel()
	const nowMS = int64(1_800_000_000_000)
	view := BuildEffectiveUsageView(EffectiveUsageViewInput{
		UsageSnapshot: freeAccountDocument(t, nowMS),
		RuntimeState: RuntimeState{
			ModelCooldowns: map[string]int64{"gemini-3-pro": nowMS + 30_000},
		},
		NowMS: nowMS,
	})
	if view.PlanType != "free" {
		t.Fatalf("plan type = %q", view.PlanType)
	}
	if !view.FreeQuotaExhausted {
		t.Fatal("free plan with active cooldown must be exhausted")
	}
	if view.RemainingPct == nil || *view.RemainingPct != 0 {
		t.Fatalf("remainingPct = %v, want 0", view.RemainingPct)
	}
	document := decodeViewPayload(t, view.UsageSnapshot)
	account := document["account"].(map[string]any)
	if account["planType"] != "free" || account["subscriptionTier"] != "Free" {
		t.Fatalf("account = %#v", account)
	}
	models := document["models"].([]any)
	for index, raw := range models {
		model := raw.(map[string]any)
		if model["remainingPct"].(float64) != 0 {
			t.Fatalf("model[%d].remainingPct = %v, want 0", index, model["remainingPct"])
		}
	}
	if len(view.ActiveModelCooldowns) != 1 {
		t.Fatalf("cooldowns = %#v", view.ActiveModelCooldowns)
	}
}

func TestEffectiveUsageViewKeepsPaidPlanRemaining(t *testing.T) {
	t.Parallel()
	const nowMS = int64(1_800_000_000_000)
	view := BuildEffectiveUsageView(EffectiveUsageViewInput{
		UsageSnapshot: usageDocumentPayload(t, map[string]any{
			"models": []any{
				map[string]any{"model": "claude-sonnet-4-5", "remainingPct": 42.5},
				map[string]any{"model": "gemini-3-pro", "remainingPct": 60.0},
			},
		}),
		RuntimeState: RuntimeState{
			ModelCooldowns: map[string]int64{"gemini-3-pro": nowMS + 30_000},
		},
		NowMS: nowMS,
	})
	if view.PlanType != "pro" {
		t.Fatalf("plan type = %q", view.PlanType)
	}
	if view.FreeQuotaExhausted {
		t.Fatal("paid plan must not be masked by model cooldown")
	}
	if view.RemainingPct == nil || *view.RemainingPct != 42.5 {
		t.Fatalf("remainingPct = %v, want 42.5", view.RemainingPct)
	}
	document := decodeViewPayload(t, view.UsageSnapshot)
	models := document["models"].([]any)
	if models[0].(map[string]any)["remainingPct"].(float64) != 42.5 {
		t.Fatalf("model remainingPct must stay untouched: %#v", models[0])
	}
}

func TestEffectiveUsageViewDropsExpiredCooldowns(t *testing.T) {
	t.Parallel()
	const nowMS = int64(1_800_000_000_000)
	view := BuildEffectiveUsageView(EffectiveUsageViewInput{
		UsageSnapshot: freeAccountDocument(t, nowMS),
		RuntimeState: RuntimeState{
			ModelCooldowns: map[string]int64{
				"gemini-3-pro":      nowMS - 1,
				"claude-sonnet-4-5": nowMS,
			},
		},
		NowMS: nowMS,
	})
	if view.FreeQuotaExhausted {
		t.Fatal("expired cooldowns must not mark the account exhausted")
	}
	// Node 用 until > nowMs 严格比较：等于当前时刻的 cooldown 已经失效。
	if len(view.ActiveModelCooldowns) != 0 {
		t.Fatalf("cooldowns = %#v", view.ActiveModelCooldowns)
	}
	if view.RemainingPct == nil || *view.RemainingPct != 42.5 {
		t.Fatalf("remainingPct = %v, want 42.5", view.RemainingPct)
	}
}

func TestEffectiveUsageViewMigratesLegacyModelFailures(t *testing.T) {
	t.Parallel()
	const nowMS = int64(1_800_000_000_000)
	view := BuildEffectiveUsageView(EffectiveUsageViewInput{
		UsageSnapshot: freeAccountDocument(t, nowMS),
		RuntimeState: RuntimeState{
			LastFailureKind: "model_quota_exhausted",
			LastFailureAtMS: nowMS - 10_000,
			ModelFailures:   map[string]float64{"gemini-3-pro": 2},
		},
		NowMS: nowMS,
	})
	if !view.FreeQuotaExhausted || !view.QuotaExhaustionSignal {
		t.Fatalf("view = %#v", view)
	}
	// 30s 猜测冷却尚未到期，legacy 失败表要把 cooldown 续上。
	if until, ok := view.ActiveModelCooldowns["gemini-3-pro"]; !ok || until != nowMS+20_000 {
		t.Fatalf("cooldowns = %#v", view.ActiveModelCooldowns)
	}
	// 冷却已过期时不再补。
	expired := BuildEffectiveUsageView(EffectiveUsageViewInput{
		UsageSnapshot: freeAccountDocument(t, nowMS),
		RuntimeState: RuntimeState{
			LastFailureKind: "model_quota_exhausted",
			LastFailureAtMS: nowMS - 40_000,
			ModelFailures:   map[string]float64{"gemini-3-pro": 2},
		},
		NowMS: nowMS,
	})
	if expired.FreeQuotaExhausted || len(expired.ActiveModelCooldowns) != 0 {
		t.Fatalf("expired view = %#v", expired)
	}
}

func TestEffectiveUsageViewWithoutSnapshot(t *testing.T) {
	t.Parallel()
	view := BuildEffectiveUsageView(EffectiveUsageViewInput{
		Account:          AccountPlan{SubscriptionTier: "Free"},
		FallbackPlanType: "oauth",
		NowMS:            1_800_000_000_000,
	})
	if view.UsageSnapshot != nil {
		t.Fatalf("snapshot = %s, want nil", view.UsageSnapshot)
	}
	if view.RemainingPct != nil {
		t.Fatalf("remainingPct = %v, want nil", view.RemainingPct)
	}
	if view.PlanType != "free" {
		t.Fatalf("plan type = %q", view.PlanType)
	}
}

func TestEffectiveUsageViewFreeWithoutSnapshotStillExhausted(t *testing.T) {
	t.Parallel()
	const nowMS = int64(1_800_000_000_000)
	view := BuildEffectiveUsageView(EffectiveUsageViewInput{
		Account: AccountPlan{PlanType: "free"},
		RuntimeState: RuntimeState{
			ModelCooldowns: map[string]int64{"gemini-3-pro": nowMS + 1},
		},
		NowMS: nowMS,
	})
	if !view.FreeQuotaExhausted {
		t.Fatal("free plan with cooldown must be exhausted even without snapshot")
	}
	if view.RemainingPct == nil || *view.RemainingPct != 0 {
		t.Fatalf("remainingPct = %v, want 0", view.RemainingPct)
	}
	if view.UsageSnapshot != nil {
		t.Fatalf("snapshot = %s, want nil", view.UsageSnapshot)
	}
}

func TestQuotaExhaustionSignalPatterns(t *testing.T) {
	t.Parallel()
	cases := []struct {
		text string
		want bool
	}{
		{text: "model_quota_exhausted", want: true},
		{text: "Resource has been exhausted (e.g. check quota).", want: true},
		{text: "quota exhausted", want: true},
		{text: "QUOTA EXCEEDED", want: true},
		{text: "resource_exhausted: check quota", want: true},
		{text: "resource_exhausted", want: false},
		{text: "rate limited", want: false},
	}
	for _, testCase := range cases {
		state := RuntimeState{LastFailureReason: testCase.text}
		if got := hasQuotaExhaustionSignal(state.signalText()); got != testCase.want {
			t.Fatalf("signal(%q) = %v, want %v", testCase.text, got, testCase.want)
		}
	}
	// 三段文本要合并判断：kind 与 error 各带一半也能命中。
	state := RuntimeState{LastFailureKind: "model_quota", LastError: "exhausted_quota"}
	if hasQuotaExhaustionSignal(state.signalText()) {
		t.Fatal("split text must not match a single pattern")
	}
	state = RuntimeState{LastFailureKind: "model_quota_exhausted", LastError: "detail"}
	if !hasQuotaExhaustionSignal(state.signalText()) {
		t.Fatal("kind alone must match")
	}
}

func TestEffectiveUsageViewPreservesUnknownFields(t *testing.T) {
	t.Parallel()
	const nowMS = int64(1_800_000_000_000)
	payload := usageDocumentPayload(t, map[string]any{
		"account": map[string]any{
			"email":             "demo@example.com",
			"planType":          "free",
			"subscriptionTier":  "Free",
			"project":           "proj-1",
			"extraAccountField": "keep-me",
		},
		"models": []any{
			map[string]any{
				"model":        "gemini-3-pro",
				"remainingPct": 60.0,
				"extraField":   "keep-me-too",
			},
		},
		"extraTopLevel": map[string]any{"kept": true},
	})
	view := BuildEffectiveUsageView(EffectiveUsageViewInput{
		UsageSnapshot: payload,
		RuntimeState: RuntimeState{
			ModelCooldowns: map[string]int64{"gemini-3-pro": nowMS + 1},
		},
		NowMS: nowMS,
	})
	document := decodeViewPayload(t, view.UsageSnapshot)
	if _, ok := document["extraTopLevel"]; !ok {
		t.Fatalf("top-level unknown field lost: %#v", document)
	}
	account := document["account"].(map[string]any)
	if account["extraAccountField"] != "keep-me" {
		t.Fatalf("account unknown field lost: %#v", account)
	}
	model := document["models"].([]any)[0].(map[string]any)
	if model["extraField"] != "keep-me-too" || model["remainingPct"].(float64) != 0 {
		t.Fatalf("model = %#v", model)
	}
}

func TestEffectiveUsageViewClampsRemaining(t *testing.T) {
	t.Parallel()
	const nowMS = int64(1_800_000_000_000)
	high := BuildEffectiveUsageView(EffectiveUsageViewInput{
		UsageSnapshot: usageDocumentPayload(t, map[string]any{
			"models": []any{map[string]any{"model": "gemini-3-pro", "remainingPct": 150.0}},
		}),
		NowMS: nowMS,
	})
	if high.RemainingPct == nil || *high.RemainingPct != 100 {
		t.Fatalf("remainingPct = %v, want 100", high.RemainingPct)
	}
	low := BuildEffectiveUsageView(EffectiveUsageViewInput{
		UsageSnapshot: usageDocumentPayload(t, map[string]any{
			"models": []any{map[string]any{"model": "gemini-3-pro", "remainingPct": -5.0}},
		}),
		NowMS: nowMS,
	})
	if low.RemainingPct == nil || *low.RemainingPct != 0 {
		t.Fatalf("remainingPct = %v, want 0", low.RemainingPct)
	}
}

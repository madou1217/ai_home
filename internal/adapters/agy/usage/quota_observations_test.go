package usage

import (
	"testing"
)

const observationCapturedAtMS = int64(1_800_000_000_000)

func TestBuildQuotaObservationsGroupsModelPools(t *testing.T) {
	t.Parallel()
	payload := usageDocumentPayload(t, map[string]any{
		"account": map[string]any{
			"email":            "demo@example.com",
			"planType":         "pro",
			"subscriptionTier": "Pro",
			"project":          "proj-1",
		},
		"models": []any{
			map[string]any{"model": "gemini-3-pro", "remainingPct": 60.0, "resetAtMs": observationCapturedAtMS + 2*60*60*1000},
			map[string]any{"model": "gemini-2-5-flash", "remainingPct": 30.0, "resetAtMs": observationCapturedAtMS + 3*60*60*1000},
			map[string]any{"model": "claude-sonnet-4-5", "remainingPct": 50.0, "resetAtMs": observationCapturedAtMS + 2*24*60*60*1000},
			map[string]any{"model": "gpt-5", "remainingPct": 80.0, "resetAtMs": observationCapturedAtMS + 3*24*60*60*1000},
		},
	})
	observations := BuildQuotaObservations(payload, observationCapturedAtMS)
	if len(observations) != 2 {
		t.Fatalf("observations = %#v", observations)
	}
	// 顺序按首次出现的桶（Node Map 插入顺序）：gemini_5h → claude_gpt_week。
	first := observations[0]
	if first.QuotaKey != "rate_limit:gemini_5h" ||
		first.WindowLabel != "Gemini 模型池 (5h)" ||
		first.WindowMinutes != 300 {
		t.Fatalf("first = %#v", first)
	}
	if first.RemainingPct == nil || *first.RemainingPct != 30 {
		t.Fatalf("gemini 5h remaining = %v, want 30 (min)", first.RemainingPct)
	}
	// 同桶的 reset 取最晚一档。
	if first.ExpectedResetAtMS != observationCapturedAtMS+3*60*60*1000 {
		t.Fatalf("gemini 5h reset = %d", first.ExpectedResetAtMS)
	}
	if first.PlanType != "pro" || first.CapturedAtMS != observationCapturedAtMS {
		t.Fatalf("first metadata = %#v", first)
	}
	second := observations[1]
	if second.QuotaKey != "rate_limit:claude_gpt_week" ||
		second.WindowLabel != "Claude & GPT 模型池 (Weekly)" ||
		second.WindowMinutes != 10080 {
		t.Fatalf("second = %#v", second)
	}
	if second.RemainingPct == nil || *second.RemainingPct != 50 {
		t.Fatalf("claude weekly remaining = %v, want 50", second.RemainingPct)
	}
}

func TestBuildQuotaObservationsWeeklyByResetInText(t *testing.T) {
	t.Parallel()
	payload := usageDocumentPayload(t, map[string]any{
		"models": []any{
			map[string]any{"model": "gemini-3-pro", "remainingPct": 10.0, "resetIn": "3 days"},
			// \bd\b 只认独立的 d："1 d" 是周窗口，"5d" 不是（Node 同一正则）。
			map[string]any{"model": "gpt-5", "remainingPct": 20.0, "resetIn": "1 d"},
			map[string]any{"model": "claude-sonnet-4-5", "remainingPct": 30.0, "resetIn": "5d"},
		},
	})
	observations := BuildQuotaObservations(payload, observationCapturedAtMS)
	if len(observations) != 3 {
		t.Fatalf("observations = %#v", observations)
	}
	keys := []string{observations[0].QuotaKey, observations[1].QuotaKey, observations[2].QuotaKey}
	want := []string{"rate_limit:gemini_week", "rate_limit:claude_gpt_week", "rate_limit:claude_gpt_5h"}
	for index := range want {
		if keys[index] != want[index] {
			t.Fatalf("keys = %#v, want %#v", keys, want)
		}
	}
}

func TestBuildQuotaObservationsIgnoresStringRemaining(t *testing.T) {
	t.Parallel()
	payload := usageDocumentPayload(t, map[string]any{
		"models": []any{
			map[string]any{"model": "gemini-3-pro", "remainingPct": "42.5", "resetAtMs": observationCapturedAtMS + 60*60*1000},
		},
	})
	observations := BuildQuotaObservations(payload, observationCapturedAtMS)
	if len(observations) != 1 {
		t.Fatalf("observations = %#v", observations)
	}
	// Node 这条路径用 typeof === 'number'，字符串剩余量是「未知」。
	if observations[0].RemainingPct != nil {
		t.Fatalf("remaining = %v, want nil", observations[0].RemainingPct)
	}
	if observations[0].ExpectedResetAtMS != observationCapturedAtMS+60*60*1000 {
		t.Fatalf("reset = %d", observations[0].ExpectedResetAtMS)
	}
}

func TestBuildQuotaObservationsPlanFallbacks(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name     string
		account  map[string]any
		planType string
		rootPlan string
		want     string
	}{
		{
			name:    "account planType",
			account: map[string]any{"planType": "Free"},
			want:    "free",
		},
		{
			name:     "root planType",
			account:  map[string]any{},
			rootPlan: "Google AI Ultra",
			want:     "ultra",
		},
		{
			name:    "oauth is not a plan",
			account: map[string]any{"planType": "oauth"},
			want:    "",
		},
	}
	for _, testCase := range cases {
		overrides := map[string]any{
			"account": testCase.account,
			"models": []any{
				map[string]any{"model": "gemini-3-pro", "remainingPct": 10.0, "resetAtMs": observationCapturedAtMS + 60*60*1000},
			},
		}
		if testCase.rootPlan != "" {
			overrides["planType"] = testCase.rootPlan
		}
		observations := BuildQuotaObservations(usageDocumentPayload(t, overrides), observationCapturedAtMS)
		if len(observations) != 1 || observations[0].PlanType != testCase.want {
			t.Fatalf("%s: observations = %#v", testCase.name, observations)
		}
	}
}

func TestBuildQuotaObservationsEmptySnapshot(t *testing.T) {
	t.Parallel()
	if observations := BuildQuotaObservations([]byte("not-json"), observationCapturedAtMS); observations != nil {
		t.Fatalf("observations = %#v", observations)
	}
	empty := usageDocumentPayload(t, map[string]any{"models": []any{}})
	if observations := BuildQuotaObservations(empty, observationCapturedAtMS); len(observations) != 0 {
		t.Fatalf("observations = %#v", observations)
	}
}

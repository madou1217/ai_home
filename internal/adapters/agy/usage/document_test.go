package usage

import (
	"encoding/json"
	"testing"
)

const testCapturedAtMS = int64(1_800_000_000_000)

// usageDocumentPayload 构造一份与 Node parseAgyCodeAssistQuotaSnapshot 同形的展示文档。
func usageDocumentPayload(t *testing.T, overrides map[string]any) []byte {
	t.Helper()
	document := map[string]any{
		"schemaVersion": 2,
		"kind":          documentKind,
		"source":        sourceID,
		"capturedAt":    testCapturedAtMS,
		"account": map[string]any{
			"email":            "demo@example.com",
			"planType":         "pro",
			"subscriptionTier": "Pro",
			"project":          "proj-1",
		},
		"models": []any{
			map[string]any{
				"model":        "claude-sonnet-4-5",
				"remainingPct": 42.5,
				"resetIn":      "3h 10m",
				"resetAtMs":    int64(testCapturedAtMS + 11_000_000),
			},
			map[string]any{
				"model":        "gemini-3-pro",
				"remainingPct": 0,
				"resetIn":      "1d",
			},
		},
		"modelForwardingRules": map[string]any{},
	}
	for key, value := range overrides {
		if value == nil {
			delete(document, key)
			continue
		}
		document[key] = value
	}
	payload, err := json.Marshal(document)
	if err != nil {
		t.Fatalf("marshal document: %v", err)
	}
	return payload
}

func TestBuildSnapshotFacts(t *testing.T) {
	t.Parallel()
	facts, ok := BuildSnapshotFacts(usageDocumentPayload(t, nil))
	if !ok {
		t.Fatal("BuildSnapshotFacts() = untrusted, want trusted")
	}
	if facts.CapturedAtMS != testCapturedAtMS {
		t.Fatalf("capturedAt = %d", facts.CapturedAtMS)
	}
	if facts.Project != "proj-1" {
		t.Fatalf("project = %q", facts.Project)
	}
	if len(facts.Models) != 2 {
		t.Fatalf("models = %d", len(facts.Models))
	}
	if facts.Models[0].ResetIn != "3h 10m" || facts.Models[0].ResetAtMS == nil ||
		*facts.Models[0].ResetAtMS != testCapturedAtMS+11_000_000 {
		t.Fatalf("model[0] = %#v", facts.Models[0])
	}
	// Node listAgyQuotaAvailableModels 只保留 remainingPct > 0 的模型。
	if len(facts.AvailableModels) != 1 || facts.AvailableModels[0] != "claude-sonnet-4-5" {
		t.Fatalf("availableModels = %#v", facts.AvailableModels)
	}
	if facts.MinRemainingPct == nil || *facts.MinRemainingPct != 0 {
		t.Fatalf("minRemainingPct = %v, want 0", facts.MinRemainingPct)
	}
}

func TestSnapshotFactsTreatMissingAndStringRemainingAsNode(t *testing.T) {
	t.Parallel()
	payload := usageDocumentPayload(t, map[string]any{
		"models": []any{
			map[string]any{"model": "alpha", "remainingPct": "12.5"},
			map[string]any{"model": "beta"},
			map[string]any{"model": "gamma", "remainingPct": 150.0},
		},
	})
	facts, ok := BuildSnapshotFacts(payload)
	if !ok {
		t.Fatal("BuildSnapshotFacts() = untrusted")
	}
	// 缺失的 remainingPct 不参与 min（Node readOptionalNumber 返回 null）；
	// 数字字符串按数值参与（Node Number("12.5")）。
	if facts.MinRemainingPct == nil || *facts.MinRemainingPct != 12.5 {
		t.Fatalf("minRemainingPct = %v, want 12.5", facts.MinRemainingPct)
	}
	if len(facts.Models) != 3 {
		t.Fatalf("models = %d", len(facts.Models))
	}
	if facts.Models[1].RemainingPct != nil {
		t.Fatalf("beta remainingPct = %v, want nil", facts.Models[1].RemainingPct)
	}
	if len(facts.AvailableModels) != 2 {
		t.Fatalf("availableModels = %#v", facts.AvailableModels)
	}
}

func TestUntrustedUsageDocuments(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name      string
		overrides map[string]any
	}{
		{name: "schema version as string", overrides: map[string]any{"schemaVersion": "2"}},
		{name: "schema version newer", overrides: map[string]any{"schemaVersion": 3}},
		{name: "schema version missing", overrides: map[string]any{"schemaVersion": nil}},
		{name: "kind mismatch", overrides: map[string]any{"kind": "gemini_oauth_stats"}},
		{name: "source mismatch", overrides: map[string]any{"source": "other_source"}},
		{name: "models is object", overrides: map[string]any{"models": map[string]any{"alpha": map[string]any{}}}},
		{name: "models missing", overrides: map[string]any{"models": nil}},
	}
	for _, testCase := range cases {
		payload := usageDocumentPayload(t, testCase.overrides)
		if _, ok := BuildSnapshotFacts(payload); ok {
			t.Fatalf("%s: BuildSnapshotFacts() = trusted, want untrusted", testCase.name)
		}
		if models := ListAvailableModels(payload); len(models) != 0 {
			t.Fatalf("%s: available models = %#v", testCase.name, models)
		}
		if !IsSnapshotStale(payload, 60_000, testCapturedAtMS) {
			t.Fatalf("%s: untrusted document must be stale", testCase.name)
		}
	}
}

func TestSnapshotStalenessBoundary(t *testing.T) {
	t.Parallel()
	payload := usageDocumentPayload(t, nil)
	const ttl = int64(60_000)
	if IsSnapshotStale(payload, ttl, testCapturedAtMS+ttl-1) {
		t.Fatal("snapshot 1ms before ttl must not be stale")
	}
	// Node 用 >= 比较：now - capturedAt 正好等于 ttl 就算过期。
	if !IsSnapshotStale(payload, ttl, testCapturedAtMS+ttl) {
		t.Fatal("snapshot at ttl boundary must be stale")
	}
	// ttl 为 0 时一律过期（Math.max(0, 0)）。
	if !IsSnapshotStale(payload, 0, testCapturedAtMS) {
		t.Fatal("zero ttl must mark snapshot stale")
	}
	// capturedAt 缺失 → 过期。
	missingCapturedAt := usageDocumentPayload(t, map[string]any{"capturedAt": nil})
	if !IsSnapshotStale(missingCapturedAt, ttl, testCapturedAtMS) {
		t.Fatal("missing capturedAt must be stale")
	}
}

func TestUsageRefreshBounds(t *testing.T) {
	t.Parallel()
	if got := UsageRefreshTTL(0, false); got != 60_000 {
		t.Fatalf("ttl default = %d", got)
	}
	if got := UsageRefreshTTL(0, true); got != 5_000 {
		t.Fatalf("ttl zero = %d, want min 5000", got)
	}
	if got := UsageRefreshTTL(90_000, true); got != 90_000 {
		t.Fatalf("ttl 90s = %d", got)
	}
	if got := UsageRefreshTTL(1<<40, true); got != 30*60_000 {
		t.Fatalf("ttl huge = %d, want max 1800000", got)
	}
	if got := UsageRefreshTimeout(0, false); got != 8_000 {
		t.Fatalf("timeout default = %d", got)
	}
	if got := UsageRefreshTimeout(1, true); got != 1_000 {
		t.Fatalf("timeout 1ms = %d, want min 1000", got)
	}
	if got := UsageRefreshTimeout(90_000, true); got != 30_000 {
		t.Fatalf("timeout 90s = %d, want max 30000", got)
	}
}

func TestShouldRefreshAfterFailure(t *testing.T) {
	t.Parallel()
	for _, kind := range []string{
		"rate_limited",
		"model_quota_exhausted",
		"model_capacity_unavailable",
		"location_unsupported",
	} {
		if !ShouldRefreshAfterFailure("agy", kind) {
			t.Fatalf("kind %q must trigger refresh", kind)
		}
	}
	for _, kind := range []string{"", "credential_rejected", "upstream_unavailable"} {
		if ShouldRefreshAfterFailure("agy", kind) {
			t.Fatalf("kind %q must not trigger refresh", kind)
		}
	}
	if ShouldRefreshAfterFailure("gemini", "rate_limited") {
		t.Fatal("non-agy provider must not trigger refresh")
	}
}

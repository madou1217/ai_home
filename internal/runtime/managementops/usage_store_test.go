package managementops

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func floatPtr(v float64) *float64 { return &v }

func TestUsageStoreCanonicalProjectionAndQueries(t *testing.T) {
	ctx := context.Background()
	tmpDir := t.TempDir()
	dbPath := filepath.Join(tmpDir, "aih.db")
	nowMS := int64(1700000100000)

	store, err := NewUsageStore(ctx, dbPath, []string{"codex", "claude"}, func() time.Time {
		return time.UnixMilli(nowMS)
	})
	if err != nil {
		t.Fatalf("NewUsageStore() error = %v", err)
	}
	defer func() { _ = store.Close() }()

	// 写入基准价格表（按单 token USD）
	if _, err := store.DB().ExecContext(ctx, `
		INSERT INTO model_usage_pricing (
			model, input_cost_per_token, output_cost_per_token,
			cache_read_input_token_cost, cache_creation_input_token_cost,
			reasoning_output_token_cost, context_cost_tiers_json, source, updated_at_ms
		) VALUES ('gpt-5', 0.00001, 0.00002, 0.000001, 0.0, 0.0, '', 'test', ?)`, nowMS); err != nil {
		t.Fatalf("seed pricing error = %v", err)
	}

	ref1 := "acct_0123456789abcdef0123"
	// 写入网关 proxy 记录 + 相同时窗内同 token 量的本地 scanner 记录，校验二分图配对去重
	inserted, err := store.InsertUsageBatch(ctx, []UsageRecordInput{
		{
			EventKey:             "proxy:codex:req-1",
			Provider:             "codex",
			AccountRef:           ref1,
			SessionID:            "sess-1",
			RequestID:            "req-1",
			SourceKind:           "server_openai_proxy",
			Model:                "gpt-5",
			InputTokens:          1000,
			OutputTokens:         500,
			CacheReadInputTokens: 200,
			TotalTokens:          1700,
			CostUSD:              floatPtr(0.05),
			TimestampMS:          nowMS - 10_000,
			Project:              "ai_home",
			CWD:                  "/work/ai_home",
		},
		{
			EventKey:             "codex:file:abcd1234abcd1234:10:usage",
			Provider:             "codex",
			AccountRef:           "",
			SessionID:            "sess-1",
			SourceKind:           "session_jsonl",
			Model:                "gpt-5",
			InputTokens:          1000,
			OutputTokens:         500,
			CacheReadInputTokens: 200,
			TotalTokens:          1700,
			TimestampMS:          nowMS - 8_000, // 8s 后扫描入库 -> 与 2s 前代理记录匹配合并
			Project:              "ai_home",
			CWD:                  "/work/ai_home",
		},
		{
			EventKey:    "claude:message:m1",
			Provider:    "claude",
			AccountRef:  ref1,
			SessionID:   "sess-c1",
			SourceKind:  "session_jsonl",
			Model:       "claude-sonnet-4-5",
			InputTokens: 400,
			OutputTokens: 100,
			TotalTokens: 500,
			CostUSD:     floatPtr(0.02),
			TimestampMS: nowMS - 20_000,
			Project:     "web",
			CWD:         "/work/web",
		},
	})
	if err != nil || inserted != 3 {
		t.Fatalf("InsertUsageBatch() = %d, err = %v", inserted, err)
	}

	if _, err := store.UpsertSessions(ctx, []UsageSessionInput{
		{Provider: "codex", SessionID: "sess-1", Project: "ai_home", CWD: "/work/ai_home", StartedAtMS: nowMS - 15_000, UpdatedAtMS: nowMS - 5_000, PromptCount: 2},
		{Provider: "claude", SessionID: "sess-c1", Project: "web", CWD: "/work/web", StartedAtMS: nowMS - 25_000, UpdatedAtMS: nowMS - 20_000, PromptCount: 1},
	}); err != nil {
		t.Fatalf("UpsertSessions() error = %v", err)
	}
	if _, err := store.InsertPromptEvents(ctx, []UsagePromptEventInput{
		{EventKey: "codex:p:1", Provider: "codex", SessionID: "sess-1", TimestampMS: nowMS - 12_000},
		{EventKey: "codex:p:2", Provider: "codex", SessionID: "sess-1", TimestampMS: nowMS - 9_000},
		{EventKey: "claude:p:1", Provider: "claude", SessionID: "sess-c1", TimestampMS: nowMS - 22_000},
	}); err != nil {
		t.Fatalf("InsertPromptEvents() error = %v", err)
	}

	q := UsageQuery{FromMS: nowMS - 60_000, ToMS: nowMS, Limit: 50}
	dash, err := store.QueryDashboard(ctx, q)
	if err != nil {
		t.Fatalf("QueryDashboard() error = %v", err)
	}
	// codex proxy + scanner 应去重成 1 次调用 + claude 1 次调用 = 2 次总调用
	if dash.Stats.TotalCalls != 2 || dash.Stats.TotalSessions != 2 || dash.Stats.TotalPrompts != 3 {
		t.Fatalf("Stats = %+v, want calls=2 sessions=2 prompts=3", dash.Stats)
	}
	if len(dash.Models) != 2 || len(dash.Sessions) != 2 {
		t.Fatalf("Models=%d Sessions=%d, want 2 each", len(dash.Models), len(dash.Sessions))
	}

	breakdown, err := store.QueryBreakdown(ctx, UsageQuery{FromMS: nowMS - 60_000, ToMS: nowMS, SessionID: "sess-1"})
	if err != nil {
		t.Fatalf("QueryBreakdown() error = %v", err)
	}
	if breakdown.Summary.Calls != 1 || len(breakdown.Accounts) != 1 || breakdown.Accounts[0].AccountRef != ref1 {
		t.Fatalf("Breakdown = %+v", breakdown)
	}

	detail, err := store.QuerySessionDetail(ctx, UsageQuery{Provider: "codex", SessionID: "sess-1"})
	if err != nil || len(detail) != 1 || detail[0].Model != "gpt-5" {
		t.Fatalf("QuerySessionDetail() = %+v, err=%v", detail, err)
	}

	// 校验 server.log 错误日志提取与脱敏
	logDir := filepath.Join(tmpDir, "logs")
	if err := os.MkdirAll(logDir, 0o755); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	logLine, _ := json.Marshal(map[string]any{
		"at":              time.UnixMilli(nowMS - 5_000).UTC().Format(time.RFC3339Nano),
		"kind":            requestContextKind,
		"requestId":       "req-err-1",
		"provider":        "codex",
		"model":           "gpt-5",
		"endpoint":   "/v1/responses",
		"status":     429,
		"error":      "rate_limit",
		"detail":     "authorization=Bearer sk-ant-secret123456 failed",
		"durationMs": 120,
	})
	if err := os.WriteFile(filepath.Join(logDir, "server.log"), append(logLine, '\n'), 0o600); err != nil {
		t.Fatalf("WriteFile(server.log) error = %v", err)
	}

	reqDetails, err := store.QueryRequestDetails(ctx, q)
	if err != nil {
		t.Fatalf("QueryRequestDetails() error = %v", err)
	}
	if len(reqDetails.Usage) != 1 || len(reqDetails.Errors) != 1 {
		t.Fatalf("reqDetails Usage=%d Errors=%d, want 1/1", len(reqDetails.Usage), len(reqDetails.Errors))
	}
	if reqDetails.Errors[0].ErrorMessage == "" || reqDetails.Errors[0].RequestID != "req-err-1" {
		t.Fatalf("unexpected error row: %+v", reqDetails.Errors[0])
	}
	if contains := stringContainsSecret(reqDetails.Errors[0].ErrorMessage); contains {
		t.Fatalf("secret leaked in sanitized ErrorMessage: %q", reqDetails.Errors[0].ErrorMessage)
	}

	// 校验 ReconcileCodebuddyUsageBatch & ReconcileZcodeUsageOwnershipBatch & InsertNativeOutcomes
	cbKey := "codebuddy:message:1111111111111111:2222222222222222:usage"
	if n, err := store.ReconcileCodebuddyUsageBatch(ctx, []UsageRecordInput{
		{EventKey: cbKey, Provider: "codebuddy", AccountRef: "", SessionID: "cbs1", SourceKind: "session_jsonl", Model: "glm-5", InputTokens: 10, OutputTokens: 5, TotalTokens: 15, TimestampMS: nowMS - 1000},
	}); err != nil || n != 1 {
		t.Fatalf("ReconcileCodebuddyUsageBatch initial = %d, %v", n, err)
	}
	if n, err := store.ReconcileCodebuddyUsageBatch(ctx, []UsageRecordInput{
		{EventKey: cbKey, Provider: "codebuddy", AccountRef: ref1, SessionID: "cbs1", SourceKind: "session_jsonl", Model: "glm-5", InputTokens: 10, OutputTokens: 5, TotalTokens: 15, TimestampMS: nowMS - 1000},
	}); err != nil || n != 1 {
		t.Fatalf("ReconcileCodebuddyUsageBatch attribute = %d, %v", n, err)
	}
	ownerRec, found, err := store.ReadUsageOwnerByEventKey(ctx, cbKey)
	if err != nil || !found || ownerRec.AccountRef != ref1 {
		t.Fatalf("ReadUsageOwnerByEventKey = %+v found=%v err=%v", ownerRec, found, err)
	}

	if n, err := store.InsertNativeOutcomes(ctx, []NativeOutcomeInput{
		{EventKey: "cb:o:1", AccountRef: ref1, Provider: "codebuddy", SessionID: "cbs1", Outcome: "success", TimestampMS: nowMS - 500},
	}); err != nil || n != 1 {
		t.Fatalf("InsertNativeOutcomes = %d, %v", n, err)
	}
}

func stringContainsSecret(s string) bool {
	return len(s) > 0 && (containsSub(s, "sk-ant-secret") || containsSub(s, "secret123456"))
}

func containsSub(s, sub string) bool {
	return len(sub) > 0 && indexString(s, sub) >= 0
}

func indexString(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

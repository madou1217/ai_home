package sqliteaccount

import (
	"context"
	"testing"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
)

func newQuotaSnapshot(
	t *testing.T,
	accountRef accountcore.AccountRef,
	capturedAt time.Time,
	entries ...usagecore.EntryInput,
) usagecore.Snapshot {
	t.Helper()
	snapshot, err := usagecore.NewSnapshot(usagecore.SnapshotInput{
		AccountRef: accountRef,
		ProviderID: "codex",
		Source:     "codex_read_rate_limits",
		CapturedAt: capturedAt,
		Entries:    entries,
	})
	if err != nil {
		t.Fatalf("NewSnapshot() error = %v", err)
	}
	return snapshot
}

func windowEntry(bucket string, windowMinutes int64, resetAt time.Time, remainingPct float64) usagecore.EntryInput {
	return usagecore.EntryInput{
		Bucket:               bucket,
		Kind:                 usagecore.KindWindow,
		Scope:                usagecore.ScopeAccount,
		HasRemaining:         true,
		RemainingBasisPoints: uint16(remainingPct * 100),
		WindowSeconds:        windowMinutes * 60,
		ResetAt:              resetAt,
		Availability:         usagecore.AvailabilityAvailable,
	}
}

func TestReplaceUsageSnapshotRecordsWindowSamples(t *testing.T) {
	store, accountRef := openUsageDocumentStore(t)
	ctx := context.Background()
	base := time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC)
	resetAt := base.Add(5 * time.Hour)

	snapshot := newQuotaSnapshot(t, accountRef, base.Add(10*time.Minute),
		windowEntry("primary", 300, resetAt, 80),
		usagecore.EntryInput{
			Bucket:       "credits",
			Kind:         usagecore.KindCredits,
			Scope:        usagecore.ScopeAccount,
			Availability: usagecore.AvailabilityAvailable,
		},
	)
	if err := store.ReplaceUsageSnapshot(ctx, snapshot); err != nil {
		t.Fatalf("ReplaceUsageSnapshot() error = %v", err)
	}

	samples, err := store.ListQuotaWindowSamples(ctx, accountRef.String(), "", 300, 0, base.Add(24*time.Hour).UnixMilli())
	if err != nil {
		t.Fatalf("ListQuotaWindowSamples() error = %v", err)
	}
	if len(samples) != 1 {
		t.Fatalf("样本数 = %d, want 1（credits 条目不应采样）", len(samples))
	}
	sample := samples[0]
	if sample.QuotaKey != "rate_limit:primary" {
		t.Fatalf("QuotaKey = %q", sample.QuotaKey)
	}
	if sample.WindowMinutes != 300 || sample.ExpectedResetAtMS != resetAt.UnixMilli() {
		t.Fatalf("样本窗口 = %+v", sample)
	}
	if sample.RemainingPct == nil || *sample.RemainingPct != 80 {
		t.Fatalf("RemainingPct = %v, want 80", sample.RemainingPct)
	}
	if sample.CapturedAtMS != base.Add(10*time.Minute).UnixMilli() {
		t.Fatalf("CapturedAtMS = %d", sample.CapturedAtMS)
	}
}

func TestReplaceUsageSnapshotDedupesWithinBucket(t *testing.T) {
	store, accountRef := openUsageDocumentStore(t)
	ctx := context.Background()
	base := time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC)
	resetAt := base.Add(5 * time.Hour)

	first := newQuotaSnapshot(t, accountRef, base.Add(10*time.Minute), windowEntry("primary", 300, resetAt, 80))
	second := newQuotaSnapshot(t, accountRef, base.Add(11*time.Minute), windowEntry("primary", 300, resetAt, 70))
	if err := store.ReplaceUsageSnapshot(ctx, first); err != nil {
		t.Fatalf("ReplaceUsageSnapshot(first) error = %v", err)
	}
	if err := store.ReplaceUsageSnapshot(ctx, second); err != nil {
		t.Fatalf("ReplaceUsageSnapshot(second) error = %v", err)
	}

	samples, err := store.ListQuotaWindowSamples(ctx, accountRef.String(), "rate_limit:primary", 300, 0, base.Add(24*time.Hour).UnixMilli())
	if err != nil {
		t.Fatalf("ListQuotaWindowSamples() error = %v", err)
	}
	if len(samples) != 1 {
		t.Fatalf("同一 5 分钟桶应只保留 1 条，得到 %d 条", len(samples))
	}
	if samples[0].RemainingPct == nil || *samples[0].RemainingPct != 80 {
		t.Fatalf("应保留桶内第一条样本，得到 %v", samples[0].RemainingPct)
	}

	third := newQuotaSnapshot(t, accountRef, base.Add(16*time.Minute), windowEntry("primary", 300, resetAt, 60))
	if err := store.ReplaceUsageSnapshot(ctx, third); err != nil {
		t.Fatalf("ReplaceUsageSnapshot(third) error = %v", err)
	}
	samples, err = store.ListQuotaWindowSamples(ctx, accountRef.String(), "rate_limit:primary", 300, 0, base.Add(24*time.Hour).UnixMilli())
	if err != nil {
		t.Fatalf("ListQuotaWindowSamples() error = %v", err)
	}
	if len(samples) != 2 {
		t.Fatalf("跨桶应新增一条，得到 %d 条", len(samples))
	}
}

func TestListQuotaWindowScopesGroupsByKeyAndWindow(t *testing.T) {
	store, accountRef := openUsageDocumentStore(t)
	ctx := context.Background()
	base := time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC)
	fiveHour := base.Add(5 * time.Hour)
	weekly := base.Add(7 * 24 * time.Hour)

	for index := 0; index < 3; index++ {
		capturedAt := base.Add(time.Duration(10+index*5) * time.Minute)
		snapshot := newQuotaSnapshot(t, accountRef, capturedAt,
			windowEntry("primary", 300, fiveHour, 80),
			windowEntry("secondary", 10080, weekly, 60),
		)
		if err := store.ReplaceUsageSnapshot(ctx, snapshot); err != nil {
			t.Fatalf("ReplaceUsageSnapshot() error = %v", err)
		}
	}

	scopes, err := store.ListQuotaWindowScopes(ctx, accountRef.String())
	if err != nil {
		t.Fatalf("ListQuotaWindowScopes() error = %v", err)
	}
	if len(scopes) != 2 {
		t.Fatalf("scope 数 = %d, want 2: %+v", len(scopes), scopes)
	}
	if scopes[0].WindowMinutes != 300 || scopes[0].SampleCount != 3 {
		t.Fatalf("5h scope = %+v", scopes[0])
	}
	if scopes[1].WindowMinutes != 10080 || scopes[1].SampleCount != 3 {
		t.Fatalf("7d scope = %+v", scopes[1])
	}
}

func TestQueryQuotaWindowUsageUsesHalfOpenWindows(t *testing.T) {
	store, accountRef := openUsageDocumentStore(t)
	ctx := context.Background()
	base := time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC)
	const hour = int64(60 * 60 * 1000)

	insertLedger := func(account string, occurredAtMS, totalTokens int64) {
		t.Helper()
		const statement = `
			INSERT INTO usage_ledger (
				account_ref, provider_id, model_id, session_id, occurred_at_ms,
				input_tokens, output_tokens, cached_input_tokens,
				cache_write_input_tokens, reasoning_tokens, total_tokens
			) VALUES (?, 'codex', 'gpt-5', '', ?, ?, 0, 0, 0, 0, ?)`
		if _, err := store.db.ExecContext(ctx, statement, account, occurredAtMS, totalTokens, totalTokens); err != nil {
			t.Fatalf("insert usage_ledger error = %v", err)
		}
	}
	insertLedger(accountRef.String(), base.UnixMilli(), 100)
	insertLedger(accountRef.String(), base.UnixMilli()+hour-1, 200)
	insertLedger(accountRef.String(), base.UnixMilli()+hour, 400)

	otherRef, err := accountcore.ParseAccountRef("acct_ffffffffffffffffffff")
	if err != nil {
		t.Fatalf("ParseAccountRef(other) error = %v", err)
	}
	otherAccount, err := accountcore.RestoreAccount(store.catalog, accountcore.RestoreAccountInput{
		Ref: otherRef, ProviderID: "codex", CLIAccountID: 2, Enabled: true,
		CreatedAt: base, UpdatedAt: base,
	})
	if err != nil {
		t.Fatalf("RestoreAccount(other) error = %v", err)
	}
	if err := store.Create(ctx, otherAccount); err != nil {
		t.Fatalf("Create(other) error = %v", err)
	}
	insertLedger(otherRef.String(), base.UnixMilli()+hour/2, 900)

	usages, err := store.QueryQuotaWindowUsage(ctx, accountRef.String(), []usagecore.QuotaWindowRange{
		{Index: 0, StartMS: base.UnixMilli(), EndMS: base.UnixMilli() + hour},
		{Index: 1, StartMS: base.UnixMilli() + hour, EndMS: base.UnixMilli() + 2*hour},
	})
	if err != nil {
		t.Fatalf("QueryQuotaWindowUsage() error = %v", err)
	}
	if len(usages) != 2 {
		t.Fatalf("窗口用量行数 = %d, want 2: %+v", len(usages), usages)
	}
	if usages[0].Tokens != 300 || usages[0].RequestCount != 2 {
		t.Fatalf("窗口 0 = %+v, want 300 tokens / 2 requests", usages[0])
	}
	if usages[1].Tokens != 400 || usages[1].RequestCount != 1 {
		t.Fatalf("窗口 1 = %+v, want 400 tokens / 1 request（边界归后一个窗口）", usages[1])
	}
}

func TestQuotaWindowSamplesPruneByRetention(t *testing.T) {
	store, accountRef := openUsageDocumentStore(t)
	ctx := context.Background()
	now := time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC)
	old := now.Add(-time.Duration(QuotaWindowSampleRetentionMS) * time.Millisecond).Add(-time.Hour)
	resetAt := now.Add(5 * time.Hour)

	if err := store.ReplaceUsageSnapshot(ctx, newQuotaSnapshot(t, accountRef, old, windowEntry("primary", 300, resetAt, 50))); err != nil {
		t.Fatalf("ReplaceUsageSnapshot(old) error = %v", err)
	}
	if err := store.ReplaceUsageSnapshot(ctx, newQuotaSnapshot(t, accountRef, now, windowEntry("primary", 300, resetAt, 60))); err != nil {
		t.Fatalf("ReplaceUsageSnapshot(now) error = %v", err)
	}

	store.quotaPruneAtMS.Store(0)
	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatalf("BeginTx() error = %v", err)
	}
	if err := store.maybePruneQuotaWindowSamples(ctx, transaction, now.UnixMilli()); err != nil {
		t.Fatalf("maybePruneQuotaWindowSamples() error = %v", err)
	}
	if err := transaction.Commit(); err != nil {
		t.Fatalf("Commit() error = %v", err)
	}

	samples, err := store.ListQuotaWindowSamples(ctx, accountRef.String(), "", 300, 0, now.UnixMilli()+time.Hour.Milliseconds())
	if err != nil {
		t.Fatalf("ListQuotaWindowSamples() error = %v", err)
	}
	if len(samples) != 1 || samples[0].CapturedAtMS != now.UnixMilli() {
		t.Fatalf("保留期外的样本应被清理，剩余 %+v", samples)
	}
}

func TestQuotaWindowSamplesCascadeWithAccountDelete(t *testing.T) {
	store, accountRef := openUsageDocumentStore(t)
	ctx := context.Background()
	base := time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC)
	if err := store.ReplaceUsageSnapshot(ctx, newQuotaSnapshot(t, accountRef, base, windowEntry("primary", 300, base.Add(5*time.Hour), 70))); err != nil {
		t.Fatalf("ReplaceUsageSnapshot() error = %v", err)
	}
	if _, err := store.db.ExecContext(ctx, "DELETE FROM accounts WHERE account_ref = ?", accountRef.String()); err != nil {
		t.Fatalf("delete account error = %v", err)
	}
	samples, err := store.ListQuotaWindowSamples(ctx, accountRef.String(), "", 300, 0, base.Add(24*time.Hour).UnixMilli())
	if err != nil {
		t.Fatalf("ListQuotaWindowSamples() error = %v", err)
	}
	if len(samples) != 0 {
		t.Fatalf("账号删除后样本应级联删除，剩余 %d 条", len(samples))
	}
}

func TestReplaceUsageSnapshotRecordsPlanType(t *testing.T) {
	store, accountRef := openUsageDocumentStore(t)
	ctx := context.Background()
	base := time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC)
	resetAt := base.Add(5 * time.Hour)
	snapshot, err := usagecore.NewSnapshot(usagecore.SnapshotInput{
		AccountRef: accountRef,
		ProviderID: "codex",
		Source:     "codex_read_rate_limits",
		PlanType:   "pro",
		CapturedAt: base.Add(10 * time.Minute),
		Entries:    []usagecore.EntryInput{windowEntry("primary", 300, resetAt, 80)},
	})
	if err != nil {
		t.Fatalf("NewSnapshot() error = %v", err)
	}
	if err := store.ReplaceUsageSnapshot(ctx, snapshot); err != nil {
		t.Fatalf("ReplaceUsageSnapshot() error = %v", err)
	}

	loaded, err := store.GetUsageSnapshot(ctx, accountRef)
	if err != nil {
		t.Fatalf("GetUsageSnapshot() error = %v", err)
	}
	if loaded.PlanType() != "pro" {
		t.Fatalf("snapshot plan type = %q, want pro", loaded.PlanType())
	}

	samples, err := store.ListQuotaWindowSamples(
		ctx,
		accountRef.String(),
		"",
		300,
		0,
		base.Add(24*time.Hour).UnixMilli(),
	)
	if err != nil {
		t.Fatalf("ListQuotaWindowSamples() error = %v", err)
	}
	if len(samples) != 1 {
		t.Fatalf("样本数 = %d, want 1", len(samples))
	}
	if samples[0].PlanType != "pro" {
		t.Fatalf("sample plan type = %q, want pro", samples[0].PlanType)
	}
}

// 窗口用量必须保留「按 Provider + 模型」的明细：成本只能按模型单价算，
// 只有总额就无法定价。
func TestQueryQuotaWindowUsageKeepsModelBreakdown(t *testing.T) {
	store, accountRef := openUsageDocumentStore(t)
	ctx := context.Background()
	base := time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC)
	const hour = int64(60 * 60 * 1000)

	insert := func(provider, model string, occurredAtMS int64, input, output, cached, cacheWrite, reasoning, total int64) {
		t.Helper()
		const statement = `
			INSERT INTO usage_ledger (
				account_ref, provider_id, model_id, session_id, occurred_at_ms,
				input_tokens, output_tokens, cached_input_tokens,
				cache_write_input_tokens, reasoning_tokens, total_tokens
			) VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?)`
		if _, err := store.db.ExecContext(
			ctx, statement, accountRef.String(), provider, model, occurredAtMS,
			input, output, cached, cacheWrite, reasoning, total,
		); err != nil {
			t.Fatalf("insert usage_ledger error = %v", err)
		}
	}
	// 账本有 CHECK(total_tokens = input_tokens + output_tokens)，缓存与推理明细不计入该式。
	insert("codex", "gpt-5.1", base.UnixMilli(), 100, 50, 10, 5, 0, 150)
	insert("codex", "gpt-5.1", base.UnixMilli()+1000, 20, 10, 0, 0, 0, 30)
	insert("claude", "claude-sonnet-4-5", base.UnixMilli()+2000, 7, 3, 1, 0, 2, 10)

	usages, err := store.QueryQuotaWindowUsage(ctx, accountRef.String(), []usagecore.QuotaWindowRange{
		{Index: 0, StartMS: base.UnixMilli(), EndMS: base.UnixMilli() + hour},
	})
	if err != nil {
		t.Fatalf("QueryQuotaWindowUsage() error = %v", err)
	}
	if len(usages) != 1 {
		t.Fatalf("窗口数 = %d, want 1", len(usages))
	}
	usage := usages[0]
	if usage.Tokens != 190 || usage.RequestCount != 3 {
		t.Fatalf("窗口汇总 = %+v, want 190 tokens / 3 requests", usage)
	}
	if len(usage.Models) != 2 {
		t.Fatalf("模型明细 = %d 条, want 2: %+v", len(usage.Models), usage.Models)
	}
	byModel := map[string]usagecore.QuotaWindowModelUsage{}
	for _, model := range usage.Models {
		byModel[model.Provider+"/"+model.Model] = model
	}
	codex, ok := byModel["codex/gpt-5.1"]
	if !ok {
		t.Fatalf("缺少 codex 明细: %+v", usage.Models)
	}
	if codex.InputTokens != 120 || codex.OutputTokens != 60 ||
		codex.CacheReadInputTokens != 10 || codex.CacheCreationInputTokens != 5 ||
		codex.Tokens != 180 || codex.RequestCount != 2 {
		t.Fatalf("codex 明细 = %+v", codex)
	}
	claude, ok := byModel["claude/claude-sonnet-4-5"]
	if !ok {
		t.Fatalf("缺少 claude 明细: %+v", usage.Models)
	}
	if claude.ReasoningOutputTokens != 2 || claude.Tokens != 10 {
		t.Fatalf("claude 明细 = %+v", claude)
	}
}

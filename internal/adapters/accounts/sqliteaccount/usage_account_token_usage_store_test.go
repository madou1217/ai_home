package sqliteaccount

import (
	"context"
	"testing"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/core/usageledger"
)

// TestQueryAccountTokenUsageSplitsDayWeekMonthAtUTCBoundaries 用真实的边界秒验证
// 「今天 / 本周一 / 本月 1 日」三个起点，并确认别的账号的记录不会被算进来。
func TestQueryAccountTokenUsageSplitsDayWeekMonthAtUTCBoundaries(t *testing.T) {
	ctx := context.Background()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	store, err := Open(ctx, OpenOptions{AIHomeDir: t.TempDir(), Catalog: catalog})
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer store.Close()

	refA, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	refB, err := accountcore.ParseAccountRef("acct_abcdef0123456789abcd")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	for index, ref := range []accountcore.AccountRef{refA, refB} {
		account, accountErr := accountcore.RestoreAccount(catalog, accountcore.RestoreAccountInput{
			Ref: ref, ProviderID: "codex", CLIAccountID: accountcore.CLIAccountID(index + 1), Enabled: true,
			CreatedAt: time.UnixMilli(100).UTC(), UpdatedAt: time.UnixMilli(100).UTC(),
		})
		if accountErr != nil {
			t.Fatalf("RestoreAccount() error = %v", accountErr)
		}
		if createErr := store.Create(ctx, account); createErr != nil {
			t.Fatalf("Create() error = %v", createErr)
		}
	}
	appendUsage := func(ref accountcore.AccountRef, model string, occurredAt time.Time, tokens uint64) {
		usage, usageErr := inference.NewUsage(inference.UsageInput{InputTokens: tokens})
		if usageErr != nil {
			t.Fatalf("NewUsage() error = %v", usageErr)
		}
		record, recordErr := usageledger.NewRecord(usageledger.RecordInput{
			AccountRef: ref, Provider: "codex", Model: model,
			OccurredAt: occurredAt.UTC(), Usage: usage,
		})
		if recordErr != nil {
			t.Fatalf("NewRecord() error = %v", recordErr)
		}
		if appendErr := store.AppendUsageRecord(ctx, record); appendErr != nil {
			t.Fatalf("AppendUsageRecord() error = %v", appendErr)
		}
	}
	// 锚点选 2026-11-06（周五）12:00 UTC：
	// 本月 1 日 = 2026-11-01 00:00，本周一 = 2026-11-02 00:00，今天 = 2026-11-06 00:00。
	appendUsage(refA, "m-oct", time.Date(2026, 10, 31, 23, 59, 59, 0, time.UTC), 10)
	appendUsage(refA, "m-month", time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC), 10)
	appendUsage(refA, "m-week", time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC), 10)
	appendUsage(refA, "m-day", time.Date(2026, 11, 6, 0, 0, 0, 0, time.UTC), 10)
	// 同一时刻的别的账号：必须被 Query.AccountRef 的 SQL 过滤掉。
	appendUsage(refB, "m-other", time.Date(2026, 11, 6, 1, 0, 0, 0, time.UTC), 99)

	anchor := time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC)
	usage, err := store.QueryAccountTokenUsage(ctx, usageledger.Query{
		From: time.UnixMilli(0).UTC(), To: anchor, AccountRef: refA,
	})
	if err != nil {
		t.Fatalf("QueryAccountTokenUsage() error = %v", err)
	}
	if usage.Day != 10 || usage.Week != 20 || usage.Month != 30 || usage.Total != 40 {
		t.Fatalf("usage = %#v, want day=10 week=20 month=30 total=40", usage)
	}
	if len(usage.Models) != 4 {
		t.Fatalf("models = %#v, want 4", usage.Models)
	}
	// 排序与 Node 一致：滚动权重（day+week+month）降序，权重相同再比 total。
	wantOrder := []string{"m-day", "m-week", "m-month", "m-oct"}
	for index, want := range wantOrder {
		if usage.Models[index].Model != want {
			t.Fatalf("models[%d] = %q, want %q (all = %#v)", index, usage.Models[index].Model, want, usage.Models)
		}
	}
	if usage.Models[0].Day != 10 || usage.Models[0].Week != 10 || usage.Models[0].Month != 10 || usage.Models[0].Total != 10 {
		t.Fatalf("m-day = %#v", usage.Models[0])
	}

	// from 也裁掉 total：只统计本周一之后的记录时，10 月那条不再计入累计。
	clipped, err := store.QueryAccountTokenUsage(ctx, usageledger.Query{
		From: time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC), To: anchor, AccountRef: refA,
	})
	if err != nil {
		t.Fatalf("QueryAccountTokenUsage(clipped) error = %v", err)
	}
	if clipped.Day != 10 || clipped.Week != 20 || clipped.Month != 20 || clipped.Total != 20 {
		t.Fatalf("clipped = %#v, want day=10 week=20 month=20 total=20", clipped)
	}
	if len(clipped.Models) != 2 {
		t.Fatalf("clipped models = %#v, want 2", clipped.Models)
	}
}

func TestQueryAccountTokenUsageRequiresAccountRef(t *testing.T) {
	ctx := context.Background()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	store, err := Open(ctx, OpenOptions{AIHomeDir: t.TempDir(), Catalog: catalog})
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer store.Close()
	_, err = store.QueryAccountTokenUsage(ctx, usageledger.Query{
		From: time.UnixMilli(0).UTC(), To: time.Now().UTC(),
	})
	if err != usageledger.ErrInvalidQuery {
		t.Fatalf("error = %v, want ErrInvalidQuery", err)
	}
}

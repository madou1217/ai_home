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

func TestUsageLedgerPersistsAndQueriesStatsAcrossReopen(t *testing.T) {
	ctx := context.Background()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	tempDir := t.TempDir()
	store, err := Open(ctx, OpenOptions{AIHomeDir: tempDir, Catalog: catalog})
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	accountRef, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	account, err := accountcore.RestoreAccount(catalog, accountcore.RestoreAccountInput{
		Ref: accountRef, ProviderID: "codex", CLIAccountID: 1, Enabled: true,
		CreatedAt: time.UnixMilli(100).UTC(), UpdatedAt: time.UnixMilli(100).UTC(),
	})
	if err != nil {
		t.Fatalf("RestoreAccount() error = %v", err)
	}
	if err := store.Create(ctx, account); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	first, _ := inference.NewUsage(inference.UsageInput{InputTokens: 10, OutputTokens: 5})
	second, _ := inference.NewUsage(inference.UsageInput{InputTokens: 7, OutputTokens: 3, CachedInputTokens: 2})
	for _, input := range []usageledger.RecordInput{
		{AccountRef: accountRef, Provider: "codex", Model: "gpt-6.1-sol", SessionID: "s1", OccurredAt: time.UnixMilli(1000).UTC(), Usage: first},
		{AccountRef: accountRef, Provider: "codex", Model: "gpt-6.1-sol", SessionID: "s1", OccurredAt: time.UnixMilli(2000).UTC(), Usage: second},
	} {
		record, recordErr := usageledger.NewRecord(input)
		if recordErr != nil {
			t.Fatalf("NewRecord() error = %v", recordErr)
		}
		if err := store.AppendUsageRecord(ctx, record); err != nil {
			t.Fatalf("AppendUsageRecord() error = %v", err)
		}
	}
	if err := store.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	store, err = Open(ctx, OpenOptions{AIHomeDir: tempDir, Catalog: catalog})
	if err != nil {
		t.Fatalf("reopen error = %v", err)
	}
	defer store.Close()
	stats, err := store.QueryUsageStats(ctx, usageledger.Query{
		From: time.UnixMilli(0).UTC(), To: time.UnixMilli(1500).UTC(), Provider: "codex",
	})
	if err != nil {
		t.Fatalf("QueryUsageStats() error = %v", err)
	}
	if stats.TotalCalls != 1 || stats.TotalSessions != 1 || stats.InputTokens != 10 || stats.OutputTokens != 5 || stats.TotalTokens != 15 {
		t.Fatalf("stats = %#v", stats)
	}
	models, err := store.QueryUsageModels(ctx, usageledger.Query{From: time.UnixMilli(0).UTC(), To: time.UnixMilli(3000).UTC()})
	if err != nil {
		t.Fatalf("QueryUsageModels() error = %v", err)
	}
	if len(models) != 1 || models[0].Calls != 2 || models[0].AccountCount != 1 || models[0].TotalTokens != 25 {
		t.Fatalf("models = %#v", models)
	}
}

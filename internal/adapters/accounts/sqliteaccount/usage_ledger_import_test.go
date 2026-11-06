package sqliteaccount

import (
	"context"
	"testing"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/core/usageledger"
)

func openUsageLedgerStore(t *testing.T) (*Store, accountcore.AccountRef) {
	t.Helper()
	ctx := context.Background()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	store, err := Open(ctx, OpenOptions{AIHomeDir: t.TempDir(), Catalog: catalog})
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
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
	return store, accountRef
}

// 导入必须按 source_key 幂等：脚本重跑一次不能把历史用量翻倍。
func TestImportUsageEventsIsIdempotent(t *testing.T) {
	ctx := context.Background()
	store, accountRef := openUsageLedgerStore(t)
	events := []usageledger.ImportEvent{
		{
			SourceKey: "node:event-1", AccountRef: accountRef, Provider: "codex",
			Model: "gpt-6.1-sol", OccurredAt: time.UnixMilli(1793948000000).UTC(),
			InputTokens: 10, OutputTokens: 5, CachedInputTokens: 2,
			CacheWriteInputTokens: 1, ReasoningTokens: 2, TotalTokens: 15,
		},
		{
			SourceKey: "node:event-2", AccountRef: accountRef, Provider: "codex",
			Model: "gpt-6.1-sol", OccurredAt: time.UnixMilli(1793948060000).UTC(),
			InputTokens: 7, OutputTokens: 3, TotalTokens: 10,
		},
	}
	imported, skipped, err := store.ImportUsageEvents(ctx, events)
	if err != nil || imported != 2 || skipped != 0 {
		t.Fatalf("首次导入 imported=%d skipped=%d err=%v", imported, skipped, err)
	}
	imported, skipped, err = store.ImportUsageEvents(ctx, events)
	if err != nil || imported != 0 || skipped != 2 {
		t.Fatalf("重跑应全部跳过 imported=%d skipped=%d err=%v", imported, skipped, err)
	}
}

// 坏行（token 不变量不成立 / 未知账号）只跳过自己，不能让整批失败。
func TestImportUsageEventsSkipsInvalidRows(t *testing.T) {
	ctx := context.Background()
	store, accountRef := openUsageLedgerStore(t)
	unknownRef, err := accountcore.ParseAccountRef("acct_ffffffffffffffffffff")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	events := []usageledger.ImportEvent{
		{
			SourceKey: "node:bad-total", AccountRef: accountRef, Provider: "codex",
			Model: "gpt-6.1-sol", OccurredAt: time.UnixMilli(1793948000000).UTC(),
			InputTokens: 10, OutputTokens: 5, TotalTokens: 99,
		},
		{
			SourceKey: "node:unknown-account", AccountRef: unknownRef, Provider: "codex",
			Model: "gpt-6.1-sol", OccurredAt: time.UnixMilli(1793948000000).UTC(),
			InputTokens: 10, OutputTokens: 5, TotalTokens: 15,
		},
		{
			SourceKey: "node:good", AccountRef: accountRef, Provider: "codex",
			Model: "gpt-6.1-sol", OccurredAt: time.UnixMilli(1793948000000).UTC(),
			InputTokens: 10, OutputTokens: 5, TotalTokens: 15,
		},
	}
	imported, skipped, err := store.ImportUsageEvents(ctx, events)
	if err != nil || imported != 1 || skipped != 2 {
		t.Fatalf("imported=%d skipped=%d err=%v", imported, skipped, err)
	}
}

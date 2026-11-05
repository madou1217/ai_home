package aihserver

import (
	"context"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountusagefeed"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/core/usageledger"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
)

// 透传用量必须真的落进 usage_ledger：这条链路是 WebUI 用量/额度页从 Node 切到 Go
// 的唯一前置条件。只测到「解析出 usage」不够——记录构造、账号身份校验、SQL 写入
// 任何一环断了，页面都会显示「Go 承接的请求没有用量」。
func TestRecordAttemptUsageWritesLedgerRow(t *testing.T) {
	ctx := context.Background()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	store, err := sqliteaccount.Open(ctx, sqliteaccount.OpenOptions{
		AIHomeDir: t.TempDir(),
		Catalog:   catalog,
	})
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	ref, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	// 账本查询要求 UTC 且 To 不早于 From；用真实当前时间，别写死日期。
	createdAt := time.Now().UTC().Truncate(time.Second).Add(-time.Hour)
	account, err := accountcore.RestoreAccount(catalog, accountcore.RestoreAccountInput{
		Ref: ref, ProviderID: "codex", CLIAccountID: 1,
		Enabled: true, CreatedAt: createdAt, UpdatedAt: createdAt,
	})
	if err != nil {
		t.Fatalf("RestoreAccount() error = %v", err)
	}
	if err := store.Create(ctx, account); err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	route, err := runtimecore.NewModelRoute(ref, "gpt-5.1")
	if err != nil {
		t.Fatalf("NewModelRoute() error = %v", err)
	}
	usage, err := inference.NewUsage(inference.UsageInput{
		InputTokens:       1200,
		OutputTokens:      340,
		CachedInputTokens: 200,
		ReasoningTokens:   40,
	})
	if err != nil {
		t.Fatalf("NewUsage() error = %v", err)
	}

	runtime := outcomeRecordingRuntime{
		usage:       accountusagefeed.NewFeed(accountusagefeed.DefaultCapacity, time.Now()),
		usageLedger: store,
		accounts:    store,
	}
	if err := runtime.RecordAttemptUsage(ctx, route, usage); err != nil {
		t.Fatalf("RecordAttemptUsage() error = %v", err)
	}

	from := createdAt.Add(-time.Hour)
	to := time.Now().UTC().Add(time.Hour)
	models, err := store.QueryUsageModels(ctx, usageledger.Query{From: from, To: to})
	if err != nil {
		t.Fatalf("QueryUsageModels() error = %v", err)
	}
	if len(models) != 1 {
		t.Fatalf("账本行数 = %d, want 1: %+v", len(models), models)
	}
	row := models[0]
	if row.Provider != "codex" || row.Model != "gpt-5.1" {
		t.Fatalf("账本归属 = %s/%s, want codex/gpt-5.1", row.Provider, row.Model)
	}
	if row.InputTokens != 1200 || row.OutputTokens != 340 ||
		row.CacheReadInputTokens != 200 || row.ReasoningOutputTokens != 40 {
		t.Fatalf("账本 token 明细 = %+v", row)
	}
	if row.Calls != 1 {
		t.Fatalf("调用次数 = %d, want 1", row.Calls)
	}
}

// 无效用量不该写账本，避免把 0 token 的「成功」灌进统计。
func TestRecordAttemptUsageIgnoresEmptyUsage(t *testing.T) {
	runtime := outcomeRecordingRuntime{
		usage: accountusagefeed.NewFeed(accountusagefeed.DefaultCapacity, time.Now()),
	}
	ref, _ := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	route, _ := runtimecore.NewModelRoute(ref, "gpt-5.1")
	usage, _ := inference.NewUsage(inference.UsageInput{})
	if err := runtime.RecordAttemptUsage(context.Background(), route, usage); err != nil {
		t.Fatalf("RecordAttemptUsage() error = %v", err)
	}
}

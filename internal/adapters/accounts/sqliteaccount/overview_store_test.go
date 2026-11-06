package sqliteaccount

import (
	"context"
	"testing"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
)

func openOverviewStore(t *testing.T) (*Store, accountcore.AccountRef) {
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

// 账号行需要的「默认账号 + 额度物化状态」必须由一次查询给出，
// 调用方不该再直读 Go 的 sqlite（切片 C 的字段翻转靠这条保证）。
func TestGetAccountOverviewCarriesQuotaStateAndDefault(t *testing.T) {
	ctx := context.Background()
	store, accountRef := openOverviewStore(t)

	capturedAtMS := int64(1793937685487)
	if _, err := store.db.ExecContext(ctx, `
		INSERT INTO account_usage_snapshots (
			account_ref, provider_id, kind, source, captured_at_ms, payload_json,
			quota_status, quota_reason, remaining_bps, has_numeric_remaining
		) VALUES (?, 'codex', '', '', ?, '{}', 'exhausted', '', 0, 1)`,
		accountRef.String(), capturedAtMS,
	); err != nil {
		t.Fatalf("insert snapshot error = %v", err)
	}
	if _, err := store.db.ExecContext(ctx, `
		INSERT INTO account_defaults (provider_id, account_ref, updated_at_ms)
		VALUES ('codex', ?, 100)`, accountRef.String(),
	); err != nil {
		t.Fatalf("insert default error = %v", err)
	}

	overview, err := store.GetAccountOverview(ctx, accountRef)
	if err != nil {
		t.Fatalf("GetAccountOverview() error = %v", err)
	}
	if !overview.IsDefault() {
		t.Fatal("默认账号未被识别")
	}
	state, found := overview.QuotaState()
	if !found {
		t.Fatal("额度状态缺失")
	}
	if state.Status() != "exhausted" || !state.HasNumericRemaining() || state.RemainingBPS() != 0 {
		t.Fatalf("额度状态不符: %+v", state)
	}
	if !state.CapturedAt().Equal(time.UnixMilli(capturedAtMS).UTC()) {
		t.Fatalf("采集时间不符: %v", state.CapturedAt())
	}
}

func TestGetAccountOverviewWithoutQuotaState(t *testing.T) {
	ctx := context.Background()
	store, accountRef := openOverviewStore(t)
	overview, err := store.GetAccountOverview(ctx, accountRef)
	if err != nil {
		t.Fatalf("GetAccountOverview() error = %v", err)
	}
	if overview.IsDefault() {
		t.Fatal("没有 account_defaults 行却判定为默认账号")
	}
	if _, found := overview.QuotaState(); found {
		t.Fatal("没有快照却给出额度状态")
	}
}

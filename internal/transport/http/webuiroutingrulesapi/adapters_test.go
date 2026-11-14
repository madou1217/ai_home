package webuiroutingrulesapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	_ "modernc.org/sqlite"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/adapters/appstate/rulesenv"
)

const ledgerRef = "acct_0123456789abcdef0456"

func mustCatalog(t *testing.T) *providers.Catalog {
	t.Helper()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	return catalog
}

func mustLocalAccount(t *testing.T, providerID string) accountcore.Account {
	t.Helper()
	reference, err := accountcore.ParseAccountRef(ledgerRef)
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	alias, err := accountcore.NewCLIAccountID(7)
	if err != nil {
		t.Fatalf("NewCLIAccountID() error = %v", err)
	}
	account, err := accountcore.RestoreAccount(mustCatalog(t), accountcore.RestoreAccountInput{
		Ref:          reference,
		ProviderID:   providerID,
		CLIAccountID: alias,
		Enabled:      true,
		CreatedAt:    time.UnixMilli(1700000000000).UTC(),
		UpdatedAt:    time.UnixMilli(1700000000001).UTC(),
	})
	if err != nil {
		t.Fatalf("RestoreAccount() error = %v", err)
	}
	return account
}

// newAppStateRoot 建立 app-state.db 的最小 schema；accountRef 为空时不写 account_refs。
func newAppStateRoot(t *testing.T, accountRef, provider string) string {
	t.Helper()
	root := t.TempDir()
	db, err := sql.Open("sqlite", filepath.Join(root, appstate.DatabaseFileName))
	if err != nil {
		t.Fatalf("open app-state: %v", err)
	}
	defer func() { _ = db.Close() }()
	statements := []string{
		"CREATE TABLE account_refs (account_ref TEXT PRIMARY KEY, provider TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
		"CREATE TABLE account_credentials (account_ref TEXT PRIMARY KEY, env_json TEXT NOT NULL DEFAULT '{}', native_auth_json TEXT NOT NULL DEFAULT '{}', env_updated_at INTEGER NOT NULL DEFAULT 0, native_auth_updated_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)",
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatalf("create table: %v", err)
		}
	}
	if accountRef != "" {
		if _, err := db.Exec("INSERT INTO account_refs VALUES (?, ?, 1, 1)", accountRef, provider); err != nil {
			t.Fatalf("insert account_refs: %v", err)
		}
	}
	return root
}

func seedCredentialRow(t *testing.T, database *sql.DB, accountRef string) {
	t.Helper()
	if _, err := database.Exec(
		"INSERT INTO account_credentials (account_ref, env_json, native_auth_json, env_updated_at, native_auth_updated_at, updated_at) VALUES (?, '{}', '{}', 0, 0, 1)",
		accountRef,
	); err != nil {
		t.Fatalf("insert account_credentials: %v", err)
	}
}

type fakeLedger struct {
	account accountcore.Account
	err     error
	calls   int
	seen    accountcore.AccountRef
}

func (ledger *fakeLedger) GetByRef(
	_ context.Context,
	accountRef accountcore.AccountRef,
) (accountcore.Account, error) {
	ledger.calls++
	ledger.seen = accountRef
	if ledger.err != nil {
		return accountcore.Account{}, ledger.err
	}
	return ledger.account, nil
}

func TestOpenAdaptersCreatesWritableStore(t *testing.T) {
	root := newAppStateRoot(t, ledgerRef, "claude")
	seedDatabase, err := sql.Open("sqlite", filepath.Join(root, appstate.DatabaseFileName))
	if err != nil {
		t.Fatalf("open seed connection: %v", err)
	}
	seedCredentialRow(t, seedDatabase, ledgerRef)
	_ = seedDatabase.Close()

	adapters, err := OpenAdapters(context.Background(), root, nil)
	if err != nil {
		t.Fatalf("OpenAdapters() error = %v", err)
	}
	t.Cleanup(func() { _ = adapters.Close() })
	if adapters.Store == nil || adapters.Accounts == nil {
		t.Fatalf("adapters = %+v, want store and resolver", adapters)
	}
	result, err := adapters.Store.Update(context.Background(), ledgerRef, rulesenv.Change{
		Rules:    []json.RawMessage{json.RawMessage(`{"kind":"rate_limited"}`)},
		GroupIDs: []string{"group-a"},
	})
	if err != nil {
		t.Fatalf("Update() error = %v", err)
	}
	if !result.Changed {
		t.Fatalf("Update() changed = false")
	}
	state, err := adapters.Store.Read(context.Background(), ledgerRef)
	if err != nil {
		t.Fatalf("Read() error = %v", err)
	}
	if len(state.Rules) != 1 || len(state.GroupIDs) != 1 {
		t.Fatalf("state = %+v", state)
	}
	if err := adapters.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
}

func TestOpenAdaptersRejectsEmptyRoot(t *testing.T) {
	adapters, err := OpenAdapters(context.Background(), "  ", nil)
	if !errors.Is(err, appstate.ErrInvalidRoot) {
		t.Fatalf("OpenAdapters() error = %v, want ErrInvalidRoot", err)
	}
	if adapters != nil {
		t.Fatalf("adapters = %+v, want nil", adapters)
	}
}

func TestLedgerResolverPrefersGoLedger(t *testing.T) {
	root := newAppStateRoot(t, ledgerRef, "claude")
	ledger := &fakeLedger{account: mustLocalAccount(t, "codex")}
	resolver := LedgerResolver{DatabasePath: filepath.Join(root, appstate.DatabaseFileName), Ledger: ledger}

	provider, found, err := resolver.ProviderOf(context.Background(), ledgerRef)
	if err != nil || !found || provider != "codex" {
		t.Fatalf("ProviderOf() = %q, %v, %v; want codex, true, nil", provider, found, err)
	}
	if ledger.calls != 1 {
		t.Fatalf("ledger calls = %d, want 1", ledger.calls)
	}
}

func TestLedgerResolverFallsBackToGoLedger(t *testing.T) {
	root := newAppStateRoot(t, "", "")
	ledger := &fakeLedger{account: mustLocalAccount(t, "codex")}
	resolver := LedgerResolver{DatabasePath: filepath.Join(root, appstate.DatabaseFileName), Ledger: ledger}

	provider, found, err := resolver.ProviderOf(context.Background(), ledgerRef)
	if err != nil || !found || provider != "codex" {
		t.Fatalf("ProviderOf() = %q, %v, %v; want codex, true, nil", provider, found, err)
	}
	if ledger.calls != 1 || ledger.seen.String() != ledgerRef {
		t.Fatalf("ledger calls = %d, seen = %q", ledger.calls, ledger.seen)
	}
}

func TestLedgerResolverTreatsNonCanonicalRefAsMissing(t *testing.T) {
	root := newAppStateRoot(t, "", "")
	ledger := &fakeLedger{account: mustLocalAccount(t, "codex")}
	resolver := LedgerResolver{DatabasePath: filepath.Join(root, appstate.DatabaseFileName), Ledger: ledger}

	if provider, found, err := resolver.ProviderOf(context.Background(), "acct_missing"); err != nil || found || provider != "" {
		t.Fatalf("ProviderOf() = %q, %v, %v; want empty, false, nil", provider, found, err)
	}
	if ledger.calls != 0 {
		t.Fatalf("ledger calls = %d, want 0", ledger.calls)
	}
}

func TestLedgerResolverReturnsMissingWhenGoLedgerMisses(t *testing.T) {
	root := newAppStateRoot(t, "", "")
	ledger := &fakeLedger{err: accountapp.ErrAccountNotFound}
	resolver := LedgerResolver{DatabasePath: filepath.Join(root, appstate.DatabaseFileName), Ledger: ledger}

	if provider, found, err := resolver.ProviderOf(context.Background(), ledgerRef); err != nil || found || provider != "" {
		t.Fatalf("ProviderOf() = %q, %v, %v; want empty, false, nil", provider, found, err)
	}
}

func TestLedgerResolverPropagatesAppStateError(t *testing.T) {
	root := t.TempDir()
	databasePath := filepath.Join(root, appstate.DatabaseFileName)
	if err := os.WriteFile(databasePath, []byte("not a sqlite database"), 0o600); err != nil {
		t.Fatalf("write invalid app-state.db: %v", err)
	}
	// Go 台账未命中后才会查询 app-state，错误必须原样向上传播。
	ledger := &fakeLedger{err: accountapp.ErrAccountNotFound}
	resolver := LedgerResolver{DatabasePath: databasePath, Ledger: ledger}

	if _, _, err := resolver.ProviderOf(context.Background(), ledgerRef); err == nil {
		t.Fatal("ProviderOf() error = nil, want app-state error")
	}
	if ledger.calls != 1 {
		t.Fatalf("ledger calls = %d, want 1", ledger.calls)
	}
}

func TestLedgerResolverPropagatesGoLedgerError(t *testing.T) {
	root := newAppStateRoot(t, "", "")
	ledger := &fakeLedger{err: errors.New("ledger boom")}
	resolver := LedgerResolver{DatabasePath: filepath.Join(root, appstate.DatabaseFileName), Ledger: ledger}

	if _, _, err := resolver.ProviderOf(context.Background(), ledgerRef); err == nil || err.Error() != "ledger boom" {
		t.Fatalf("ProviderOf() error = %v, want ledger boom", err)
	}
}

func TestLedgerResolverWithoutGoLedger(t *testing.T) {
	root := newAppStateRoot(t, "", "")
	resolver := LedgerResolver{DatabasePath: filepath.Join(root, appstate.DatabaseFileName)}

	if provider, found, err := resolver.ProviderOf(context.Background(), ledgerRef); err != nil || found || provider != "" {
		t.Fatalf("ProviderOf() = %q, %v, %v; want empty, false, nil", provider, found, err)
	}
}

func TestLedgerResolverUsesRealSQLiteAccountStore(t *testing.T) {
	directory := t.TempDir()
	store, err := sqliteaccount.Open(context.Background(), sqliteaccount.OpenOptions{
		AIHomeDir: directory,
		Catalog:   mustCatalog(t),
	})
	if err != nil {
		t.Fatalf("sqliteaccount.Open() error = %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	database, err := sql.Open("sqlite", "file:"+filepath.Join(directory, sqliteaccount.DatabaseFileName)+"?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatalf("open aih.db: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if _, err := database.Exec(
		"INSERT INTO accounts (account_ref, provider_id, cli_account_id, enabled, created_at_ms, updated_at_ms) VALUES (?, 'codex', 3, 1, 1, 1)",
		ledgerRef,
	); err != nil {
		t.Fatalf("insert accounts: %v", err)
	}

	root := newAppStateRoot(t, "", "")
	resolver := LedgerResolver{
		DatabasePath: filepath.Join(root, appstate.DatabaseFileName),
		Ledger:       store,
	}
	provider, found, err := resolver.ProviderOf(context.Background(), ledgerRef)
	if err != nil || !found || provider != "codex" {
		t.Fatalf("ProviderOf() = %q, %v, %v; want codex, true, nil", provider, found, err)
	}
	if provider, found, err := resolver.ProviderOf(context.Background(), "acct_ffffffffffffffffffff"); err != nil || found || provider != "" {
		t.Fatalf("missing ProviderOf() = %q, %v, %v", provider, found, err)
	}
}

func TestAdaptersCloseNilSafe(t *testing.T) {
	var adapters *Adapters
	if err := adapters.Close(); err != nil {
		t.Fatalf("nil Close() error = %v", err)
	}
	if err := (&Adapters{}).Close(); err != nil {
		t.Fatalf("empty Close() error = %v", err)
	}
}

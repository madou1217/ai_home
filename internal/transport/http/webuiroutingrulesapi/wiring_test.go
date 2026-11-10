package webuiroutingrulesapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"

	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/adapters/appstate/rulesenv"
)

func storedEnvFor(t *testing.T, database *sql.DB, accountRef string) map[string]json.RawMessage {
	t.Helper()
	var raw string
	if err := database.QueryRow("SELECT env_json FROM account_credentials WHERE account_ref = ?", accountRef).Scan(&raw); err != nil {
		t.Fatalf("read env_json for %s: %v", accountRef, err)
	}
	env := map[string]json.RawMessage{}
	if err := json.Unmarshal([]byte(raw), &env); err != nil {
		t.Fatalf("decode env_json for %s: %v", accountRef, err)
	}
	return env
}

func newWiredHandler(t *testing.T, f *fixture, ledger AccountLedger) (*Handler, *Adapters) {
	t.Helper()
	adapters, err := OpenAdapters(context.Background(), filepath.Dir(f.path), ledger)
	if err != nil {
		t.Fatalf("OpenAdapters() error = %v", err)
	}
	t.Cleanup(func() { _ = adapters.Close() })
	handler, err := NewHandler(Dependencies{
		Authorizer: allowAllAuthorizer{allow: true},
		Store:      adapters.Store,
		Accounts:   adapters.Accounts,
		Catalog:    f.catalog,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	return handler, adapters
}

func newGoLedger(t *testing.T, f *fixture, accountRef, provider string) *sqliteaccount.Store {
	t.Helper()
	directory := t.TempDir()
	store, err := sqliteaccount.Open(context.Background(), sqliteaccount.OpenOptions{
		AIHomeDir: directory,
		Catalog:   f.catalog,
	})
	if err != nil {
		t.Fatalf("sqliteaccount.Open() error = %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	database, err := sql.Open("sqlite", "file:"+filepath.Join(directory, sqliteaccount.DatabaseFileName)+"?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatalf("open aih.db: %v", err)
	}
	defer func() { _ = database.Close() }()
	if _, err := database.Exec(
		"INSERT INTO accounts (account_ref, provider_id, cli_account_id, enabled, created_at_ms, updated_at_ms) VALUES (?, ?, 3, 1, 1, 1)",
		accountRef, provider,
	); err != nil {
		t.Fatalf("insert accounts: %v", err)
	}
	return store
}

func TestHandlerWritesThroughAdapters(t *testing.T) {
	f := newFixture(t, `{"OTHER_KEY":"keep"}`)
	handler, _ := newWiredHandler(t, f, nil)
	body := mustJSON(t, map[string]any{
		"upstreamErrorRules":    []any{validRule()},
		"upstreamErrorGroupIds": []string{"group-a"},
	})
	recorder := f.post(t, handler, testProvider, testRef, body)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", recorder.Code, recorder.Body.String())
	}
	view := decodeView(t, recorder)
	if !view.OK || !view.Changed || view.Provider != testProvider {
		t.Fatalf("view = %+v", view)
	}
	env := f.storedEnv(t)
	if _, exists := env["OTHER_KEY"]; !exists {
		t.Fatalf("credential key dropped: %v", env)
	}
	if _, exists := env[rulesenv.RulesEnvKey]; !exists {
		t.Fatalf("rules key missing: %v", env)
	}
}

func TestHandlerAcceptsGoLedgerOnlyAccount(t *testing.T) {
	f := newFixture(t, `{}`)
	ledger := newGoLedger(t, f, ledgerRef, "codex")
	seedCredentialRow(t, f.db, ledgerRef)
	handler, _ := newWiredHandler(t, f, ledger)

	body := mustJSON(t, map[string]any{
		"upstreamErrorRules":    []any{validRule()},
		"upstreamErrorGroupIds": []string{"group-b"},
	})
	recorder := f.post(t, handler, "codex", ledgerRef, body)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", recorder.Code, recorder.Body.String())
	}
	view := decodeView(t, recorder)
	if !view.OK || view.Provider != "codex" || view.AccountRef != ledgerRef {
		t.Fatalf("view = %+v", view)
	}
	if env := storedEnvFor(t, f.db, ledgerRef); len(env) != 2 {
		t.Fatalf("env = %v, want rules and group ids", env)
	}
}

func TestHandlerRejectsProviderMismatchAgainstGoLedger(t *testing.T) {
	f := newFixture(t, `{}`)
	ledger := newGoLedger(t, f, ledgerRef, "claude")
	seedCredentialRow(t, f.db, ledgerRef)
	handler, _ := newWiredHandler(t, f, ledger)
	recorder := f.post(t, handler, "codex", ledgerRef, `{"upstreamErrorRules":[]}`)
	assertError(t, recorder, http.StatusNotFound, "account_not_found")
	if env := storedEnvFor(t, f.db, ledgerRef); len(env) != 0 {
		t.Fatalf("env = %v, want empty", env)
	}
}

func TestHandlerClearErrorBlockStays501ThroughAdapters(t *testing.T) {
	f := newFixture(t, `{"OTHER_KEY":"keep"}`)
	handler, _ := newWiredHandler(t, f, nil)
	body := mustJSON(t, map[string]any{
		"upstreamErrorRules":    []any{validRule()},
		"upstreamErrorGroupIds": []string{"group-a"},
		"clearErrorBlock":       true,
	})
	recorder := f.post(t, handler, testProvider, testRef, body)
	assertError(t, recorder, http.StatusNotImplemented, "runtime_block_clear_unavailable")
	env := f.storedEnv(t)
	if len(env) != 1 {
		t.Fatalf("env = %v, want only the seeded key", env)
	}
	if _, exists := env[rulesenv.RulesEnvKey]; exists {
		t.Fatalf("rules were written despite rejected clearErrorBlock")
	}
}

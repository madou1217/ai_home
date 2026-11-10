package webuiroutingrulesapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"path/filepath"
	"testing"
	"time"

	_ "modernc.org/sqlite"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
	"github.com/madou1217/ai_home/internal/adapters/accountruntime/inmemory"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/adapters/appstate/rulesenv"
)

// 现成的运行态实现直接满足本包的清理端口，接线时不需要再包一层。
var _ RuntimeBlockClearer = (*inmemory.Runtime)(nil)

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
	return newWiredHandlerWithRuntime(t, f, ledger, nil)
}

func newWiredHandlerWithRuntime(
	t *testing.T,
	f *fixture,
	ledger AccountLedger,
	runtime RuntimeBlockClearer,
) (*Handler, *Adapters) {
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
		Runtime:    runtime,
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

// 未装配运行态端口的宿主仍然整次拒绝（不制造假成功）。
func TestHandlerClearErrorBlockWithoutRuntimeStays501(t *testing.T) {
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

// 接上真实的 inmemory 运行态后，clearErrorBlock 必须真的解除阻塞并写 env。
func TestHandlerClearErrorBlockClearsRealRuntime(t *testing.T) {
	ctx := context.Background()
	now := time.UnixMilli(1_800_000_000_000)
	f := newFixture(t, `{}`)
	f.seedAccount(t, canonicalRef, `{"OTHER_KEY":"keep"}`)
	accountRef, err := accountcore.ParseAccountRef(canonicalRef)
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	route, err := runtimecore.NewModelRoute(accountRef, "test-model")
	if err != nil {
		t.Fatalf("NewModelRoute() error = %v", err)
	}
	runtimeInstance, err := inmemory.New(func() time.Time { return now })
	if err != nil {
		t.Fatalf("inmemory.New() error = %v", err)
	}
	if err := runtimeInstance.ReplaceUsageProjection(
		ctx,
		accountRef,
		true,
		nil,
		usagecore.UnknownRemaining(),
	); err != nil {
		t.Fatalf("ReplaceUsageProjection() error = %v", err)
	}
	eligibility, err := runtimeInstance.CheckEligibility(ctx, route)
	if err != nil {
		t.Fatalf("CheckEligibility() error = %v", err)
	}
	if eligibility.Eligible() {
		t.Fatal("写请求前账号必须处于被阻塞状态")
	}

	handler, _ := newWiredHandlerWithRuntime(t, f, nil, runtimeInstance)
	body := mustJSON(t, map[string]any{
		"upstreamErrorRules":    []any{validRule()},
		"upstreamErrorGroupIds": []string{"group-a"},
		"clearErrorBlock":       true,
	})
	recorder := f.post(t, handler, testProvider, canonicalRef, body)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", recorder.Code, recorder.Body.String())
	}
	view := decodeView(t, recorder)
	if view.ClearEvidence != string(accountcore.StatusEventManualAdminClear) {
		t.Fatalf("clearEvidence = %q, want manual_admin_clear", view.ClearEvidence)
	}
	eligibility, err = runtimeInstance.CheckEligibility(ctx, route)
	if err != nil {
		t.Fatalf("CheckEligibility() after clear error = %v", err)
	}
	if !eligibility.Eligible() {
		t.Fatalf("clearErrorBlock 后必须重新可征召，实际 = %v", eligibility.Status())
	}
	env := storedEnvFor(t, f.db, canonicalRef)
	if _, exists := env[rulesenv.RulesEnvKey]; !exists {
		t.Fatalf("rules key missing: %v", env)
	}
}

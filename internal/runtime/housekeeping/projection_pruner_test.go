package housekeeping

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
)

type stubAccountsReader struct {
	accounts []RegisteredAccount
	err      error
}

func (s stubAccountsReader) ListRegisteredAccounts(context.Context) ([]RegisteredAccount, error) {
	if s.err != nil {
		return nil, s.err
	}
	return s.accounts, nil
}

type stubReconciler struct {
	failPaths map[string]error
	calls     []string
}

func (s *stubReconciler) Reconcile(_ context.Context, provider, accountRef, rootKind, projectionPath string) error {
	s.calls = append(s.calls, rootKind+":"+provider+":"+accountRef)
	if err, ok := s.failPaths[projectionPath]; ok {
		return err
	}
	return nil
}

func TestPruneStaleRuntimeProjectionsFailClosedOnReaderError(t *testing.T) {
	aiHome := t.TempDir()
	staleDir := filepath.Join(aiHome, "run", "auth-projections", "codex", "acct_0123456789abcdef0123")
	if err := os.MkdirAll(staleDir, 0o755); err != nil {
		t.Fatal(err)
	}
	rec := &stubReconciler{}
	_, err := PruneStaleRuntimeProjections(context.Background(), ProjectionPruneOptions{
		AIHomeDir:  aiHome,
		Accounts:   stubAccountsReader{err: errors.New("db corrupt")},
		Reconciler: rec,
	})
	if err == nil {
		t.Fatal("expected error on corrupt DB reader")
	}
	if _, statErr := os.Stat(staleDir); statErr != nil {
		t.Fatalf("staleDir should remain untouched on reader error, statErr = %v", statErr)
	}
	if len(rec.calls) != 0 {
		t.Fatalf("reconciler should not be called, got %v", rec.calls)
	}
}

func TestPruneStaleRuntimeProjectionsHandlesKeptStaleInvalidAndReconcileFailures(t *testing.T) {
	aiHome := t.TempDir()
	keptRef := "acct_11111111111111111111"
	staleRef := "acct_22222222222222222222"
	failReconcileRef := "acct_33333333333333333333"
	desktopStaleRef := "acct_44444444444444444444"

	dirs := []string{
		filepath.Join(aiHome, "run", "auth-projections", "codex", keptRef),
		filepath.Join(aiHome, "run", "auth-projections", "codex", staleRef),
		filepath.Join(aiHome, "run", "auth-projections", "codex", failReconcileRef),
		filepath.Join(aiHome, "run", "auth-projections", "codex", "not-an-account-ref"),
		filepath.Join(aiHome, "run", "auth-projections", "unknown-provider", staleRef),
		filepath.Join(aiHome, "run", "codex-desktop", keptRef),
		filepath.Join(aiHome, "run", "codex-desktop", desktopStaleRef),
		filepath.Join(aiHome, "run", "codex-desktop", "bad_ref"),
	}
	for _, dir := range dirs {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	strayFile := filepath.Join(aiHome, "run", "auth-projections", "stray.txt")
	if err := os.WriteFile(strayFile, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}

	failPath := filepath.Join(aiHome, "run", "auth-projections", "codex", failReconcileRef)
	rec := &stubReconciler{
		failPaths: map[string]error{failPath: errors.New("reconcile failed")},
	}

	summary, err := PruneStaleRuntimeProjections(context.Background(), ProjectionPruneOptions{
		AIHomeDir: aiHome,
		Accounts: stubAccountsReader{
			accounts: []RegisteredAccount{
				{Provider: "codex", AccountRef: keptRef, Enabled: true, Status: "up"},
			},
		},
		Reconciler: rec,
	})
	if err != nil {
		t.Fatalf("PruneStaleRuntimeProjections() err = %v", err)
	}
	if summary.Kept != 2 || summary.Removed != 2 || summary.Failed != 5 {
		t.Fatalf("summary = %+v, want Kept=2 Removed=2 Failed=5", summary)
	}
	if _, err := os.Stat(filepath.Join(aiHome, "run", "auth-projections", "codex", keptRef)); err != nil {
		t.Fatalf("kept dir missing: %v", err)
	}
	if _, err := os.Stat(filepath.Join(aiHome, "run", "auth-projections", "codex", staleRef)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("stale auth projection should be removed, err = %v", err)
	}
	if _, err := os.Stat(filepath.Join(aiHome, "run", "codex-desktop", desktopStaleRef)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("stale desktop projection should be removed, err = %v", err)
	}
	if _, err := os.Stat(failPath); err != nil {
		t.Fatalf("reconcile failure should preserve %s, err = %v", failPath, err)
	}
	if _, err := os.Stat(filepath.Join(aiHome, "run", "auth-projections", "unknown-provider", staleRef)); err != nil {
		t.Fatalf("unknown provider root should remain untouched: %v", err)
	}
}

func TestPruneStaleRuntimeProjectionsMigratesResourcesViaDeletionProjection(t *testing.T) {
	aiHome := t.TempDir()
	hostHome := t.TempDir()
	staleRef := "acct_55555555555555555555"
	desktopRef := "acct_66666666666666666666"
	unsafeRef := "acct_77777777777777777777"

	authProj := filepath.Join(aiHome, "run", "auth-projections", "codex", staleRef, ".codex")
	if err := os.MkdirAll(filepath.Join(authProj, "sessions", "2026"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(authProj, "auth.json"), []byte(`{"secret":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(authProj, "sessions", "2026", "rollout.jsonl"), []byte("line1\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	desktopProj := filepath.Join(aiHome, "run", "codex-desktop", desktopRef)
	if err := os.MkdirAll(filepath.Join(desktopProj, "sessions"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(desktopProj, "config.toml"), []byte("model = \"o3\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(desktopProj, "sessions", "desktop.jsonl"), []byte("desktop\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	unsafeProj := filepath.Join(aiHome, "run", "auth-projections", "codex", unsafeRef)
	if err := os.MkdirAll(unsafeProj, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(unsafeProj, "unregistered.txt"), []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}

	summary, err := PruneStaleRuntimeProjections(context.Background(), ProjectionPruneOptions{
		AIHomeDir:  aiHome,
		Accounts:   stubAccountsReader{},
		Reconciler: DeletionProjectionReconciler{AIHomeDir: aiHome, HostHomeDir: hostHome},
	})
	if err != nil {
		t.Fatalf("PruneStaleRuntimeProjections() err = %v", err)
	}
	if summary.Removed != 2 || summary.Failed != 1 {
		t.Fatalf("summary = %+v, want Removed=2 Failed=1", summary)
	}
	migrated1, err := os.ReadFile(filepath.Join(hostHome, ".codex", "sessions", "2026", "rollout.jsonl"))
	if err != nil || string(migrated1) != "line1\n" {
		t.Fatalf("migrated auth-projection session mismatch: %q, err=%v", migrated1, err)
	}
	migrated2, err := os.ReadFile(filepath.Join(hostHome, ".codex", "sessions", "desktop.jsonl"))
	if err != nil || string(migrated2) != "desktop\n" {
		t.Fatalf("migrated desktop session mismatch: %q, err=%v", migrated2, err)
	}
	if _, err := os.Stat(filepath.Join(hostHome, ".codex", "auth.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("private auth.json must not migrate to host, err=%v", err)
	}
	if _, err := os.Stat(unsafeProj); err != nil {
		t.Fatalf("unsafeProj should remain preserved when reconciliation fails-closed, err=%v", err)
	}
}

func TestSQLiteRegisteredAccountsReader(t *testing.T) {
	ctx := context.Background()
	aiHome := t.TempDir()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() err = %v", err)
	}
	store, err := sqliteaccount.Open(ctx, sqliteaccount.OpenOptions{
		AIHomeDir: aiHome,
		Catalog:   catalog,
	})
	if err != nil {
		t.Fatalf("sqliteaccount.Open() err = %v", err)
	}
	defer store.Close()

	now := time.Now().UTC()
	cred, err := codex.NewAPIKeyAuth(codex.APIKeyInput{APIKey: "sk-test-123"})
	if err != nil {
		t.Fatal(err)
	}
	registrar, err := accountapp.NewRegistrar(catalog, store, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	account, err := registrar.Register(ctx, cred, nil)
	if err != nil {
		t.Fatalf("Register() err = %v", err)
	}

	got, err := (SQLiteRegisteredAccountsReader{Store: store}).ListRegisteredAccounts(ctx)
	if err != nil {
		t.Fatalf("ListRegisteredAccounts() err = %v", err)
	}
	if len(got) != 1 || got[0].AccountRef != account.Ref().String() || got[0].Provider != "codex" || !got[0].Enabled || got[0].Status != "up" {
		t.Fatalf("got = %+v", got)
	}
}

package sqliteaccount

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/core/providers"
)

func TestOpenCreatesPrivateCanonicalDatabase(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	aiHomeDir := t.TempDir()
	store := openTestStoreAt(t, aiHomeDir)

	databasePath := filepath.Join(aiHomeDir, DatabaseFileName)
	if _, err := os.Stat(filepath.Join(aiHomeDir, "app-state.db")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("Open 不应创建或读取旧 app-state.db")
	}
	info, err := os.Stat(databasePath)
	if err != nil {
		t.Fatalf("Stat(aih.db) error = %v", err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != databaseFileMode {
		t.Fatalf("aih.db mode = %#o, want %#o", info.Mode().Perm(), databaseFileMode)
	}

	var applicationID, schemaVersion, foreignKeys int
	if err := store.db.QueryRowContext(ctx, "PRAGMA application_id").Scan(&applicationID); err != nil {
		t.Fatalf("PRAGMA application_id error = %v", err)
	}
	if err := store.db.QueryRowContext(ctx, "PRAGMA user_version").Scan(&schemaVersion); err != nil {
		t.Fatalf("PRAGMA user_version error = %v", err)
	}
	if err := store.db.QueryRowContext(ctx, "PRAGMA foreign_keys").Scan(&foreignKeys); err != nil {
		t.Fatalf("PRAGMA foreign_keys error = %v", err)
	}
	if applicationID != ApplicationID || schemaVersion != SchemaVersion || foreignKeys != 1 {
		t.Fatalf(
			"database identity = (%d, %d, %d), want (%d, %d, 1)",
			applicationID,
			schemaVersion,
			foreignKeys,
			ApplicationID,
			SchemaVersion,
		)
	}
	var journalMode string
	if err := store.db.QueryRowContext(ctx, "PRAGMA journal_mode").Scan(&journalMode); err != nil {
		t.Fatalf("PRAGMA journal_mode error = %v", err)
	}
	if journalMode != "wal" {
		t.Fatalf("journal_mode = %q, want wal", journalMode)
	}
}

func TestOpenRejectsForeignAndUnversionedSchemas(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		setup func(*testing.T, string)
	}{
		{
			name: "foreign application id",
			setup: func(t *testing.T, path string) {
				t.Helper()
				db := openRawSQLite(t, path)
				if _, err := db.Exec("PRAGMA application_id = 1234"); err != nil {
					t.Fatalf("set foreign application_id error = %v", err)
				}
				if err := db.Close(); err != nil {
					t.Fatalf("close foreign database error = %v", err)
				}
			},
		},
		{
			name: "unversioned legacy table",
			setup: func(t *testing.T, path string) {
				t.Helper()
				db := openRawSQLite(t, path)
				if _, err := db.Exec("CREATE TABLE legacy_accounts(id INTEGER PRIMARY KEY)"); err != nil {
					t.Fatalf("create legacy table error = %v", err)
				}
				if err := db.Close(); err != nil {
					t.Fatalf("close legacy database error = %v", err)
				}
			},
		},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			aiHomeDir := t.TempDir()
			databasePath := filepath.Join(aiHomeDir, DatabaseFileName)
			test.setup(t, databasePath)
			catalog := newTestCatalog(t)
			store, err := Open(context.Background(), OpenOptions{
				AIHomeDir: aiHomeDir,
				Catalog:   catalog,
			})
			if store != nil {
				_ = store.Close()
			}
			if !errors.Is(err, ErrIncompatibleDatabase) {
				t.Fatalf("Open() error = %v, want ErrIncompatibleDatabase", err)
			}
		})
	}
}

func TestOpenReusesCanonicalDatabaseAfterRestart(t *testing.T) {
	t.Parallel()

	aiHomeDir := t.TempDir()
	first := openTestStoreAt(t, aiHomeDir)
	if err := first.Close(); err != nil {
		t.Fatalf("first Close() error = %v", err)
	}

	catalog := newTestCatalog(t)
	second, err := Open(context.Background(), OpenOptions{
		AIHomeDir: aiHomeDir,
		Catalog:   catalog,
	})
	if err != nil {
		t.Fatalf("second Open() error = %v", err)
	}
	if err := second.Close(); err != nil {
		t.Fatalf("second Close() error = %v", err)
	}
}

// TestOpenMigratesV1WithoutLosingAccountData 验证前向 migration 只增加模型关系。
func TestOpenMigratesV1WithoutLosingAccountData(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	aiHomeDir := t.TempDir()
	databasePath := filepath.Join(aiHomeDir, DatabaseFileName)
	credential, err := codex.NewAPIKeyAuth(codex.APIKeyInput{
		APIKey: "synthetic-v1-migration-key",
	})
	if err != nil {
		t.Fatalf("codex.NewAPIKeyAuth() error = %v", err)
	}
	accountRef, err := accountcore.DeriveAccountRef(credential)
	if err != nil {
		t.Fatalf("DeriveAccountRef() error = %v", err)
	}
	credentialJSON, err := json.Marshal(map[string]string{
		"api_key":  credential.APIKey(),
		"base_url": credential.BaseURL(),
	})
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	v1 := openRawSQLite(t, databasePath)
	if _, err := v1.ExecContext(ctx, SchemaV1); err != nil {
		t.Fatalf("create v1 schema error = %v", err)
	}
	createdAt := time.Date(2026, time.July, 27, 0, 0, 0, 0, time.UTC)
	if _, err := v1.ExecContext(
		ctx,
		`INSERT INTO accounts (
			account_ref, provider_id, cli_account_id, enabled,
			created_at_ms, updated_at_ms
		) VALUES (?, 'codex', 1, 1, ?, ?)`,
		accountRef.String(),
		createdAt.UnixMilli(),
		createdAt.UnixMilli(),
	); err != nil {
		t.Fatalf("insert v1 account error = %v", err)
	}
	if _, err := v1.ExecContext(
		ctx,
		`INSERT INTO account_credentials (
			account_ref, auth_kind, auth_mode, format_version,
			credential_json, updated_at_ms
		) VALUES (?, 'api_key', '', 1, ?, ?)`,
		accountRef.String(),
		string(credentialJSON),
		createdAt.UnixMilli(),
	); err != nil {
		t.Fatalf("insert v1 credential error = %v", err)
	}
	if err := v1.Close(); err != nil {
		t.Fatalf("close v1 database error = %v", err)
	}

	store, err := Open(ctx, OpenOptions{
		AIHomeDir: aiHomeDir,
		Catalog:   newTestCatalog(t),
	})
	if err != nil {
		t.Fatalf("Open(v1) error = %v", err)
	}
	t.Cleanup(func() {
		_ = store.Close()
	})
	account, err := store.GetByRef(ctx, accountRef)
	if err != nil {
		t.Fatalf("GetByRef() error = %v", err)
	}
	restored, err := store.GetCredential(ctx, accountRef)
	if err != nil {
		t.Fatalf("GetCredential() error = %v", err)
	}
	models, err := store.ListAccountModels(ctx, accountRef)
	if err != nil {
		t.Fatalf("ListAccountModels() error = %v", err)
	}
	if account.Ref() != accountRef ||
		restored.IdentitySeed() != credential.IdentitySeed() ||
		len(models) != 0 {
		t.Fatalf(
			"migration result account=%#v credential=%T models=%#v",
			account,
			restored,
			models,
		)
	}
	var schemaVersion int
	if err := store.db.QueryRowContext(
		ctx,
		"PRAGMA user_version",
	).Scan(&schemaVersion); err != nil {
		t.Fatalf("PRAGMA user_version error = %v", err)
	}
	if schemaVersion != SchemaVersion {
		t.Fatalf("schema version = %d, want %d", schemaVersion, SchemaVersion)
	}
}

func TestOpenSerializesConcurrentInitialMigration(t *testing.T) {
	t.Parallel()

	const openCount = 8
	ctx := context.Background()
	aiHomeDir := t.TempDir()
	catalog := newTestCatalog(t)
	start := make(chan struct{})
	stores := make([]*Store, openCount)
	openErrors := make([]error, openCount)
	var waitGroup sync.WaitGroup
	waitGroup.Add(openCount)
	for index := range openCount {
		go func() {
			defer waitGroup.Done()
			<-start
			stores[index], openErrors[index] = Open(ctx, OpenOptions{
				AIHomeDir: aiHomeDir,
				Catalog:   catalog,
			})
		}()
	}
	close(start)
	waitGroup.Wait()

	for index, openErr := range openErrors {
		if openErr != nil {
			t.Fatalf("Open(%d) error = %v", index, openErr)
		}
	}
	for index, store := range stores {
		if err := store.Close(); err != nil {
			t.Fatalf("Close(%d) error = %v", index, err)
		}
	}

	reopened, err := Open(ctx, OpenOptions{
		AIHomeDir: aiHomeDir,
		Catalog:   catalog,
	})
	if err != nil {
		t.Fatalf("reopen error = %v", err)
	}
	if err := reopened.Close(); err != nil {
		t.Fatalf("reopened Close() error = %v", err)
	}
}

func openTestStore(t *testing.T) *Store {
	t.Helper()
	return openTestStoreAt(t, t.TempDir())
}

func openTestStoreAt(t *testing.T, aiHomeDir string) *Store {
	t.Helper()

	store, err := Open(context.Background(), OpenOptions{
		AIHomeDir: aiHomeDir,
		Catalog:   newTestCatalog(t),
	})
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	t.Cleanup(func() {
		_ = store.Close()
	})
	return store
}

func newTestCatalog(t *testing.T) *providers.Catalog {
	t.Helper()

	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	return catalog
}

func openRawSQLite(t *testing.T, path string) *sql.DB {
	t.Helper()

	db, err := sql.Open("sqlite", buildDatabaseDSN(path))
	if err != nil {
		t.Fatalf("sql.Open() error = %v", err)
	}
	if err := db.Ping(); err != nil {
		_ = db.Close()
		t.Fatalf("db.Ping() error = %v", err)
	}
	return db
}

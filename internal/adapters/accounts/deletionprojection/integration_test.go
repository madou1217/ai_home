package deletionprojection_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/deletionprojection"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/adapters/codex/authfile"
)

// TestSQLiteDeletionRetriesAfterProjectionReconciliation 验证真实 aih.db 在
// projection 不可安全收敛时保留账号，修正临时资源后同一删除可以幂等重试。
func TestSQLiteDeletionRetriesAfterProjectionReconciliation(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	aiHomeDir := t.TempDir()
	hostHomeDir := t.TempDir()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	store, err := sqliteaccount.Open(ctx, sqliteaccount.OpenOptions{
		AIHomeDir: aiHomeDir,
		Catalog:   catalog,
	})
	if err != nil {
		t.Fatalf("sqliteaccount.Open() error = %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("Store.Close() error = %v", err)
		}
	})
	registeredAt := time.Date(2026, 8, 15, 4, 5, 6, 0, time.UTC)
	credential, err := codex.NewAPIKeyAuth(codex.APIKeyInput{
		APIKey: "synthetic-deletion-projection-integration-key",
	})
	if err != nil {
		t.Fatalf("codex.NewAPIKeyAuth() error = %v", err)
	}
	registrar, err := accountapp.NewRegistrar(
		catalog,
		store,
		func() time.Time { return registeredAt },
	)
	if err != nil {
		t.Fatalf("NewRegistrar() error = %v", err)
	}
	account, err := registrar.Register(ctx, credential, nil)
	if err != nil {
		t.Fatalf("Register() error = %v", err)
	}
	preparer, err := deletionprojection.New(deletionprojection.Options{
		AIHomeDir:   aiHomeDir,
		HostHomeDir: hostHomeDir,
		Credentials: store,
		Clock:       func() time.Time { return registeredAt.Add(time.Second) },
	})
	if err != nil {
		t.Fatalf("deletionprojection.New() error = %v", err)
	}
	deleter, err := accountapp.NewDeleter(
		store,
		integrationDeletionGuard{},
		preparer,
		integrationDeletionCleanup{},
	)
	if err != nil {
		t.Fatalf("NewDeleter() error = %v", err)
	}

	projectionRoot := filepath.Join(
		aiHomeDir,
		"run",
		"auth-projections",
		"codex",
		account.Ref().String(),
	)
	authJSON, err := authfile.Encode(credential)
	if err != nil {
		t.Fatalf("authfile.Encode() error = %v", err)
	}
	writePrivateFile(t, filepath.Join(projectionRoot, ".codex", "auth.json"), authJSON)
	unmanagedPath := filepath.Join(projectionRoot, ".codex", "sessions")
	if err := os.Symlink(t.TempDir(), unmanagedPath); err != nil {
		t.Fatalf("Symlink() error = %v", err)
	}

	err = deleter.DeleteAccount(ctx, account.Ref())
	if !errors.Is(err, accountapp.ErrAccountDeletionPreparationFailed) {
		t.Fatalf("DeleteAccount(first) error = %v", err)
	}
	if _, err := store.GetByRef(ctx, account.Ref()); err != nil {
		t.Fatalf("失败关闭后账号未保留: %v", err)
	}
	if err := os.Remove(unmanagedPath); err != nil {
		t.Fatalf("Remove(unmanaged symlink) error = %v", err)
	}

	if err := deleter.DeleteAccount(ctx, account.Ref()); err != nil {
		t.Fatalf("DeleteAccount(retry) error = %v", err)
	}
	if _, err := store.GetByRef(ctx, account.Ref()); !errors.Is(err, accountapp.ErrAccountNotFound) {
		t.Fatalf("重试后账号仍存在: %v", err)
	}
	if _, err := os.Lstat(projectionRoot); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("重试后敏感 projection 仍存在: %v", err)
	}
}

type integrationDeletionGuard struct{}

func (integrationDeletionGuard) AssertAccountDeletable(
	context.Context,
	accountcore.AccountRef,
) error {
	return nil
}

type integrationDeletionCleanup struct{}

func (integrationDeletionCleanup) ForgetAccount(accountcore.AccountRef) {}

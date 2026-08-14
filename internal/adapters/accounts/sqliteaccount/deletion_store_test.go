package sqliteaccount

import (
	"context"
	"errors"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	usageapp "github.com/madou1217/ai_home/application/accountusage"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
	"github.com/madou1217/ai_home/internal/testsupport/accountmodels"
)

// TestStoreDeletesAccountGraphAndPublishesRoutingSnapshot 验证主记录、级联数据和路由索引同步删除。
func TestStoreDeletesAccountGraphAndPublishesRoutingSnapshot(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestStore(t)
	registrar, err := accountapp.NewRegistrar(
		store.catalog,
		store,
		testAccountTime,
	)
	if err != nil {
		t.Fatalf("NewRegistrar() error = %v", err)
	}
	account, err := registrar.Register(
		ctx,
		newTestCodexOAuth(t),
		newTestCodexAccountProfile(t),
	)
	if err != nil {
		t.Fatalf("Register() error = %v", err)
	}
	discovery, err := accountmodels.NewDiscovery(store.catalog)
	if err != nil {
		t.Fatalf("accountmodels.NewDiscovery() error = %v", err)
	}
	modelManagement, err := accountapp.NewModelManagement(store, store, discovery, testAccountTime)
	if err != nil {
		t.Fatalf("NewModelManagement() error = %v", err)
	}
	if _, err := modelManagement.RefreshAccountModels(ctx, account.Ref()); err != nil {
		t.Fatalf("RefreshAccountModels() error = %v", err)
	}
	snapshot := newUsageStoreSnapshot(
		t,
		account.Ref(),
		testAccountTime(),
		[]usagecore.EntryInput{{
			Bucket:       "primary",
			Kind:         usagecore.KindWindow,
			Scope:        usagecore.ScopeAccount,
			Availability: usagecore.AvailabilityUnknown,
		}},
	)
	if err := store.ReplaceUsageSnapshot(ctx, snapshot); err != nil {
		t.Fatalf("ReplaceUsageSnapshot() error = %v", err)
	}
	modelID := mustModelID(t, "gpt-5.6-sol")
	oldRoutes, err := store.LoadRoutingCandidates(ctx, "codex", modelID)
	if err != nil || oldRoutes.Len() != 1 {
		t.Fatalf("LoadRoutingCandidates(before) len=%d error=%v", oldRoutes.Len(), err)
	}

	if err := store.DeleteAccount(ctx, account.Ref()); err != nil {
		t.Fatalf("DeleteAccount() error = %v", err)
	}
	if _, err := store.GetByRef(ctx, account.Ref()); !errors.Is(
		err,
		accountapp.ErrAccountNotFound,
	) {
		t.Fatalf("GetByRef(deleted) error = %v", err)
	}
	if _, err := store.GetUsageSnapshot(ctx, account.Ref()); !errors.Is(
		err,
		usageapp.ErrSnapshotNotFound,
	) {
		t.Fatalf("GetUsageSnapshot(deleted) error = %v", err)
	}
	newRoutes, err := store.LoadRoutingCandidates(ctx, "codex", modelID)
	if err != nil || newRoutes.Len() != 0 || oldRoutes.Len() != 1 {
		t.Fatalf(
			"routing snapshots old=%d new=%d error=%v",
			oldRoutes.Len(),
			newRoutes.Len(),
			err,
		)
	}
	for _, table := range []string{
		"accounts",
		"account_credentials",
		"account_profiles",
		"account_models",
		"account_usage",
		"account_defaults",
	} {
		assertDeletedAccountRows(t, store, table, account.Ref().String())
	}
	if err := store.DeleteAccount(ctx, account.Ref()); !errors.Is(
		err,
		accountapp.ErrAccountNotFound,
	) {
		t.Fatalf("DeleteAccount(missing) error = %v", err)
	}
}

// TestStoreDeletionAllowsCurrentMaxAliasReuse 验证删除最大别名后继续沿用现存最大值分配规则。
func TestStoreDeletionAllowsCurrentMaxAliasReuse(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestStore(t)
	registrar, err := accountapp.NewRegistrar(
		store.catalog,
		store,
		func() time.Time { return testAccountTime() },
	)
	if err != nil {
		t.Fatalf("NewRegistrar() error = %v", err)
	}
	first, err := registrar.Register(
		ctx,
		mustClaudeAPIKey(t, "synthetic-delete-alias-first"),
		nil,
	)
	if err != nil {
		t.Fatalf("Register(first) error = %v", err)
	}
	if err := store.DeleteAccount(ctx, first.Ref()); err != nil {
		t.Fatalf("DeleteAccount(first) error = %v", err)
	}
	second, err := registrar.Register(
		ctx,
		mustClaudeAPIKey(t, "synthetic-delete-alias-second"),
		nil,
	)
	if err != nil {
		t.Fatalf("Register(second) error = %v", err)
	}
	if second.CLIAccountID().Int64() != 1 {
		t.Fatalf(
			"删除最大别名后新 alias = %d, want 1",
			second.CLIAccountID().Int64(),
		)
	}
}

// assertDeletedAccountRows 验证表中不再包含指定账号记录。
func assertDeletedAccountRows(
	t *testing.T,
	store *Store,
	table string,
	accountRef string,
) {
	t.Helper()

	var count int
	query := "SELECT COUNT(*) FROM " + table + " WHERE account_ref = ?"
	if err := store.db.QueryRow(query, accountRef).Scan(&count); err != nil {
		t.Fatalf("count %s error = %v", table, err)
	}
	if count != 0 {
		t.Fatalf("%s deleted account rows = %d", table, count)
	}
}

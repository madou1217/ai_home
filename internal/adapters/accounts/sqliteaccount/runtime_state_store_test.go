package sqliteaccount

import (
	"context"
	"errors"
	"testing"
	"time"

	runtimeapp "github.com/madou1217/ai_home/application/accountruntime"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
)

// TestRuntimeStateStoreRoundTripsModelCooldown 验证冷却状态在真实 SQLite 上往返无损，
// 且账号删除时随外键级联清理。
func TestRuntimeStateStoreRoundTripsModelCooldown(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestStore(t)
	account := newCodexAPIKeyAccount(t, store, 1, "sk-runtime-state")
	if err := store.Create(ctx, account); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	now := testAccountTime()
	route, err := runtimecore.NewModelRoute(account.Ref(), "gpt-5.6-sol")
	if err != nil {
		t.Fatalf("NewModelRoute() error = %v", err)
	}
	entry := runtimeapp.PersistedModelState{
		Route: route,
		State: runtimecore.ModelStateSnapshot{
			StreakKind:      runtimecore.FailureRequestTimeout,
			StreakCount:     2,
			StreakExpiresAt: now.Add(2 * time.Minute),
			CooldownKind:    runtimecore.FailureRequestTimeout,
			CooldownUntil:   now.Add(30 * time.Second),
			LastFailureAt:   now,
		},
	}
	if err := store.SaveModelState(ctx, entry); err != nil {
		t.Fatalf("SaveModelState() error = %v", err)
	}
	// 覆盖写入必须幂等，不能留下重复行。
	if err := store.SaveModelState(ctx, entry); err != nil {
		t.Fatalf("SaveModelState(again) error = %v", err)
	}

	entries, err := store.LoadModelStates(ctx)
	if err != nil {
		t.Fatalf("LoadModelStates() error = %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("LoadModelStates() = %d 行, want 1", len(entries))
	}
	loaded := entries[0]
	if loaded.Route != route {
		t.Fatalf("恢复元组 = %#v, want %#v", loaded.Route, route)
	}
	if loaded.State.StreakKind != entry.State.StreakKind ||
		loaded.State.StreakCount != entry.State.StreakCount ||
		!loaded.State.StreakExpiresAt.Equal(entry.State.StreakExpiresAt) ||
		loaded.State.CooldownKind != entry.State.CooldownKind ||
		!loaded.State.CooldownUntil.Equal(entry.State.CooldownUntil) ||
		!loaded.State.LastFailureAt.Equal(entry.State.LastFailureAt) {
		t.Fatalf("恢复状态 = %#v, want %#v", loaded.State, entry.State)
	}
	restored, err := runtimecore.RestoreModelState(loaded.State)
	if err != nil {
		t.Fatalf("RestoreModelState() error = %v", err)
	}
	if restored.IsZero() {
		t.Fatal("恢复后的状态不应为零值")
	}

	if err := store.DeleteModelState(ctx, route); err != nil {
		t.Fatalf("DeleteModelState() error = %v", err)
	}
	entries, err = store.LoadModelStates(ctx)
	if err != nil {
		t.Fatalf("LoadModelStates(after delete) error = %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("删除后仍有 %d 行", len(entries))
	}

	// 账号删除必须级联清掉冷却行。
	if err := store.SaveModelState(ctx, entry); err != nil {
		t.Fatalf("SaveModelState(before delete account) error = %v", err)
	}
	if err := store.DeleteAccount(ctx, account.Ref()); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
	entries, err = store.LoadModelStates(ctx)
	if err != nil {
		t.Fatalf("LoadModelStates(after account delete) error = %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("账号删除后仍有 %d 行冷却状态", len(entries))
	}
}

// TestRuntimeStateStoreRejectsInvalidInput 验证端口在写库前拒绝无效元组和状态。
func TestRuntimeStateStoreRejectsInvalidInput(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestStore(t)
	account := newCodexAPIKeyAccount(t, store, 1, "sk-runtime-state-invalid")
	if err := store.Create(ctx, account); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	route, err := runtimecore.NewModelRoute(account.Ref(), "gpt-5.6-sol")
	if err != nil {
		t.Fatalf("NewModelRoute() error = %v", err)
	}

	if err := store.SaveModelState(ctx, runtimeapp.PersistedModelState{}); !errors.Is(
		err,
		runtimeapp.ErrInvalidRequest,
	) {
		t.Fatalf("SaveModelState(empty) error = %v", err)
	}
	streakWithoutCount := runtimeapp.PersistedModelState{
		Route: route,
		State: runtimecore.ModelStateSnapshot{
			StreakKind: runtimecore.FailureRequestTimeout,
		},
	}
	if err := store.SaveModelState(ctx, streakWithoutCount); !errors.Is(
		err,
		runtimeapp.ErrInvalidRequest,
	) {
		t.Fatalf("SaveModelState(no count) error = %v", err)
	}
	if err := store.DeleteModelState(ctx, runtimecore.ModelRoute{}); !errors.Is(
		err,
		runtimeapp.ErrInvalidRequest,
	) {
		t.Fatalf("DeleteModelState(invalid) error = %v", err)
	}
}

// TestRuntimeStateStoreIgnoresWritesForUnknownAccount 验证账号已被并发删除时写入
// 静默丢弃，而不是把已经在内存中生效的冷却判为失败。
func TestRuntimeStateStoreIgnoresWritesForUnknownAccount(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestStore(t)
	account := newCodexAPIKeyAccount(t, store, 1, "sk-runtime-state-race")
	if err := store.Create(ctx, account); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	route, err := runtimecore.NewModelRoute(account.Ref(), "gpt-5.6-sol")
	if err != nil {
		t.Fatalf("NewModelRoute() error = %v", err)
	}
	if err := store.DeleteAccount(ctx, account.Ref()); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
	if err := store.SaveModelState(ctx, runtimeapp.PersistedModelState{
		Route: route,
		State: runtimecore.ModelStateSnapshot{
			CooldownKind:  runtimecore.FailureRateLimited,
			CooldownUntil: testAccountTime().Add(time.Minute),
			LastFailureAt: testAccountTime(),
		},
	}); err != nil {
		t.Fatalf("SaveModelState(unknown account) error = %v", err)
	}
}

// TestMigrationAddsRuntimeStateTableToExistingV7Database 验证既有 v7 库可以前向迁移
// 到 v8，并保留原有账号数据。
func TestMigrationAddsRuntimeStateTableToExistingV7Database(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	aiHomeDir := t.TempDir()
	store := openTestStoreAt(t, aiHomeDir)
	account := newCodexAPIKeyAccount(t, store, 1, "sk-migrate-v7")
	if err := store.Create(ctx, account); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	route, err := runtimecore.NewModelRoute(account.Ref(), "gpt-5.4")
	if err != nil {
		t.Fatalf("NewModelRoute() error = %v", err)
	}
	now := testAccountTime()
	if err := store.SaveModelState(ctx, runtimeapp.PersistedModelState{
		Route: route,
		State: runtimecore.ModelStateSnapshot{
			CooldownKind:  runtimecore.FailureRateLimited,
			CooldownUntil: now.Add(5 * time.Minute),
			LastFailureAt: now,
		},
	}); err != nil {
		t.Fatalf("SaveModelState() error = %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}

	// 把库退回到 v7 形态：删掉 v8 引入的表与索引，并回写 user_version。
	rollback := openTestStoreAt(t, aiHomeDir)
	if _, err := rollback.db.ExecContext(
		ctx,
		"DROP INDEX idx_account_runtime_state_cooldown",
	); err != nil {
		t.Fatalf("DROP INDEX error = %v", err)
	}
	if _, err := rollback.db.ExecContext(
		ctx,
		"DROP TABLE account_runtime_state",
	); err != nil {
		t.Fatalf("DROP TABLE error = %v", err)
	}
	if _, err := rollback.db.ExecContext(ctx, "PRAGMA user_version = 7"); err != nil {
		t.Fatalf("PRAGMA user_version error = %v", err)
	}
	if err := rollback.Close(); err != nil {
		t.Fatalf("Close(rollback) error = %v", err)
	}

	migrated := openTestStoreAt(t, aiHomeDir)
	entries, err := migrated.LoadModelStates(ctx)
	if err != nil {
		t.Fatalf("LoadModelStates(after migration) error = %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("迁移后不应保留旧冷却行, got %d", len(entries))
	}
	overview, err := migrated.GetAccountOverview(ctx, account.Ref())
	if err != nil {
		t.Fatalf("GetAccountOverview() error = %v", err)
	}
	if overview.Account().Ref() != account.Ref() {
		t.Fatalf("迁移后账号丢失: %#v", overview.Account().Ref())
	}
	if err := migrated.SaveModelState(ctx, runtimeapp.PersistedModelState{
		Route: route,
		State: runtimecore.ModelStateSnapshot{
			CooldownKind:  runtimecore.FailureRateLimited,
			CooldownUntil: now.Add(time.Minute),
			LastFailureAt: now,
		},
	}); err != nil {
		t.Fatalf("SaveModelState(after migration) error = %v", err)
	}
}

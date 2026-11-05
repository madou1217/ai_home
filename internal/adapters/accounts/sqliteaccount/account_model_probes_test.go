package sqliteaccount

import (
	"context"
	"errors"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// TestRecordModelProbeRoundTrip 覆盖探测事实的写入、覆盖语义与读取投影：
// 成功覆盖来源和计数并清空错误；失败只更新时刻与错误，保留上一次成功的目录计数。
func TestRecordModelProbeRoundTrip(t *testing.T) {
	store := openOAuthJobStore(t)
	ctx := context.Background()
	const ref = "acct_0123456789abcdef0123"
	accountRef, err := accountcore.ParseAccountRef(ref)
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	if _, err := store.db.ExecContext(
		ctx,
		"INSERT INTO accounts (account_ref, provider_id, cli_account_id, enabled, created_at_ms, updated_at_ms) VALUES (?, 'codex', 1, 1, 1, 1)",
		ref,
	); err != nil {
		t.Fatalf("插入账号失败: %v", err)
	}

	firstAttempt := time.Date(2026, 11, 5, 10, 0, 0, 0, time.UTC)
	if err := store.RecordModelProbe(ctx, accountapp.ModelProbeRecord{
		AccountRef:  accountRef,
		AttemptedAt: firstAttempt,
		Succeeded:   true,
		Source:      accountapp.ModelProbeSourceRemote,
		ModelCount:  7,
		UpdatedAt:   firstAttempt,
	}); err != nil {
		t.Fatalf("RecordModelProbe(success) error = %v", err)
	}
	sets, err := store.ListAllAccountModels(ctx)
	if err != nil {
		t.Fatalf("ListAllAccountModels() error = %v", err)
	}
	if len(sets) != 1 {
		t.Fatalf("账号数 = %d, want 1", len(sets))
	}
	// provider_id 由 accounts 派生，即使探测在读取凭据前就发生也不会写空。
	assertProbe(t, sets[0], firstAttempt, accountapp.ModelProbeSourceRemote, "", "", 7)
	if len(sets[0].Models) != 0 {
		t.Fatalf("成功探测不创建模型关系, got %d", len(sets[0].Models))
	}

	// 失败只更新时刻与错误：目录快照没被替换，last_model_count 必须保留 7。
	secondAttempt := firstAttempt.Add(2 * time.Minute)
	const failureMessage = "上游 403：凭据已过期"
	if err := store.RecordModelProbe(ctx, accountapp.ModelProbeRecord{
		AccountRef:   accountRef,
		AttemptedAt:  secondAttempt,
		Succeeded:    false,
		Source:       accountapp.ModelProbeSourceError,
		ErrorCode:    "discovery_failed",
		ErrorMessage: failureMessage,
		UpdatedAt:    secondAttempt,
	}); err != nil {
		t.Fatalf("RecordModelProbe(failure) error = %v", err)
	}
	sets, err = store.ListAllAccountModels(ctx)
	if err != nil {
		t.Fatalf("ListAllAccountModels() after failure error = %v", err)
	}
	assertProbe(t, sets[0], secondAttempt, accountapp.ModelProbeSourceError,
		"discovery_failed", failureMessage, 7)

	// 再次成功必须清空上一次的错误，并把计数换成新目录大小。
	thirdAttempt := secondAttempt.Add(time.Minute)
	if err := store.RecordModelProbe(ctx, accountapp.ModelProbeRecord{
		AccountRef:  accountRef,
		AttemptedAt: thirdAttempt,
		Succeeded:   true,
		Source:      accountapp.ModelProbeSourceRemote,
		ModelCount:  2,
		UpdatedAt:   thirdAttempt,
	}); err != nil {
		t.Fatalf("RecordModelProbe(second success) error = %v", err)
	}
	sets, err = store.ListAllAccountModels(ctx)
	if err != nil {
		t.Fatalf("ListAllAccountModels() after second success error = %v", err)
	}
	assertProbe(t, sets[0], thirdAttempt, accountapp.ModelProbeSourceRemote, "", "", 2)

	var providerID string
	if err := store.db.QueryRowContext(
		ctx,
		"SELECT provider_id FROM account_model_probes WHERE account_ref = ?",
		ref,
	).Scan(&providerID); err != nil {
		t.Fatalf("读取探测行失败: %v", err)
	}
	if providerID != "codex" {
		t.Fatalf("provider_id = %q, want codex", providerID)
	}
}

// TestRecordModelProbeRejectsInvalidRecord 保证存储层不会写入无法解释的事实。
func TestRecordModelProbeRejectsInvalidRecord(t *testing.T) {
	store := openOAuthJobStore(t)
	err := store.RecordModelProbe(context.Background(), accountapp.ModelProbeRecord{})
	if !errors.Is(err, accountapp.ErrInvalidModelProbe) {
		t.Fatalf("RecordModelProbe() error = %v, want ErrInvalidModelProbe", err)
	}
}

// TestRecordModelProbeSkipsUnknownAccount 覆盖并发删除：账号不存在时静默不写，
// 不能靠探测事实把已经删除的账号重新带回来。
func TestRecordModelProbeSkipsUnknownAccount(t *testing.T) {
	store := openOAuthJobStore(t)
	accountRef, err := accountcore.ParseAccountRef("acct_ffffffffffffffffffff")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	attemptedAt := time.Date(2026, 11, 5, 10, 0, 0, 0, time.UTC)
	if err := store.RecordModelProbe(context.Background(), accountapp.ModelProbeRecord{
		AccountRef:  accountRef,
		AttemptedAt: attemptedAt,
		Succeeded:   true,
		Source:      accountapp.ModelProbeSourceRemote,
		ModelCount:  1,
		UpdatedAt:   attemptedAt,
	}); err != nil {
		t.Fatalf("RecordModelProbe() error = %v", err)
	}
	var count int
	if err := store.db.QueryRowContext(
		context.Background(),
		"SELECT COUNT(*) FROM account_model_probes",
	).Scan(&count); err != nil {
		t.Fatalf("统计探测行失败: %v", err)
	}
	if count != 0 {
		t.Fatalf("未知账号写入探测行 = %d, want 0", count)
	}
}

// TestAccountModelProbesForwardMigrationFromV20 模拟既有 v20 库升级：
// v21 只新增探测表，旧库的账号与模型关系必须原样保留。
func TestAccountModelProbesForwardMigrationFromV20(t *testing.T) {
	aiHomeDir := t.TempDir()
	store := openOAuthJobStoreAt(t, aiHomeDir)
	ctx := context.Background()
	const ref = "acct_0123456789abcdef0123"
	if _, err := store.db.ExecContext(
		ctx,
		"INSERT INTO accounts (account_ref, provider_id, cli_account_id, enabled, created_at_ms, updated_at_ms) VALUES (?, 'codex', 1, 1, 1, 1)",
		ref,
	); err != nil {
		t.Fatalf("插入账号失败: %v", err)
	}
	// 回退到 v20 的夹具必须是**真正的 v20 结构**：v22 新增的别名表也要一起删，
	// 否则重放 v23 的 ALTER TABLE ADD COLUMN 会撞上「列已存在」。
	for _, table := range []string{"account_model_probes", "model_alias", "model_alias_meta"} {
		if _, err := store.db.ExecContext(ctx, "DROP TABLE IF EXISTS "+table); err != nil {
			t.Fatalf("drop %s error = %v", table, err)
		}
	}
	if _, err := store.db.ExecContext(ctx, "PRAGMA user_version = 20"); err != nil {
		t.Fatalf("rewind user_version error = %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}

	upgraded := openOAuthJobStoreAt(t, aiHomeDir)
	var version int
	if err := upgraded.db.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		t.Fatalf("read user_version error = %v", err)
	}
	if version != SchemaVersion {
		t.Fatalf("user_version after upgrade = %d, want %d", version, SchemaVersion)
	}
	assertSQLiteObjectsExist(t, upgraded, "account_model_probes")
	var accountCount int
	if err := upgraded.db.QueryRowContext(
		ctx,
		"SELECT COUNT(*) FROM accounts",
	).Scan(&accountCount); err != nil {
		t.Fatalf("统计账号失败: %v", err)
	}
	if accountCount != 1 {
		t.Fatalf("升级后账号数 = %d, want 1", accountCount)
	}
}

// assertProbe 统一核对读取投影里的探测字段。
func assertProbe(
	t *testing.T,
	set accountapp.AccountModelSet,
	attemptedAt time.Time,
	source string,
	errorCode string,
	errorMessage string,
	modelCount int,
) {
	t.Helper()
	if !set.LastAttemptAt.Equal(attemptedAt) {
		t.Fatalf("LastAttemptAt = %s, want %s", set.LastAttemptAt, attemptedAt)
	}
	if set.LastSource != source ||
		set.LastErrorCode != errorCode ||
		set.LastErrorMessage != errorMessage ||
		set.LastModelCount != modelCount {
		t.Fatalf(
			"probe = %s/%q/%q/%d, want %s/%q/%q/%d",
			set.LastSource,
			set.LastErrorCode,
			set.LastErrorMessage,
			set.LastModelCount,
			source,
			errorCode,
			errorMessage,
			modelCount,
		)
	}
}

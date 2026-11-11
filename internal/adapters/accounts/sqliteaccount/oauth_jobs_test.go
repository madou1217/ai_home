package sqliteaccount

import (
	"context"
	"errors"
	"testing"
	"time"

	accountauth "github.com/madou1217/ai_home/application/accountauth"
	"github.com/madou1217/ai_home/core/providers"
)

func openOAuthJobStore(t *testing.T) *Store {
	t.Helper()
	return openOAuthJobStoreAt(t, t.TempDir())
}

func openOAuthJobStoreAt(t *testing.T, aiHomeDir string) *Store {
	t.Helper()
	ctx := context.Background()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	store, err := Open(ctx, OpenOptions{AIHomeDir: aiHomeDir, Catalog: catalog})
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

func newOAuthJobRecord(
	id string,
	status accountauth.Status,
	createdAt time.Time,
) accountauth.JobRecord {
	return accountauth.JobRecord{
		ID:         id,
		ProviderID: "codex",
		Purpose:    accountauth.PurposeRegister,
		Status:     status,
		CreatedAt:  createdAt,
		ExpiresAt:  createdAt.Add(accountauth.DefaultJobTTL),
		UpdatedAt:  createdAt,
	}
}

func TestOAuthJobUpsertIsIdempotentAndOverwrites(t *testing.T) {
	store := openOAuthJobStore(t)
	ctx := context.Background()
	createdAt := time.Date(2026, 11, 5, 10, 0, 0, 0, time.UTC)
	pending := newOAuthJobRecord("job-idempotent", accountauth.StatusPending, createdAt)
	for attempt := range 3 {
		if err := store.UpsertJob(ctx, pending); err != nil {
			t.Fatalf("UpsertJob() attempt %d error = %v", attempt, err)
		}
	}
	records, err := store.ListJobs(ctx, false)
	if err != nil {
		t.Fatalf("ListJobs() error = %v", err)
	}
	if len(records) != 1 {
		t.Fatalf("records after 3 upserts = %d, want 1", len(records))
	}
	if records[0].Status != accountauth.StatusPending || !records[0].CreatedAt.Equal(createdAt) {
		t.Fatalf("record = %#v", records[0])
	}

	// 同一 Job 的状态推进必须覆盖原行，而不是再写一条新快照。
	finishedAt := createdAt.Add(90 * time.Second)
	completed := pending
	completed.Status = accountauth.StatusCompleted
	completed.UpdatedAt = finishedAt
	completed.ErrorCode = ""
	if err := store.UpsertJob(ctx, completed); err != nil {
		t.Fatalf("UpsertJob() completed error = %v", err)
	}
	record, found, err := store.GetJob(ctx, pending.ID)
	if err != nil || !found {
		t.Fatalf("GetJob() = %v, %v", found, err)
	}
	if record.Status != accountauth.StatusCompleted || !record.UpdatedAt.Equal(finishedAt) {
		t.Fatalf("record after upsert = %#v", record)
	}
	// 调用方没给 FinishedAt 时，终态行用 UpdatedAt 兜底（Node 推送路径依赖这一点）。
	if !record.FinishedAt.Equal(finishedAt) {
		t.Fatalf("FinishedAt after upsert = %s, want %s", record.FinishedAt, finishedAt)
	}
	records, _ = store.ListJobs(ctx, false)
	if len(records) != 1 {
		t.Fatalf("records after status change = %d, want 1", len(records))
	}
}

// 迟到的 pending 快照不能把已落库的终态改回活动状态。
//
// 这是持久层的状态机 CAS：Node 的 dirty 重试、Go 重启前遗留的推送都可能
// 在终态之后到达；如果照单全收，已经完成/过期的 Job 会重新变成「等待回调」，
// 前端会一直轮询一个永远不会推进的任务。
func TestOAuthJobStalePendingCannotReviveTerminal(t *testing.T) {
	store := openOAuthJobStore(t)
	ctx := context.Background()
	createdAt := time.Date(2026, 11, 5, 10, 0, 0, 0, time.UTC)
	completed := newOAuthJobRecord("job-terminal-guard", accountauth.StatusCompleted, createdAt)
	completed.UpdatedAt = createdAt.Add(time.Minute)
	completed.FinishedAt = createdAt.Add(time.Minute)
	completed.AccountRef = "acct_0123456789abcdef0123"
	completed.CLIAccountID = 42
	if err := store.UpsertJob(ctx, completed); err != nil {
		t.Fatalf("UpsertJob() completed error = %v", err)
	}

	stale := newOAuthJobRecord("job-terminal-guard", accountauth.StatusPending, createdAt)
	stale.UpdatedAt = createdAt.Add(2 * time.Minute)
	if err := store.UpsertJob(ctx, stale); err != nil {
		t.Fatalf("UpsertJob() pending error = %v", err)
	}
	// 第二个终态（例如迟到的失败回调）同样不能改写首次成功结果。
	secondTerminal := newOAuthJobRecord("job-terminal-guard", accountauth.StatusFailed, createdAt)
	secondTerminal.UpdatedAt = createdAt.Add(3 * time.Minute)
	secondTerminal.FinishedAt = secondTerminal.UpdatedAt
	secondTerminal.ErrorCode = "provider_rejected"
	if err := store.UpsertJob(ctx, secondTerminal); err != nil {
		t.Fatalf("UpsertJob() failed error = %v", err)
	}

	record, found, err := store.GetJob(ctx, completed.ID)
	if err != nil || !found {
		t.Fatalf("GetJob() = %v, %v", found, err)
	}
	if record.Status != accountauth.StatusCompleted {
		t.Fatalf("终态被迟到的 pending 复活: %#v", record)
	}
	if !record.UpdatedAt.Equal(completed.UpdatedAt) || !record.FinishedAt.Equal(completed.FinishedAt) {
		t.Fatalf("被忽略的旧快照改写了时间: %#v", record)
	}
	if record.AccountRef != completed.AccountRef || record.CLIAccountID != completed.CLIAccountID {
		t.Fatalf("终态账号结果被覆盖: %#v", record)
	}
}

// 过期是单向门：即使随后到达一个「完成」快照，也不能把状态改回来。
// 过期意味着 Go 已经确认该 Job 的 OAuth Flow 随进程消失，重放完成结果只会
// 制造「完成了但实际没有执行」的假象。
func TestOAuthJobExpiredIsFinal(t *testing.T) {
	store := openOAuthJobStore(t)
	ctx := context.Background()
	createdAt := time.Date(2026, 11, 5, 10, 0, 0, 0, time.UTC)
	if err := store.UpsertJob(ctx, newOAuthJobRecord("job-expired-final", accountauth.StatusPending, createdAt)); err != nil {
		t.Fatalf("UpsertJob() pending error = %v", err)
	}
	expiredAt := createdAt.Add(11 * time.Minute)
	if _, err := store.ExpirePendingJobs(ctx, expiredAt); err != nil {
		t.Fatalf("ExpirePendingJobs() error = %v", err)
	}

	late := newOAuthJobRecord("job-expired-final", accountauth.StatusCompleted, createdAt)
	late.UpdatedAt = expiredAt.Add(time.Minute)
	late.FinishedAt = late.UpdatedAt
	late.AccountRef = "acct_0123456789abcdef0123"
	late.CLIAccountID = 42
	if err := store.UpsertJob(ctx, late); err != nil {
		t.Fatalf("UpsertJob() late completed error = %v", err)
	}
	record, found, err := store.GetJob(ctx, late.ID)
	if err != nil || !found {
		t.Fatalf("GetJob() = %v, %v", found, err)
	}
	if record.Status != accountauth.StatusExpired || record.ErrorCode != "expired" {
		t.Fatalf("过期 Job 被完成快照复活: %#v", record)
	}
	if record.AccountRef != "" || record.CLIAccountID != 0 {
		t.Fatalf("过期 Job 接受了账号结果: %#v", record)
	}
}

// processing 不能倒回 pending：回调已经被唯一消费者领取，倒回会让第二个
// 回调再次领取并产生第二次 token 交换。
func TestOAuthJobProcessingCannotRegressToPending(t *testing.T) {
	store := openOAuthJobStore(t)
	ctx := context.Background()
	createdAt := time.Date(2026, 11, 5, 10, 0, 0, 0, time.UTC)
	processing := newOAuthJobRecord("job-processing-guard", accountauth.StatusProcessing, createdAt)
	processing.UpdatedAt = createdAt.Add(30 * time.Second)
	if err := store.UpsertJob(ctx, processing); err != nil {
		t.Fatalf("UpsertJob() processing error = %v", err)
	}
	stale := newOAuthJobRecord("job-processing-guard", accountauth.StatusPending, createdAt)
	stale.UpdatedAt = createdAt.Add(time.Minute)
	if err := store.UpsertJob(ctx, stale); err != nil {
		t.Fatalf("UpsertJob() pending error = %v", err)
	}
	record, found, err := store.GetJob(ctx, processing.ID)
	if err != nil || !found {
		t.Fatalf("GetJob() = %v, %v", found, err)
	}
	if record.Status != accountauth.StatusProcessing {
		t.Fatalf("processing 被 pending 覆盖: %#v", record)
	}
}

// 同一终态的重复推送必须允许精修账号结果：Node 可能先写 completed，
// 随后才补上 account_ref / cli_account_id。
func TestOAuthJobCompletedSnapshotCanBeRefined(t *testing.T) {
	store := openOAuthJobStore(t)
	ctx := context.Background()
	createdAt := time.Date(2026, 11, 5, 10, 0, 0, 0, time.UTC)
	completed := newOAuthJobRecord("job-completed-refine", accountauth.StatusCompleted, createdAt)
	completed.UpdatedAt = createdAt.Add(time.Minute)
	completed.FinishedAt = completed.UpdatedAt
	if err := store.UpsertJob(ctx, completed); err != nil {
		t.Fatalf("UpsertJob() completed error = %v", err)
	}
	refined := completed
	refined.UpdatedAt = createdAt.Add(2 * time.Minute)
	refined.AccountRef = "acct_0123456789abcdef0123"
	refined.CLIAccountID = 42
	if err := store.UpsertJob(ctx, refined); err != nil {
		t.Fatalf("UpsertJob() refined error = %v", err)
	}
	record, found, err := store.GetJob(ctx, completed.ID)
	if err != nil || !found {
		t.Fatalf("GetJob() = %v, %v", found, err)
	}
	if record.Status != accountauth.StatusCompleted ||
		record.AccountRef != refined.AccountRef ||
		record.CLIAccountID != refined.CLIAccountID ||
		!record.UpdatedAt.Equal(refined.UpdatedAt) {
		t.Fatalf("completed 快照精修失败: %#v", record)
	}
}

// DeleteJob 只删目标行；不存在时返回 false 而不是报错。
func TestOAuthJobDeleteRemovesOnlyTarget(t *testing.T) {
	store := openOAuthJobStore(t)
	ctx := context.Background()
	createdAt := time.Date(2026, 11, 5, 10, 0, 0, 0, time.UTC)
	for _, id := range []string{"job-keep", "job-delete"} {
		if err := store.UpsertJob(ctx, newOAuthJobRecord(id, accountauth.StatusFailed, createdAt)); err != nil {
			t.Fatalf("UpsertJob(%s) error = %v", id, err)
		}
	}
	deleted, err := store.DeleteJob(ctx, "job-delete")
	if err != nil || !deleted {
		t.Fatalf("DeleteJob() = %v, %v", deleted, err)
	}
	if _, found, err := store.GetJob(ctx, "job-delete"); err != nil || found {
		t.Fatalf("deleted job still present: found=%v err=%v", found, err)
	}
	if _, found, err := store.GetJob(ctx, "job-keep"); err != nil || !found {
		t.Fatalf("untargeted job was removed: found=%v err=%v", found, err)
	}
	if deleted, err := store.DeleteJob(ctx, "job-delete"); err != nil || deleted {
		t.Fatalf("second DeleteJob() = %v, %v", deleted, err)
	}
}

func TestOAuthJobUpsertRejectsIncompleteRecord(t *testing.T) {
	store := openOAuthJobStore(t)
	ctx := context.Background()
	valid := newOAuthJobRecord(
		"job-valid",
		accountauth.StatusPending,
		time.UnixMilli(1_700_000_000_000).UTC(),
	)
	missingID := valid
	missingID.ID = ""
	missingProvider := valid
	missingProvider.ProviderID = ""
	missingStatus := valid
	missingStatus.Status = ""
	missingCreatedAt := valid
	missingCreatedAt.CreatedAt = time.Time{}
	missingExpiresAt := valid
	missingExpiresAt.ExpiresAt = time.Time{}
	cases := map[string]accountauth.JobRecord{
		"缺少 job_id":   missingID,
		"缺少 provider": missingProvider,
		"缺少状态":        missingStatus,
		"缺少创建时间":      missingCreatedAt,
		"缺少过期时间":      missingExpiresAt,
	}
	for name, record := range cases {
		if err := store.UpsertJob(ctx, record); !errors.Is(err, ErrInvalidOAuthJobRecord) {
			t.Fatalf("%s: UpsertJob() error = %v", name, err)
		}
	}
	records, _ := store.ListJobs(ctx, false)
	if len(records) != 0 {
		t.Fatalf("records after rejected writes = %d, want 0", len(records))
	}
}

func TestOAuthJobTerminalSnapshotSurvivesRestart(t *testing.T) {
	aiHomeDir := t.TempDir()
	store := openOAuthJobStoreAt(t, aiHomeDir)
	ctx := context.Background()
	createdAt := time.Date(2026, 11, 5, 10, 0, 0, 0, time.UTC)
	failed := newOAuthJobRecord("job-terminal", accountauth.StatusPending, createdAt)
	failed.Status = accountauth.StatusFailed
	failed.ErrorCode = "provider_rejected"
	failed.ErrorMessage = "上游拒绝授权"
	failed.UpdatedAt = createdAt.Add(2 * time.Minute)
	failed.FinishedAt = createdAt.Add(2 * time.Minute)
	failed.AccountRef = "acct_0123456789abcdef0123"
	failed.CLIAccountID = 42
	if err := store.UpsertJob(ctx, failed); err != nil {
		t.Fatalf("UpsertJob() error = %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}

	// 重启后终态快照必须还能查到：这正是「Job 只在内存」的原始缺陷。
	reopened := openOAuthJobStoreAt(t, aiHomeDir)
	record, found, err := reopened.GetJob(ctx, failed.ID)
	if err != nil || !found {
		t.Fatalf("GetJob() after restart = %v, %v", found, err)
	}
	if record.Status != accountauth.StatusFailed ||
		record.ErrorCode != "provider_rejected" ||
		record.ErrorMessage != "上游拒绝授权" {
		t.Fatalf("record after restart = %#v", record)
	}
	// 终态结果列必须一起跨重启：只留状态码而不留账号结果，回放仍然是不完整的。
	if record.AccountRef != failed.AccountRef ||
		record.CLIAccountID != failed.CLIAccountID ||
		!record.FinishedAt.Equal(failed.FinishedAt) {
		t.Fatalf("terminal result after restart = %#v", record)
	}
	if !record.CreatedAt.Equal(createdAt) || !record.UpdatedAt.Equal(failed.UpdatedAt) {
		t.Fatalf("times after restart = %s / %s", record.CreatedAt, record.UpdatedAt)
	}
	active, err := reopened.ListJobs(ctx, true)
	if err != nil || len(active) != 0 {
		t.Fatalf("active jobs after restart = %d, %v", len(active), err)
	}
}

func TestOAuthJobListActiveOnlyFiltersTerminalStates(t *testing.T) {
	store := openOAuthJobStore(t)
	ctx := context.Background()
	base := time.Date(2026, 11, 5, 10, 0, 0, 0, time.UTC)
	statuses := []accountauth.Status{
		accountauth.StatusPending,
		accountauth.StatusProcessing,
		accountauth.StatusCompleted,
		accountauth.StatusFailed,
		accountauth.StatusCancelled,
		accountauth.StatusExpired,
	}
	for index, status := range statuses {
		record := newOAuthJobRecord(
			"job-status-"+string(rune('a'+index)),
			status,
			base.Add(time.Duration(index)*time.Second),
		)
		if err := store.UpsertJob(ctx, record); err != nil {
			t.Fatalf("UpsertJob(%s) error = %v", status, err)
		}
	}
	all, err := store.ListJobs(ctx, false)
	if err != nil || len(all) != len(statuses) {
		t.Fatalf("ListJobs(false) = %d, %v", len(all), err)
	}
	active, err := store.ListJobs(ctx, true)
	if err != nil {
		t.Fatalf("ListJobs(true) error = %v", err)
	}
	if len(active) != 2 {
		t.Fatalf("ListJobs(true) = %d, want 2", len(active))
	}
	for _, record := range active {
		if record.Status != accountauth.StatusPending &&
			record.Status != accountauth.StatusProcessing {
			t.Fatalf("active list contains terminal status %q", record.Status)
		}
	}
	// 列表按最新创建在前，调用方不必再排序。
	if !active[0].CreatedAt.After(active[1].CreatedAt) {
		t.Fatalf("active order = %s then %s", active[0].CreatedAt, active[1].CreatedAt)
	}
}

func TestOAuthJobExpirePendingJobsMarksUnfinishedOnly(t *testing.T) {
	store := openOAuthJobStore(t)
	ctx := context.Background()
	base := time.Date(2026, 11, 5, 10, 0, 0, 0, time.UTC)
	ids := []string{"job-pending", "job-processing", "job-completed"}
	statuses := []accountauth.Status{
		accountauth.StatusPending,
		accountauth.StatusProcessing,
		accountauth.StatusCompleted,
	}
	for index, id := range ids {
		record := newOAuthJobRecord(id, statuses[index], base.Add(time.Duration(index)*time.Second))
		if err := store.UpsertJob(ctx, record); err != nil {
			t.Fatalf("UpsertJob(%s) error = %v", id, err)
		}
	}
	restartAt := base.Add(30 * time.Minute)
	affected, err := store.ExpirePendingJobs(ctx, restartAt)
	if err != nil {
		t.Fatalf("ExpirePendingJobs() error = %v", err)
	}
	if affected != 2 {
		t.Fatalf("ExpirePendingJobs() = %d, want 2", affected)
	}
	for _, id := range []string{"job-pending", "job-processing"} {
		record, found, err := store.GetJob(ctx, id)
		if err != nil || !found {
			t.Fatalf("GetJob(%s) = %v, %v", id, found, err)
		}
		if record.Status != accountauth.StatusExpired || record.ErrorCode != "expired" {
			t.Fatalf("%s after expire = %#v", id, record)
		}
		if !record.UpdatedAt.Equal(restartAt) || !record.FinishedAt.Equal(restartAt) {
			t.Fatalf(
				"%s updatedAt/finishedAt = %s / %s, want %s",
				id,
				record.UpdatedAt,
				record.FinishedAt,
				restartAt,
			)
		}
	}
	completed, _, err := store.GetJob(ctx, "job-completed")
	if err != nil {
		t.Fatalf("GetJob(job-completed) error = %v", err)
	}
	if completed.Status != accountauth.StatusCompleted || completed.ErrorCode != "" {
		t.Fatalf("completed job was touched: %#v", completed)
	}
	// 幂等：没有未完成 Job 时不再产生写入。
	if affected, err := store.ExpirePendingJobs(ctx, restartAt.Add(time.Minute)); err != nil || affected != 0 {
		t.Fatalf("second ExpirePendingJobs() = %d, %v", affected, err)
	}
}

func TestOAuthJobsSchemaIsPresentAtCurrentVersion(t *testing.T) {
	store := openOAuthJobStore(t)
	var version int
	if err := store.db.QueryRowContext(
		context.Background(),
		"PRAGMA user_version",
	).Scan(&version); err != nil {
		t.Fatalf("read user_version error = %v", err)
	}
	if version != SchemaVersion {
		t.Fatalf("user_version = %d, want %d", version, SchemaVersion)
	}
	assertSQLiteObjectsExist(t, store, "oauth_jobs",
		"idx_oauth_jobs_provider_status",
		"idx_oauth_jobs_updated_at",
	)
}

func TestOAuthJobsForwardMigrationFromV16(t *testing.T) {
	aiHomeDir := t.TempDir()
	store := openOAuthJobStoreAt(t, aiHomeDir)
	ctx := context.Background()
	// 把全新库降回「v16 但还没有 oauth_jobs」的形态，模拟真实升级路径。
	// v18 的采样表、v19 的账本/检测表、v20 的快照列与 v21 的探测表同样要回退，
	// 否则前向迁移会撞到已存在的表 / 列。
	if _, err := store.db.ExecContext(ctx, "DROP TABLE oauth_jobs"); err != nil {
		t.Fatalf("drop oauth_jobs error = %v", err)
	}
	for _, table := range []string{
		"account_quota_window_samples",
		"account_quota_window_ledger",
		"account_quota_detector_state",
		"account_quota_reset_events",
		"account_model_probes",
		// v22/v23 新增的别名表也必须回退：夹具要代表真正的 v16 结构，
		// 否则重放 v23 的 ALTER TABLE ADD COLUMN 会撞上「列已存在」。
		"model_alias",
		"model_alias_meta",
	} {
		if _, err := store.db.ExecContext(ctx, "DROP TABLE "+table); err != nil {
			t.Fatalf("drop %s error = %v", table, err)
		}
	}
	if _, err := store.db.ExecContext(ctx, "ALTER TABLE account_usage DROP COLUMN plan_type"); err != nil {
		t.Fatalf("drop account_usage.plan_type error = %v", err)
	}
	// v26 给 usage_ledger 加了幂等导入键（列 + 部分唯一索引）；夹具代表真正的 v16
	// 结构，回退时一并去掉，否则重放 v26 会撞上「列已存在」。
	if _, err := store.db.ExecContext(ctx, "DROP INDEX IF EXISTS idx_usage_ledger_source_key"); err != nil {
		t.Fatalf("drop idx_usage_ledger_source_key error = %v", err)
	}
	if _, err := store.db.ExecContext(ctx, "ALTER TABLE usage_ledger DROP COLUMN source_key"); err != nil {
		t.Fatalf("drop usage_ledger.source_key error = %v", err)
	}
	if _, err := store.db.ExecContext(ctx, "PRAGMA user_version = 16"); err != nil {
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
	assertSQLiteObjectsExist(t, upgraded, "oauth_jobs",
		"idx_oauth_jobs_provider_status",
		"idx_oauth_jobs_updated_at",
	)
	record := newOAuthJobRecord(
		"job-after-migration",
		accountauth.StatusPending,
		time.Date(2026, 11, 5, 10, 0, 0, 0, time.UTC),
	)
	if err := upgraded.UpsertJob(ctx, record); err != nil {
		t.Fatalf("UpsertJob() after migration error = %v", err)
	}
}

// TestOAuthJobsTerminalColumnsForwardMigrationFromV28 验证 v29 可回放：
// 把 oauth_jobs 退回 v28 的列结构（保留既有行），再让 Open 重放 v29，
// 旧行必须原样保留，新列以默认值补齐，之后可以正常写入终态结果。
func TestOAuthJobsTerminalColumnsForwardMigrationFromV28(t *testing.T) {
	aiHomeDir := t.TempDir()
	store := openOAuthJobStoreAt(t, aiHomeDir)
	ctx := context.Background()
	createdAt := time.Date(2026, 11, 5, 10, 0, 0, 0, time.UTC)
	legacy := newOAuthJobRecord("job-v28", accountauth.StatusFailed, createdAt)
	legacy.ErrorCode = "provider_rejected"
	legacy.UpdatedAt = createdAt.Add(time.Minute)
	if err := store.UpsertJob(ctx, legacy); err != nil {
		t.Fatalf("UpsertJob() error = %v", err)
	}

	// 夹具必须代表真正的 v28 结构，否则重放 v29 会撞上「列已存在」。
	for _, column := range []string{"account_ref", "cli_account_id", "finished_at_ms"} {
		if _, err := store.db.ExecContext(
			ctx,
			"ALTER TABLE oauth_jobs DROP COLUMN "+column,
		); err != nil {
			t.Fatalf("drop oauth_jobs.%s error = %v", column, err)
		}
	}
	if _, err := store.db.ExecContext(ctx, "PRAGMA user_version = 28"); err != nil {
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
	record, found, err := upgraded.GetJob(ctx, legacy.ID)
	if err != nil || !found {
		t.Fatalf("GetJob() after upgrade = %v, %v", found, err)
	}
	if record.Status != accountauth.StatusFailed || record.ErrorCode != "provider_rejected" {
		t.Fatalf("legacy row after upgrade = %#v", record)
	}
	// 旧行没有终态结果列，迁移后以默认值补齐。
	if record.AccountRef != "" || record.CLIAccountID != 0 || !record.FinishedAt.IsZero() {
		t.Fatalf("legacy terminal columns = %#v", record)
	}

	record.AccountRef = "acct_0123456789abcdef0123"
	record.CLIAccountID = 42
	record.FinishedAt = legacy.UpdatedAt
	if err := upgraded.UpsertJob(ctx, record); err != nil {
		t.Fatalf("UpsertJob() after upgrade error = %v", err)
	}
	reloaded, _, err := upgraded.GetJob(ctx, legacy.ID)
	if err != nil {
		t.Fatalf("GetJob() reloaded error = %v", err)
	}
	if reloaded.AccountRef != record.AccountRef ||
		reloaded.CLIAccountID != record.CLIAccountID ||
		!reloaded.FinishedAt.Equal(record.FinishedAt) {
		t.Fatalf("terminal columns after upgrade = %#v", reloaded)
	}
}

// assertSQLiteObjectsExist 检查表/索引真实存在，避免「迁移写了但没生效」。
func assertSQLiteObjectsExist(t *testing.T, store *Store, names ...string) {
	t.Helper()
	for _, name := range names {
		var count int
		const objectSQL = `
			SELECT COUNT(*)
			FROM sqlite_schema
			WHERE name = ? AND type IN ('table', 'index')`
		if err := store.db.QueryRowContext(
			context.Background(),
			objectSQL,
			name,
		).Scan(&count); err != nil {
			t.Fatalf("check %s error = %v", name, err)
		}
		if count != 1 {
			t.Fatalf("sqlite object %q count = %d, want 1", name, count)
		}
	}
}

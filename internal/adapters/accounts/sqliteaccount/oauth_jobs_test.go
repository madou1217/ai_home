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
	records, _ = store.ListJobs(ctx, false)
	if len(records) != 1 {
		t.Fatalf("records after status change = %d, want 1", len(records))
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
		if !record.UpdatedAt.Equal(restartAt) {
			t.Fatalf("%s updatedAt = %s, want %s", id, record.UpdatedAt, restartAt)
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

package sqliteaccount

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	accountauth "github.com/madou1217/ai_home/application/accountauth"
)

// ErrInvalidOAuthJobRecord 表示调用方提交的 Job 快照缺少主键或必要时间。
//
// 适配器只落「公开快照」，不做业务状态机判断；但 job_id 为空或时间缺失会让
// 记录无法被查询、也无法参与终态回收，属于写库前就必须拒绝的输入。
var ErrInvalidOAuthJobRecord = errors.New("OAuth Job 快照无效")

// oauthJobColumns 固定读写列顺序，保证 INSERT、SELECT 与 scan 使用同一套字段。
const oauthJobColumns = `
	job_id, provider_id, purpose, target_ref, status,
	created_at_ms, expires_at_ms, updated_at_ms,
	error_code, error_message,
	account_ref, cli_account_id, finished_at_ms`

const (
	// upsertOAuthJobSQL 以 job_id 为唯一键覆盖写入。
	//
	// Job 的生命周期是「同一行反复改状态」，因此必须是 upsert 而不是 insert：
	// 调用方不需要先查存在性，重启恢复后的重放也能保持幂等。
	//
	// 终态结果列只在来者是终态时覆盖：迟到的 pending/processing 推送
	// （例如重启前遗留的 dirty 重放）不能把已落库的账号结果抹成空值。
	upsertOAuthJobSQL = `
		INSERT INTO oauth_jobs (` + oauthJobColumns + `)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (job_id) DO UPDATE SET
			provider_id = excluded.provider_id,
			purpose = excluded.purpose,
			target_ref = excluded.target_ref,
			status = excluded.status,
			created_at_ms = excluded.created_at_ms,
			expires_at_ms = excluded.expires_at_ms,
			updated_at_ms = excluded.updated_at_ms,
			error_code = excluded.error_code,
			error_message = excluded.error_message,
			account_ref = CASE
				WHEN ? THEN oauth_jobs.account_ref ELSE excluded.account_ref END,
			cli_account_id = CASE
				WHEN ? THEN oauth_jobs.cli_account_id ELSE excluded.cli_account_id END,
			finished_at_ms = CASE
				WHEN ? THEN oauth_jobs.finished_at_ms ELSE excluded.finished_at_ms END`

	getOAuthJobSQL = `
		SELECT ` + oauthJobColumns + `
		  FROM oauth_jobs
		 WHERE job_id = ?`

	listOAuthJobsSQL = `
		SELECT ` + oauthJobColumns + `
		  FROM oauth_jobs
		 ORDER BY created_at_ms DESC, job_id ASC`

	// listActiveOAuthJobsSQL 只保留活动 Job：
	// 终态行再多也不该出现在「还有没有在进行的登录」这类查询里。
	listActiveOAuthJobsSQL = `
		SELECT ` + oauthJobColumns + `
		  FROM oauth_jobs
		 WHERE status IN (?, ?)
		 ORDER BY created_at_ms DESC, job_id ASC`

	// expirePendingOAuthJobsSQL 一次性把未完成 Job 收敛为 expired。
	//
	// 进程重启后内存里的 OAuth Flow（state / PKCE / verifier）已经不存在，
	// 这些 Job 永远不可能再完成；留在 pending 会让「同 Provider 单活」永远拒绝新登录。
	expirePendingOAuthJobsSQL = `
		UPDATE oauth_jobs
		   SET status = ?,
		       updated_at_ms = ?,
		       error_code = ?,
		       finished_at_ms = ?
		 WHERE status IN (?, ?)`
)

// UpsertJob 覆盖写入一个 OAuth Job 公开快照。
func (store *Store) UpsertJob(ctx context.Context, record accountauth.JobRecord) error {
	if store == nil || store.db == nil {
		return ErrIncompatibleDatabase
	}
	if ctx == nil {
		return ErrInvalidOAuthJobRecord
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if record.ID == "" ||
		record.ProviderID == "" ||
		record.Purpose == "" ||
		record.Status == "" ||
		record.CreatedAt.IsZero() ||
		record.ExpiresAt.IsZero() {
		return ErrInvalidOAuthJobRecord
	}
	// updated_at_ms 参与终态回收排序；调用方没显式更新时间时用创建时间兜底，
	// 否则零时间会被写成 0，让这条记录永远排在「最旧」而被优先回收。
	updatedAt := record.UpdatedAt
	if updatedAt.IsZero() {
		updatedAt = record.CreatedAt
	}
	// finished_at_ms 只对终态有意义。调用方未显式给出时用 updatedAt 兜底：
	// 否则零时间会被写成负数毫秒，违反列约束。
	var finishedAtMS int64
	if !record.FinishedAt.IsZero() {
		finishedAtMS = record.FinishedAt.UnixMilli()
	} else if record.Status.IsTerminal() {
		finishedAtMS = updatedAt.UnixMilli()
	}
	// 非终态快照不携带账号结果，冲突时保留已有终态值。
	preserveTerminalResult := 0
	if !record.Status.IsTerminal() {
		preserveTerminalResult = 1
	}
	if _, err := store.db.ExecContext(
		ctx,
		upsertOAuthJobSQL,
		record.ID,
		record.ProviderID,
		string(record.Purpose),
		record.TargetRef,
		string(record.Status),
		record.CreatedAt.UnixMilli(),
		record.ExpiresAt.UnixMilli(),
		updatedAt.UnixMilli(),
		record.ErrorCode,
		record.ErrorMessage,
		record.AccountRef,
		record.CLIAccountID,
		finishedAtMS,
		preserveTerminalResult,
		preserveTerminalResult,
		preserveTerminalResult,
	); err != nil {
		return fmt.Errorf("写入 OAuth Job 快照失败: %w", err)
	}
	return nil
}

// GetJob 读取单个 OAuth Job 快照；不存在时 found 为 false 且不返回错误。
func (store *Store) GetJob(
	ctx context.Context,
	jobID string,
) (accountauth.JobRecord, bool, error) {
	if store == nil || store.db == nil {
		return accountauth.JobRecord{}, false, ErrIncompatibleDatabase
	}
	if ctx == nil || jobID == "" {
		return accountauth.JobRecord{}, false, ErrInvalidOAuthJobRecord
	}
	if err := ctx.Err(); err != nil {
		return accountauth.JobRecord{}, false, err
	}
	record, err := scanOAuthJobRecord(
		store.db.QueryRowContext(ctx, getOAuthJobSQL, jobID),
	)
	if errors.Is(err, sql.ErrNoRows) {
		return accountauth.JobRecord{}, false, nil
	}
	if err != nil {
		return accountauth.JobRecord{}, false, fmt.Errorf("读取 OAuth Job 快照失败: %w", err)
	}
	return record, true, nil
}

// ListJobs 返回 Job 快照列表；activeOnly 只保留 pending/processing。
//
// 排序固定为「最新创建在前」，让调用方不必自己再排一次；
// job_id 作为次级键保证同一毫秒创建的记录顺序稳定。
func (store *Store) ListJobs(
	ctx context.Context,
	activeOnly bool,
) ([]accountauth.JobRecord, error) {
	if store == nil || store.db == nil {
		return nil, ErrIncompatibleDatabase
	}
	if ctx == nil {
		return nil, ErrInvalidOAuthJobRecord
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	query := listOAuthJobsSQL
	var arguments []any
	if activeOnly {
		query = listActiveOAuthJobsSQL
		arguments = []any{
			string(accountauth.StatusPending),
			string(accountauth.StatusProcessing),
		}
	}
	rows, err := store.db.QueryContext(ctx, query, arguments...)
	if err != nil {
		return nil, fmt.Errorf("查询 OAuth Job 快照失败: %w", err)
	}
	defer func() {
		_ = rows.Close()
	}()

	records := make([]accountauth.JobRecord, 0, 16)
	for rows.Next() {
		record, scanErr := scanOAuthJobRecord(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		records = append(records, record)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历 OAuth Job 快照失败: %w", err)
	}
	return records, nil
}

// ExpirePendingJobs 把全部未完成 Job 标成 expired，并返回受影响行数。
//
// 幂等：第二次调用不会再有 pending/processing 行，返回 0。
func (store *Store) ExpirePendingJobs(
	ctx context.Context,
	now time.Time,
) (int64, error) {
	if store == nil || store.db == nil {
		return 0, ErrIncompatibleDatabase
	}
	if ctx == nil || now.IsZero() {
		return 0, ErrInvalidOAuthJobRecord
	}
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	result, err := store.db.ExecContext(
		ctx,
		expirePendingOAuthJobsSQL,
		string(accountauth.StatusExpired),
		now.UnixMilli(),
		string(accountauth.StatusExpired),
		now.UnixMilli(),
		string(accountauth.StatusPending),
		string(accountauth.StatusProcessing),
	)
	if err != nil {
		return 0, fmt.Errorf("过期 OAuth Job 快照失败: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("读取 OAuth Job 过期结果失败: %w", err)
	}
	return affected, nil
}

// scanOAuthJobRecord 把一行还原成不含任何敏感值的公开快照。
//
// 复用包内已有的 rowScanner，让 *sql.Row 与 *sql.Rows 走同一套列顺序。
func scanOAuthJobRecord(scanner rowScanner) (accountauth.JobRecord, error) {
	var record accountauth.JobRecord
	var purpose, status string
	var createdAtMS, expiresAtMS, updatedAtMS, finishedAtMS int64
	if err := scanner.Scan(
		&record.ID,
		&record.ProviderID,
		&purpose,
		&record.TargetRef,
		&status,
		&createdAtMS,
		&expiresAtMS,
		&updatedAtMS,
		&record.ErrorCode,
		&record.ErrorMessage,
		&record.AccountRef,
		&record.CLIAccountID,
		&finishedAtMS,
	); err != nil {
		return accountauth.JobRecord{}, err
	}
	record.Purpose = accountauth.Purpose(purpose)
	record.Status = accountauth.Status(status)
	record.CreatedAt = timeFromUnixMilli(createdAtMS)
	record.ExpiresAt = timeFromUnixMilli(expiresAtMS)
	record.UpdatedAt = timeFromUnixMilli(updatedAtMS)
	record.FinishedAt = timeFromUnixMilli(finishedAtMS)
	return record, nil
}

// 编译期确认适配器实现了应用层端口，端口后续增删方法时这里先红。
var _ accountauth.JobStore = (*Store)(nil)

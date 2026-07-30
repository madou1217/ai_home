package sqliteaccount

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	usageapp "github.com/madou1217/ai_home/application/accountusage"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
)

var _ usageapp.SnapshotStore = (*Store)(nil)

// ReplaceUsageSnapshot 在单事务中全量替换账号当前额度；失败时保留旧快照。
func (store *Store) ReplaceUsageSnapshot(
	ctx context.Context,
	snapshot usagecore.Snapshot,
) error {
	if store == nil ||
		store.db == nil ||
		ctx == nil ||
		!snapshot.IsValid() {
		return usageapp.ErrInvalidSnapshot
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("开始账号额度替换事务失败: %w", err)
	}
	defer func() {
		_ = transaction.Rollback()
	}()
	providerID, err := readUsageAccountProvider(
		ctx,
		transaction,
		snapshot.AccountRef(),
	)
	if err != nil {
		return err
	}
	if providerID != snapshot.ProviderID() {
		return usageapp.ErrInvalidSnapshot
	}
	if _, err := transaction.ExecContext(
		ctx,
		"DELETE FROM account_usage WHERE account_ref = ?",
		snapshot.AccountRef().String(),
	); err != nil {
		return fmt.Errorf("删除账号旧额度快照失败: %w", err)
	}
	if err := insertUsageEntries(ctx, transaction, snapshot); err != nil {
		return err
	}
	if err := transaction.Commit(); err != nil {
		return fmt.Errorf("提交账号额度替换事务失败: %w", err)
	}
	return nil
}

// GetUsageSnapshot 按主键前缀读取最近一次成功的完整额度快照。
func (store *Store) GetUsageSnapshot(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) (usagecore.Snapshot, error) {
	if store == nil ||
		store.db == nil ||
		ctx == nil ||
		!accountRef.IsValid() {
		return usagecore.Snapshot{}, usageapp.ErrInvalidRequest
	}
	if err := ctx.Err(); err != nil {
		return usagecore.Snapshot{}, err
	}
	const query = `
		SELECT a.provider_id,
		       u.limit_id, u.limit_name, u.bucket, u.kind, u.scope, u.scope_key,
		       u.remaining_bps, u.availability, u.window_seconds, u.reset_at_ms,
		       u.source, u.captured_at_ms
		FROM account_usage AS u
		JOIN accounts AS a ON a.account_ref = u.account_ref
		WHERE u.account_ref = ?
		ORDER BY u.limit_id, u.bucket`
	rows, err := store.db.QueryContext(ctx, query, accountRef.String())
	if err != nil {
		return usagecore.Snapshot{}, fmt.Errorf("查询账号额度快照失败: %w", err)
	}
	defer func() {
		_ = rows.Close()
	}()

	var providerID, source string
	var capturedAtMS int64
	entries := make([]usagecore.EntryInput, 0, 8)
	for rows.Next() {
		entry, metadata, err := scanUsageEntry(rows)
		if err != nil {
			return usagecore.Snapshot{}, err
		}
		if len(entries) == 0 {
			providerID = metadata.providerID
			source = metadata.source
			capturedAtMS = metadata.capturedAtMS
		} else if providerID != metadata.providerID ||
			source != metadata.source ||
			capturedAtMS != metadata.capturedAtMS {
			return usagecore.Snapshot{}, ErrIncompatibleDatabase
		}
		entries = append(entries, entry)
	}
	if err := rows.Err(); err != nil {
		return usagecore.Snapshot{}, fmt.Errorf("遍历账号额度快照失败: %w", err)
	}
	if len(entries) == 0 {
		return usagecore.Snapshot{}, usageapp.ErrSnapshotNotFound
	}
	snapshot, err := usagecore.NewSnapshot(usagecore.SnapshotInput{
		AccountRef: accountRef,
		ProviderID: providerID,
		Source:     source,
		CapturedAt: time.UnixMilli(capturedAtMS).UTC(),
		Entries:    entries,
	})
	if err != nil {
		return usagecore.Snapshot{}, ErrIncompatibleDatabase
	}
	return snapshot, nil
}

// usageMetadata 是同一快照每行必须一致的账号外部元数据。
type usageMetadata struct {
	providerID   string
	source       string
	capturedAtMS int64
}

// scanUsageEntry 把可空 SQLite 标量恢复为领域输入。
func scanUsageEntry(row rowScanner) (usagecore.EntryInput, usageMetadata, error) {
	var entry usagecore.EntryInput
	var kind, scope, availability string
	var remainingBPS, windowSeconds, resetAtMS sql.NullInt64
	var metadata usageMetadata
	if err := row.Scan(
		&metadata.providerID,
		&entry.LimitID,
		&entry.LimitName,
		&entry.Bucket,
		&kind,
		&scope,
		&entry.ScopeKey,
		&remainingBPS,
		&availability,
		&windowSeconds,
		&resetAtMS,
		&metadata.source,
		&metadata.capturedAtMS,
	); err != nil {
		return usagecore.EntryInput{}, usageMetadata{},
			fmt.Errorf("读取账号额度条目失败: %w", err)
	}
	entry.Kind = usagecore.Kind(kind)
	entry.Scope = usagecore.Scope(scope)
	entry.Availability = usagecore.Availability(availability)
	if remainingBPS.Valid {
		if remainingBPS.Int64 < 0 || remainingBPS.Int64 > 10_000 {
			return usagecore.EntryInput{}, usageMetadata{}, ErrIncompatibleDatabase
		}
		entry.HasRemaining = true
		entry.RemainingBasisPoints = uint16(remainingBPS.Int64)
	}
	if windowSeconds.Valid {
		entry.WindowSeconds = windowSeconds.Int64
	}
	if resetAtMS.Valid {
		entry.ResetAt = time.UnixMilli(resetAtMS.Int64).UTC()
	}
	if _, err := usagecore.NewEntry(entry); err != nil {
		return usagecore.EntryInput{}, usageMetadata{}, ErrIncompatibleDatabase
	}
	return entry, metadata, nil
}

// readUsageAccountProvider 确认目标账号存在并返回其不可变 Provider。
func readUsageAccountProvider(
	ctx context.Context,
	transaction *sql.Tx,
	accountRef accountcore.AccountRef,
) (string, error) {
	var providerID string
	err := transaction.QueryRowContext(
		ctx,
		"SELECT provider_id FROM accounts WHERE account_ref = ? LIMIT 1",
		accountRef.String(),
	).Scan(&providerID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", usageapp.ErrSnapshotNotFound
	}
	if err != nil {
		return "", fmt.Errorf("读取账号额度所属 Provider 失败: %w", err)
	}
	return providerID, nil
}

// insertUsageEntries 使用一条预编译语句写入完整排序快照。
func insertUsageEntries(
	ctx context.Context,
	transaction *sql.Tx,
	snapshot usagecore.Snapshot,
) error {
	const statement = `
		INSERT INTO account_usage (
			account_ref, limit_id, limit_name, bucket, kind, scope, scope_key,
			remaining_bps, availability, window_seconds, reset_at_ms,
			source, captured_at_ms
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	prepared, err := transaction.PrepareContext(ctx, statement)
	if err != nil {
		return fmt.Errorf("准备账号额度写入失败: %w", err)
	}
	defer func() {
		_ = prepared.Close()
	}()
	for _, entry := range snapshot.Entries() {
		if _, err := prepared.ExecContext(
			ctx,
			snapshot.AccountRef().String(),
			entry.LimitID(),
			entry.LimitName(),
			entry.Bucket(),
			string(entry.Kind()),
			string(entry.Scope()),
			entry.ScopeKey(),
			nullableRemaining(entry),
			string(entry.Availability()),
			nullablePositive(entry.WindowSeconds()),
			nullableTime(entry.ResetAt()),
			snapshot.Source(),
			snapshot.CapturedAt().UnixMilli(),
		); err != nil {
			return fmt.Errorf("写入账号额度条目失败: %w", err)
		}
	}
	return nil
}

// nullableRemaining 区分未知剩余比例和明确为零。
func nullableRemaining(entry usagecore.Entry) any {
	value, known := entry.RemainingBasisPoints()
	if !known {
		return nil
	}
	return int64(value)
}

// nullablePositive 把领域零值转换为 SQLite NULL。
func nullablePositive(value int64) any {
	if value == 0 {
		return nil
	}
	return value
}

// nullableTime 把可选 UTC 时间转换为 Unix 毫秒。
func nullableTime(value time.Time) any {
	if value.IsZero() {
		return nil
	}
	return value.UnixMilli()
}

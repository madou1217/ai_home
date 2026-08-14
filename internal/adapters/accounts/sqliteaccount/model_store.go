package sqliteaccount

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

var _ accountapp.AccountModelStore = (*Store)(nil)

// ListAccountModels 返回按模型 ID 排序的完整自动发现与人工覆盖关系。
func (store *Store) ListAccountModels(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) ([]accountapp.AccountModel, error) {
	if store == nil || store.db == nil || !accountRef.IsValid() {
		return nil, accountapp.ErrInvalidAccountModel
	}
	exists, err := store.accountExists(ctx, store.db, accountRef)
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, accountapp.ErrAccountNotFound
	}
	return store.listAccountModels(ctx, store.db, accountRef)
}

// ReplaceDiscoveredModels 全量替换上游发现标记，同时保留人工启用或禁用。
func (store *Store) ReplaceDiscoveredModels(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	models []runtimecore.ModelID,
	updatedAt time.Time,
) ([]accountapp.AccountModel, error) {
	return store.replaceDiscoveredModels(
		ctx,
		accountRef,
		models,
		time.Time{},
		updatedAt,
	)
}

// ReplaceDiscoveredModelsIfCredentialVersion 仅在模型发现使用的凭据仍为当前版本时，
// 原子替换上游发现标记，防止旧凭据结果覆盖轮换或重登后的模型快照。
func (store *Store) ReplaceDiscoveredModelsIfCredentialVersion(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	models []runtimecore.ModelID,
	expectedCredentialUpdatedAt time.Time,
	updatedAt time.Time,
) ([]accountapp.AccountModel, error) {
	if !validPersistedModelTime(expectedCredentialUpdatedAt) {
		return nil, accountapp.ErrInvalidDiscoveredModels
	}
	return store.replaceDiscoveredModels(
		ctx,
		accountRef,
		models,
		expectedCredentialUpdatedAt,
		updatedAt,
	)
}

// replaceDiscoveredModels 复用同一模型替换事务；非零凭据版本启用 CAS 门禁。
func (store *Store) replaceDiscoveredModels(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	models []runtimecore.ModelID,
	expectedCredentialUpdatedAt time.Time,
	updatedAt time.Time,
) ([]accountapp.AccountModel, error) {
	if store == nil ||
		store.db == nil ||
		store.routes == nil ||
		!accountRef.IsValid() ||
		!validPersistedModelTime(updatedAt) ||
		!accountapp.ValidDiscoveredModelIDs(models) {
		return nil, accountapp.ErrInvalidDiscoveredModels
	}
	store.routingWrites.Lock()
	defer store.routingWrites.Unlock()
	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("开始账号模型刷新事务失败: %w", err)
	}
	defer func() {
		_ = transaction.Rollback()
	}()
	exists, err := store.accountExists(ctx, transaction, accountRef)
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, accountapp.ErrAccountNotFound
	}
	if !expectedCredentialUpdatedAt.IsZero() {
		matched, err := matchesCredentialVersion(
			ctx,
			transaction,
			accountRef,
			expectedCredentialUpdatedAt,
		)
		if err != nil {
			return nil, err
		}
		if !matched {
			return nil, accountapp.ErrCredentialConflict
		}
	}
	if err := replaceDiscoveredModelRows(
		ctx,
		transaction,
		accountRef,
		models,
		updatedAt.UnixMilli(),
	); err != nil {
		return nil, err
	}
	snapshot, err := store.listAccountModels(ctx, transaction, accountRef)
	if err != nil {
		return nil, err
	}
	if err := transaction.Commit(); err != nil {
		return nil, fmt.Errorf("提交账号模型刷新事务失败: %w", err)
	}
	if err := store.publishAccountModels(accountRef, snapshot); err != nil {
		return nil, err
	}
	return snapshot, nil
}

// matchesCredentialVersion 在当前写事务内锁定并核对凭据版本。
func matchesCredentialVersion(
	ctx context.Context,
	executor statementExecutor,
	accountRef accountcore.AccountRef,
	expectedUpdatedAt time.Time,
) (bool, error) {
	const statement = `
		UPDATE account_credentials
		SET updated_at_ms = updated_at_ms
		WHERE account_ref = ? AND updated_at_ms = ?`
	result, err := executor.ExecContext(
		ctx,
		statement,
		accountRef.String(),
		expectedUpdatedAt.UnixMilli(),
	)
	if err != nil {
		return false, fmt.Errorf("核对账号凭据版本失败: %w", err)
	}
	matched, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("读取账号凭据版本匹配结果失败: %w", err)
	}
	return matched == 1, nil
}

// replaceDiscoveredModelRows 在调用方事务内替换发现标记并保留人工覆盖。
func replaceDiscoveredModelRows(
	ctx context.Context,
	executor statementExecutor,
	accountRef accountcore.AccountRef,
	models []runtimecore.ModelID,
	updatedAtMS int64,
) error {
	if !accountapp.ValidDiscoveredModelIDs(models) {
		return accountapp.ErrInvalidDiscoveredModels
	}
	const clearDiscovered = `
		UPDATE account_models
		SET upstream_available = 0, updated_at_ms = ?
		WHERE account_ref = ?`
	if _, err := executor.ExecContext(
		ctx,
		clearDiscovered,
		updatedAtMS,
		accountRef.String(),
	); err != nil {
		return fmt.Errorf("清理账号旧模型发现标记失败: %w", err)
	}
	const upsertDiscovered = `
		INSERT INTO account_models (
			account_ref, model_id, upstream_available, manual_policy, updated_at_ms
		) VALUES (?, ?, 1, 'inherit', ?)
		ON CONFLICT (account_ref, model_id) DO UPDATE SET
			upstream_available = 1,
			updated_at_ms = excluded.updated_at_ms`
	for _, modelID := range models {
		if _, err := executor.ExecContext(
			ctx,
			upsertDiscovered,
			accountRef.String(),
			modelID.String(),
			updatedAtMS,
		); err != nil {
			return fmt.Errorf("写入账号发现模型失败: %w", err)
		}
	}
	const removeInheritedMissing = `
		DELETE FROM account_models
		WHERE account_ref = ?
		  AND upstream_available = 0
		  AND manual_policy = 'inherit'`
	if _, err := executor.ExecContext(
		ctx,
		removeInheritedMissing,
		accountRef.String(),
	); err != nil {
		return fmt.Errorf("删除账号失效模型关系失败: %w", err)
	}
	return nil
}

// SetManualModelPolicy 设置人工覆盖，并清理没有上游来源的 inherit 空行。
func (store *Store) SetManualModelPolicy(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	modelID runtimecore.ModelID,
	policy accountapp.ModelManualPolicy,
	updatedAt time.Time,
) ([]accountapp.AccountModel, error) {
	if store == nil ||
		store.db == nil ||
		store.routes == nil ||
		!accountRef.IsValid() ||
		!modelID.IsValid() ||
		!policy.IsValid() ||
		!validPersistedModelTime(updatedAt) {
		return nil, accountapp.ErrInvalidAccountModel
	}
	store.routingWrites.Lock()
	defer store.routingWrites.Unlock()
	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("开始人工模型维护事务失败: %w", err)
	}
	defer func() {
		_ = transaction.Rollback()
	}()
	exists, err := store.accountExists(ctx, transaction, accountRef)
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, accountapp.ErrAccountNotFound
	}
	const upsertPolicy = `
		INSERT INTO account_models (
			account_ref, model_id, upstream_available, manual_policy, updated_at_ms
		) VALUES (?, ?, 0, ?, ?)
		ON CONFLICT (account_ref, model_id) DO UPDATE SET
			manual_policy = excluded.manual_policy,
			updated_at_ms = excluded.updated_at_ms`
	if _, err := transaction.ExecContext(
		ctx,
		upsertPolicy,
		accountRef.String(),
		modelID.String(),
		policy.String(),
		updatedAt.UnixMilli(),
	); err != nil {
		return nil, fmt.Errorf("写入人工模型策略失败: %w", err)
	}
	if policy == accountapp.ModelPolicyInherit {
		const removeEmptyInherited = `
			DELETE FROM account_models
			WHERE account_ref = ?
			  AND model_id = ?
			  AND upstream_available = 0
			  AND manual_policy = 'inherit'`
		if _, err := transaction.ExecContext(
			ctx,
			removeEmptyInherited,
			accountRef.String(),
			modelID.String(),
		); err != nil {
			return nil, fmt.Errorf("清理空人工模型关系失败: %w", err)
		}
	}
	snapshot, err := store.listAccountModels(ctx, transaction, accountRef)
	if err != nil {
		return nil, err
	}
	if err := transaction.Commit(); err != nil {
		return nil, fmt.Errorf("提交人工模型维护事务失败: %w", err)
	}
	if err := store.publishAccountModels(accountRef, snapshot); err != nil {
		return nil, err
	}
	return snapshot, nil
}

// listAccountModels 从数据库执行器恢复排序后的完整关系。
func (store *Store) listAccountModels(
	ctx context.Context,
	executor queryExecutor,
	accountRef accountcore.AccountRef,
) ([]accountapp.AccountModel, error) {
	const query = `
		SELECT model_id, upstream_available, manual_policy, updated_at_ms
		FROM account_models
		WHERE account_ref = ?
		ORDER BY model_id`
	rows, err := executor.QueryContext(ctx, query, accountRef.String())
	if err != nil {
		return nil, fmt.Errorf("查询账号模型关系失败: %w", err)
	}
	defer func() {
		_ = rows.Close()
	}()
	models := make([]accountapp.AccountModel, 0)
	for rows.Next() {
		var (
			modelIDText  string
			upstream     bool
			manualPolicy string
			updatedAtMS  int64
		)
		if err := rows.Scan(
			&modelIDText,
			&upstream,
			&manualPolicy,
			&updatedAtMS,
		); err != nil {
			return nil, fmt.Errorf("读取账号模型关系失败: %w", err)
		}
		policy, err := accountapp.ParseModelManualPolicy(manualPolicy)
		if err != nil {
			return nil, ErrIncompatibleDatabase
		}
		model, err := accountapp.NewAccountModel(accountapp.AccountModelInput{
			AccountRef:        accountRef,
			ModelID:           modelIDText,
			UpstreamAvailable: upstream,
			ManualPolicy:      policy,
			UpdatedAt:         time.UnixMilli(updatedAtMS).UTC(),
		})
		if err != nil {
			return nil, ErrIncompatibleDatabase
		}
		models = append(models, model)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历账号模型关系失败: %w", err)
	}
	return models, nil
}

// publishAccountModels 只把有效模型标识投影到进程内路由索引。
func (store *Store) publishAccountModels(
	accountRef accountcore.AccountRef,
	models []accountapp.AccountModel,
) error {
	effective, err := accountapp.EffectiveModelIDs(models)
	if err != nil {
		return ErrIncompatibleDatabase
	}
	if !store.routes.replaceModels(accountRef, effective) {
		return ErrIncompatibleDatabase
	}
	return nil
}

// accountExists 区分不存在账号与合法的空模型集合。
func (store *Store) accountExists(
	ctx context.Context,
	executor queryRowExecutor,
	accountRef accountcore.AccountRef,
) (bool, error) {
	const query = `SELECT 1 FROM accounts WHERE account_ref = ? LIMIT 1`
	var exists int
	err := executor.QueryRowContext(ctx, query, accountRef.String()).Scan(&exists)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("检查账号模型所属账号失败: %w", err)
	}
	return exists == 1, nil
}

// validPersistedModelTime 拒绝非 UTC 毫秒精度或越界时间。
func validPersistedModelTime(value time.Time) bool {
	return !value.IsZero() &&
		value.Location() == time.UTC &&
		value.Nanosecond()%int(time.Millisecond) == 0 &&
		value.UnixMilli() >= 0 &&
		value.UnixMilli() <= 253_402_300_799_999
}

// queryExecutor 是数据库和事务共享的参数化列表查询端口。
type queryExecutor interface {
	QueryContext(
		ctx context.Context,
		query string,
		args ...any,
	) (*sql.Rows, error)
}

// queryRowExecutor 是数据库和事务共享的单行查询端口。
type queryRowExecutor interface {
	QueryRowContext(
		ctx context.Context,
		query string,
		args ...any,
	) *sql.Row
}

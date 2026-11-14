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
var _ accountapp.ModelProbeRecorder = (*Store)(nil)

// ListAllAccountModels 一次读出有事实可讲的账号的模型关系与探测事实。
//
// 以 accounts 为驱动表做 LEFT JOIN，但只保留「有模型」或「有探测事实」的账号：
// 从 account_models 出发会让「探测过但目录为空」的账号消失；反过来无条件返回全部
// 账号也不对——WebUI 合并缓存时会把「无模型且无错误」当成已确认为空，从而清掉旧目录。
// 两样都没有的账号属于「未知」，留在账号列表里，不在这里伪造空结果。
func (store *Store) ListAllAccountModels(ctx context.Context) (accountapp.AccountModelCatalog, error) {
	const query = `
		SELECT a.account_ref, a.provider_id,
		       m.model_id, m.upstream_available, m.manual_policy, m.updated_at_ms,
		       p.last_attempt_at_ms, p.last_error_code, p.last_error_message,
		       p.last_source, p.last_model_count
		FROM accounts AS a
		LEFT JOIN account_models AS m ON m.account_ref = a.account_ref
		LEFT JOIN account_model_probes AS p ON p.account_ref = a.account_ref
		WHERE m.account_ref IS NOT NULL OR p.account_ref IS NOT NULL
		ORDER BY a.account_ref, m.model_id`
	if store == nil || store.db == nil || ctx == nil {
		return accountapp.AccountModelCatalog{}, ErrIncompatibleDatabase
	}
	// 指纹与 data 必须来自同一个读快照：否则并发写入会让 Node 拿到「新 generation +
	// 旧目录」，条件刷新会一直误判为没有变化。
	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return accountapp.AccountModelCatalog{}, fmt.Errorf("开始账号模型读取事务失败: %w", err)
	}
	defer func() {
		_ = transaction.Rollback()
	}()
	stamp, err := readAccountModelCatalogStamp(ctx, transaction)
	if err != nil {
		return accountapp.AccountModelCatalog{}, err
	}
	rows, err := transaction.QueryContext(ctx, query)
	if err != nil {
		return accountapp.AccountModelCatalog{}, fmt.Errorf("查询全量账号模型关系失败: %w", err)
	}
	defer func() {
		_ = rows.Close()
	}()
	sets := make([]accountapp.AccountModelSet, 0)
	// ORDER BY already groups each account contiguously. Keep only the current
	// group instead of an O(accounts) hash index and repeated account parsing.
	var currentRef accountcore.AccountRef
	position := -1
	for rows.Next() {
		var (
			accountRefText string
			providerID     string
			modelIDText    sql.NullString
			upstream       sql.NullBool
			manualPolicy   sql.NullString
			modelUpdatedAt sql.NullInt64
			attemptAtMS    sql.NullInt64
			errorCode      sql.NullString
			errorMessage   sql.NullString
			source         sql.NullString
			modelCount     sql.NullInt64
		)
		if err := rows.Scan(
			&accountRefText,
			&providerID,
			&modelIDText,
			&upstream,
			&manualPolicy,
			&modelUpdatedAt,
			&attemptAtMS,
			&errorCode,
			&errorMessage,
			&source,
			&modelCount,
		); err != nil {
			return accountapp.AccountModelCatalog{}, fmt.Errorf("读取全量账号模型关系失败: %w", err)
		}
		if position < 0 || currentRef.String() != accountRefText {
			accountRef, err := accountcore.ParseAccountRef(accountRefText)
			if err != nil {
				return accountapp.AccountModelCatalog{}, ErrIncompatibleDatabase
			}
			if position >= 0 && accountRefText <= currentRef.String() {
				return accountapp.AccountModelCatalog{}, ErrIncompatibleDatabase
			}
			currentRef = accountRef
			set := accountapp.AccountModelSet{
				AccountRef:       accountRef,
				ProviderID:       providerID,
				LastErrorCode:    errorCode.String,
				LastErrorMessage: errorMessage.String,
				LastSource:       source.String,
			}
			if attemptAtMS.Valid {
				attemptedAt := time.UnixMilli(attemptAtMS.Int64).UTC()
				if !validPersistedTimestamp(attemptedAt) ||
					modelCount.Int64 < 0 ||
					modelCount.Int64 > accountapp.MaxDiscoveredModelsPerAccount {
					return accountapp.AccountModelCatalog{}, ErrIncompatibleDatabase
				}
				set.LastAttemptAt = attemptedAt
				set.LastModelCount = int(modelCount.Int64)
			}
			position = len(sets)
			sets = append(sets, set)
		}
		// LEFT JOIN 对无模型账号返回一行 NULL，跳过模型构造但保留探测事实。
		if !modelIDText.Valid {
			continue
		}
		policy, err := accountapp.ParseModelManualPolicy(manualPolicy.String)
		if err != nil {
			return accountapp.AccountModelCatalog{}, ErrIncompatibleDatabase
		}
		model, err := accountapp.NewAccountModel(accountapp.AccountModelInput{
			AccountRef:        currentRef,
			ModelID:           modelIDText.String,
			UpstreamAvailable: upstream.Bool,
			ManualPolicy:      policy,
			UpdatedAt:         time.UnixMilli(modelUpdatedAt.Int64).UTC(),
		})
		if err != nil {
			return accountapp.AccountModelCatalog{}, ErrIncompatibleDatabase
		}
		sets[position].Models = append(sets[position].Models, model)
	}
	if err := rows.Err(); err != nil {
		return accountapp.AccountModelCatalog{}, fmt.Errorf("遍历全量账号模型关系失败: %w", err)
	}
	if err := rows.Close(); err != nil {
		return accountapp.AccountModelCatalog{}, fmt.Errorf("关闭全量账号模型关系游标失败: %w", err)
	}
	if err := transaction.Commit(); err != nil {
		return accountapp.AccountModelCatalog{}, fmt.Errorf("提交账号模型读取事务失败: %w", err)
	}
	return accountapp.AccountModelCatalog{
		Sets:        sets,
		Generation:  stamp.Generation,
		UpdatedAtMS: stamp.UpdatedAtMS,
	}, nil
}

// accountModelCatalogStampReader 让普通连接与读事务共用同一段聚合查询。
type accountModelCatalogStampReader interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// readAccountModelCatalogStamp 计算目录指纹。
//
// generation = max(updated_at_ms) + 行数。所有现有写路径（替换发现结果、人工策略、
// 探测事实、账号级联删除）都会改变这两个输入之一：
//   - 正常写入把 updated_at_ms 推到写入时刻，generation 单调前进；
//   - 同一毫秒内的增删、或级联删除（MAX 不变但行数少了）由行数项区分。
//
// 它不是数据库序列，因此不保证跨「行数减少且 MAX 未前进」的场景严格单调；
// 读取方必须把 generation 变小也当成「需要重新拉取」。
func readAccountModelCatalogStamp(
	ctx context.Context,
	reader accountModelCatalogStampReader,
) (accountapp.AccountModelCatalogStamp, error) {
	const query = `
		SELECT
			COALESCE((SELECT MAX(updated_at_ms) FROM account_models), 0),
			(SELECT COUNT(*) FROM account_models),
			COALESCE((SELECT MAX(updated_at_ms) FROM account_model_probes), 0),
			(SELECT COUNT(*) FROM account_model_probes)`
	var (
		modelUpdatedAtMS int64
		modelRowCount    int64
		probeUpdatedAtMS int64
		probeRowCount    int64
	)
	if err := reader.QueryRowContext(ctx, query).Scan(
		&modelUpdatedAtMS,
		&modelRowCount,
		&probeUpdatedAtMS,
		&probeRowCount,
	); err != nil {
		return accountapp.AccountModelCatalogStamp{}, fmt.Errorf("读取账号模型目录代次失败: %w", err)
	}
	updatedAtMS := modelUpdatedAtMS
	if probeUpdatedAtMS > updatedAtMS {
		updatedAtMS = probeUpdatedAtMS
	}
	return accountapp.AccountModelCatalogStamp{
		Generation:  updatedAtMS + modelRowCount + probeRowCount,
		UpdatedAtMS: updatedAtMS,
	}, nil
}

// AccountModelCatalogStamp 只读取目录指纹，供条件刷新做轻量探测。
func (store *Store) AccountModelCatalogStamp(
	ctx context.Context,
) (accountapp.AccountModelCatalogStamp, error) {
	if store == nil || store.db == nil || ctx == nil {
		return accountapp.AccountModelCatalogStamp{}, ErrIncompatibleDatabase
	}
	return readAccountModelCatalogStamp(ctx, store.db)
}

// RecordModelProbe 追加或更新一个账号的最近一次探测事实。
//
// provider_id 从 accounts 派生而不是由调用方传入：探测可能在读取凭据前就失败，
// 调用方此时并不知道 Provider；账号也不存在时 INSERT ... SELECT 自然不写入，
// 不会把并发删除的账号重新变出来。
func (store *Store) RecordModelProbe(
	ctx context.Context,
	record accountapp.ModelProbeRecord,
) error {
	if store == nil || store.db == nil || ctx == nil || !record.IsValid() {
		return accountapp.ErrInvalidModelProbe
	}
	statement := recordModelProbeFailureSQL
	if record.Succeeded {
		statement = recordModelProbeSuccessSQL
	}
	var credentialVersion any
	if !record.CredentialUpdatedAt.IsZero() {
		credentialVersion = record.CredentialUpdatedAt.UnixMilli()
	}
	_, err := store.db.ExecContext(
		ctx,
		statement,
		record.AccountRef.String(),
		record.AttemptedAt.UnixMilli(),
		record.ErrorCode,
		record.ErrorMessage,
		record.Source,
		record.ModelCount,
		record.UpdatedAt.UnixMilli(),
		record.AccountRef.String(),
		credentialVersion,
		credentialVersion,
	)
	if err != nil {
		return fmt.Errorf("写入账号模型探测事实失败: %w", err)
	}
	return nil
}

// recordModelProbeSuccessSQL 成功时覆盖来源、计数并清空错误。
const recordModelProbeSuccessSQL = `
	INSERT INTO account_model_probes (
		account_ref, provider_id, last_attempt_at_ms, last_error_code,
		last_error_message, last_source, last_model_count, updated_at_ms
	)
	SELECT ?, a.provider_id, ?, ?, ?, ?, ?, ?
	FROM accounts AS a
	WHERE a.account_ref = ?
	  AND (? IS NULL OR EXISTS (
		SELECT 1 FROM account_credentials AS c
		WHERE c.account_ref = a.account_ref AND c.updated_at_ms = ?
	  ))
	ON CONFLICT (account_ref) DO UPDATE SET
		provider_id = excluded.provider_id,
		last_attempt_at_ms = excluded.last_attempt_at_ms,
		last_error_code = '',
		last_error_message = '',
		last_source = excluded.last_source,
		last_model_count = excluded.last_model_count,
		updated_at_ms = excluded.updated_at_ms`

// recordModelProbeFailureSQL 失败时只更新时刻与错误。
//
// 特意不写 last_model_count：目录快照没有被替换，计数必须继续描述上一份成功快照，
// 否则 WebUI 会把「刷新失败但旧目录还在」显示成空目录。
const recordModelProbeFailureSQL = `
	INSERT INTO account_model_probes (
		account_ref, provider_id, last_attempt_at_ms, last_error_code,
		last_error_message, last_source, last_model_count, updated_at_ms
	)
	SELECT ?, a.provider_id, ?, ?, ?, ?, ?, ?
	FROM accounts AS a
	WHERE a.account_ref = ?
	  AND (? IS NULL OR EXISTS (
		SELECT 1 FROM account_credentials AS c
		WHERE c.account_ref = a.account_ref AND c.updated_at_ms = ?
	  ))
	ON CONFLICT (account_ref) DO UPDATE SET
		provider_id = excluded.provider_id,
		last_attempt_at_ms = excluded.last_attempt_at_ms,
		last_error_code = excluded.last_error_code,
		last_error_message = excluded.last_error_message,
		last_source = excluded.last_source,
		updated_at_ms = excluded.updated_at_ms`

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
	if !validPersistedTimestamp(expectedCredentialUpdatedAt) {
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
		!validPersistedTimestamp(updatedAt) ||
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
		!validPersistedTimestamp(updatedAt) {
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

// validPersistedTimestamp 拒绝非 UTC 毫秒精度或越界时间。
func validPersistedTimestamp(value time.Time) bool {
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

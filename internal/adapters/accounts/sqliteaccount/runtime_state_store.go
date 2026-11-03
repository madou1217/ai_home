package sqliteaccount

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	runtimeapp "github.com/madou1217/ai_home/application/accountruntime"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

const (
	loadModelStatesSQL = `
		SELECT account_ref, model_id, streak_kind, streak_count,
		       streak_expires_at_ms, cooldown_kind, cooldown_until_ms,
		       last_failure_at_ms
		FROM account_runtime_state
		ORDER BY account_ref, model_id`

	saveModelStateSQL = `
		INSERT INTO account_runtime_state (
			account_ref, model_id, streak_kind, streak_count,
			streak_expires_at_ms, cooldown_kind, cooldown_until_ms,
			last_failure_at_ms
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (account_ref, model_id) DO UPDATE SET
			streak_kind = excluded.streak_kind,
			streak_count = excluded.streak_count,
			streak_expires_at_ms = excluded.streak_expires_at_ms,
			cooldown_kind = excluded.cooldown_kind,
			cooldown_until_ms = excluded.cooldown_until_ms,
			last_failure_at_ms = excluded.last_failure_at_ms`

	deleteModelStateSQL = `
		DELETE FROM account_runtime_state
		WHERE account_ref = ? AND model_id = ?`
)

var _ runtimeapp.StateStore = (*Store)(nil)

// LoadModelStates 读取全部跨重启保留的账号模型冷却状态。
func (store *Store) LoadModelStates(
	ctx context.Context,
) ([]runtimeapp.PersistedModelState, error) {
	if store == nil || store.db == nil {
		return nil, ErrIncompatibleDatabase
	}
	if ctx == nil {
		return nil, runtimeapp.ErrInvalidRequest
	}
	rows, err := store.db.QueryContext(ctx, loadModelStatesSQL)
	if err != nil {
		return nil, fmt.Errorf("查询账号模型冷却状态失败: %w", err)
	}
	defer func() {
		_ = rows.Close()
	}()

	entries := make([]runtimeapp.PersistedModelState, 0, 16)
	for rows.Next() {
		entry, scanErr := scanPersistedModelState(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		entries = append(entries, entry)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历账号模型冷却状态失败: %w", err)
	}
	return entries, nil
}

// SaveModelState 覆盖写入一个账号模型冷却状态。
//
// 账号已删除时静默丢弃：外键级联会先一步清掉行，这里不能因为一次竞态写入失败
// 把已经在内存中生效的冷却判为错误。
func (store *Store) SaveModelState(
	ctx context.Context,
	entry runtimeapp.PersistedModelState,
) error {
	if store == nil || store.db == nil {
		return ErrIncompatibleDatabase
	}
	if ctx == nil ||
		!entry.Route.IsValid() ||
		entry.State.StreakKind != "" && entry.State.StreakCount == 0 {
		return runtimeapp.ErrInvalidRequest
	}
	if _, err := store.db.ExecContext(
		ctx,
		saveModelStateSQL,
		entry.Route.AccountRef().String(),
		entry.Route.ModelID().String(),
		string(entry.State.StreakKind),
		int64(entry.State.StreakCount),
		unixMilliOrZero(entry.State.StreakExpiresAt),
		string(entry.State.CooldownKind),
		unixMilliOrZero(entry.State.CooldownUntil),
		unixMilliOrZero(entry.State.LastFailureAt),
	); err != nil {
		if isForeignKeyError(err) {
			return nil
		}
		return fmt.Errorf("写入账号模型冷却状态失败: %w", err)
	}
	return nil
}

// DeleteModelState 删除一个账号模型冷却状态；不存在时视为成功。
func (store *Store) DeleteModelState(
	ctx context.Context,
	route runtimecore.ModelRoute,
) error {
	if store == nil || store.db == nil {
		return ErrIncompatibleDatabase
	}
	if ctx == nil || !route.IsValid() {
		return runtimeapp.ErrInvalidRequest
	}
	if _, err := store.db.ExecContext(
		ctx,
		deleteModelStateSQL,
		route.AccountRef().String(),
		route.ModelID().String(),
	); err != nil {
		return fmt.Errorf("删除账号模型冷却状态失败: %w", err)
	}
	return nil
}

// scanPersistedModelState 解析一行并重建已经过领域校验的运行态投影。
func scanPersistedModelState(
	rows *sql.Rows,
) (runtimeapp.PersistedModelState, error) {
	var accountRef, modelID string
	var streakKind, cooldownKind string
	var streakCount, streakExpiresAtMS, cooldownUntilMS, lastFailureAtMS int64
	if err := rows.Scan(
		&accountRef,
		&modelID,
		&streakKind,
		&streakCount,
		&streakExpiresAtMS,
		&cooldownKind,
		&cooldownUntilMS,
		&lastFailureAtMS,
	); err != nil {
		return runtimeapp.PersistedModelState{}, fmt.Errorf(
			"解析账号模型冷却状态失败: %w",
			err,
		)
	}
	parsedAccountRef, refErr := accountcore.ParseAccountRef(accountRef)
	route, routeErr := runtimecore.NewModelRoute(parsedAccountRef, modelID)
	if refErr != nil || routeErr != nil {
		return runtimeapp.PersistedModelState{}, errors.Join(
			runtimeapp.ErrInvalidRequest,
			refErr,
			routeErr,
		)
	}
	return runtimeapp.PersistedModelState{
		Route: route,
		State: runtimecore.ModelStateSnapshot{
			StreakKind:      runtimecore.FailureKind(streakKind),
			StreakCount:     uint8(streakCount),
			StreakExpiresAt: timeFromUnixMilli(streakExpiresAtMS),
			CooldownKind:    runtimecore.FailureKind(cooldownKind),
			CooldownUntil:   timeFromUnixMilli(cooldownUntilMS),
			LastFailureAt:   timeFromUnixMilli(lastFailureAtMS),
		},
	}, nil
}

// unixMilliOrZero 把领域零时间写成 0，与 schema 的默认值语义一致。
func unixMilliOrZero(value time.Time) int64 {
	if value.IsZero() {
		return 0
	}
	return value.UnixMilli()
}

// timeFromUnixMilli 把 0 还原成零时间，其余还原为 UTC 毫秒。
func timeFromUnixMilli(value int64) time.Time {
	if value <= 0 {
		return time.Time{}
	}
	return time.UnixMilli(value).UTC()
}

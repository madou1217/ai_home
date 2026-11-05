package sqliteaccount

import (
	"context"
	"database/sql"
	"fmt"

	usagecore "github.com/madou1217/ai_home/core/accountusage"
)

// advanceQuotaDetector 用一个观测推进 (账号, quotaKey) 的重置检测状态机。
//
// 状态与事件同事务写入：检测基线落后于事件会造成重复事件，反之会漏事件。
// 与 Node quota-reset-detector 同规则（见 core/accountusage/quota_reset_detector.go）。
func (store *Store) advanceQuotaDetector(
	ctx context.Context,
	transaction *sql.Tx,
	snapshot usagecore.Snapshot,
	observation usagecore.QuotaWindowSample,
) error {
	if observation.QuotaKey == "" || observation.CapturedAtMS <= 0 {
		return nil
	}
	accountRef := snapshot.AccountRef().String()
	state, hasState, err := readQuotaDetectorState(ctx, transaction, accountRef, observation.QuotaKey)
	if err != nil {
		return err
	}
	next, event := usagecore.AdvanceQuotaDetector(
		state,
		hasState,
		accountRef,
		snapshot.ProviderID(),
		observation,
	)
	if err := upsertQuotaDetectorState(ctx, transaction, accountRef, snapshot.ProviderID(), observation.QuotaKey, next); err != nil {
		return err
	}
	if event == nil {
		return nil
	}
	return insertQuotaResetEvent(ctx, transaction, accountRef, event)
}

func readQuotaDetectorState(
	ctx context.Context,
	queryer quotaLedgerQueryer,
	accountRef string,
	quotaKey string,
) (usagecore.QuotaDetectorState, bool, error) {
	const query = `
		SELECT last_remaining_pct, last_expected_reset_at_ms, last_captured_at_ms,
		       is_armed, rearm_generation, exhausted_at_ms
		FROM account_quota_detector_state
		WHERE account_ref = ? AND quota_key = ?`
	var state usagecore.QuotaDetectorState
	var remainingPct sql.NullFloat64
	var isArmed int64
	var exhaustedAtMS sql.NullInt64
	err := queryer.QueryRowContext(ctx, query, accountRef, quotaKey).Scan(
		&remainingPct,
		&state.LastExpectedResetAtMS,
		&state.LastCapturedAtMS,
		&isArmed,
		&state.RearmGeneration,
		&exhaustedAtMS,
	)
	if err == sql.ErrNoRows {
		return usagecore.QuotaDetectorState{}, false, nil
	}
	if err != nil {
		return usagecore.QuotaDetectorState{}, false, fmt.Errorf("读取额度重置检测基线失败: %w", err)
	}
	if remainingPct.Valid {
		value := remainingPct.Float64
		state.LastRemainingPct = &value
	}
	state.IsArmed = isArmed != 0
	if exhaustedAtMS.Valid {
		value := exhaustedAtMS.Int64
		state.ExhaustedAtMS = &value
	}
	return state, true, nil
}

func upsertQuotaDetectorState(
	ctx context.Context,
	transaction *sql.Tx,
	accountRef string,
	providerID string,
	quotaKey string,
	state usagecore.QuotaDetectorState,
) error {
	const statement = `
		INSERT INTO account_quota_detector_state (
			account_ref, quota_key, provider_id, last_remaining_pct,
			last_expected_reset_at_ms, last_captured_at_ms, is_armed,
			rearm_generation, exhausted_at_ms, updated_at_ms
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (account_ref, quota_key) DO UPDATE SET
			provider_id = excluded.provider_id,
			last_remaining_pct = excluded.last_remaining_pct,
			last_expected_reset_at_ms = excluded.last_expected_reset_at_ms,
			last_captured_at_ms = excluded.last_captured_at_ms,
			is_armed = excluded.is_armed,
			rearm_generation = excluded.rearm_generation,
			exhausted_at_ms = excluded.exhausted_at_ms,
			updated_at_ms = excluded.updated_at_ms`
	armed := int64(0)
	if state.IsArmed {
		armed = 1
	}
	if _, err := transaction.ExecContext(
		ctx,
		statement,
		accountRef,
		quotaKey,
		providerID,
		nullableFloat(state.LastRemainingPct),
		state.LastExpectedResetAtMS,
		state.LastCapturedAtMS,
		armed,
		state.RearmGeneration,
		nullableInt64(state.ExhaustedAtMS),
		state.LastCapturedAtMS,
	); err != nil {
		return fmt.Errorf("写入额度重置检测基线失败: %w", err)
	}
	return nil
}

func insertQuotaResetEvent(
	ctx context.Context,
	transaction *sql.Tx,
	accountRef string,
	event *usagecore.QuotaResetEvent,
) error {
	const statement = `
		INSERT INTO account_quota_reset_events (
			event_key, account_ref, provider_id, quota_key, window_label,
			window_minutes, event_kind, classification, cause,
			previous_remaining_pct, current_remaining_pct,
			previous_expected_reset_at_ms, exhausted_at_ms,
			occurred_at_ms, detected_at_ms, early_duration_ms, created_at_ms
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (event_key) DO NOTHING`
	if _, err := transaction.ExecContext(
		ctx,
		statement,
		event.EventKey,
		accountRef,
		event.ProviderID,
		event.QuotaKey,
		event.WindowLabel,
		event.WindowMinutes,
		event.EventKind,
		event.Classification,
		event.Cause,
		nullableFloat(event.PreviousRemainingPct),
		nullableFloat(event.CurrentRemainingPct),
		event.PreviousExpectedResetAtMS,
		nullableInt64(event.ExhaustedAtMS),
		event.OccurredAtMS,
		event.DetectedAtMS,
		event.EarlyDurationMS,
		event.DetectedAtMS,
	); err != nil {
		return fmt.Errorf("写入额度重置事件失败: %w", err)
	}
	return nil
}

// ListQuotaResetEvents 按账号 / quotaKey 读取一段时间的重置事件（升序）。
//
// 不按 window_minutes 过滤：老事件可能没有这一列，交给窗口重建按 quotaKey 兜底。
func (store *Store) ListQuotaResetEvents(
	ctx context.Context,
	accountRef string,
	quotaKey string,
	fromMS int64,
	toMS int64,
) ([]usagecore.QuotaResetEvent, error) {
	if store == nil || store.db == nil || ctx == nil {
		return nil, nil
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	query := `
		SELECT event_key, provider_id, quota_key, window_label, window_minutes,
		       event_kind, classification, cause,
		       previous_remaining_pct, current_remaining_pct,
		       previous_expected_reset_at_ms, exhausted_at_ms,
		       occurred_at_ms, detected_at_ms, early_duration_ms
		FROM account_quota_reset_events
		WHERE account_ref = ? AND occurred_at_ms >= ? AND occurred_at_ms <= ?`
	parameters := []any{accountRef, fromMS, toMS}
	if quotaKey != "" {
		query += " AND quota_key = ?"
		parameters = append(parameters, quotaKey)
	}
	query += " ORDER BY occurred_at_ms, event_id LIMIT 5000"
	rows, err := store.db.QueryContext(ctx, query, parameters...)
	if err != nil {
		return nil, fmt.Errorf("查询额度重置事件失败: %w", err)
	}
	defer func() {
		_ = rows.Close()
	}()
	events := make([]usagecore.QuotaResetEvent, 0, 32)
	for rows.Next() {
		var event usagecore.QuotaResetEvent
		var previousPct, currentPct sql.NullFloat64
		var exhaustedAtMS sql.NullInt64
		if err := rows.Scan(
			&event.EventKey,
			&event.ProviderID,
			&event.QuotaKey,
			&event.WindowLabel,
			&event.WindowMinutes,
			&event.EventKind,
			&event.Classification,
			&event.Cause,
			&previousPct,
			&currentPct,
			&event.PreviousExpectedResetAtMS,
			&exhaustedAtMS,
			&event.OccurredAtMS,
			&event.DetectedAtMS,
			&event.EarlyDurationMS,
		); err != nil {
			return nil, fmt.Errorf("读取额度重置事件失败: %w", err)
		}
		if previousPct.Valid {
			value := previousPct.Float64
			event.PreviousRemainingPct = &value
		}
		if currentPct.Valid {
			value := currentPct.Float64
			event.CurrentRemainingPct = &value
		}
		if exhaustedAtMS.Valid {
			value := exhaustedAtMS.Int64
			event.ExhaustedAtMS = &value
		}
		events = append(events, event)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历额度重置事件失败: %w", err)
	}
	return events, nil
}

// ListQuotaResetEventScopes 返回账号下产生过重置事件的 (quotaKey, 窗口长度)。
//
// 老事件缺 window_minutes 时按 0 返回：调用方只把它当「这个 quotaKey 存在」的证据。
func (store *Store) ListQuotaResetEventScopes(
	ctx context.Context,
	accountRef string,
) ([]usagecore.QuotaWindowScope, error) {
	if store == nil || store.db == nil || ctx == nil {
		return nil, nil
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	const query = `
		SELECT quota_key, MAX(window_label) AS window_label, window_minutes,
		       COUNT(*) AS event_count, MAX(occurred_at_ms) AS last_occurred_at_ms
		FROM account_quota_reset_events
		WHERE account_ref = ?
		GROUP BY quota_key, window_minutes
		ORDER BY window_minutes, quota_key`
	rows, err := store.db.QueryContext(ctx, query, accountRef)
	if err != nil {
		return nil, fmt.Errorf("查询额度重置事件范围失败: %w", err)
	}
	defer func() {
		_ = rows.Close()
	}()
	scopes := make([]usagecore.QuotaWindowScope, 0, 8)
	for rows.Next() {
		var scope usagecore.QuotaWindowScope
		var eventCount int64
		if err := rows.Scan(
			&scope.QuotaKey,
			&scope.WindowLabel,
			&scope.WindowMinutes,
			&eventCount,
			&scope.LastCapturedAtMS,
		); err != nil {
			return nil, fmt.Errorf("读取额度重置事件范围失败: %w", err)
		}
		if scope.QuotaKey == "" {
			continue
		}
		scopes = append(scopes, scope)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历额度重置事件范围失败: %w", err)
	}
	return scopes, nil
}

func nullableFloat(value *float64) any {
	if value == nil {
		return nil
	}
	return *value
}

func nullableInt64(value *int64) any {
	if value == nil {
		return nil
	}
	return *value
}

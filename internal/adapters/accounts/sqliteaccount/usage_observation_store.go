package sqliteaccount

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	usageapp "github.com/madou1217/ai_home/application/accountusage"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
)

var _ usageapp.ObservationStore = (*Store)(nil)

// ReplaceUsageObservationIfCredentialVersion 以同一事务提交一次观察的全部读模型。
func (store *Store) ReplaceUsageObservationIfCredentialVersion(
	ctx context.Context,
	snapshot usagecore.Snapshot,
	document usagecore.Document,
	state usageapp.DocumentQuotaState,
	expectedCredentialUpdatedAt time.Time,
) error {
	if !snapshot.IsValid() || !document.IsValid() ||
		!validPersistedTimestamp(expectedCredentialUpdatedAt) ||
		document.AccountRef() != snapshot.AccountRef() ||
		document.ProviderID() != snapshot.ProviderID() ||
		document.Source() != snapshot.Source() ||
		!document.CapturedAt().Equal(snapshot.CapturedAt()) ||
		state.AccountRef != snapshot.AccountRef() || state.Remaining != snapshot.MinRemaining() ||
		state.DocumentCapturedAtMS != document.CapturedAt().UnixMilli() ||
		state.UsageCapturedAtMS != snapshot.CapturedAt().UnixMilli() || !state.HasUsageSnapshot {
		return usageapp.ErrInvalidSnapshot
	}
	return store.replaceUsageObservation(ctx, snapshot, expectedCredentialUpdatedAt, &document, &state)
}

// checkUsageObservationTime is shared by native and compatibility writers.
// Different sources at the same timestamp conflict; neither gets silent priority.
func checkUsageObservationTime(
	ctx context.Context,
	transaction *sql.Tx,
	ref accountcore.AccountRef,
	source string,
	capturedAt time.Time,
) error {
	rows, err := transaction.QueryContext(ctx, `
    SELECT source, captured_at_ms FROM account_usage WHERE account_ref = ?
    UNION
    SELECT source, captured_at_ms FROM account_usage_snapshots WHERE account_ref = ?`,
		ref.String(), ref.String())
	if err != nil {
		return fmt.Errorf("读取额度观察代次失败: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var currentSource string
		var currentAt int64
		if err := rows.Scan(&currentSource, &currentAt); err != nil {
			return err
		}
		if currentAt > capturedAt.UnixMilli() || (currentAt == capturedAt.UnixMilli() && currentSource != source) {
			return usageapp.ErrSnapshotSuperseded
		}
	}
	return rows.Err()
}

// A repeated timestamp is an idempotent replay only when all normalized facts match.
func checkUsageSnapshotReplay(ctx context.Context, transaction *sql.Tx, snapshot usagecore.Snapshot) error {
	var at sql.NullInt64
	if err := transaction.QueryRowContext(ctx, `SELECT MAX(captured_at_ms) FROM account_usage WHERE account_ref = ?`, snapshot.AccountRef().String()).Scan(&at); err != nil {
		return err
	}
	if !at.Valid || at.Int64 != snapshot.CapturedAt().UnixMilli() {
		return nil
	}
	rows, err := transaction.QueryContext(ctx, `
    SELECT a.provider_id, u.limit_id, u.limit_name, u.bucket, u.kind, u.scope, u.scope_key,
           u.remaining_bps, u.availability, u.window_seconds, u.reset_at_ms,
           u.source, u.captured_at_ms, u.plan_type
      FROM account_usage AS u JOIN accounts AS a ON a.account_ref = u.account_ref
     WHERE u.account_ref = ? ORDER BY u.limit_id, u.bucket`, snapshot.AccountRef().String())
	if err != nil {
		return err
	}
	defer rows.Close()
	expected := snapshot.Entries()
	index := 0
	for rows.Next() {
		input, metadata, err := scanUsageEntry(rows)
		if err != nil {
			return err
		}
		entry, err := usagecore.NewEntry(input)
		if err != nil {
			return err
		}
		if index >= len(expected) || entry != expected[index] ||
			metadata.providerID != snapshot.ProviderID() || metadata.source != snapshot.Source() ||
			metadata.capturedAtMS != snapshot.CapturedAt().UnixMilli() || metadata.planType != snapshot.PlanType() {
			return usageapp.ErrSnapshotSuperseded
		}
		index++
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if index != len(expected) {
		return usageapp.ErrSnapshotSuperseded
	}
	return nil
}

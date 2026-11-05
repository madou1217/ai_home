package sqliteaccount

import (
	"context"
	"database/sql"
	"fmt"

	usagecore "github.com/madou1217/ai_home/core/accountusage"
)

// quotaLedgerQueryer 同时适配 *sql.DB 与 *sql.Tx。
type quotaLedgerQueryer interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// upsertQuotaWindowLedger 把一次快照观察合并进窗口账本（单调不回退）。
//
// 与 Node window-ledger.reconcileLedger 同规则：更新的观察才能覆盖，
// 旧快照与观察不出窗口的快照原样保留账本。
func (store *Store) upsertQuotaWindowLedger(
	ctx context.Context,
	transaction *sql.Tx,
	snapshot usagecore.Snapshot,
) error {
	accountRef := snapshot.AccountRef().String()
	current, hasLedger, err := readQuotaWindowLedger(ctx, transaction, accountRef)
	if err != nil {
		return err
	}
	next := usagecore.ReconcileQuotaWindowLedger(
		current,
		usagecore.ObserveQuotaWindow(snapshot),
	)
	if hasLedger && next == current {
		return nil
	}
	if next.ObservedAtMS <= 0 {
		return nil
	}
	const statement = `
		INSERT INTO account_quota_window_ledger (
			account_ref, window_minutes, anchor_at_ms, close_at_ms,
			source, observed_at_ms, updated_at_ms
		) VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (account_ref) DO UPDATE SET
			window_minutes = excluded.window_minutes,
			anchor_at_ms = excluded.anchor_at_ms,
			close_at_ms = excluded.close_at_ms,
			source = excluded.source,
			observed_at_ms = excluded.observed_at_ms,
			updated_at_ms = excluded.updated_at_ms`
	if _, err := transaction.ExecContext(
		ctx,
		statement,
		accountRef,
		next.WindowMinutes,
		next.AnchorAtMS,
		next.CloseAtMS,
		next.Source,
		next.ObservedAtMS,
		next.ObservedAtMS,
	); err != nil {
		return fmt.Errorf("写入额度窗口账本失败: %w", err)
	}
	return nil
}

// GetQuotaWindowLedger 读取账号的窗口账本；没有记录是正常状态。
func (store *Store) GetQuotaWindowLedger(
	ctx context.Context,
	accountRef string,
) (usagecore.QuotaWindowLedger, bool, error) {
	if store == nil || store.db == nil || ctx == nil {
		return usagecore.QuotaWindowLedger{}, false, nil
	}
	if err := ctx.Err(); err != nil {
		return usagecore.QuotaWindowLedger{}, false, err
	}
	return readQuotaWindowLedger(ctx, store.db, accountRef)
}

func readQuotaWindowLedger(
	ctx context.Context,
	queryer quotaLedgerQueryer,
	accountRef string,
) (usagecore.QuotaWindowLedger, bool, error) {
	const query = `
		SELECT window_minutes, anchor_at_ms, close_at_ms, source, observed_at_ms
		FROM account_quota_window_ledger
		WHERE account_ref = ?`
	var ledger usagecore.QuotaWindowLedger
	err := queryer.QueryRowContext(ctx, query, accountRef).Scan(
		&ledger.WindowMinutes,
		&ledger.AnchorAtMS,
		&ledger.CloseAtMS,
		&ledger.Source,
		&ledger.ObservedAtMS,
	)
	if err == sql.ErrNoRows {
		return usagecore.QuotaWindowLedger{}, false, nil
	}
	if err != nil {
		return usagecore.QuotaWindowLedger{}, false, fmt.Errorf("读取额度窗口账本失败: %w", err)
	}
	return usagecore.NormalizeQuotaWindowLedger(ledger), true, nil
}

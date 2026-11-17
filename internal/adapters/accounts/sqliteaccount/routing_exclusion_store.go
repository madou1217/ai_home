package sqliteaccount

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

var errDerivedRoutingOwnedByGo = errors.New("routing_derived_owned_by_go")

// SetRoutingExclusion changes only manual intent. The two former Node-derived
// reasons cannot be written by callers; typed/capability guards remain Go-owned.
func (store *Store) SetRoutingExclusion(ctx context.Context, accountRef accountcore.AccountRef, excluded bool, reason string, updatedAt time.Time) error {
	if store == nil || store.db == nil || ctx == nil || !accountRef.IsValid() {
		return accountcore.ErrInvalidAccountRef
	}
	reason = strings.TrimSpace(reason)
	if legacyDerivedRoutingReason(reason) {
		return errDerivedRoutingOwnedByGo
	}
	transaction, err := store.beginModelTransaction(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = transaction.Rollback() }()
	_, err = transaction.ExecContext(ctx, `INSERT INTO account_routing_exclusions (account_ref,excluded,reason,updated_at_ms) VALUES (?,?,?,?)
 ON CONFLICT(account_ref) DO UPDATE SET excluded=excluded.excluded,reason=excluded.reason,updated_at_ms=excluded.updated_at_ms`, accountRef.String(), excluded, reason, updatedAt.UTC().UnixMilli())
	if isForeignKeyError(err) {
		return accountapp.ErrAccountNotFound
	}
	if err != nil {
		return fmt.Errorf("写入账号路由排除失败: %w", err)
	}
	entry, err := store.readCredentialRoutingEntry(ctx, transaction, accountRef)
	if err != nil {
		return err
	}
	if err := transaction.Commit(ctx); err != nil {
		return err
	}
	store.routes.publishCredentialAccount(entry, "")
	return nil
}

// Historical derived rows stay untouched for provenance but cease to be manual
// authority. Empty/unknown reasons and the independent user alias-pool preference
// are preserved; a legacy PUT false cannot overwrite participates=false.
func (store *Store) readManualRoutingExclusions(ctx context.Context, reader queryExecutor) (map[string]bool, error) {
	rows, err := reader.QueryContext(ctx, `SELECT account_ref,reason FROM account_routing_exclusions WHERE excluded=1`)
	if err != nil {
		return nil, fmt.Errorf("routing_manual_read: %w", err)
	}
	out := map[string]bool{}
	for rows.Next() {
		var ref, reason string
		if err := rows.Scan(&ref, &reason); err != nil {
			_ = rows.Close()
			return nil, err
		}
		if !legacyDerivedRoutingReason(reason) {
			out[ref] = true
		}
	}
	if err := errors.Join(rows.Err(), rows.Close()); err != nil {
		return nil, err
	}
	rows, err = reader.QueryContext(ctx, `SELECT key,value FROM app_kv WHERE key LIKE 'account:alias-pool:%'`)
	if err != nil {
		return nil, fmt.Errorf("routing_participation_read: %w", err)
	}
	for rows.Next() {
		var key, value string
		if err := rows.Scan(&key, &value); err != nil {
			_ = rows.Close()
			return nil, err
		}
		if strings.TrimSpace(value) == "" || strings.TrimSpace(value) == "null" {
			continue
		}
		var preference struct {
			Participates *bool `json:"participates"`
		}
		if err := json.Unmarshal([]byte(value), &preference); err != nil {
			_ = rows.Close()
			return nil, errors.New("routing_participation_invalid")
		}
		if preference.Participates != nil && !*preference.Participates {
			out[strings.TrimPrefix(key, "account:alias-pool:")] = true
		}
	}
	if err := errors.Join(rows.Err(), rows.Close()); err != nil {
		return nil, err
	}
	return out, nil
}

// RoutingExclusionState exposes current effective facts without conflating a
// request's manual bool with the independent canonical derived exclusion.
func (store *Store) RoutingExclusionState(ctx context.Context, ref accountcore.AccountRef) (manual, derived bool, reason string, err error) {
	if store == nil || store.db == nil || ctx == nil || !ref.IsValid() {
		return false, false, "", accountcore.ErrInvalidAccountRef
	}
	transaction, err := store.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return false, false, "", err
	}
	defer transaction.Rollback()
	var present string
	if err := transaction.QueryRowContext(ctx, "SELECT account_ref FROM accounts WHERE account_ref=?", ref.String()).Scan(&present); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			err = accountapp.ErrAccountNotFound
		}
		return false, false, "", err
	}
	manuals, err := store.readManualRoutingExclusions(ctx, transaction)
	if err != nil {
		return false, false, "", err
	}
	reasons, err := store.readDerivedRoutingReasons(ctx, transaction, ref)
	if err != nil {
		return false, false, "", err
	}
	reason, found := reasons[ref]
	if !found {
		reason = "credential_missing"
	}
	return manuals[ref.String()], reason != "", reason, transaction.Commit()
}

// LoadRoutingExclusions is the same manual OR typed/capability fact used by the
// routing index. Errors must propagate to directory consumers, never mean empty.
func (store *Store) LoadRoutingExclusions(ctx context.Context) (map[string]bool, error) {
	if store == nil || store.db == nil || ctx == nil {
		return nil, errors.New("routing_exclusion_unavailable")
	}
	transaction, err := store.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer transaction.Rollback()
	out, err := store.readManualRoutingExclusions(ctx, transaction)
	if err != nil {
		return nil, err
	}
	reasons, err := store.readDerivedRoutingReasons(ctx, transaction, "")
	if err != nil {
		return nil, err
	}
	rows, err := transaction.QueryContext(ctx, "SELECT account_ref FROM accounts")
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var text string
		if err := rows.Scan(&text); err != nil {
			_ = rows.Close()
			return nil, err
		}
		ref, err := accountcore.ParseAccountRef(text)
		if err != nil {
			_ = rows.Close()
			return nil, err
		}
		reason, found := reasons[ref]
		if !found || reason != "" {
			out[text] = true
		}
	}
	if err := errors.Join(rows.Err(), rows.Close()); err != nil {
		return nil, err
	}
	return out, transaction.Commit()
}

package sqliteaccount

import (
	"context"
	"errors"
	"fmt"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/gemini"
)

// The Vertex credential guard is one part of the canonical derived route
// decision. It never reads user enabled/default state or a legacy Node verdict.
func credentialRoutingExcluded(credential accountapp.Credential) bool {
	vertex, ok := credential.(*gemini.VertexAuth)
	return ok && vertex != nil && vertex.Placeholder()
}

type credentialRoutingReader interface {
	queryExecutor
	queryRowExecutor
}

// Every derived bit is read from the same canonical snapshot. A typed decoding
// failure is an error, never permission to publish an account as included.
func (store *Store) readDerivedRoutingReasons(ctx context.Context, reader queryExecutor, only accountcore.AccountRef) (map[accountcore.AccountRef]string, error) {
	query := `SELECT a.account_ref,a.provider_id,c.credential_ref,c.auth_kind,c.auth_mode,c.format_version,c.credential_json,c.updated_at_ms
 FROM accounts a JOIN account_credentials c ON c.account_ref=a.account_ref`
	var args []any
	if only.IsValid() {
		query += " WHERE a.account_ref=?"
		args = append(args, only.String())
	}
	rows, err := reader.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("credential_routing_guard_read: %w", err)
	}
	reasons := map[accountcore.AccountRef]string{}
	for rows.Next() {
		var refText string
		var record credentialRecord
		if err := rows.Scan(&refText, &record.providerID, &record.credentialRef, &record.authKind, &record.authMode, &record.formatVersion, &record.payload, &record.updatedAtMS); err != nil {
			_ = rows.Close()
			return nil, fmt.Errorf("credential_routing_guard_scan: %w", err)
		}
		ref, err := accountcore.ParseAccountRef(refText)
		if err != nil {
			_ = rows.Close()
			return nil, ErrInvalidCredential
		}
		snapshot, err := store.restoreCredentialSnapshot(ref, record)
		if err != nil {
			_ = rows.Close()
			return nil, fmt.Errorf("credential_routing_guard_invalid: %w", err)
		}
		reasons[ref] = store.derivedRoutingReason(record.providerID, snapshot.Credential())
	}
	if err := errors.Join(rows.Err(), rows.Close()); err != nil {
		return nil, fmt.Errorf("credential_routing_guard_rows: %w", err)
	}
	return reasons, nil
}

func (store *Store) readCredentialRoutingGuards(ctx context.Context, reader queryExecutor) (map[accountcore.AccountRef]bool, error) {
	reasons, err := store.readDerivedRoutingReasons(ctx, reader, "")
	if err != nil {
		return nil, err
	}
	guards := make(map[accountcore.AccountRef]bool, len(reasons))
	for ref, reason := range reasons {
		guards[ref] = reason != ""
	}
	return guards, nil
}

// An absent credential cannot be interpreted as an unguarded account.
func canonicalRoutingGuard(guards map[accountcore.AccountRef]bool, ref accountcore.AccountRef) bool {
	guard, found := guards[ref]
	return !found || guard
}

// The caller owns routingWrites and the same transaction that changed the
// credential. Capture every routing fact before COMMIT so publication cannot
// observe a different generation or fail after a successful credential write.
func (store *Store) readCredentialRoutingEntry(ctx context.Context, reader credentialRoutingReader, ref accountcore.AccountRef) (indexedRoutingAccount, error) {
	var refText, provider string
	var alias int64
	var enabled, excluded bool
	if err := reader.QueryRowContext(ctx, `SELECT a.account_ref,a.provider_id,a.cli_account_id,a.enabled,0
 FROM accounts a WHERE a.account_ref=?`, ref.String()).Scan(&refText, &provider, &alias, &enabled, &excluded); err != nil {
		return indexedRoutingAccount{}, err
	}
	_, account, err := restoreIndexedRoutingAccount(store.catalog, refText, provider, alias)
	if err != nil {
		return indexedRoutingAccount{}, err
	}
	manual, err := store.readManualRoutingExclusions(ctx, reader)
	if err != nil {
		return indexedRoutingAccount{}, err
	}
	excluded = manual[ref.String()]
	reasons, err := store.readDerivedRoutingReasons(ctx, reader, ref)
	if err != nil {
		return indexedRoutingAccount{}, err
	}
	reason, found := reasons[ref]
	guard := !found || reason != ""
	models, err := store.listAccountModels(ctx, reader, ref)
	if err != nil {
		return indexedRoutingAccount{}, err
	}
	effective, err := accountapp.EffectiveModelIDs(models)
	if err != nil {
		return indexedRoutingAccount{}, err
	}
	return indexedRoutingAccount{account: account, enabled: enabled, excluded: excluded, credentialExcluded: guard, models: effective}, nil
}

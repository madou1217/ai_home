package sqliteaccount

import (
	"context"
	"errors"
	"fmt"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/gemini"
)

// A credential guard is derived from canonical typed credentials, never from
// user enabled/default state or the legacy routing-exclusion writer. The
// credential document remains its only persisted authority.
func credentialRoutingExcluded(credential accountapp.Credential) bool {
	vertex, ok := credential.(*gemini.VertexAuth)
	return ok && vertex != nil && vertex.Placeholder()
}

type credentialRoutingReader interface {
	queryExecutor
	queryRowExecutor
}

// Read only typed Vertex documents. Unreadable or invalid documents are errors,
// not permission to publish an otherwise enabled account into the routing pool.
func (store *Store) readCredentialRoutingGuards(ctx context.Context, reader queryExecutor) (map[accountcore.AccountRef]bool, error) {
	rows, err := reader.QueryContext(ctx, `SELECT a.account_ref,a.provider_id,c.credential_ref,c.auth_kind,c.auth_mode,c.format_version,c.credential_json,c.updated_at_ms
 FROM accounts a JOIN account_credentials c ON c.account_ref=a.account_ref
 WHERE a.provider_id=? AND c.auth_kind=?`, gemini.ProviderID, gemini.AuthKindVertex)
	if err != nil {
		return nil, fmt.Errorf("credential_routing_guard_read: %w", err)
	}
	guards := map[accountcore.AccountRef]bool{}
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
		guards[ref] = credentialRoutingExcluded(snapshot.Credential())
	}
	if err := errors.Join(rows.Err(), rows.Close()); err != nil {
		return nil, fmt.Errorf("credential_routing_guard_rows: %w", err)
	}
	return guards, nil
}

// The caller owns routingWrites and the same transaction that changed the
// credential. Capture every routing fact before COMMIT so publication cannot
// observe a different generation or fail after a successful credential write.
func (store *Store) readCredentialRoutingEntry(ctx context.Context, reader credentialRoutingReader, ref accountcore.AccountRef) (indexedRoutingAccount, error) {
	var refText, provider string
	var alias int64
	var enabled, excluded bool
	if err := reader.QueryRowContext(ctx, `SELECT a.account_ref,a.provider_id,a.cli_account_id,a.enabled,COALESCE(e.excluded,0)
 FROM accounts a LEFT JOIN account_routing_exclusions e ON e.account_ref=a.account_ref WHERE a.account_ref=?`, ref.String()).Scan(&refText, &provider, &alias, &enabled, &excluded); err != nil {
		return indexedRoutingAccount{}, err
	}
	_, account, err := restoreIndexedRoutingAccount(store.catalog, refText, provider, alias)
	if err != nil {
		return indexedRoutingAccount{}, err
	}
	guard := false
	if provider == gemini.ProviderID {
		guards, err := store.readCredentialRoutingGuards(ctx, reader)
		if err != nil {
			return indexedRoutingAccount{}, err
		}
		guard = guards[ref]
	}
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

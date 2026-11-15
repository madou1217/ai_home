package sqliteaccount

import (
	"context"
	"database/sql"
	"errors"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// FindCredentialSnapshotByIdentity locates a registered stable identity without
// importing an unknown host login or confusing it with the incoming selection.
func (store *Store) FindCredentialSnapshotByIdentity(ctx context.Context, credential accountapp.Credential) (accountapp.CredentialSnapshot, bool, error) {
	var zero accountapp.CredentialSnapshot
	ref, err := accountcore.DeriveCredentialRef(credential)
	if err != nil {
		return zero, false, err
	}
	var rawRef string
	err = store.db.QueryRowContext(ctx, "SELECT c.account_ref FROM account_credentials c JOIN accounts a ON a.account_ref=c.account_ref WHERE a.provider_id=? AND c.credential_ref=?", credential.ProviderID(), ref.String()).Scan(&rawRef)
	if errors.Is(err, sql.ErrNoRows) {
		return zero, false, nil
	}
	if err != nil {
		return zero, false, err
	}
	accountRef, err := accountcore.ParseAccountRef(rawRef)
	if err != nil {
		return zero, false, err
	}
	out, err := store.GetCredentialSnapshot(ctx, accountRef)
	return out, err == nil, err
}

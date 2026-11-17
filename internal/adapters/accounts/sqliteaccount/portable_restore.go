package sqliteaccount

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// RestorePortableAccount preserves an unused source reference and CLI alias,
// while identity matches always reuse the existing canonical aggregate. Existing
// user state is retained; credential updates require the existing generation
// arbitration to prove the incoming grant is newer. The returned snapshot is authoritative.
func (store *Store) RestorePortableAccount(ctx context.Context, sourceRef, sourceAlias string, credential accountapp.Credential, profile accountapp.PublicProfile, disabled bool, supplement json.RawMessage) (accountcore.Account, bool, error) {
	req, err := accountapp.NewRegistrationRequest(store.catalog, credential, profile, time.Now())
	if err != nil {
		return accountcore.Account{}, false, err
	}
	document, err := store.credentials.Encode(credential)
	if err != nil {
		return accountcore.Account{}, false, err
	}
	var profileDoc encodedProfile
	if req.HasProfile() {
		profileDoc, err = store.profiles.Encode(req.ProfileSnapshot().Profile())
		if err != nil {
			return accountcore.Account{}, false, err
		}
	}
	preferred := req.AccountRef()
	if sourceRef != "" {
		preferred, err = accountcore.ParseAccountRef(sourceRef)
		if err != nil {
			return accountcore.Account{}, false, err
		}
	}
	store.routingWrites.Lock()
	defer store.routingWrites.Unlock()
	conn, err := store.db.Conn(ctx)
	if err != nil {
		return accountcore.Account{}, false, err
	}
	defer conn.Close()
	if _, err = conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return accountcore.Account{}, false, err
	}
	defer conn.ExecContext(ctx, "ROLLBACK")
	var existing string
	err = conn.QueryRowContext(ctx, "SELECT a.account_ref FROM accounts a JOIN account_credentials c ON c.account_ref=a.account_ref WHERE a.provider_id=? AND c.credential_ref=?", credential.ProviderID(), document.credentialRef.String()).Scan(&existing)
	if err == nil {
		ref, e := accountcore.ParseAccountRef(existing)
		if e != nil {
			return accountcore.Account{}, false, e
		}
		var current credentialRecord
		e = conn.QueryRowContext(ctx, credentialSnapshotQuery, ref.String()).Scan(&current.providerID, &current.credentialRef, &current.authKind, &current.authMode, &current.formatVersion, &current.payload, &current.updatedAtMS)
		if e != nil {
			return accountcore.Account{}, false, e
		}
		incomingJSON := string(document.json)
		if string(current.payload) != incomingJSON && supportsReauthentication(credential.ProviderID(), document.authKind, document.authMode) {
			stored, e := store.credentials.Decode(current.providerID, current.authKind, current.authMode, current.payload)
			if e != nil {
				return accountcore.Account{}, false, e
			}
			// Generation checks use the credential-derived identity; the stable
			// restored source ref can predate today's identity derivation rules.
			derived, e := accountcore.DeriveAccountRef(credential)
			if e != nil {
				return accountcore.Account{}, false, e
			}
			change, e := accountapp.NewReauthentication(store.catalog, derived, credential, nil, time.Now())
			if e != nil {
				return accountcore.Account{}, false, e
			}
			newer, e := change.ShouldReplaceCredential(stored)
			if e != nil {
				return accountcore.Account{}, false, e
			}
			if newer {
				now := time.Now().UnixMilli()
				if now <= current.updatedAtMS {
					now = current.updatedAtMS + 1
				}
				if _, e = conn.ExecContext(ctx, `UPDATE account_credentials SET credential_json=?,updated_at_ms=? WHERE account_ref=? AND updated_at_ms=?`, incomingJSON, now, ref.String(), current.updatedAtMS); e != nil {
					return accountcore.Account{}, false, e
				}
				if _, e = conn.ExecContext(ctx, `UPDATE accounts SET updated_at_ms=MAX(updated_at_ms,?) WHERE account_ref=?`, now, ref.String()); e != nil {
					return accountcore.Account{}, false, e
				}
				if req.HasProfile() {
					var profileVersion sql.NullInt64
					readErr := conn.QueryRowContext(ctx, "SELECT updated_at_ms FROM account_profiles WHERE account_ref=?", ref.String()).Scan(&profileVersion)
					if readErr != nil && !errors.Is(readErr, sql.ErrNoRows) {
						return accountcore.Account{}, false, readErr
					}
					if e = replaceProfile(ctx, conn, ref, reauthenticationRecord{profileUpdatedAtMS: profileVersion}, profileDoc, now); e != nil {
						return accountcore.Account{}, false, e
					}
				}
				if e = writePortableSupplement(ctx, conn, ref, now, supplement); e != nil {
					return accountcore.Account{}, false, e
				}

			}
		}
		entry, e := store.readCredentialRoutingEntry(ctx, conn, ref)
		if e != nil {
			return accountcore.Account{}, false, e
		}
		if _, e = conn.ExecContext(ctx, "COMMIT"); e != nil {
			return accountcore.Account{}, false, e
		}
		account, e := store.GetByRef(ctx, ref)
		store.routes.publishCredentialAccount(entry, "")
		return account, false, e
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return accountcore.Account{}, false, err
	}
	var occupied int
	if err = conn.QueryRowContext(ctx, "SELECT count(*) FROM accounts WHERE account_ref=?", preferred.String()).Scan(&occupied); err != nil {
		return accountcore.Account{}, false, err
	}
	if occupied > 0 {
		return accountcore.Account{}, false, errors.New("backup_source_identity_conflict")
	}
	alias, parseErr := strconv.ParseInt(sourceAlias, 10, 64)
	if parseErr != nil || alias <= 0 {
		alias = 0
	}
	if alias > 0 {
		if err = conn.QueryRowContext(ctx, "SELECT count(*) FROM accounts WHERE provider_id=? AND cli_account_id=?", credential.ProviderID(), alias).Scan(&occupied); err != nil {
			return accountcore.Account{}, false, err
		}
		if occupied > 0 {
			alias = 0
		}
	}
	if alias == 0 {
		if err = conn.QueryRowContext(ctx, "SELECT COALESCE(MAX(cli_account_id),0)+1 FROM accounts WHERE provider_id=?", credential.ProviderID()).Scan(&alias); err != nil {
			return accountcore.Account{}, false, err
		}
	}
	id, err := accountcore.NewCLIAccountID(alias)
	if err != nil {
		return accountcore.Account{}, false, err
	}
	now := req.RegisteredAt()
	account, err := accountcore.RestoreAccount(store.catalog, accountcore.RestoreAccountInput{Ref: preferred, ProviderID: credential.ProviderID(), CLIAccountID: id, Enabled: !disabled, CreatedAt: now, UpdatedAt: now})
	if err != nil {
		return accountcore.Account{}, false, err
	}
	if _, err = conn.ExecContext(ctx, "INSERT INTO accounts(account_ref,provider_id,cli_account_id,enabled,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?)", preferred.String(), credential.ProviderID(), alias, !disabled, now.UnixMilli(), now.UnixMilli()); err != nil {
		return accountcore.Account{}, false, err
	}
	if _, err = conn.ExecContext(ctx, `INSERT INTO account_credentials(account_ref,credential_ref,auth_kind,auth_mode,format_version,credential_json,updated_at_ms) VALUES(?,?,?,?,?,?,?)`, preferred.String(), document.credentialRef.String(), document.authKind, document.authMode, credentialFormatVersion, string(document.json), now.UnixMilli()); err != nil {
		return accountcore.Account{}, false, err
	}
	if req.HasProfile() {
		if err = insertRegistrationProfile(ctx, conn, preferred, profileDoc, now.UnixMilli()); err != nil {
			return accountcore.Account{}, false, err
		}
	}
	if err = writePortableSupplement(ctx, conn, preferred, now.UnixMilli(), supplement); err != nil {
		return accountcore.Account{}, false, err
	}
	entry, err := store.readCredentialRoutingEntry(ctx, conn, preferred)
	if err != nil {
		return accountcore.Account{}, false, err
	}
	if _, err = conn.ExecContext(ctx, "COMMIT"); err != nil {
		return accountcore.Account{}, false, fmt.Errorf("backup_restore_commit: %w", err)
	}
	store.routes.publishCredentialAccount(entry, "")
	return account, true, nil
}

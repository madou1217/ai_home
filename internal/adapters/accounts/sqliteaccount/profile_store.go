package sqliteaccount

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

var _ accountapp.ProfileStore = (*Store)(nil)

// UpsertProfile 写入不早于当前版本的 Provider 公开资料。
func (store *Store) UpsertProfile(
	ctx context.Context,
	snapshot accountapp.ProfileSnapshot,
) error {
	document, err := store.profiles.Encode(snapshot.Profile())
	if err != nil {
		return err
	}
	const statement = `
		INSERT INTO account_profiles (
			account_ref, display_name, email, subscription_kind,
			subscription_raw, format_version, profile_json, updated_at_ms
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(account_ref) DO UPDATE SET
			display_name = excluded.display_name,
			email = excluded.email,
			subscription_kind = excluded.subscription_kind,
			subscription_raw = excluded.subscription_raw,
			format_version = excluded.format_version,
			profile_json = excluded.profile_json,
			updated_at_ms = excluded.updated_at_ms
		WHERE excluded.updated_at_ms > account_profiles.updated_at_ms
		   OR (
				excluded.updated_at_ms = account_profiles.updated_at_ms
				AND excluded.display_name = account_profiles.display_name
				AND excluded.email = account_profiles.email
				AND excluded.subscription_kind = account_profiles.subscription_kind
				AND excluded.subscription_raw = account_profiles.subscription_raw
				AND excluded.format_version = account_profiles.format_version
				AND excluded.profile_json = account_profiles.profile_json
			)`
	result, err := store.db.ExecContext(
		ctx,
		statement,
		snapshot.AccountRef().String(),
		document.displayName,
		document.email,
		document.subscriptionKind,
		document.subscriptionRaw,
		profileFormatVersion,
		string(document.json),
		snapshot.UpdatedAt().UnixMilli(),
	)
	if isForeignKeyError(err) {
		return accountapp.ErrAccountNotFound
	}
	if err != nil {
		return fmt.Errorf("写入账号公开资料失败: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("读取账号公开资料写入结果失败: %w", err)
	}
	if affected != 1 {
		return accountapp.ErrProfileConflict
	}
	return nil
}

// GetProfile 按账号身份延迟读取并重新构造 Provider 公开资料。
func (store *Store) GetProfile(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) (accountapp.ProfileSnapshot, error) {
	if !accountRef.IsValid() {
		return accountapp.ProfileSnapshot{}, accountcore.ErrInvalidAccountRef
	}
	const query = `
		SELECT a.provider_id, p.display_name, p.email,
		       p.subscription_kind, p.subscription_raw,
		       p.format_version, p.profile_json, p.updated_at_ms
		FROM account_profiles AS p
		INNER JOIN accounts AS a ON a.account_ref = p.account_ref
		WHERE p.account_ref = ?
		LIMIT 1`
	var providerID string
	var document encodedProfile
	var formatVersion int
	var updatedAtMS int64
	err := store.db.QueryRowContext(ctx, query, accountRef.String()).Scan(
		&providerID,
		&document.displayName,
		&document.email,
		&document.subscriptionKind,
		&document.subscriptionRaw,
		&formatVersion,
		&document.json,
		&updatedAtMS,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return accountapp.ProfileSnapshot{}, accountapp.ErrProfileNotFound
	}
	if err != nil {
		return accountapp.ProfileSnapshot{}, fmt.Errorf("读取账号公开资料失败: %w", err)
	}
	if formatVersion != profileFormatVersion {
		return accountapp.ProfileSnapshot{}, ErrInvalidProfileDocument
	}
	profile, err := store.profiles.Decode(providerID, document)
	if err != nil {
		return accountapp.ProfileSnapshot{}, err
	}
	snapshot, err := accountapp.NewProfileSnapshot(
		store.catalog,
		profile,
		time.UnixMilli(updatedAtMS).UTC(),
	)
	if err != nil || snapshot.AccountRef() != accountRef {
		return accountapp.ProfileSnapshot{}, ErrInvalidProfileDocument
	}
	return snapshot, nil
}

package sqliteaccount

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

var _ accountapp.LaunchSelectionStore = (*Store)(nil)

// launchCandidateSelect 单次读取启动资格需要的基础账号列和完整凭据快照。
const launchCandidateSelect = `
	SELECT a.account_ref, a.provider_id, a.cli_account_id, a.enabled,
	       a.created_at_ms, a.updated_at_ms,
	       c.credential_ref, c.auth_kind, c.auth_mode, c.format_version,
	       c.credential_json, c.updated_at_ms
	FROM accounts AS a
	LEFT JOIN account_credentials AS c ON c.account_ref = a.account_ref`

// LoadLaunchCandidateByRef 使用账号主键点查显式启动目标。
func (store *Store) LoadLaunchCandidateByRef(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) (accountapp.LaunchCandidate, error) {
	if store == nil || store.db == nil || ctx == nil || !accountRef.IsValid() {
		return accountapp.LaunchCandidate{}, accountapp.ErrInvalidLaunchSelection
	}
	return store.scanLaunchCandidate(store.db.QueryRowContext(
		ctx,
		launchCandidateSelect+` WHERE a.account_ref = ? LIMIT 1`,
		accountRef.String(),
	))
}

// LoadLaunchCandidateByCLIAccountID 使用 Provider 内唯一索引点查用户数字别名。
func (store *Store) LoadLaunchCandidateByCLIAccountID(
	ctx context.Context,
	providerID string,
	cliAccountID accountcore.CLIAccountID,
) (accountapp.LaunchCandidate, error) {
	canonicalProviderID, err := store.canonicalLaunchProvider(
		ctx,
		providerID,
	)
	if err != nil {
		return accountapp.LaunchCandidate{}, err
	}
	if !cliAccountID.IsValid() {
		return accountapp.LaunchCandidate{}, accountapp.ErrInvalidLaunchSelection
	}
	return store.scanLaunchCandidate(store.db.QueryRowContext(
		ctx,
		launchCandidateSelect+
			` WHERE a.provider_id = ? AND a.cli_account_id = ? LIMIT 1`,
		canonicalProviderID,
		cliAccountID.Int64(),
	))
}

// LoadDefaultLaunchCandidate 使用 Provider 默认关系主键点查启动目标。
func (store *Store) LoadDefaultLaunchCandidate(
	ctx context.Context,
	providerID string,
) (accountapp.LaunchCandidate, error) {
	canonicalProviderID, err := store.canonicalLaunchProvider(
		ctx,
		providerID,
	)
	if err != nil {
		return accountapp.LaunchCandidate{}, err
	}
	query := launchCandidateSelect + `
		INNER JOIN account_defaults AS d ON d.account_ref = a.account_ref
		WHERE d.provider_id = ?
		LIMIT 1`
	candidate, err := store.scanLaunchCandidate(store.db.QueryRowContext(
		ctx,
		query,
		canonicalProviderID,
	))
	if errors.Is(err, accountapp.ErrAccountNotFound) {
		return accountapp.LaunchCandidate{}, accountapp.ErrProviderDefaultNotFound
	}
	return candidate, err
}

// scanLaunchCandidate 恢复基础账号并在内存中校验凭据 JSON，结果不携带敏感正文。
func (store *Store) scanLaunchCandidate(
	row rowScanner,
) (accountapp.LaunchCandidate, error) {
	var record accountRecord
	var credentialRef, authKind, authMode, payload sql.NullString
	var formatVersion, credentialUpdatedAtMS sql.NullInt64
	if err := row.Scan(
		&record.accountRef,
		&record.providerID,
		&record.cliAccountID,
		&record.enabled,
		&record.createdAtMS,
		&record.updatedAtMS,
		&credentialRef,
		&authKind,
		&authMode,
		&formatVersion,
		&payload,
		&credentialUpdatedAtMS,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return accountapp.LaunchCandidate{}, accountapp.ErrAccountNotFound
		}
		return accountapp.LaunchCandidate{}, fmt.Errorf(
			"读取启动账号候选失败: %w",
			err,
		)
	}
	account, err := store.restoreAccount(record)
	if err != nil {
		return accountapp.LaunchCandidate{}, ErrIncompatibleDatabase
	}
	hasCredential, err := store.restoreLaunchCredential(
		account,
		credentialRef,
		authKind,
		authMode,
		formatVersion,
		payload,
		credentialUpdatedAtMS,
	)
	if err != nil {
		return accountapp.LaunchCandidate{}, err
	}
	candidate, err := accountapp.NewLaunchCandidate(
		account,
		hasCredential,
	)
	if err != nil {
		return accountapp.LaunchCandidate{}, ErrIncompatibleDatabase
	}
	return candidate, nil
}

// restoreLaunchCredential 区分无凭据账号，并复用正式快照恢复规则校验完整凭据。
func (store *Store) restoreLaunchCredential(
	account accountcore.Account,
	credentialRef sql.NullString,
	authKind sql.NullString,
	authMode sql.NullString,
	formatVersion sql.NullInt64,
	payload sql.NullString,
	updatedAtMS sql.NullInt64,
) (bool, error) {
	fields := []bool{
		credentialRef.Valid,
		authKind.Valid,
		authMode.Valid,
		formatVersion.Valid,
		payload.Valid,
		updatedAtMS.Valid,
	}
	present := false
	complete := true
	for _, valid := range fields {
		present = present || valid
		complete = complete && valid
	}
	if !present {
		return false, nil
	}
	if !complete {
		return false, ErrIncompatibleDatabase
	}
	snapshot, err := store.restoreCredentialSnapshot(
		account.Ref(),
		credentialRecord{
			providerID:    account.ProviderID(),
			credentialRef: credentialRef.String,
			authKind:      authKind.String,
			authMode:      authMode.String,
			formatVersion: int(formatVersion.Int64),
			payload:       []byte(payload.String),
			updatedAtMS:   updatedAtMS.Int64,
		},
	)
	if err != nil ||
		snapshot.AccountRef() != account.Ref() ||
		snapshot.ProviderID() != account.ProviderID() {
		return false, ErrIncompatibleDatabase
	}
	return true, nil
}

// canonicalLaunchProvider 验证上下文和规范 Provider，适配器不接受别名或隐式修剪。
func (store *Store) canonicalLaunchProvider(
	ctx context.Context,
	providerID string,
) (string, error) {
	if store == nil || store.db == nil || store.catalog == nil || ctx == nil {
		return "", accountapp.ErrInvalidLaunchSelection
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	canonicalProviderID, found := store.catalog.CanonicalID(providerID)
	if !found || canonicalProviderID != providerID {
		return "", accountapp.ErrInvalidLaunchSelection
	}
	return canonicalProviderID, nil
}

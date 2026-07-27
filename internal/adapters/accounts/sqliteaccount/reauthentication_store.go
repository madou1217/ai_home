package sqliteaccount

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/core/accounts/codex"
)

var _ accountapp.ReauthenticationStore = (*Store)(nil)

// reauthenticationTargetSQL 是读取原地 OAuth 重新认证所需版本和账号快照的唯一查询。
const reauthenticationTargetSQL = `
	SELECT a.account_ref, a.provider_id, a.cli_account_id, a.enabled,
	       a.created_at_ms, a.updated_at_ms,
	       c.auth_kind, c.auth_mode, c.updated_at_ms,
	       p.updated_at_ms
	FROM accounts AS a
	LEFT JOIN account_credentials AS c ON c.account_ref = a.account_ref
	LEFT JOIN account_profiles AS p ON p.account_ref = a.account_ref
	WHERE a.account_ref = ?
	LIMIT 1`

// GetReauthenticationTarget 返回身份可稳定保持的 Codex 或 Claude OAuth 账号。
func (store *Store) GetReauthenticationTarget(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) (accountcore.Account, error) {
	if !accountRef.IsValid() {
		return accountcore.Account{}, accountcore.ErrInvalidAccountRef
	}
	record, account, err := store.readReauthenticationTarget(
		store.db.QueryRowContext(ctx, reauthenticationTargetSQL, accountRef.String()),
	)
	if err != nil {
		return accountcore.Account{}, err
	}
	if !supportsReauthentication(
		account.ProviderID(),
		record.authKind.String,
		record.authMode.String,
	) {
		return accountcore.Account{}, accountapp.ErrReauthenticationUnsupported
	}
	return account, nil
}

// Reauthenticate 在立即事务中原子替换凭据、公开资料和账号更新时间。
func (store *Store) Reauthenticate(
	ctx context.Context,
	reauthentication accountapp.Reauthentication,
) (result accountcore.Account, resultErr error) {
	if !store.acceptsReauthentication(reauthentication) {
		return accountcore.Account{}, accountapp.ErrInvalidReauthentication
	}
	credentialDocument, err := store.credentials.Encode(
		reauthentication.Credential(),
	)
	if err != nil {
		return accountcore.Account{}, err
	}
	profileDocument, err := store.profiles.Encode(
		reauthentication.Profile().Profile(),
	)
	if err != nil {
		return accountcore.Account{}, err
	}
	if !supportsReauthentication(
		reauthentication.ProviderID(),
		credentialDocument.authKind,
		credentialDocument.authMode,
	) {
		return accountcore.Account{}, accountapp.ErrReauthenticationUnsupported
	}

	connection, err := store.db.Conn(ctx)
	if err != nil {
		return accountcore.Account{}, fmt.Errorf("获取账号重新认证连接失败: %w", err)
	}
	defer func() {
		_ = connection.Close()
	}()
	if _, err := connection.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		if isBusyError(err) {
			return accountcore.Account{}, accountapp.ErrReauthenticationConflict
		}
		return accountcore.Account{}, fmt.Errorf("开始账号重新认证事务失败: %w", err)
	}
	defer func() {
		if resultErr != nil {
			_, _ = connection.ExecContext(context.WithoutCancel(ctx), "ROLLBACK")
		}
	}()

	record, current, err := store.readReauthenticationTarget(
		connection.QueryRowContext(
			ctx,
			reauthenticationTargetSQL,
			reauthentication.AccountRef().String(),
		),
	)
	if err != nil {
		return accountcore.Account{}, err
	}
	if current.ProviderID() != reauthentication.ProviderID() {
		return accountcore.Account{}, accountapp.ErrReauthenticationIdentityMismatch
	}
	if !supportsReauthentication(
		current.ProviderID(),
		record.authKind.String,
		record.authMode.String,
	) {
		return accountcore.Account{}, accountapp.ErrReauthenticationUnsupported
	}

	updatedAtMS := reauthentication.UpdatedAt().UnixMilli()
	if !record.canReplaceAt(updatedAtMS) {
		return accountcore.Account{}, accountapp.ErrReauthenticationConflict
	}
	if err := replaceCredential(
		ctx,
		connection,
		reauthentication.AccountRef(),
		record,
		credentialDocument,
		updatedAtMS,
	); err != nil {
		return accountcore.Account{}, err
	}
	if err := replaceProfile(
		ctx,
		connection,
		reauthentication.AccountRef(),
		record,
		profileDocument,
		updatedAtMS,
	); err != nil {
		return accountcore.Account{}, err
	}
	if err := touchReauthenticatedAccount(
		ctx,
		connection,
		reauthentication.AccountRef(),
		record.account.updatedAtMS,
		updatedAtMS,
	); err != nil {
		return accountcore.Account{}, err
	}
	if _, err := connection.ExecContext(ctx, "COMMIT"); err != nil {
		if isBusyError(err) {
			return accountcore.Account{}, accountapp.ErrReauthenticationConflict
		}
		return accountcore.Account{}, fmt.Errorf("提交账号重新认证事务失败: %w", err)
	}

	record.account.updatedAtMS = updatedAtMS
	return store.restoreAccount(record.account)
}

// acceptsReauthentication 校验命令和 Store 当前 Provider 合同一致。
func (store *Store) acceptsReauthentication(
	reauthentication accountapp.Reauthentication,
) bool {
	if store == nil ||
		store.db == nil ||
		store.catalog == nil ||
		!reauthentication.IsValid() {
		return false
	}
	providerID, found := store.catalog.CanonicalID(
		reauthentication.ProviderID(),
	)
	return found && providerID == reauthentication.ProviderID()
}

// readReauthenticationTarget 恢复账号并保留事务 CAS 所需的当前版本。
func (store *Store) readReauthenticationTarget(
	row rowScanner,
) (reauthenticationRecord, accountcore.Account, error) {
	var record reauthenticationRecord
	err := row.Scan(
		&record.account.accountRef,
		&record.account.providerID,
		&record.account.cliAccountID,
		&record.account.enabled,
		&record.account.createdAtMS,
		&record.account.updatedAtMS,
		&record.authKind,
		&record.authMode,
		&record.credentialUpdatedAtMS,
		&record.profileUpdatedAtMS,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return reauthenticationRecord{}, accountcore.Account{}, accountapp.ErrAccountNotFound
	}
	if err != nil {
		return reauthenticationRecord{}, accountcore.Account{}, fmt.Errorf(
			"读取账号重新认证目标失败: %w",
			err,
		)
	}
	if !record.authKind.Valid ||
		!record.authMode.Valid ||
		!record.credentialUpdatedAtMS.Valid {
		return reauthenticationRecord{}, accountcore.Account{}, accountapp.ErrCredentialNotFound
	}
	account, err := store.restoreAccount(record.account)
	if err != nil {
		return reauthenticationRecord{}, accountcore.Account{}, err
	}
	return record, account, nil
}

// supportsReauthentication 只允许身份不依赖当前 Token 的 OAuth 凭据形态。
func supportsReauthentication(
	providerID string,
	authKind string,
	authMode string,
) bool {
	switch providerID {
	case codex.ProviderID:
		return authKind == codex.AuthKindOAuth.String() && authMode == ""
	case claude.ProviderID:
		return authKind == claude.AuthKindOAuth.String() &&
			authMode == claude.OAuthModeRefreshable.String()
	default:
		return false
	}
}

// replaceCredential 使用读取到的版本执行 compare-and-swap。
func replaceCredential(
	ctx context.Context,
	connection *sql.Conn,
	accountRef accountcore.AccountRef,
	current reauthenticationRecord,
	document encodedCredential,
	updatedAtMS int64,
) error {
	const statement = `
		UPDATE account_credentials
		SET auth_kind = ?, auth_mode = ?, format_version = ?,
		    credential_json = ?, updated_at_ms = ?
		WHERE account_ref = ?
		  AND auth_kind = ?
		  AND auth_mode = ?
		  AND updated_at_ms = ?`
	result, err := connection.ExecContext(
		ctx,
		statement,
		document.authKind,
		document.authMode,
		credentialFormatVersion,
		string(document.json),
		updatedAtMS,
		accountRef.String(),
		current.authKind.String,
		current.authMode.String,
		current.credentialUpdatedAtMS.Int64,
	)
	return requireSingleReauthenticationWrite(result, err, "替换账号凭据")
}

// replaceProfile 插入缺失资料，或使用读取到的版本替换现有资料。
func replaceProfile(
	ctx context.Context,
	connection *sql.Conn,
	accountRef accountcore.AccountRef,
	current reauthenticationRecord,
	document encodedProfile,
	updatedAtMS int64,
) error {
	if !current.profileUpdatedAtMS.Valid {
		return insertRegistrationProfile(
			ctx,
			connection,
			accountRef,
			document,
			updatedAtMS,
		)
	}
	const statement = `
		UPDATE account_profiles
		SET display_name = ?, email = ?, subscription_kind = ?,
		    subscription_raw = ?, format_version = ?, profile_json = ?,
		    updated_at_ms = ?
		WHERE account_ref = ? AND updated_at_ms = ?`
	result, err := connection.ExecContext(
		ctx,
		statement,
		document.displayName,
		document.email,
		document.subscriptionKind,
		document.subscriptionRaw,
		profileFormatVersion,
		string(document.json),
		updatedAtMS,
		accountRef.String(),
		current.profileUpdatedAtMS.Int64,
	)
	return requireSingleReauthenticationWrite(result, err, "替换账号公开资料")
}

// touchReauthenticatedAccount 使用账号版本 CAS 推进基础聚合更新时间。
func touchReauthenticatedAccount(
	ctx context.Context,
	connection *sql.Conn,
	accountRef accountcore.AccountRef,
	currentUpdatedAtMS int64,
	updatedAtMS int64,
) error {
	const statement = `
		UPDATE accounts
		SET updated_at_ms = ?
		WHERE account_ref = ? AND updated_at_ms = ?`
	result, err := connection.ExecContext(
		ctx,
		statement,
		updatedAtMS,
		accountRef.String(),
		currentUpdatedAtMS,
	)
	return requireSingleReauthenticationWrite(result, err, "更新账号重新认证时间")
}

// requireSingleReauthenticationWrite 统一事务写入和 CAS 冲突语义。
func requireSingleReauthenticationWrite(
	result sql.Result,
	err error,
	action string,
) error {
	if isBusyError(err) {
		return accountapp.ErrReauthenticationConflict
	}
	if err != nil {
		return fmt.Errorf("%s失败: %w", action, err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("读取%s结果失败: %w", action, err)
	}
	if affected != 1 {
		return accountapp.ErrReauthenticationConflict
	}
	return nil
}

// reauthenticationRecord 保存同一事务中读取的账号和凭据版本。
type reauthenticationRecord struct {
	account               accountRecord
	authKind              sql.NullString
	authMode              sql.NullString
	credentialUpdatedAtMS sql.NullInt64
	profileUpdatedAtMS    sql.NullInt64
}

// canReplaceAt 确保凭据、资料和基础账号版本统一单调推进。
func (record reauthenticationRecord) canReplaceAt(updatedAtMS int64) bool {
	if updatedAtMS <= record.account.updatedAtMS ||
		updatedAtMS <= record.credentialUpdatedAtMS.Int64 {
		return false
	}
	return !record.profileUpdatedAtMS.Valid ||
		updatedAtMS > record.profileUpdatedAtMS.Int64
}

package sqliteaccount

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

var _ accountapp.CredentialStore = (*Store)(nil)

// Register 在同一 SQLite 事务中创建基础账号和 Provider 凭据。
func (store *Store) Register(
	ctx context.Context,
	registration accountapp.Registration,
) error {
	account := registration.Account()
	if !store.acceptsAccount(account) {
		return accountapp.ErrInvalidRegistration
	}
	document, err := store.credentials.Encode(registration.Credential())
	if err != nil {
		return err
	}
	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("开始账号注册事务失败: %w", err)
	}
	defer func() {
		_ = transaction.Rollback()
	}()

	if err := insertAccount(ctx, transaction, account); err != nil {
		return err
	}
	if err := insertCredential(
		ctx,
		transaction,
		account.Ref(),
		document,
		registration.CredentialUpdatedAt().UnixMilli(),
	); err != nil {
		return err
	}
	if err := transaction.Commit(); err != nil {
		if isConstraintError(err) {
			return accountapp.ErrAccountConflict
		}
		return fmt.Errorf("提交账号注册事务失败: %w", err)
	}
	return nil
}

// GetCredential 按账号身份延迟读取并重新构造 Provider 凭据。
func (store *Store) GetCredential(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) (accountapp.Credential, error) {
	if !accountRef.IsValid() {
		return nil, accountcore.ErrInvalidAccountRef
	}
	const query = `
		SELECT a.provider_id, c.auth_kind, c.auth_mode,
		       c.format_version, c.credential_json
		FROM account_credentials AS c
		INNER JOIN accounts AS a ON a.account_ref = c.account_ref
		WHERE c.account_ref = ?
		LIMIT 1`
	var providerID, authKind, authMode string
	var formatVersion int
	var payload []byte
	err := store.db.QueryRowContext(ctx, query, accountRef.String()).Scan(
		&providerID,
		&authKind,
		&authMode,
		&formatVersion,
		&payload,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, accountapp.ErrCredentialNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("读取账号凭据失败: %w", err)
	}
	if formatVersion != credentialFormatVersion {
		return nil, ErrInvalidCredential
	}
	credential, err := store.credentials.Decode(providerID, authKind, authMode, payload)
	if err != nil {
		return nil, err
	}
	derivedRef, err := accountcore.DeriveAccountRef(credential)
	if err != nil || derivedRef != accountRef {
		return nil, ErrInvalidCredential
	}
	return credential, nil
}

// insertAccount 在现有事务中写入基础账号。
func insertAccount(
	ctx context.Context,
	transaction *sql.Tx,
	account accountcore.Account,
) error {
	const statement = `
		INSERT INTO accounts (
			account_ref, provider_id, cli_account_id, enabled,
			created_at_ms, updated_at_ms
		) VALUES (?, ?, ?, ?, ?, ?)`
	_, err := transaction.ExecContext(ctx, statement, accountRowArguments(account)...)
	return mapAccountWriteError(err)
}

// insertCredential 在现有事务中写入版本化凭据文档。
func insertCredential(
	ctx context.Context,
	transaction *sql.Tx,
	accountRef accountcore.AccountRef,
	document encodedCredential,
	updatedAtMS int64,
) error {
	const statement = `
		INSERT INTO account_credentials (
			account_ref, auth_kind, auth_mode, format_version,
			credential_json, updated_at_ms
		) VALUES (?, ?, ?, ?, ?, ?)`
	_, err := transaction.ExecContext(
		ctx,
		statement,
		accountRef.String(),
		document.authKind,
		document.authMode,
		credentialFormatVersion,
		string(document.json),
		updatedAtMS,
	)
	if isConstraintError(err) {
		return accountapp.ErrAccountConflict
	}
	if err != nil {
		return fmt.Errorf("写入账号凭据失败: %w", err)
	}
	return nil
}

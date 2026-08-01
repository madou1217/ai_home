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

var _ accountapp.CredentialStore = (*Store)(nil)
var _ accountapp.CredentialVersionStore = (*Store)(nil)

// credentialSnapshotQuery 是按 AccountRef 读取凭据及其 CAS 版本的唯一查询。
const credentialSnapshotQuery = `
	SELECT a.provider_id, c.credential_ref, c.auth_kind, c.auth_mode,
	       c.format_version, c.credential_json, c.updated_at_ms
	FROM account_credentials AS c
	INNER JOIN accounts AS a ON a.account_ref = c.account_ref
	WHERE c.account_ref = ?
	LIMIT 1`

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
	store.routingWrites.Lock()
	defer store.routingWrites.Unlock()
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
	routingAccount, err := store.newRoutingAccount(account)
	if err != nil {
		return err
	}
	store.routes.setAccount(routingAccount, account.Enabled())
	return nil
}

// GetCredential 按账号身份延迟读取并重新构造 Provider 凭据。
func (store *Store) GetCredential(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) (accountapp.Credential, error) {
	snapshot, err := store.GetCredentialSnapshot(ctx, accountRef)
	if err != nil {
		return nil, err
	}
	return snapshot.Credential(), nil
}

// GetCredentialBinding 按账号身份返回不依赖当前密钥反推主键的凭据绑定。
func (store *Store) GetCredentialBinding(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) (accountapp.CredentialBinding, error) {
	snapshot, err := store.GetCredentialSnapshot(ctx, accountRef)
	if err != nil {
		return accountapp.CredentialBinding{}, err
	}
	return snapshot.Binding(), nil
}

// GetCredentialSnapshot 按账号身份读取凭据及其毫秒精度 CAS 版本。
func (store *Store) GetCredentialSnapshot(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) (accountapp.CredentialSnapshot, error) {
	if !accountRef.IsValid() {
		return accountapp.CredentialSnapshot{}, accountcore.ErrInvalidAccountRef
	}
	var record credentialRecord
	err := store.db.QueryRowContext(
		ctx,
		credentialSnapshotQuery,
		accountRef.String(),
	).Scan(
		&record.providerID,
		&record.credentialRef,
		&record.authKind,
		&record.authMode,
		&record.formatVersion,
		&record.payload,
		&record.updatedAtMS,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return accountapp.CredentialSnapshot{}, accountapp.ErrCredentialNotFound
	}
	if err != nil {
		return accountapp.CredentialSnapshot{}, fmt.Errorf(
			"读取账号凭据失败: %w",
			err,
		)
	}
	return store.restoreCredentialSnapshot(accountRef, record)
}

// restoreCredentialSnapshot 统一验证凭据格式、引用摘要和账号绑定。
func (store *Store) restoreCredentialSnapshot(
	accountRef accountcore.AccountRef,
	record credentialRecord,
) (accountapp.CredentialSnapshot, error) {
	if record.formatVersion != credentialFormatVersion {
		return accountapp.CredentialSnapshot{}, ErrInvalidCredential
	}
	credential, err := store.credentials.Decode(
		record.providerID,
		record.authKind,
		record.authMode,
		record.payload,
	)
	if err != nil {
		return accountapp.CredentialSnapshot{}, err
	}
	credentialRef, err := accountcore.ParseCredentialRef(record.credentialRef)
	if err != nil {
		return accountapp.CredentialSnapshot{}, ErrInvalidCredential
	}
	derivedCredentialRef, err := accountcore.DeriveCredentialRef(credential)
	if err != nil || derivedCredentialRef != credentialRef {
		return accountapp.CredentialSnapshot{}, ErrInvalidCredential
	}
	snapshot, err := accountapp.NewCredentialSnapshot(
		accountRef,
		record.providerID,
		credential,
		time.UnixMilli(record.updatedAtMS).UTC(),
	)
	if err != nil {
		return accountapp.CredentialSnapshot{}, ErrInvalidCredential
	}
	return snapshot, nil
}

// credentialRecord 是持久化凭据恢复使用的内部扫描结构。
type credentialRecord struct {
	providerID    string
	credentialRef string
	authKind      string
	authMode      string
	formatVersion int
	payload       []byte
	updatedAtMS   int64
}

// ReplaceCredential 使用 updated_at_ms compare-and-swap 原子替换凭据文档。
func (store *Store) ReplaceCredential(
	ctx context.Context,
	replacement accountapp.CredentialReplacement,
) error {
	if store == nil ||
		store.db == nil ||
		!replacement.IsValid() {
		return accountapp.ErrInvalidCredentialReplacement
	}
	document, err := store.credentials.Encode(replacement.Credential())
	if err != nil {
		return err
	}
	const statement = `
		UPDATE account_credentials
		SET credential_ref = ?, auth_kind = ?, auth_mode = ?, format_version = ?,
		    credential_json = ?, updated_at_ms = ?
		WHERE account_ref = ? AND updated_at_ms = ?`
	result, err := store.db.ExecContext(
		ctx,
		statement,
		document.credentialRef.String(),
		document.authKind,
		document.authMode,
		credentialFormatVersion,
		string(document.json),
		replacement.UpdatedAt().UnixMilli(),
		replacement.AccountRef().String(),
		replacement.ExpectedUpdatedAt().UnixMilli(),
	)
	if isConstraintError(err) {
		return accountapp.ErrCredentialConflict
	}
	if err != nil {
		return fmt.Errorf("替换账号凭据失败: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("读取账号凭据替换结果失败: %w", err)
	}
	if affected != 1 {
		return accountapp.ErrCredentialConflict
	}
	return nil
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
			account_ref, credential_ref, auth_kind, auth_mode, format_version,
			credential_json, updated_at_ms
		) VALUES (?, ?, ?, ?, ?, ?, ?)`
	_, err := transaction.ExecContext(
		ctx,
		statement,
		accountRef.String(),
		document.credentialRef.String(),
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

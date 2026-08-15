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

var _ accountapp.StaticCredentialRotationStore = (*Store)(nil)

// staticCredentialRotationTargetSQL 读取轮换事务需要的账号和当前凭据版本。
const staticCredentialRotationTargetSQL = `
	SELECT a.account_ref, a.provider_id, a.cli_account_id, a.enabled,
	       a.created_at_ms, a.updated_at_ms,
	       c.credential_ref, c.auth_kind, c.auth_mode, c.updated_at_ms
	FROM accounts AS a
	LEFT JOIN account_credentials AS c ON c.account_ref = a.account_ref
	WHERE a.account_ref = ?
	LIMIT 1`

// RotateStaticCredential 原子替换静态凭据并清理旧 usage，模型保留到异步刷新成功。
func (store *Store) RotateStaticCredential(
	ctx context.Context,
	rotation accountapp.StaticCredentialRotation,
) (result accountcore.Account, resultErr error) {
	if store == nil ||
		store.db == nil ||
		store.routes == nil ||
		ctx == nil ||
		!rotation.IsValid() {
		return accountcore.Account{}, accountapp.ErrInvalidStaticCredentialRotation
	}
	document, err := store.credentials.Encode(rotation.Replacement())
	if err != nil {
		return accountcore.Account{}, err
	}
	currentCredentialRef, err := accountcore.DeriveCredentialRef(
		rotation.CurrentCredential(),
	)
	if err != nil {
		return accountcore.Account{}, accountapp.ErrInvalidStaticCredentialRotation
	}
	store.routingWrites.Lock()
	defer store.routingWrites.Unlock()
	connection, err := store.db.Conn(ctx)
	if err != nil {
		return accountcore.Account{}, fmt.Errorf("获取静态凭据轮换连接失败: %w", err)
	}
	defer func() {
		_ = connection.Close()
	}()
	if _, err := connection.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		if isBusyError(err) {
			return accountcore.Account{}, accountapp.ErrStaticCredentialRotationConflict
		}
		return accountcore.Account{}, fmt.Errorf("开始静态凭据轮换事务失败: %w", err)
	}
	defer func() {
		if resultErr != nil {
			_, _ = connection.ExecContext(context.WithoutCancel(ctx), "ROLLBACK")
		}
	}()

	record, err := store.readStaticCredentialRotationTarget(
		connection.QueryRowContext(
			ctx,
			staticCredentialRotationTargetSQL,
			rotation.AccountRef().String(),
		),
	)
	if err != nil {
		return accountcore.Account{}, err
	}
	currentAccount, err := store.restoreAccount(record.account)
	if err != nil {
		return accountcore.Account{}, err
	}
	if currentAccount.ProviderID() != rotation.ProviderID() ||
		!currentAccount.UpdatedAt().Equal(rotation.ExpectedAccountUpdatedAt()) ||
		record.credentialRef.String != currentCredentialRef.String() ||
		record.credentialUpdatedAtMS.Int64 != rotation.ExpectedCredentialUpdatedAt().UnixMilli() {
		return accountcore.Account{}, accountapp.ErrStaticCredentialRotationConflict
	}
	if !supportsStaticCredentialRotation(
		currentAccount.ProviderID(),
		record.authKind.String,
		record.authMode.String,
	) {
		return accountcore.Account{}, accountapp.ErrStaticCredentialRotationUnsupported
	}

	updatedAtMS := rotation.UpdatedAt().UnixMilli()
	if err := replaceStaticCredential(
		ctx,
		connection,
		rotation,
		record,
		document,
		updatedAtMS,
	); err != nil {
		return accountcore.Account{}, err
	}
	if err := touchStaticCredentialAccount(
		ctx,
		connection,
		rotation,
		updatedAtMS,
	); err != nil {
		return accountcore.Account{}, err
	}
	if err := clearCredentialUsage(
		ctx,
		connection,
		rotation.AccountRef(),
	); err != nil {
		return accountcore.Account{}, err
	}
	if _, err := connection.ExecContext(ctx, "COMMIT"); err != nil {
		if isBusyError(err) || isConstraintError(err) {
			return accountcore.Account{}, accountapp.ErrStaticCredentialRotationConflict
		}
		return accountcore.Account{}, fmt.Errorf("提交静态凭据轮换事务失败: %w", err)
	}
	record.account.updatedAtMS = updatedAtMS
	return store.restoreAccount(record.account)
}

// readStaticCredentialRotationTarget 解析事务内的账号和凭据版本记录。
func (store *Store) readStaticCredentialRotationTarget(
	row rowScanner,
) (staticCredentialRotationRecord, error) {
	var record staticCredentialRotationRecord
	err := row.Scan(
		&record.account.accountRef,
		&record.account.providerID,
		&record.account.cliAccountID,
		&record.account.enabled,
		&record.account.createdAtMS,
		&record.account.updatedAtMS,
		&record.credentialRef,
		&record.authKind,
		&record.authMode,
		&record.credentialUpdatedAtMS,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return staticCredentialRotationRecord{}, accountapp.ErrAccountNotFound
	}
	if err != nil {
		return staticCredentialRotationRecord{}, fmt.Errorf(
			"读取静态凭据轮换目标失败: %w",
			err,
		)
	}
	if !record.credentialRef.Valid ||
		!record.authKind.Valid ||
		!record.authMode.Valid ||
		!record.credentialUpdatedAtMS.Valid {
		return staticCredentialRotationRecord{}, accountapp.ErrCredentialNotFound
	}
	if _, err := accountcore.ParseCredentialRef(record.credentialRef.String); err != nil {
		return staticCredentialRotationRecord{}, ErrInvalidCredential
	}
	return record, nil
}

// supportsStaticCredentialRotation 限定本阶段允许原地编辑的凭据类型。
func supportsStaticCredentialRotation(
	providerID string,
	authKind string,
	authMode string,
) bool {
	if authMode != "" {
		return false
	}
	switch providerID {
	case codex.ProviderID:
		return authKind == codex.AuthKindAPIKey.String()
	case claude.ProviderID:
		return authKind == claude.AuthKindAPIKey.String() ||
			authKind == claude.AuthKindAuthToken.String()
	default:
		return false
	}
}

// replaceStaticCredential 使用账号、旧凭据引用和版本执行单行 CAS。
func replaceStaticCredential(
	ctx context.Context,
	connection *sql.Conn,
	rotation accountapp.StaticCredentialRotation,
	current staticCredentialRotationRecord,
	document encodedCredential,
	updatedAtMS int64,
) error {
	const statement = `
		UPDATE account_credentials
		SET credential_ref = ?, auth_kind = ?, auth_mode = ?, format_version = ?,
		    credential_json = ?, updated_at_ms = ?
		WHERE account_ref = ?
		  AND credential_ref = ?
		  AND auth_kind = ?
		  AND auth_mode = ?
		  AND updated_at_ms = ?`
	result, err := connection.ExecContext(
		ctx,
		statement,
		document.credentialRef.String(),
		document.authKind,
		document.authMode,
		credentialFormatVersion,
		string(document.json),
		updatedAtMS,
		rotation.AccountRef().String(),
		current.credentialRef.String,
		current.authKind.String,
		current.authMode.String,
		current.credentialUpdatedAtMS.Int64,
	)
	return requireSingleStaticCredentialWrite(result, err, "替换静态账号凭据")
}

// touchStaticCredentialAccount 推进基础账号更新时间但不改变账号身份和启停状态。
func touchStaticCredentialAccount(
	ctx context.Context,
	connection *sql.Conn,
	rotation accountapp.StaticCredentialRotation,
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
		rotation.AccountRef().String(),
		rotation.ExpectedAccountUpdatedAt().UnixMilli(),
	)
	return requireSingleStaticCredentialWrite(result, err, "更新静态账号时间")
}

// requireSingleStaticCredentialWrite 统一唯一冲突、锁冲突和 CAS 失败语义。
func requireSingleStaticCredentialWrite(
	result sql.Result,
	err error,
	action string,
) error {
	if isBusyError(err) || isConstraintError(err) {
		return accountapp.ErrStaticCredentialRotationConflict
	}
	if err != nil {
		return fmt.Errorf("%s失败: %w", action, err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("读取%s结果失败: %w", action, err)
	}
	if affected != 1 {
		return accountapp.ErrStaticCredentialRotationConflict
	}
	return nil
}

// staticCredentialRotationRecord 保存立即事务内读取的账号和凭据 CAS 字段。
type staticCredentialRotationRecord struct {
	account               accountRecord
	credentialRef         sql.NullString
	authKind              sql.NullString
	authMode              sql.NullString
	credentialUpdatedAtMS sql.NullInt64
}

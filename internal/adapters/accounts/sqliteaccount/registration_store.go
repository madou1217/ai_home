package sqliteaccount

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"math"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

var _ accountapp.RegistrationStore = (*Store)(nil)

// RegisterNew 在同一事务中分配 Provider 内 CLI 别名并写入完整注册快照。
func (store *Store) RegisterNew(
	ctx context.Context,
	request accountapp.RegistrationRequest,
) (accountcore.Account, error) {
	if !store.acceptsRegistrationRequest(request) {
		return accountcore.Account{}, accountapp.ErrInvalidRegistration
	}
	credentialDocument, err := store.credentials.Encode(request.Credential())
	if err != nil {
		return accountcore.Account{}, err
	}
	var profileDocument encodedProfile
	if request.HasProfile() {
		profileDocument, err = store.profiles.Encode(
			request.ProfileSnapshot().Profile(),
		)
		if err != nil {
			return accountcore.Account{}, err
		}
	}

	store.routingWrites.Lock()
	defer store.routingWrites.Unlock()
	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return accountcore.Account{}, fmt.Errorf("开始新账号注册事务失败: %w", err)
	}
	defer func() {
		_ = transaction.Rollback()
	}()

	alias, err := insertAccountWithAllocatedAlias(ctx, transaction, request)
	if err != nil {
		return accountcore.Account{}, err
	}
	account, err := accountcore.NewAccount(
		store.catalog,
		accountcore.NewAccountInput{
			Identity:     request.Credential(),
			CLIAccountID: alias,
			CreatedAt:    request.RegisteredAt(),
		},
	)
	if err != nil ||
		account.Ref() != request.AccountRef() ||
		account.ProviderID() != request.ProviderID() {
		return accountcore.Account{}, accountapp.ErrInvalidRegistration
	}
	if err := insertCredential(
		ctx,
		transaction,
		account.Ref(),
		credentialDocument,
		request.RegisteredAt().UnixMilli(),
	); err != nil {
		return accountcore.Account{}, err
	}
	if request.HasProfile() {
		if err := insertRegistrationProfile(
			ctx,
			transaction,
			request.AccountRef(),
			profileDocument,
			request.RegisteredAt().UnixMilli(),
		); err != nil {
			return accountcore.Account{}, err
		}
	}
	if err := transaction.Commit(); err != nil {
		if isConstraintError(err) {
			return accountcore.Account{}, accountapp.ErrAccountConflict
		}
		return accountcore.Account{}, fmt.Errorf("提交新账号注册事务失败: %w", err)
	}
	routingAccount, err := store.newRoutingAccount(account)
	if err != nil {
		return accountcore.Account{}, err
	}
	store.routes.replaceAccount(routingAccount, account.Enabled(), nil)
	return account, nil
}

// acceptsRegistrationRequest 校验命令和当前 Provider Catalog 的一致性。
func (store *Store) acceptsRegistrationRequest(
	request accountapp.RegistrationRequest,
) bool {
	if store == nil ||
		store.db == nil ||
		store.catalog == nil ||
		!request.IsValid() {
		return false
	}
	providerID, found := store.catalog.CanonicalID(request.ProviderID())
	return found && providerID == request.ProviderID()
}

// insertAccountWithAllocatedAlias 使用单个写语句串行分配 Provider 内下一个别名。
func insertAccountWithAllocatedAlias(
	ctx context.Context,
	transaction *sql.Tx,
	request accountapp.RegistrationRequest,
) (accountcore.CLIAccountID, error) {
	const statement = `
		INSERT INTO accounts (
			account_ref, provider_id, cli_account_id, enabled,
			created_at_ms, updated_at_ms
		)
		SELECT ?, ?, COALESCE(MAX(cli_account_id), 0) + 1, 1, ?, ?
		FROM accounts
		WHERE provider_id = ?
		HAVING COALESCE(MAX(cli_account_id), 0) < ?
		RETURNING cli_account_id`
	var allocatedAlias int64
	err := transaction.QueryRowContext(
		ctx,
		statement,
		request.AccountRef().String(),
		request.ProviderID(),
		request.RegisteredAt().UnixMilli(),
		request.RegisteredAt().UnixMilli(),
		request.ProviderID(),
		int64(math.MaxInt64),
	).Scan(&allocatedAlias)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, accountapp.ErrCLIAccountIDExhausted
	}
	if isConstraintError(err) {
		return 0, accountapp.ErrAccountConflict
	}
	if err != nil {
		return 0, fmt.Errorf("分配 CLI 账号别名失败: %w", err)
	}
	alias, err := accountcore.NewCLIAccountID(allocatedAlias)
	if err != nil {
		return 0, accountapp.ErrCLIAccountIDExhausted
	}
	return alias, nil
}

// insertRegistrationProfile 在注册事务中写入经过 codec 校验的公开资料。
func insertRegistrationProfile(
	ctx context.Context,
	executor statementExecutor,
	accountRef accountcore.AccountRef,
	document encodedProfile,
	updatedAtMS int64,
) error {
	const statement = `
		INSERT INTO account_profiles (
			account_ref, display_name, email, subscription_kind,
			subscription_raw, format_version, profile_json, updated_at_ms
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	_, err := executor.ExecContext(
		ctx,
		statement,
		accountRef.String(),
		document.displayName,
		document.email,
		document.subscriptionKind,
		document.subscriptionRaw,
		profileFormatVersion,
		string(document.json),
		updatedAtMS,
	)
	if isConstraintError(err) {
		return accountapp.ErrAccountConflict
	}
	if err != nil {
		return fmt.Errorf("写入注册账号公开资料失败: %w", err)
	}
	return nil
}

// statementExecutor 让事务和独占连接复用相同的参数化写入函数。
type statementExecutor interface {
	ExecContext(
		ctx context.Context,
		query string,
		args ...any,
	) (sql.Result, error)
}

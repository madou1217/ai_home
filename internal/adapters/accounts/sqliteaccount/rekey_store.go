package sqliteaccount

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/agy"
)

var _ accountapp.AccountReKeyStore = (*Store)(nil)

// reKeySpecialTables 是不参与通用搬移、需要单独处理的表：
//   - accounts 本身；account_credentials 要换成新凭据（credential_ref 也是按
//     身份派生的唯一键，不能简单 UPDATE）；
//   - oauth_jobs 同时有 account_ref 与 target_ref 两列；
//   - account_tombstones 记录的是被删除身份，不跟着迁移。
var reKeySpecialTables = map[string]struct{}{
	"accounts":            {},
	"account_credentials": {},
	"oauth_jobs":          {},
	"account_tombstones":  {},
}

// listAccountRefTables 从 schema 动态发现所有带 account_ref 的表。
//
// 不写死表名：后续新增按账号归属的快照表时，漏加进清单会让旧账号删除时的
// 级联把数据一起抹掉，而且没有任何编译期提示。
func listAccountRefTables(
	ctx context.Context,
	transaction *sql.Tx,
) ([]string, error) {
	rows, err := transaction.QueryContext(
		ctx,
		"SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
	)
	if err != nil {
		return nil, fmt.Errorf("读取账号快照表清单失败: %w", err)
	}
	defer rows.Close()
	var tables []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, fmt.Errorf("读取账号快照表名失败: %w", err)
		}
		if _, special := reKeySpecialTables[name]; special {
			continue
		}
		var columns int
		if err := transaction.QueryRowContext(
			ctx,
			"SELECT COUNT(*) FROM pragma_table_info(?) WHERE name = 'account_ref'",
			name,
		).Scan(&columns); err != nil {
			return nil, fmt.Errorf("检查账号快照表 %s 失败: %w", name, err)
		}
		if columns > 0 {
			tables = append(tables, name)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历账号快照表失败: %w", err)
	}
	return tables, nil
}

// ReKeyAccount 把账号、凭据和全部从属快照原子迁移到新身份引用。
//
// 这是刷新发现稳定身份变化时的唯一写路径：不能只改凭据行（AccountRef 派生自
// 身份），也不能只改账号行（从属表会被外键挡住）。新身份已存在时返回冲突，
// 不合并两个账号——合并会静默改写用户可见的数字别名与默认账号。
func (store *Store) ReKeyAccount(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	credential accountapp.Credential,
	updatedAt time.Time,
) (accountapp.CredentialSnapshot, error) {
	if store == nil || ctx == nil || credential == nil ||
		!accountRef.IsValid() || updatedAt.IsZero() {
		return accountapp.CredentialSnapshot{}, accountapp.ErrInvalidCredentialReplacement
	}
	identityRef, err := accountcore.DeriveAccountRef(credential)
	if err != nil || identityRef == accountRef {
		return accountapp.CredentialSnapshot{}, accountapp.ErrInvalidCredentialReplacement
	}
	document, err := store.credentials.Encode(credential)
	if err != nil {
		return accountapp.CredentialSnapshot{}, err
	}
	old, err := store.GetByRef(ctx, accountRef)
	if err != nil {
		return accountapp.CredentialSnapshot{}, err
	}
	oldCredential, _ := store.GetCredential(ctx, accountRef)
	if old.ProviderID() != credential.ProviderID() {
		return accountapp.CredentialSnapshot{}, accountapp.ErrReauthenticationIdentityMismatch
	}
	accountUpdatedAt := updatedAt.UTC()
	if !accountUpdatedAt.After(old.UpdatedAt()) {
		accountUpdatedAt = old.UpdatedAt().Add(time.Millisecond)
	}
	newAccount, err := accountcore.RestoreAccount(store.catalog, accountcore.RestoreAccountInput{
		Ref:          identityRef,
		ProviderID:   old.ProviderID(),
		CLIAccountID: old.CLIAccountID(),
		Enabled:      old.Enabled(),
		CreatedAt:    old.CreatedAt(),
		UpdatedAt:    accountUpdatedAt,
	})
	if err != nil {
		return accountapp.CredentialSnapshot{}, accountapp.ErrInvalidCredentialReplacement
	}

	store.routingWrites.Lock()
	defer store.routingWrites.Unlock()
	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return accountapp.CredentialSnapshot{}, fmt.Errorf("开始账号身份迁移事务失败: %w", err)
	}
	defer func() {
		_ = transaction.Rollback()
	}()
	exists, err := store.accountExists(ctx, transaction, identityRef)
	if err != nil {
		return accountapp.CredentialSnapshot{}, err
	}
	if exists {
		return accountapp.CredentialSnapshot{}, accountapp.ErrAccountReKeyConflict
	}
	// accounts 的 UNIQUE(provider_id, cli_account_id) 是立即约束：新账号要沿用
	// 用户可见的数字别名，旧行必须先让位。临时别名取该 Provider 当前最大值 +1，
	// 事务内不会被其它写者看见，提交前旧行就被删掉。
	temporaryCLIID, err := nextTemporaryCLIAccountID(
		ctx,
		transaction,
		old.ProviderID(),
	)
	if err != nil {
		return accountapp.CredentialSnapshot{}, err
	}
	if _, err := transaction.ExecContext(
		ctx,
		"UPDATE accounts SET cli_account_id = ? WHERE account_ref = ?",
		temporaryCLIID,
		accountRef.String(),
	); err != nil {
		return accountapp.CredentialSnapshot{}, fmt.Errorf("暂存旧账号数字别名失败: %w", err)
	}
	if err := insertAccount(ctx, transaction, newAccount); err != nil {
		return accountapp.CredentialSnapshot{}, err
	}
	childTables, err := listAccountRefTables(ctx, transaction)
	if err != nil {
		return accountapp.CredentialSnapshot{}, err
	}
	for _, table := range childTables {
		if err := moveAccountRows(ctx, transaction, table, accountRef, identityRef); err != nil {
			return accountapp.CredentialSnapshot{}, err
		}
	}
	if err := moveOAuthJobRows(ctx, transaction, accountRef, identityRef); err != nil {
		return accountapp.CredentialSnapshot{}, err
	}
	if err := updateReKeyedDisplayIdentity(
		ctx,
		transaction,
		oldCredential,
		credential,
		accountRef,
		identityRef,
	); err != nil {
		return accountapp.CredentialSnapshot{}, err
	}
	// 新身份如果曾被删除，遗留 tombstone 会阻止后续任何重建；本次是明确接管
	// 该身份，清掉它。
	if _, err := transaction.ExecContext(
		ctx,
		"DELETE FROM account_tombstones WHERE account_ref = ?",
		identityRef.String(),
	); err != nil {
		return accountapp.CredentialSnapshot{}, fmt.Errorf("清理账号身份墓碑失败: %w", err)
	}
	if _, err := transaction.ExecContext(
		ctx,
		"DELETE FROM account_credentials WHERE account_ref = ?",
		accountRef.String(),
	); err != nil {
		return accountapp.CredentialSnapshot{}, fmt.Errorf("删除旧账号凭据失败: %w", err)
	}
	if err := insertCredential(
		ctx,
		transaction,
		identityRef,
		document,
		updatedAt.UTC().UnixMilli(),
	); err != nil {
		return accountapp.CredentialSnapshot{}, err
	}
	if _, err := transaction.ExecContext(
		ctx,
		"DELETE FROM accounts WHERE account_ref = ?",
		accountRef.String(),
	); err != nil {
		return accountapp.CredentialSnapshot{}, fmt.Errorf("删除旧账号行失败: %w", err)
	}
	if err := transaction.Commit(); err != nil {
		if isConstraintError(err) {
			return accountapp.CredentialSnapshot{}, accountapp.ErrAccountReKeyConflict
		}
		return accountapp.CredentialSnapshot{}, fmt.Errorf("提交账号身份迁移事务失败: %w", err)
	}

	snapshot, err := accountapp.NewCredentialSnapshot(
		identityRef,
		credential.ProviderID(),
		credential,
		updatedAt.UTC(),
	)
	if err != nil {
		return accountapp.CredentialSnapshot{}, accountapp.ErrInvalidCredentialReplacement
	}
	store.reindexReKeyedAccount(ctx, accountRef, newAccount)
	return snapshot, nil
}

// nextTemporaryCLIAccountID 返回该 Provider 当前未占用的最大别名 +1。
func nextTemporaryCLIAccountID(
	ctx context.Context,
	transaction *sql.Tx,
	providerID string,
) (int64, error) {
	var temporary int64
	if err := transaction.QueryRowContext(
		ctx,
		"SELECT COALESCE(MAX(cli_account_id), 0) + 1 FROM accounts WHERE provider_id = ?",
		providerID,
	).Scan(&temporary); err != nil {
		return 0, fmt.Errorf("读取账号数字别名上界失败: %w", err)
	}
	if temporary <= 0 {
		return 0, accountapp.ErrAccountReKeyConflict
	}
	return temporary, nil
}

// updateReKeyedDisplayIdentity 把公开资料里的旧身份邮箱改成新邮箱。
//
// 账号页的邮箱/显示名可能来自 account_profiles 或 account_ui_state；这些行
// 跟着账号迁移后如果仍保留旧邮箱，界面会出现「账号已迁移、标题还是旧账号」。
// 只改与旧身份完全相同的值，用户手工改过的显示名不动。
func updateReKeyedDisplayIdentity(
	ctx context.Context,
	transaction *sql.Tx,
	previousCredential accountapp.Credential,
	currentCredential accountapp.Credential,
	previous accountcore.AccountRef,
	current accountcore.AccountRef,
) error {
	oldAuth, oldOK := previousCredential.(*agy.OAuthAuth)
	newAuth, newOK := currentCredential.(*agy.OAuthAuth)
	if !oldOK || !newOK || oldAuth == nil || newAuth == nil {
		return nil
	}
	oldEmail := oldAuth.Email()
	newEmail := newAuth.Email()
	if oldEmail == "" || newEmail == "" || oldEmail == newEmail {
		return nil
	}
	if _, err := transaction.ExecContext(
		ctx,
		`UPDATE account_profiles
		 SET email = ?,
		     display_name = CASE WHEN display_name = ? THEN ? ELSE display_name END,
		     profile_json = json_set(profile_json, '$.email', ?)
		 WHERE account_ref = ? AND email = ?`,
		newEmail,
		oldEmail,
		newEmail,
		newEmail,
		current.String(),
		oldEmail,
	); err != nil {
		return fmt.Errorf("更新账号资料邮箱失败: %w", err)
	}
	if _, err := transaction.ExecContext(
		ctx,
		`UPDATE account_ui_state
		 SET display_name = ?
		 WHERE account_ref = ? AND display_name = ?`,
		newEmail,
		current.String(),
		oldEmail,
	); err != nil {
		return fmt.Errorf("更新账号展示名失败: %w", err)
	}
	return nil
}

// moveAccountRows 把单表里的账号引用搬到新引用。
func moveAccountRows(
	ctx context.Context,
	transaction *sql.Tx,
	table string,
	previous accountcore.AccountRef,
	current accountcore.AccountRef,
) error {
	statement := fmt.Sprintf(
		"UPDATE %s SET account_ref = ? WHERE account_ref = ?",
		table,
	)
	if _, err := transaction.ExecContext(
		ctx,
		statement,
		current.String(),
		previous.String(),
	); err != nil {
		return fmt.Errorf("迁移账号表 %s 失败: %w", table, err)
	}
	return nil
}

// moveOAuthJobRows 把仍指向旧账号的登录作业改挂到新身份。
func moveOAuthJobRows(
	ctx context.Context,
	transaction *sql.Tx,
	previous accountcore.AccountRef,
	current accountcore.AccountRef,
) error {
	if _, err := transaction.ExecContext(
		ctx,
		"UPDATE oauth_jobs SET account_ref = ? WHERE account_ref = ?",
		current.String(),
		previous.String(),
	); err != nil {
		return fmt.Errorf("迁移账号登录作业失败: %w", err)
	}
	if _, err := transaction.ExecContext(
		ctx,
		"UPDATE oauth_jobs SET target_ref = ? WHERE target_ref = ?",
		current.String(),
		previous.String(),
	); err != nil {
		return fmt.Errorf("迁移账号重新认证目标失败: %w", err)
	}
	return nil
}

// reindexReKeyedAccount 在提交后同步进程内路由索引；失败不回滚已提交的账号事实。
func (store *Store) reindexReKeyedAccount(
	ctx context.Context,
	previous accountcore.AccountRef,
	current accountcore.Account,
) {
	routingAccount, err := store.newRoutingAccount(current)
	if err != nil {
		return
	}
	models, err := store.listAccountModels(ctx, store.db, current.Ref())
	if err != nil {
		store.routes.deleteAccount(previous)
		store.routes.replaceAccount(routingAccount, current.Enabled(), nil)
		return
	}
	effective, err := accountapp.EffectiveModelIDs(models)
	if err != nil {
		effective = nil
	}
	store.routes.deleteAccount(previous)
	store.routes.replaceAccount(routingAccount, current.Enabled(), effective)
}

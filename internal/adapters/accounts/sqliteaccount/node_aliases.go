package sqliteaccount

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

// nodeCLIAliasRetryOffset 是两阶段改号时使用的临时偏移量。
//
// accounts 上有 UNIQUE(provider_id, cli_account_id)，直接把 A 改成 B 而 B 仍被
// 另一个账号占用会立即冲突。先把整个 Provider 的编号推到高位，再写入目标值，
// 这样任意置换都能在一次事务内完成。
const nodeCLIAliasRetryOffset = 1_000_000

// nodeCLIAliases 读取 Node 台账里的 CLI 数字别名。
//
// 用户看到的 `aih <provider> <id>` 历史编号一直记录在 app-state.db 的
// account_cli_aliases 表里；Go 账号库的 cli_account_id 是另一套自增序列。
// 两套编号必须收敛到同一份用户可见编号，否则 `aih ls` 与 `aih list` 会显示
// 同一个账号的不同 ID，按 ls 的编号启动还会落到另一个账号。
//
// 返回 provider -> account_ref -> cli_account_id；app-state 不存在或表缺失时
// 返回空映射，不阻断账号库打开。
func readNodeCLIAliases(ctx context.Context, aiHomeDir string) map[string]map[string]int64 {
	aliases := make(map[string]map[string]int64)
	databasePath, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return aliases
	}
	db, err := appstate.OpenReadOnly(ctx, databasePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return aliases
		}
		return aliases
	}
	defer func() { _ = db.Close() }()
	rows, err := db.QueryContext(
		ctx,
		`SELECT provider, account_ref, cli_account_id FROM account_cli_aliases`,
	)
	if err != nil {
		// 表缺失（全新安装只有 Go 库）等价于没有 Node 台账。
		return aliases
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var provider, accountRef, rawID string
		if scanErr := rows.Scan(&provider, &accountRef, &rawID); scanErr != nil {
			continue
		}
		provider = strings.ToLower(strings.TrimSpace(provider))
		accountRef = strings.TrimSpace(accountRef)
		id, parseErr := strconv.ParseInt(strings.TrimSpace(rawID), 10, 64)
		if provider == "" || accountRef == "" || parseErr != nil || id <= 0 {
			continue
		}
		byRef, ok := aliases[provider]
		if !ok {
			byRef = make(map[string]int64)
			aliases[provider] = byRef
		}
		byRef[accountRef] = id
	}
	return aliases
}

// reconcileNodeCLIAliases 把所有已知账号的 cli_account_id 收敛到 Node 台账编号。
//
// 没有 Node 别名的账号保持相对顺序，统一排到该 Provider 已用最大编号之后；
// 这样既不会占用用户历史编号，也不会在新账号上制造空洞以外的冲突。
func (store *Store) reconcileNodeCLIAliases(
	ctx context.Context,
	aliases map[string]map[string]int64,
) error {
	if len(aliases) == 0 {
		return nil
	}
	providers := make([]string, 0, len(aliases))
	for provider := range aliases {
		providers = append(providers, provider)
	}
	sort.Strings(providers)
	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("开始账号编号收敛事务失败: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()
	changed := false
	for _, provider := range providers {
		providerChanged, err := reconcileProviderAliases(ctx, transaction, provider, aliases[provider])
		if err != nil {
			return err
		}
		changed = changed || providerChanged
	}
	if !changed {
		return nil
	}
	if err := transaction.Commit(); err != nil {
		return fmt.Errorf("提交账号编号收敛事务失败: %w", err)
	}
	return nil
}

// reconcileProviderAliases 处理单个 Provider；返回是否真的改过编号。
func reconcileProviderAliases(
	ctx context.Context,
	transaction *sql.Tx,
	provider string,
	aliases map[string]int64,
) (bool, error) {
	type accountRow struct {
		accountRef string
		cliID      int64
	}
	rows, err := transaction.QueryContext(
		ctx,
		`SELECT account_ref, cli_account_id FROM accounts WHERE provider_id = ? ORDER BY cli_account_id`,
		provider,
	)
	if err != nil {
		return false, fmt.Errorf("读取 %s 账号编号失败: %w", provider, err)
	}
	accounts := make([]accountRow, 0)
	maxCurrent := int64(0)
	for rows.Next() {
		var row accountRow
		if scanErr := rows.Scan(&row.accountRef, &row.cliID); scanErr != nil {
			_ = rows.Close()
			return false, fmt.Errorf("读取 %s 账号编号失败: %w", provider, scanErr)
		}
		if row.cliID > maxCurrent {
			maxCurrent = row.cliID
		}
		accounts = append(accounts, row)
	}
	if closeErr := rows.Close(); closeErr != nil {
		return false, fmt.Errorf("读取 %s 账号编号失败: %w", provider, closeErr)
	}
	if len(accounts) == 0 {
		return false, nil
	}

	desired := make(map[string]int64, len(accounts))
	used := make(map[int64]bool, len(accounts))
	maxDesired := int64(0)
	for _, account := range accounts {
		alias, ok := aliases[account.accountRef]
		if !ok || alias <= 0 || used[alias] {
			continue
		}
		desired[account.accountRef] = alias
		used[alias] = true
		if alias > maxDesired {
			maxDesired = alias
		}
	}
	nextID := maxDesired + 1
	for _, account := range accounts {
		if _, ok := desired[account.accountRef]; ok {
			continue
		}
		for used[nextID] {
			nextID++
		}
		desired[account.accountRef] = nextID
		used[nextID] = true
		nextID++
	}

	changed := false
	for _, account := range accounts {
		if desired[account.accountRef] != account.cliID {
			changed = true
			break
		}
	}
	if !changed {
		return false, nil
	}

	if _, err := transaction.ExecContext(
		ctx,
		`UPDATE accounts SET cli_account_id = cli_account_id + ? WHERE provider_id = ?`,
		nodeCLIAliasRetryOffset+maxCurrent+maxDesired,
		provider,
	); err != nil {
		return false, fmt.Errorf("暂存 %s 账号编号失败: %w", provider, err)
	}
	statement, err := transaction.PrepareContext(
		ctx,
		`UPDATE accounts SET cli_account_id = ? WHERE provider_id = ? AND account_ref = ?`,
	)
	if err != nil {
		return false, fmt.Errorf("准备 %s 账号编号更新失败: %w", provider, err)
	}
	defer func() { _ = statement.Close() }()
	for accountRef, cliID := range desired {
		if _, err := statement.ExecContext(ctx, cliID, provider, accountRef); err != nil {
			return false, fmt.Errorf("写入 %s 账号编号失败: %w", provider, err)
		}
	}
	// oauth_jobs 只是运行中作业的快照；编号随账号一起修正，避免作业恢复后显示旧号。
	_, _ = transaction.ExecContext(
		ctx,
		`UPDATE oauth_jobs
		 SET cli_account_id = COALESCE((
		   SELECT a.cli_account_id FROM accounts AS a WHERE a.account_ref = oauth_jobs.account_ref
		 ), cli_account_id)
		 WHERE provider_id = ? AND account_ref <> ''`,
		provider,
	)
	return true, nil
}

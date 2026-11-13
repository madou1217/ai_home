package hostapps

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	_ "modernc.org/sqlite"
)

const (
	appStateDatabaseFileName  = "app-state.db"
	goAccountDatabaseFileName = "aih.db"
	busyTimeoutMS             = 5000
)

// Source 提供运行态匹配所需的账号身份（只读）。
//
// 账号台账以 Node 的 account_refs 为主、Go 的 accounts 表补齐：
// 两边都可能存在对方还没同步的账号，只看一张表会把真实运行中的实例漏掉。
type Source struct {
	AIHomeDir string
	// DatabasePath 为空时按 AIHomeDir/app-state.db 推导。
	DatabasePath string
}

// NewSource 创建账号身份来源。
func NewSource(aiHomeDir string) *Source {
	return &Source{AIHomeDir: strings.TrimSpace(aiHomeDir)}
}

func (source *Source) appStatePath() string {
	if source == nil {
		return ""
	}
	if path := strings.TrimSpace(source.DatabasePath); path != "" {
		return path
	}
	root := strings.TrimSpace(source.AIHomeDir)
	if root == "" {
		return ""
	}
	return filepath.Join(root, appStateDatabaseFileName)
}

func (source *Source) goAccountPath() string {
	root := strings.TrimSpace(source.AIHomeDir)
	if root == "" {
		return ""
	}
	return filepath.Join(root, goAccountDatabaseFileName)
}

// ListAccounts 返回去重后的账号身份（provider + account_ref）。
//
// 读不到任何数据库时返回空列表而不是错误：运行态是增量信息，不该让入口探测失败。
func (source *Source) ListAccounts(ctx context.Context) ([]Account, error) {
	seen := make(map[string]bool)
	accounts := make([]Account, 0, 32)
	appendAccount := func(provider string, accountRef string) {
		normalizedProvider := strings.ToLower(strings.TrimSpace(provider))
		normalizedRef := NormalizeAccountRef(accountRef)
		if normalizedProvider == "" || normalizedRef == "" {
			return
		}
		key := normalizedProvider + "\x00" + normalizedRef
		if seen[key] {
			return
		}
		seen[key] = true
		accounts = append(accounts, Account{Provider: normalizedProvider, AccountRef: normalizedRef})
	}

	if path := source.appStatePath(); path != "" {
		rows, err := readAccountRows(ctx, path, "account_refs")
		if err == nil {
			for _, row := range rows {
				appendAccount(row.provider, row.accountRef)
			}
		}
	}
	if path := source.goAccountPath(); path != "" {
		rows, err := readAccountRows(ctx, path, "accounts")
		if err == nil {
			for _, row := range rows {
				appendAccount(row.provider, row.accountRef)
			}
		}
	}
	return accounts, nil
}

// ListCLIAliases 返回 provider + NUL + cliAccountId → account_ref 的槽位映射。
//
// 只有缺少账号引用标记的历史 CLI 进程才需要它；读不到时返回空映射。
func (source *Source) ListCLIAliases(ctx context.Context) (map[string]string, error) {
	aliases := make(map[string]string)
	path := source.appStatePath()
	if path == "" {
		return aliases, nil
	}
	db, err := openReadOnly(ctx, path)
	if err != nil {
		return aliases, nil
	}
	defer func() { _ = db.Close() }()
	rows, err := db.QueryContext(ctx, "SELECT provider, cli_account_id, account_ref FROM account_cli_aliases")
	if err != nil {
		return aliases, nil
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var provider string
		var cliAccountID string
		var accountRef string
		if scanErr := rows.Scan(&provider, &cliAccountID, &accountRef); scanErr != nil {
			continue
		}
		if NormalizeAccountRef(accountRef) == "" || strings.TrimSpace(cliAccountID) == "" {
			continue
		}
		aliases[cliAliasKey(provider, cliAccountID)] = accountRef
	}
	return aliases, rows.Err()
}

type accountRow struct {
	provider   string
	accountRef string
}

func readAccountRows(ctx context.Context, databasePath string, table string) ([]accountRow, error) {
	db, err := openReadOnly(ctx, databasePath)
	if err != nil {
		return nil, err
	}
	defer func() { _ = db.Close() }()
	query := "SELECT provider_id, account_ref FROM accounts"
	if table == "account_refs" {
		query = "SELECT provider, account_ref FROM account_refs"
	}
	rows, err := db.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	accounts := make([]accountRow, 0, 32)
	for rows.Next() {
		var row accountRow
		if scanErr := rows.Scan(&row.provider, &row.accountRef); scanErr != nil {
			continue
		}
		accounts = append(accounts, row)
	}
	return accounts, rows.Err()
}

func openReadOnly(ctx context.Context, databasePath string) (*sql.DB, error) {
	info, err := os.Stat(databasePath)
	if err != nil || !info.Mode().IsRegular() {
		return nil, fmt.Errorf("hostapps: 数据库不可用")
	}
	dsn := "file:" + databasePath + "?_pragma=busy_timeout(" + strconv.Itoa(busyTimeoutMS) + ")&mode=ro"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	return db, nil
}

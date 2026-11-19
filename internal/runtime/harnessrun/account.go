package harnessrun

import (
	"context"
	"database/sql"
	"regexp"
	"strings"

	"github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

var numericCLIAccountID = regexp.MustCompile(`^[0-9]+$`)

// accountSelection 是 `aih harness` 选中的身份账号。
type accountSelection struct {
	AccountRef   string
	CLIAccountID string
	Provider     string
}

// selectAccount 复刻 Node selectAccount：
//   - `acct_…` 按 account_refs + account_cli_aliases 精确解析；
//   - 纯数字按 Provider 的 CLI 账号编号解析；
//   - 空值取该 Provider 的第一个账号，优先 CLI 编号 1。
//
// 返回的错误码与 Node 一致：account_ref_not_found / account_not_found。
// 所有数据库错误都按 bestEffort 处理（Node 选账号传 bestEffort: true），
// 读不到等价于没有账号。
func selectAccount(
	ctx context.Context,
	aiHomeDir string,
	catalog *providers.Catalog,
	provider string,
	account string,
) (accountSelection, string) {
	account = strings.TrimSpace(account)
	normalizedProvider := normalizeProvider(catalog, provider)

	if account != "" && isAccountRef(account) {
		record, found := lookupCLIRecordByRef(ctx, aiHomeDir, catalog, account)
		if !found {
			return accountSelection{}, "account_ref_not_found"
		}
		return record, ""
	}

	if account != "" && numericCLIAccountID.MatchString(account) {
		if normalizedProvider == "" {
			return accountSelection{}, "account_not_found"
		}
		record, found := lookupRecordByCLIID(ctx, aiHomeDir, catalog, normalizedProvider, account)
		if !found {
			return accountSelection{}, "account_not_found"
		}
		if record.CLIAccountID == "" {
			record.CLIAccountID = account
		}
		return record, ""
	}

	if account != "" || normalizedProvider == "" {
		return accountSelection{}, "account_not_found"
	}

	records := listCLIRecords(ctx, aiHomeDir, catalog, normalizedProvider)
	if len(records) == 0 {
		return accountSelection{}, "account_not_found"
	}
	preferred := records[0]
	for _, record := range records {
		if record.CLIAccountID == "1" {
			preferred = record
			break
		}
	}
	return preferred, ""
}

func normalizeProvider(catalog *providers.Catalog, provider string) string {
	if catalog == nil {
		return ""
	}
	canonical, ok := catalog.CanonicalID(provider)
	if !ok {
		return ""
	}
	return canonical
}

func isAccountRef(value string) bool {
	accountRef, err := accounts.ParseAccountRef(value)
	return err == nil && accountRef.IsValid()
}

// mapCLIRecord 校验与 Node mapCliAccountRefRow 相同的事实：合法 accountRef、
// 已注册 Provider、纯数字 CLI 编号。
func mapCLIRecord(catalog *providers.Catalog, accountRef, provider, cliAccountID string) (accountSelection, bool) {
	accountRef = strings.TrimSpace(accountRef)
	cliAccountID = strings.TrimSpace(cliAccountID)
	if !isAccountRef(accountRef) || !numericCLIAccountID.MatchString(cliAccountID) {
		return accountSelection{}, false
	}
	normalized := normalizeProvider(catalog, provider)
	if normalized == "" {
		return accountSelection{}, false
	}
	return accountSelection{
		AccountRef:   accountRef,
		CLIAccountID: cliAccountID,
		Provider:     normalized,
	}, true
}

func openAccountDatabase(ctx context.Context, aiHomeDir string) (*sql.DB, bool) {
	databasePath, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return nil, false
	}
	db, err := appstate.OpenReadOnly(ctx, databasePath)
	if err != nil {
		return nil, false
	}
	return db, true
}

func lookupCLIRecordByRef(
	ctx context.Context,
	aiHomeDir string,
	catalog *providers.Catalog,
	accountRef string,
) (accountSelection, bool) {
	db, ok := openAccountDatabase(ctx, aiHomeDir)
	if !ok {
		return accountSelection{}, false
	}
	defer func() { _ = db.Close() }()
	row := db.QueryRowContext(ctx, `
		SELECT r.account_ref, r.provider, a.cli_account_id
		FROM account_refs r
		INNER JOIN account_cli_aliases a ON a.account_ref = r.account_ref
		WHERE r.account_ref = ?
	`, strings.TrimSpace(accountRef))
	var ref, provider, cliID string
	if err := row.Scan(&ref, &provider, &cliID); err != nil {
		return accountSelection{}, false
	}
	return mapCLIRecord(catalog, ref, provider, cliID)
}

func lookupRecordByCLIID(
	ctx context.Context,
	aiHomeDir string,
	catalog *providers.Catalog,
	provider string,
	cliAccountID string,
) (accountSelection, bool) {
	db, ok := openAccountDatabase(ctx, aiHomeDir)
	if !ok {
		return accountSelection{}, false
	}
	defer func() { _ = db.Close() }()
	row := db.QueryRowContext(ctx, `
		SELECT r.account_ref, r.provider, a.cli_account_id
		FROM account_cli_aliases a
		INNER JOIN account_refs r ON r.account_ref = a.account_ref
		WHERE a.provider = ? AND a.cli_account_id = ?
		ORDER BY a.updated_at DESC, a.created_at DESC
		LIMIT 1
	`, provider, cliAccountID)
	var ref, storedProvider, storedID string
	if err := row.Scan(&ref, &storedProvider, &storedID); err != nil {
		return accountSelection{}, false
	}
	return mapCLIRecord(catalog, ref, storedProvider, storedID)
}

func listCLIRecords(
	ctx context.Context,
	aiHomeDir string,
	catalog *providers.Catalog,
	provider string,
) []accountSelection {
	db, ok := openAccountDatabase(ctx, aiHomeDir)
	if !ok {
		return nil
	}
	defer func() { _ = db.Close() }()
	rows, err := db.QueryContext(ctx, `
		SELECT r.account_ref, r.provider, a.cli_account_id
		FROM account_cli_aliases a
		INNER JOIN account_refs r ON r.account_ref = a.account_ref
		WHERE a.provider = ?
		ORDER BY CAST(a.cli_account_id AS INTEGER), a.updated_at DESC
	`, provider)
	if err != nil {
		return nil
	}
	defer func() { _ = rows.Close() }()
	records := make([]accountSelection, 0)
	seenSlots := make(map[string]bool)
	for rows.Next() {
		var ref, storedProvider, cliID string
		if scanErr := rows.Scan(&ref, &storedProvider, &cliID); scanErr != nil {
			continue
		}
		record, valid := mapCLIRecord(catalog, ref, storedProvider, cliID)
		if !valid {
			continue
		}
		slot := record.Provider + "\x00" + record.CLIAccountID
		if seenSlots[slot] {
			continue
		}
		seenSlots[slot] = true
		records = append(records, record)
	}
	return records
}

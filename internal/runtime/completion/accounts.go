package completion

import (
	"database/sql"
	"strings"
)

// listCLIAccounts 读取某个 Provider 的用户可见 CLI 编号。
//
// 唯一事实源是 account_cli_aliases（`aih <cli> ls` 与账号解析同源）；INNER JOIN
// account_refs 保证只返回仍登记的账号，与 Node listCliAccountRefRecords 一致。
func listCLIAccounts(aiHome, provider string) []accountRow {
	normalizedProvider := strings.ToLower(strings.TrimSpace(provider))
	if normalizedProvider == "" {
		return nil
	}
	rows := make([]accountRow, 0, 16)
	withReadDB(aiHome, func(database *sql.DB) {
		result, err := database.Query(`
			SELECT a.provider, a.cli_account_id, a.account_ref
			  FROM account_cli_aliases a
			  INNER JOIN account_refs r ON r.account_ref = a.account_ref
			 WHERE a.provider = ?
			 ORDER BY CAST(a.cli_account_id AS INTEGER), a.updated_at DESC`, normalizedProvider)
		if err != nil {
			return
		}
		defer func() { _ = result.Close() }()
		seen := make(map[string]struct{}, 16)
		for result.Next() {
			var rowProvider, cliAccountID, accountRef string
			if scanErr := result.Scan(&rowProvider, &cliAccountID, &accountRef); scanErr != nil {
				continue
			}
			row := accountRow{
				Provider:     strings.ToLower(strings.TrimSpace(rowProvider)),
				CLIAccountID: strings.TrimSpace(cliAccountID),
				AccountRef:   strings.TrimSpace(accountRef),
			}
			if row.Provider == "" || row.CLIAccountID == "" || row.AccountRef == "" {
				continue
			}
			slot := row.Provider + "\x00" + row.CLIAccountID
			if _, exists := seen[slot]; exists {
				continue
			}
			seen[slot] = struct{}{}
			rows = append(rows, row)
		}
	})
	return rows
}

// listRawCLIAccounts 读取全部 account_cli_aliases 行（不做 account_refs 连接）。
func listRawCLIAccounts(aiHome string) []accountRow {
	rows := make([]accountRow, 0, 32)
	withReadDB(aiHome, func(database *sql.DB) {
		result, err := database.Query(`
			SELECT provider, cli_account_id, account_ref
			  FROM account_cli_aliases
			 ORDER BY provider, CAST(cli_account_id AS INTEGER)`)
		if err != nil {
			return
		}
		defer func() { _ = result.Close() }()
		seen := make(map[string]struct{}, 32)
		for result.Next() {
			var provider, cliAccountID, accountRef string
			if scanErr := result.Scan(&provider, &cliAccountID, &accountRef); scanErr != nil {
				continue
			}
			row := accountRow{
				Provider:     strings.ToLower(strings.TrimSpace(provider)),
				CLIAccountID: strings.TrimSpace(cliAccountID),
				AccountRef:   strings.TrimSpace(accountRef),
			}
			if row.Provider == "" || row.CLIAccountID == "" || row.AccountRef == "" {
				continue
			}
			slot := row.Provider + "\x00" + row.CLIAccountID + "\x00" + row.AccountRef
			if _, exists := seen[slot]; exists {
				continue
			}
			seen[slot] = struct{}{}
			rows = append(rows, row)
		}
	})
	return rows
}

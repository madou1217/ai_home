package appstate

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// goAccountDatabaseFileName 与 accounts/sqliteaccount.DatabaseFileName 指向同一个文件；
// 这里只读账号表，不引入账号适配器包（appstate 是它更下层的依赖）。
const goAccountDatabaseFileName = "aih.db"

// lookupGoAccountProviderNear 以 app-state.db 所在目录（即 AIH 数据根）为基准，
// 只读同目录的 Go 账号库 accounts 表；文件或表缺失都按「没有」处理。
func lookupGoAccountProviderNear(
	ctx context.Context,
	appStatePath string,
	accountRef string,
) (string, bool, error) {
	reference := strings.TrimSpace(accountRef)
	if reference == "" || strings.TrimSpace(appStatePath) == "" {
		return "", false, nil
	}
	databasePath := filepath.Join(filepath.Dir(appStatePath), goAccountDatabaseFileName)
	info, statErr := os.Stat(databasePath)
	if statErr != nil || !info.Mode().IsRegular() {
		return "", false, nil
	}
	db, err := openAndPing(ctx, databasePath, false)
	if err != nil {
		return "", false, fmt.Errorf("打开 Go 账号库失败: %w", err)
	}
	defer func() { _ = db.Close() }()
	var provider string
	err = db.QueryRowContext(ctx,
		`SELECT provider_id FROM accounts WHERE account_ref = ?`,
		reference,
	).Scan(&provider)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "no such table") {
			return "", false, nil
		}
		return "", false, fmt.Errorf("读取 Go 账号归属失败: %w", err)
	}
	return provider, true, nil
}

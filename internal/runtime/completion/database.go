package completion

import (
	"context"
	"database/sql"
	"os"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

// completionDBTimeout 限制补全热路径上的 SQLite 等待：补全宁可没有候选，
// 也不能让 TAB 因为一个被锁住的库停住。
const completionDBTimeout = 1500 * time.Millisecond

// withReadDB 以只读方式打开 aih.db 并执行查询；缺失/损坏/锁定一律静默跳过。
func withReadDB(aiHome string, query func(database *sql.DB)) {
	path, err := appstate.DatabasePath(aiHome)
	if err != nil {
		return
	}
	if info, statErr := os.Stat(path); statErr != nil || info.IsDir() {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), completionDBTimeout)
	defer cancel()
	database, err := appstate.OpenReadOnly(ctx, path)
	if err != nil {
		return
	}
	defer func() { _ = database.Close() }()
	query(database)
}

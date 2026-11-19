package sqliteaccount

import (
	"context"
	"database/sql"
	"errors"
)

// LoadRawConfig 读取 app_kv 中的原始配置值；不存在时返回 nil, nil。
// 价格插件只通过该端口读配置，不持有数据库连接。
func (store *Store) LoadRawConfig(ctx context.Context, key string) ([]byte, error) {
	if store == nil || store.db == nil {
		return nil, errors.New("sqliteaccount: store unavailable")
	}
	var raw string
	err := store.db.QueryRowContext(ctx, "SELECT value FROM app_kv WHERE key=?", key).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return []byte(raw), nil
}

package sqliteaccount

import (
	"context"

	"github.com/madou1217/ai_home/application/modelalias"
)

// 编译期确认：存储层满足别名持久化端口。
var _ modelalias.Repository = (*Store)(nil)

// Load owns the one-time legacy migration before reading canonical aliases.
// Errors never authorize an empty projection or a Node-side seed fallback.
func (store *Store) Load(ctx context.Context) ([]modelalias.Record, int64, error) {
	if err := store.migrateLegacyModelAliases(ctx); err != nil {
		return nil, 0, err
	}
	return store.ListModelAliases(ctx)
}

// Save 实现 modelalias.Repository。
func (store *Store) Save(ctx context.Context, records []modelalias.Record) (int64, error) {
	return store.ReplaceModelAliases(ctx, records)
}

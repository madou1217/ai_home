package sqliteaccount

import (
	"context"
	"fmt"

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
	records, generation, err := store.ListModelAliases(ctx)
	if err != nil {
		return nil, 0, err
	}
	// Store.Restore's historical normalization discards an invalid collection.
	// Validate the canonical read here so corruption cannot masquerade as empty.
	if len(records) > modelalias.MaxRecords {
		return nil, 0, fmt.Errorf("model_alias_canonical_invalid: %w", modelalias.ErrInvalidProjection)
	}
	seen := make(map[string]struct{}, len(records))
	for _, record := range records {
		if !record.IsValid() {
			return nil, 0, fmt.Errorf("model_alias_canonical_invalid: %w", modelalias.ErrInvalidAlias)
		}
		if record.ID != "" {
			if _, duplicate := seen[record.ID]; duplicate {
				return nil, 0, fmt.Errorf("model_alias_canonical_invalid: %w", modelalias.ErrInvalidProjection)
			}
			seen[record.ID] = struct{}{}
		}
	}
	return records, generation, nil
}

// Save 实现 modelalias.Repository。
func (store *Store) Save(ctx context.Context, records []modelalias.Record) (int64, error) {
	return store.ReplaceModelAliases(ctx, records)
}

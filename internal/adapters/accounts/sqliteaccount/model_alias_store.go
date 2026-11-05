package sqliteaccount

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/madou1217/ai_home/application/modelalias"
)

// ListModelAliases 读取当前别名表与代次。
//
// 返回顺序即 position 顺序：Node 用数组下标做同优先级候选的稳定 tiebreaker，
// 换一种排序会改变别名解析结果。
func (store *Store) ListModelAliases(ctx context.Context) ([]modelalias.Record, int64, error) {
	if store == nil || store.db == nil || ctx == nil {
		return nil, 0, modelalias.ErrInvalidProjection
	}
	const query = `
		SELECT id, alias, target, provider, target_provider, priority, enabled, description
		FROM model_alias ORDER BY position`
	rows, err := store.db.QueryContext(ctx, query)
	if err != nil {
		return nil, 0, fmt.Errorf("读取模型别名失败: %w", err)
	}
	defer func() { _ = rows.Close() }()
	records := make([]modelalias.Record, 0, 32)
	for rows.Next() {
		var (
			record  modelalias.Record
			enabled int
		)
		if err := rows.Scan(
			&record.ID, &record.Alias, &record.Target, &record.Provider,
			&record.TargetProvider, &record.Priority, &enabled, &record.Description,
		); err != nil {
			return nil, 0, fmt.Errorf("读取模型别名行失败: %w", err)
		}
		value := enabled != 0
		record.Enabled = &value
		records = append(records, record)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("遍历模型别名失败: %w", err)
	}
	generation, err := store.modelAliasGeneration(ctx)
	if err != nil {
		return nil, 0, err
	}
	return records, generation, nil
}

// ReplaceModelAliases 用给定集合整体替换别名表，并让代次 +1。
//
// 事务内「删光再写」：别名集合是整体语义（顺序与集合都参与解析），
// 逐条 diff 会在中途失败时留下半个集合，比整份替换更难恢复。
func (store *Store) ReplaceModelAliases(
	ctx context.Context,
	records []modelalias.Record,
) (int64, error) {
	if store == nil || store.db == nil || ctx == nil || len(records) > modelalias.MaxRecords {
		return 0, modelalias.ErrInvalidProjection
	}
	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("开始别名替换事务失败: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()

	if _, err := transaction.ExecContext(ctx, "DELETE FROM model_alias"); err != nil {
		return 0, fmt.Errorf("清空模型别名失败: %w", err)
	}
	const statement = `
		INSERT INTO model_alias (
			id, alias, target, provider, target_provider, priority, enabled,
			description, created_at_ms, updated_at_ms, position
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	prepared, err := transaction.PrepareContext(ctx, statement)
	if err != nil {
		return 0, fmt.Errorf("准备模型别名写入失败: %w", err)
	}
	defer func() { _ = prepared.Close() }()
	now := time.Now().UTC().UnixMilli()
	for index, record := range records {
		if !record.IsValid() {
			return 0, modelalias.ErrInvalidAlias
		}
		enabled := 0
		if record.IsEnabled() {
			enabled = 1
		}
		if _, err := prepared.ExecContext(
			ctx,
			record.ID, record.Alias, record.Target, record.ScopeProvider(),
			record.ResolvedTargetProvider(), record.Priority, enabled,
			record.Description, now, now, index,
		); err != nil {
			return 0, fmt.Errorf("写入模型别名失败: %w", err)
		}
	}
	if _, err := transaction.ExecContext(
		ctx,
		"UPDATE model_alias_meta SET generation = generation + 1 WHERE id = 1",
	); err != nil {
		return 0, fmt.Errorf("推进别名代次失败: %w", err)
	}
	generation, err := modelAliasGenerationIn(ctx, transaction)
	if err != nil {
		return 0, err
	}
	if err := transaction.Commit(); err != nil {
		return 0, fmt.Errorf("提交别名替换失败: %w", err)
	}
	return generation, nil
}

// ModelAliasGeneration 返回当前代次；0 表示从未写入过。
func (store *Store) ModelAliasGeneration(ctx context.Context) (int64, error) {
	if store == nil || store.db == nil || ctx == nil {
		return 0, modelalias.ErrInvalidProjection
	}
	return store.modelAliasGeneration(ctx)
}

func (store *Store) modelAliasGeneration(ctx context.Context) (int64, error) {
	return modelAliasGenerationIn(ctx, store.db)
}

// generationReader 让普通连接与事务共用同一段读取逻辑。
type generationReader interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func modelAliasGenerationIn(ctx context.Context, reader generationReader) (int64, error) {
	var generation int64
	if err := reader.QueryRowContext(
		ctx,
		"SELECT generation FROM model_alias_meta WHERE id = 1",
	).Scan(&generation); err != nil {
		if err == sql.ErrNoRows {
			return 0, nil
		}
		return 0, fmt.Errorf("读取别名代次失败: %w", err)
	}
	return generation, nil
}

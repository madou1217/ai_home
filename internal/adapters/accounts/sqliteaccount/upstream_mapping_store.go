package sqliteaccount

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	mappingapp "github.com/madou1217/ai_home/application/upstreammapping"
	mappingcore "github.com/madou1217/ai_home/core/upstreammapping"
	rulescore "github.com/madou1217/ai_home/core/upstreamrules"
)

// 编译期确认：适配器满足映射组持久化端口。
var _ mappingapp.Repository = (*UpstreamErrorMappingRepository)(nil)

// UpstreamErrorMappingRepository 把映射组持久化端口落到 aih.db。
//
// 单独一个适配器而不是把方法挂到 Store 上：Store 的公开方法已经覆盖账号生命周期，
// 映射组只服务一条管理链路，独立类型能让两条链路保持单向依赖，也方便单独测试。
type UpstreamErrorMappingRepository struct {
	store *Store
}

// NewUpstreamErrorMappingRepository 创建映射组仓储。
func NewUpstreamErrorMappingRepository(store *Store) *UpstreamErrorMappingRepository {
	return &UpstreamErrorMappingRepository{store: store}
}

// mappingQuerier 让普通连接与事务共用同一段读取逻辑。
type mappingQuerier interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

// mappingGroupRecord 是一行组元数据在装配期的中间形态。
type mappingGroupRecord struct {
	id          string
	name        string
	description string
	provider    string
	enabled     bool
	position    int
	version     int64
	createdAtMS int64
	updatedAtMS int64
	entries     []mappingcore.Entry
}

// List 实现映射组持久化端口。
func (repository *UpstreamErrorMappingRepository) List(ctx context.Context) ([]mappingcore.Group, error) {
	if !repository.available(ctx) {
		return nil, mappingapp.ErrServiceUnavailable
	}
	transaction, err := repository.store.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("开始映射组读取事务失败: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()
	groups, err := loadMappingGroups(ctx, transaction, "")
	if err != nil {
		return nil, err
	}
	if err := transaction.Commit(); err != nil {
		return nil, fmt.Errorf("提交映射组读取事务失败: %w", err)
	}
	return groups, nil
}

// Get 实现映射组持久化端口。
func (repository *UpstreamErrorMappingRepository) Get(
	ctx context.Context,
	id string,
) (mappingcore.Group, error) {
	if !repository.available(ctx) {
		return mappingcore.Group{}, mappingapp.ErrServiceUnavailable
	}
	transaction, err := repository.store.db.BeginTx(ctx, nil)
	if err != nil {
		return mappingcore.Group{}, fmt.Errorf("开始映射组读取事务失败: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()
	groups, err := loadMappingGroups(ctx, transaction, id)
	if err != nil {
		return mappingcore.Group{}, err
	}
	if len(groups) == 0 {
		return mappingcore.Group{}, mappingcore.ErrGroupNotFound
	}
	if err := transaction.Commit(); err != nil {
		return mappingcore.Group{}, fmt.Errorf("提交映射组读取事务失败: %w", err)
	}
	return groups[0], nil
}

// Create 实现映射组持久化端口；position 与版本在事务内分配。
func (repository *UpstreamErrorMappingRepository) Create(
	ctx context.Context,
	group mappingcore.Group,
) (mappingcore.Group, error) {
	if !repository.available(ctx) {
		return mappingcore.Group{}, mappingapp.ErrServiceUnavailable
	}
	repository.store.mappingWrites.Lock()
	defer repository.store.mappingWrites.Unlock()

	transaction, err := repository.store.db.BeginTx(ctx, nil)
	if err != nil {
		return mappingcore.Group{}, fmt.Errorf("开始映射组写入事务失败: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()

	var count int
	if err := transaction.QueryRowContext(
		ctx,
		"SELECT COUNT(*) FROM upstream_error_mapping_group",
	).Scan(&count); err != nil {
		return mappingcore.Group{}, fmt.Errorf("统计映射组数量失败: %w", err)
	}
	if count >= mappingcore.MaxGroups {
		return mappingcore.Group{}, mappingcore.ErrGroupLimit
	}
	var position int
	if err := transaction.QueryRowContext(
		ctx,
		"SELECT COALESCE(MAX(position) + 1, 0) FROM upstream_error_mapping_group",
	).Scan(&position); err != nil {
		return mappingcore.Group{}, fmt.Errorf("分配映射组顺序失败: %w", err)
	}
	// 截断到毫秒：内存里返回的时间必须与库里的精度一致，否则调用方比较
	// 「创建时间是否被改写」时会因纳秒误差误判。
	now := time.Now().UTC().Truncate(time.Millisecond)
	nowMS := now.UnixMilli()
	const insertGroup = `
		INSERT INTO upstream_error_mapping_group (
			id, name, description, provider, enabled, position, version,
			created_at_ms, updated_at_ms
		) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
	if _, err := transaction.ExecContext(
		ctx,
		insertGroup,
		group.ID(),
		group.Name(),
		group.Description(),
		group.Provider(),
		group.Enabled(),
		position,
		nowMS,
		nowMS,
	); err != nil {
		if isConstraintError(err) {
			return mappingcore.Group{}, mappingcore.ErrGroupExists
		}
		return mappingcore.Group{}, fmt.Errorf("写入映射组失败: %w", err)
	}
	if err := insertMappingRules(ctx, transaction, group.ID(), group.Entries()); err != nil {
		return mappingcore.Group{}, err
	}
	if err := transaction.Commit(); err != nil {
		return mappingcore.Group{}, fmt.Errorf("提交映射组写入失败: %w", err)
	}
	return mappingcore.RestoreGroup(mappingcore.Input{
		ID:          group.ID(),
		Name:        group.Name(),
		Description: group.Description(),
		Provider:    group.Provider(),
		Enabled:     boolPointer(group.Enabled()),
		Entries:     group.Entries(),
		Position:    position,
		Version:     1,
		CreatedAt:   now,
		UpdatedAt:   now,
	})
}

// Update 实现映射组持久化端口；版本不匹配时返回 ErrGroupConflict。
func (repository *UpstreamErrorMappingRepository) Update(
	ctx context.Context,
	group mappingcore.Group,
	expectedVersion int64,
) (mappingcore.Group, error) {
	if !repository.available(ctx) {
		return mappingcore.Group{}, mappingapp.ErrServiceUnavailable
	}
	repository.store.mappingWrites.Lock()
	defer repository.store.mappingWrites.Unlock()

	transaction, err := repository.store.db.BeginTx(ctx, nil)
	if err != nil {
		return mappingcore.Group{}, fmt.Errorf("开始映射组写入事务失败: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()

	var currentVersion int64
	var position int
	var createdAtMS int64
	err = transaction.QueryRowContext(
		ctx,
		"SELECT version, position, created_at_ms FROM upstream_error_mapping_group WHERE id = ?",
		group.ID(),
	).Scan(&currentVersion, &position, &createdAtMS)
	if errors.Is(err, sql.ErrNoRows) {
		return mappingcore.Group{}, mappingcore.ErrGroupNotFound
	}
	if err != nil {
		return mappingcore.Group{}, fmt.Errorf("读取映射组版本失败: %w", err)
	}
	if currentVersion != expectedVersion {
		return mappingcore.Group{}, mappingcore.ErrGroupConflict
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	nowMS := now.UnixMilli()
	const updateGroup = `
		UPDATE upstream_error_mapping_group
		SET name = ?, description = ?, provider = ?, enabled = ?,
		    version = version + 1, updated_at_ms = ?
		WHERE id = ? AND version = ?`
	result, err := transaction.ExecContext(
		ctx,
		updateGroup,
		group.Name(),
		group.Description(),
		group.Provider(),
		group.Enabled(),
		nowMS,
		group.ID(),
		expectedVersion,
	)
	if err != nil {
		return mappingcore.Group{}, fmt.Errorf("更新映射组失败: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return mappingcore.Group{}, fmt.Errorf("读取映射组更新结果失败: %w", err)
	}
	if affected != 1 {
		return mappingcore.Group{}, mappingcore.ErrGroupConflict
	}
	if _, err := transaction.ExecContext(
		ctx,
		"DELETE FROM upstream_error_mapping_rule WHERE group_id = ?",
		group.ID(),
	); err != nil {
		return mappingcore.Group{}, fmt.Errorf("清理映射组规则失败: %w", err)
	}
	if err := insertMappingRules(ctx, transaction, group.ID(), group.Entries()); err != nil {
		return mappingcore.Group{}, err
	}
	if err := transaction.Commit(); err != nil {
		return mappingcore.Group{}, fmt.Errorf("提交映射组更新失败: %w", err)
	}
	return mappingcore.RestoreGroup(mappingcore.Input{
		ID:          group.ID(),
		Name:        group.Name(),
		Description: group.Description(),
		Provider:    group.Provider(),
		Enabled:     boolPointer(group.Enabled()),
		Entries:     group.Entries(),
		Position:    position,
		Version:     currentVersion + 1,
		CreatedAt:   time.UnixMilli(createdAtMS).UTC(),
		UpdatedAt:   now,
	})
}

// Delete 实现映射组持久化端口。
func (repository *UpstreamErrorMappingRepository) Delete(
	ctx context.Context,
	id string,
	expectedVersion *int64,
) error {
	if !repository.available(ctx) {
		return mappingapp.ErrServiceUnavailable
	}
	repository.store.mappingWrites.Lock()
	defer repository.store.mappingWrites.Unlock()

	transaction, err := repository.store.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("开始映射组写入事务失败: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()

	var result sql.Result
	if expectedVersion == nil {
		result, err = transaction.ExecContext(
			ctx,
			"DELETE FROM upstream_error_mapping_group WHERE id = ?",
			id,
		)
	} else {
		result, err = transaction.ExecContext(
			ctx,
			"DELETE FROM upstream_error_mapping_group WHERE id = ? AND version = ?",
			id,
			*expectedVersion,
		)
	}
	if err != nil {
		return fmt.Errorf("删除映射组失败: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("读取映射组删除结果失败: %w", err)
	}
	if affected == 0 {
		var exists int
		if err := transaction.QueryRowContext(
			ctx,
			"SELECT COUNT(*) FROM upstream_error_mapping_group WHERE id = ?",
			id,
		).Scan(&exists); err != nil {
			return fmt.Errorf("检查映射组是否存在失败: %w", err)
		}
		if exists == 0 {
			return mappingcore.ErrGroupNotFound
		}
		return mappingcore.ErrGroupConflict
	}
	if err := transaction.Commit(); err != nil {
		return fmt.Errorf("提交映射组删除失败: %w", err)
	}
	return nil
}

// available 判断仓储是否具备可用的数据库连接。
func (repository *UpstreamErrorMappingRepository) available(ctx context.Context) bool {
	return repository != nil && repository.store != nil && repository.store.db != nil && ctx != nil
}

// loadMappingGroups 读取按 position 排序的组及其规则条目。
//
// onlyID 非空时只读取该组；读事务保证组行与条目来自同一快照，不会读到「组已写入、
// 规则还没写完」的中间状态。
func loadMappingGroups(
	ctx context.Context,
	querier mappingQuerier,
	onlyID string,
) ([]mappingcore.Group, error) {
	groupQuery := `
		SELECT id, name, description, provider, enabled, position, version,
		       created_at_ms, updated_at_ms
		FROM upstream_error_mapping_group`
	arguments := make([]any, 0, 1)
	if onlyID != "" {
		groupQuery += " WHERE id = ?"
		arguments = append(arguments, onlyID)
	}
	groupQuery += " ORDER BY position, id"
	rows, err := querier.QueryContext(ctx, groupQuery, arguments...)
	if err != nil {
		return nil, fmt.Errorf("读取映射组失败: %w", err)
	}
	order := make([]string, 0, 16)
	records := make(map[string]*mappingGroupRecord, 16)
	for rows.Next() {
		var record mappingGroupRecord
		if err := rows.Scan(
			&record.id,
			&record.name,
			&record.description,
			&record.provider,
			&record.enabled,
			&record.position,
			&record.version,
			&record.createdAtMS,
			&record.updatedAtMS,
		); err != nil {
			_ = rows.Close()
			return nil, fmt.Errorf("读取映射组行失败: %w", err)
		}
		order = append(order, record.id)
		records[record.id] = &record
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, fmt.Errorf("遍历映射组失败: %w", err)
	}
	_ = rows.Close()
	if len(order) == 0 {
		return []mappingcore.Group{}, nil
	}

	ruleQuery := "SELECT group_id, position, rule_json FROM upstream_error_mapping_rule"
	ruleArguments := make([]any, 0, 1)
	if onlyID != "" {
		ruleQuery += " WHERE group_id = ?"
		ruleArguments = append(ruleArguments, onlyID)
	}
	ruleQuery += " ORDER BY group_id, position"
	ruleRows, err := querier.QueryContext(ctx, ruleQuery, ruleArguments...)
	if err != nil {
		return nil, fmt.Errorf("读取映射组规则失败: %w", err)
	}
	defer func() { _ = ruleRows.Close() }()
	for ruleRows.Next() {
		var groupID string
		var position int
		var raw string
		if err := ruleRows.Scan(&groupID, &position, &raw); err != nil {
			return nil, fmt.Errorf("读取映射组规则行失败: %w", err)
		}
		record, ok := records[groupID]
		if !ok {
			return nil, fmt.Errorf("%w: 规则引用了不存在的映射组 %s", ErrIncompatibleDatabase, groupID)
		}
		// 顺序必须从 0 连续：出现空洞说明有人绕过写入口改过库，不能猜它的匹配次序。
		if position != len(record.entries) {
			return nil, fmt.Errorf("%w: 映射组 %s 的规则顺序不连续", ErrIncompatibleDatabase, groupID)
		}
		rule, err := decodeMappingRule(raw)
		if err != nil {
			return nil, fmt.Errorf("%w: 映射组 %s 规则无效: %v", ErrIncompatibleDatabase, groupID, err)
		}
		record.entries = append(record.entries, mappingcore.Entry{Position: position, Rule: rule})
	}
	if err := ruleRows.Err(); err != nil {
		return nil, fmt.Errorf("遍历映射组规则失败: %w", err)
	}

	groups := make([]mappingcore.Group, 0, len(order))
	for _, id := range order {
		record := records[id]
		group, err := mappingcore.RestoreGroup(mappingcore.Input{
			ID:          record.id,
			Name:        record.name,
			Description: record.description,
			Provider:    record.provider,
			Enabled:     boolPointer(record.enabled),
			Entries:     record.entries,
			Position:    record.position,
			Version:     record.version,
			CreatedAt:   time.UnixMilli(record.createdAtMS).UTC(),
			UpdatedAt:   time.UnixMilli(record.updatedAtMS).UTC(),
		})
		if err != nil {
			return nil, fmt.Errorf("%w: 映射组 %s: %v", ErrIncompatibleDatabase, id, err)
		}
		groups = append(groups, group)
	}
	return groups, nil
}

// insertMappingRules 在事务内写入组内规则；条目顺序直接取 Entry.Position。
func insertMappingRules(
	ctx context.Context,
	transaction *sql.Tx,
	groupID string,
	entries []mappingcore.Entry,
) error {
	const statement = `
		INSERT INTO upstream_error_mapping_rule (group_id, position, rule_json)
		VALUES (?, ?, ?)`
	prepared, err := transaction.PrepareContext(ctx, statement)
	if err != nil {
		return fmt.Errorf("准备映射组规则写入失败: %w", err)
	}
	defer func() { _ = prepared.Close() }()
	for _, entry := range entries {
		encoded, err := json.Marshal(entry.Rule)
		if err != nil {
			return fmt.Errorf("序列化映射组规则失败: %w", err)
		}
		if _, err := prepared.ExecContext(ctx, groupID, entry.Position, string(encoded)); err != nil {
			return fmt.Errorf("写入映射组规则失败: %w", err)
		}
	}
	return nil
}

// decodeMappingRule 从持久化 JSON 恢复规则并重新编译正则。
func decodeMappingRule(raw string) (rulescore.Rule, error) {
	var rule rulescore.Rule
	if err := json.Unmarshal([]byte(raw), &rule); err != nil {
		return rulescore.Rule{}, err
	}
	return rulescore.NewRule(
		rule.Name(),
		rule.Kind(),
		rule.Enabled(),
		rule.Statuses(),
		rule.Matchers(),
	)
}

// boolPointer 把布尔值变成指针，用于领域构造器区分「未提供」与显式 false。
func boolPointer(value bool) *bool { return &value }

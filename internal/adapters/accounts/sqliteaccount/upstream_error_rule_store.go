package sqliteaccount

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"

	rulesapp "github.com/madou1217/ai_home/application/upstreamrules"
	rulescore "github.com/madou1217/ai_home/core/upstreamrules"
)

// 编译期确认：适配器满足账号规则持久化端口。
var _ rulesapp.Repository = (*UpstreamErrorRuleRepository)(nil)

// UpstreamErrorRuleRepository 把账号级规则、组挂载与兼容投影落到 aih.db。
//
// 单独一个适配器而不是把方法挂到 Store 上：账号规则只服务管理链路与上游失败求值，
// 与账号生命周期保持单向依赖，也方便单独测试。
type UpstreamErrorRuleRepository struct {
	store *Store
}

// NewUpstreamErrorRuleRepository 创建账号规则仓储。
func NewUpstreamErrorRuleRepository(store *Store) *UpstreamErrorRuleRepository {
	return &UpstreamErrorRuleRepository{store: store}
}

// AccountProvider 实现账号规则持久化端口。
func (repository *UpstreamErrorRuleRepository) AccountProvider(
	ctx context.Context,
	accountRef string,
) (string, bool, error) {
	if !repository.available(ctx) {
		return "", false, rulesapp.ErrServiceUnavailable
	}
	var provider string
	err := repository.store.db.QueryRowContext(
		ctx,
		"SELECT provider_id FROM accounts WHERE account_ref = ?",
		accountRef,
	).Scan(&provider)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("读取账号 Provider 失败: %w", err)
	}
	return provider, true, nil
}

// Load 实现账号规则持久化端口。
func (repository *UpstreamErrorRuleRepository) Load(
	ctx context.Context,
	accountRef string,
	source rulesapp.Source,
) (rulesapp.Record, bool, error) {
	if !repository.available(ctx) {
		return rulesapp.Record{}, false, rulesapp.ErrServiceUnavailable
	}
	transaction, err := repository.store.db.BeginTx(ctx, nil)
	if err != nil {
		return rulesapp.Record{}, false, fmt.Errorf("开始账号规则读取事务失败: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()
	records, err := loadRuleRecords(ctx, transaction, source, accountRef)
	if err != nil {
		return rulesapp.Record{}, false, err
	}
	if err := transaction.Commit(); err != nil {
		return rulesapp.Record{}, false, fmt.Errorf("提交账号规则读取事务失败: %w", err)
	}
	record, exists := records[accountRef]
	if !exists {
		return rulesapp.Record{}, false, nil
	}
	return record, true, nil
}

// List 实现账号规则持久化端口。
func (repository *UpstreamErrorRuleRepository) List(
	ctx context.Context,
	source rulesapp.Source,
) ([]rulesapp.Record, error) {
	if !repository.available(ctx) {
		return nil, rulesapp.ErrServiceUnavailable
	}
	transaction, err := repository.store.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("开始账号规则读取事务失败: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()
	records, err := loadRuleRecords(ctx, transaction, source, "")
	if err != nil {
		return nil, err
	}
	if err := transaction.Commit(); err != nil {
		return nil, fmt.Errorf("提交账号规则读取事务失败: %w", err)
	}
	return sortedRecords(records), nil
}

// ReplaceAccount 实现账号规则持久化端口。
//
// 同一事务里清掉该账号的兼容投影：账号级配置一旦写入，它就是唯一有效来源，旧投影
// 必须消失，否则用户在界面清空规则后旧的生效规则还会复活。
func (repository *UpstreamErrorRuleRepository) ReplaceAccount(
	ctx context.Context,
	record rulesapp.Record,
) error {
	if !repository.available(ctx) {
		return rulesapp.ErrServiceUnavailable
	}
	repository.store.ruleWrites.Lock()
	defer repository.store.ruleWrites.Unlock()

	transaction, err := repository.store.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("开始账号规则写入事务失败: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()

	var provider string
	err = transaction.QueryRowContext(
		ctx,
		"SELECT provider_id FROM accounts WHERE account_ref = ?",
		record.AccountRef,
	).Scan(&provider)
	if errors.Is(err, sql.ErrNoRows) {
		return rulesapp.ErrAccountNotFound
	}
	if err != nil {
		return fmt.Errorf("读取账号 Provider 失败: %w", err)
	}
	if _, err := transaction.ExecContext(
		ctx,
		"DELETE FROM account_upstream_error_rule WHERE account_ref = ?",
		record.AccountRef,
	); err != nil {
		return fmt.Errorf("清理账号规则失败: %w", err)
	}
	if _, err := transaction.ExecContext(
		ctx,
		"DELETE FROM account_upstream_error_group WHERE account_ref = ?",
		record.AccountRef,
	); err != nil {
		return fmt.Errorf("清理账号组挂载失败: %w", err)
	}
	if err := insertAccountRules(ctx, transaction, record, rulesapp.SourceAccount); err != nil {
		return err
	}
	const insertGroup = `
		INSERT INTO account_upstream_error_group (account_ref, position, group_id)
		VALUES (?, ?, ?)`
	prepared, err := transaction.PrepareContext(ctx, insertGroup)
	if err != nil {
		return fmt.Errorf("准备账号组挂载写入失败: %w", err)
	}
	defer func() { _ = prepared.Close() }()
	for position, groupID := range record.GroupIDs {
		if _, err := prepared.ExecContext(ctx, record.AccountRef, position, groupID); err != nil {
			return fmt.Errorf("写入账号组挂载失败: %w", err)
		}
	}
	if err := transaction.Commit(); err != nil {
		return fmt.Errorf("提交账号规则写入失败: %w", err)
	}
	return nil
}

// ReplaceProjection 实现账号规则持久化端口。
func (repository *UpstreamErrorRuleRepository) ReplaceProjection(
	ctx context.Context,
	records []rulesapp.Record,
) error {
	if !repository.available(ctx) {
		return rulesapp.ErrServiceUnavailable
	}
	repository.store.ruleWrites.Lock()
	defer repository.store.ruleWrites.Unlock()

	transaction, err := repository.store.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("开始兼容投影写入事务失败: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()
	if _, err := transaction.ExecContext(
		ctx,
		"DELETE FROM account_upstream_error_rule WHERE source = ?",
		rulesapp.SourceProjection,
	); err != nil {
		return fmt.Errorf("清理兼容投影失败: %w", err)
	}
	for _, record := range records {
		record.Source = rulesapp.SourceProjection
		if err := insertAccountRules(ctx, transaction, record, rulesapp.SourceProjection); err != nil {
			return err
		}
	}
	if err := transaction.Commit(); err != nil {
		return fmt.Errorf("提交兼容投影写入失败: %w", err)
	}
	return nil
}

// DeleteAccountRules 实现账号规则持久化端口。
func (repository *UpstreamErrorRuleRepository) DeleteAccountRules(
	ctx context.Context,
	accountRef string,
) (bool, error) {
	if !repository.available(ctx) {
		return false, rulesapp.ErrServiceUnavailable
	}
	repository.store.ruleWrites.Lock()
	defer repository.store.ruleWrites.Unlock()

	transaction, err := repository.store.db.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("开始账号规则删除事务失败: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()
	deleted := 0
	for _, statement := range []string{
		"DELETE FROM account_upstream_error_rule WHERE account_ref = ?",
		"DELETE FROM account_upstream_error_group WHERE account_ref = ?",
	} {
		result, execErr := transaction.ExecContext(ctx, statement, accountRef)
		if execErr != nil {
			return false, fmt.Errorf("删除账号规则失败: %w", execErr)
		}
		affected, rowsErr := result.RowsAffected()
		if rowsErr != nil {
			return false, fmt.Errorf("读取账号规则删除结果失败: %w", rowsErr)
		}
		deleted += int(affected)
	}
	if err := transaction.Commit(); err != nil {
		return false, fmt.Errorf("提交账号规则删除失败: %w", err)
	}
	return deleted > 0, nil
}

// ListAccountRefs 实现账号规则持久化端口。
func (repository *UpstreamErrorRuleRepository) ListAccountRefs(ctx context.Context) ([]string, error) {
	if !repository.available(ctx) {
		return nil, rulesapp.ErrServiceUnavailable
	}
	const query = `
		SELECT account_ref FROM account_upstream_error_rule
		UNION
		SELECT account_ref FROM account_upstream_error_group
		ORDER BY account_ref`
	rows, err := repository.store.db.QueryContext(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("读取账号规则索引失败: %w", err)
	}
	defer func() { _ = rows.Close() }()
	refs := make([]string, 0, 16)
	for rows.Next() {
		var ref string
		if err := rows.Scan(&ref); err != nil {
			return nil, fmt.Errorf("读取账号规则索引行失败: %w", err)
		}
		refs = append(refs, ref)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历账号规则索引失败: %w", err)
	}
	return refs, nil
}

// available 判断仓储是否具备可用的数据库连接。
func (repository *UpstreamErrorRuleRepository) available(ctx context.Context) bool {
	return repository != nil && repository.store != nil && repository.store.db != nil && ctx != nil
}

// loadRuleRecords 读取某个来源的规则，并在账号级来源上补齐组挂载。
//
// onlyRef 非空时只读取该账号；读事务保证规则与挂载来自同一快照，不会读到
// 「规则已删、挂载还没写完」的中间状态。
func loadRuleRecords(
	ctx context.Context,
	querier mappingQuerier,
	source rulesapp.Source,
	onlyRef string,
) (map[string]rulesapp.Record, error) {
	ruleQuery := `
		SELECT r.account_ref, a.provider_id, r.position, r.rule_json
		FROM account_upstream_error_rule r
		JOIN accounts a ON a.account_ref = r.account_ref
		WHERE r.source = ?`
	arguments := []any{string(source)}
	if onlyRef != "" {
		ruleQuery += " AND r.account_ref = ?"
		arguments = append(arguments, onlyRef)
	}
	ruleQuery += " ORDER BY r.account_ref, r.position"
	rows, err := querier.QueryContext(ctx, ruleQuery, arguments...)
	if err != nil {
		return nil, fmt.Errorf("读取账号规则失败: %w", err)
	}
	records := map[string]rulesapp.Record{}
	for rows.Next() {
		var ref string
		var provider string
		var position int
		var raw string
		if err := rows.Scan(&ref, &provider, &position, &raw); err != nil {
			_ = rows.Close()
			return nil, fmt.Errorf("读取账号规则行失败: %w", err)
		}
		record, exists := records[ref]
		if !exists {
			record = rulesapp.Record{
				AccountRef: ref,
				Provider:   provider,
				Source:     source,
				GroupIDs:   []string{},
				Rules:      []rulescore.Rule{},
			}
		}
		if position != len(record.Rules) {
			_ = rows.Close()
			return nil, fmt.Errorf("%w: 账号 %s 的规则顺序不连续", ErrIncompatibleDatabase, ref)
		}
		rule, decodeErr := decodeMappingRule(raw)
		if decodeErr != nil {
			_ = rows.Close()
			return nil, fmt.Errorf("%w: 账号 %s 规则无效: %v", ErrIncompatibleDatabase, ref, decodeErr)
		}
		record.Rules = append(record.Rules, rule)
		records[ref] = record
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, fmt.Errorf("遍历账号规则失败: %w", err)
	}
	_ = rows.Close()

	if source != rulesapp.SourceAccount {
		return records, nil
	}
	groupQuery := `
		SELECT g.account_ref, a.provider_id, g.position, g.group_id
		FROM account_upstream_error_group g
		JOIN accounts a ON a.account_ref = g.account_ref`
	groupArguments := make([]any, 0, 1)
	if onlyRef != "" {
		groupQuery += " WHERE g.account_ref = ?"
		groupArguments = append(groupArguments, onlyRef)
	}
	groupQuery += " ORDER BY g.account_ref, g.position"
	groupRows, err := querier.QueryContext(ctx, groupQuery, groupArguments...)
	if err != nil {
		return nil, fmt.Errorf("读取账号组挂载失败: %w", err)
	}
	defer func() { _ = groupRows.Close() }()
	for groupRows.Next() {
		var ref string
		var provider string
		var position int
		var groupID string
		if err := groupRows.Scan(&ref, &provider, &position, &groupID); err != nil {
			return nil, fmt.Errorf("读取账号组挂载行失败: %w", err)
		}
		record, exists := records[ref]
		if !exists {
			// 账号只有组挂载、没有自身规则：仍然是一条有效配置，必须建记录。
			record = rulesapp.Record{
				AccountRef: ref,
				Provider:   provider,
				Source:     source,
				GroupIDs:   []string{},
				Rules:      []rulescore.Rule{},
			}
		}
		if position != len(record.GroupIDs) {
			return nil, fmt.Errorf("%w: 账号 %s 的组挂载顺序不连续", ErrIncompatibleDatabase, ref)
		}
		record.GroupIDs = append(record.GroupIDs, groupID)
		records[ref] = record
	}
	if err := groupRows.Err(); err != nil {
		return nil, fmt.Errorf("遍历账号组挂载失败: %w", err)
	}
	return records, nil
}

// sortedRecords 把 map 转成按账号引用排序的切片。
func sortedRecords(records map[string]rulesapp.Record) []rulesapp.Record {
	refs := make([]string, 0, len(records))
	for ref := range records {
		refs = append(refs, ref)
	}
	sort.Strings(refs)
	result := make([]rulesapp.Record, 0, len(refs))
	for _, ref := range refs {
		result = append(result, records[ref])
	}
	return result
}

// insertAccountRules 在事务内写入一个来源的全部规则。
func insertAccountRules(
	ctx context.Context,
	transaction *sql.Tx,
	record rulesapp.Record,
	source rulesapp.Source,
) error {
	const statement = `
		INSERT INTO account_upstream_error_rule (account_ref, source, position, rule_json)
		VALUES (?, ?, ?, ?)`
	prepared, err := transaction.PrepareContext(ctx, statement)
	if err != nil {
		return fmt.Errorf("准备账号规则写入失败: %w", err)
	}
	defer func() { _ = prepared.Close() }()
	for position, rule := range record.Rules {
		encoded, err := json.Marshal(rule)
		if err != nil {
			return fmt.Errorf("序列化账号规则失败: %w", err)
		}
		if _, err := prepared.ExecContext(ctx, record.AccountRef, string(source), position, string(encoded)); err != nil {
			return fmt.Errorf("写入账号规则失败: %w", err)
		}
	}
	return nil
}

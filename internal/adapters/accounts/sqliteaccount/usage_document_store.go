package sqliteaccount

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	usageapp "github.com/madou1217/ai_home/application/accountusage"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
)

var _ usageapp.UsageDocumentStore = (*Store)(nil)

// ReplaceUsageDocument 覆盖账号当前 Provider 快照文档。
//
// 采集时间只增不减：乱序到达的旧文档不能把新文档顶掉。账号存在性与 Provider
// 一致性在同一事务内确认，避免采集方把文档写到错误的账号上。
func (store *Store) ReplaceUsageDocument(
	ctx context.Context,
	document usagecore.Document,
) error {
	if store == nil ||
		store.db == nil ||
		ctx == nil ||
		!document.IsValid() {
		return usagecore.ErrInvalidDocument
	}
	if err := ctx.Err(); err != nil {
		return err
	}

	store.routingWrites.Lock()
	defer store.routingWrites.Unlock()
	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("开始额度文档写入事务失败: %w", err)
	}
	defer func() {
		_ = transaction.Rollback()
	}()

	var providerID string
	err = transaction.QueryRowContext(
		ctx,
		"SELECT provider_id FROM accounts WHERE account_ref = ? LIMIT 1",
		document.AccountRef().String(),
	).Scan(&providerID)
	if errors.Is(err, sql.ErrNoRows) {
		return accountapp.ErrAccountNotFound
	}
	if err != nil {
		return fmt.Errorf("读取额度文档所属账号失败: %w", err)
	}
	if providerID != document.ProviderID() {
		return usagecore.ErrInvalidDocument
	}

	const statement = `
		INSERT INTO account_usage_snapshots (
			account_ref, provider_id, kind, source, captured_at_ms, payload_json
		) VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(account_ref) DO UPDATE SET
			provider_id = excluded.provider_id,
			kind = excluded.kind,
			source = excluded.source,
			captured_at_ms = excluded.captured_at_ms,
			payload_json = excluded.payload_json
		WHERE excluded.captured_at_ms >= account_usage_snapshots.captured_at_ms`
	if _, err := transaction.ExecContext(
		ctx,
		statement,
		document.AccountRef().String(),
		document.ProviderID(),
		document.Kind(),
		document.Source(),
		document.CapturedAt().UnixMilli(),
		string(document.Payload()),
	); err != nil {
		return fmt.Errorf("写入账号额度文档失败: %w", err)
	}
	if err := transaction.Commit(); err != nil {
		return fmt.Errorf("提交额度文档写入事务失败: %w", err)
	}
	return nil
}

// ListUsageDocuments 按账号/Provider 过滤返回完整文档。
func (store *Store) ListUsageDocuments(
	ctx context.Context,
	query usageapp.DocumentQuery,
) ([]usagecore.Document, error) {
	if store == nil || store.db == nil || ctx == nil {
		return nil, usageapp.ErrInvalidRequest
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	statement := strings.Builder{}
	statement.WriteString(`
		SELECT account_ref, provider_id, kind, source, captured_at_ms, payload_json
		  FROM account_usage_snapshots`)
	conditions := make([]string, 0, 2)
	arguments := make([]any, 0, len(query.Providers)+len(query.AccountRefs))
	if len(query.Providers) > 0 {
		conditions = append(conditions, "provider_id IN ("+placeholders(len(query.Providers))+")")
		for _, providerID := range query.Providers {
			arguments = append(arguments, providerID)
		}
	}
	if len(query.AccountRefs) > 0 {
		conditions = append(conditions, "account_ref IN ("+placeholders(len(query.AccountRefs))+")")
		for _, accountRef := range query.AccountRefs {
			arguments = append(arguments, accountRef.String())
		}
	}
	if len(conditions) > 0 {
		statement.WriteString(" WHERE ")
		statement.WriteString(strings.Join(conditions, " AND "))
	}
	statement.WriteString(" ORDER BY account_ref")

	rows, err := store.db.QueryContext(ctx, statement.String(), arguments...)
	if err != nil {
		return nil, fmt.Errorf("查询账号额度文档失败: %w", err)
	}
	defer func() {
		_ = rows.Close()
	}()

	documents := make([]usagecore.Document, 0, 16)
	for rows.Next() {
		document, err := scanUsageDocument(rows)
		if err != nil {
			return nil, err
		}
		documents = append(documents, document)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历账号额度文档失败: %w", err)
	}
	return documents, nil
}

// scanUsageDocument 把 SQLite 行恢复为不可变领域文档。
func scanUsageDocument(row rowScanner) (usagecore.Document, error) {
	var accountRef, providerID, kind, source, payload string
	var capturedAtMS int64
	if err := row.Scan(
		&accountRef,
		&providerID,
		&kind,
		&source,
		&capturedAtMS,
		&payload,
	); err != nil {
		return usagecore.Document{}, fmt.Errorf("读取账号额度文档失败: %w", err)
	}
	parsedRef, err := accountcore.ParseAccountRef(accountRef)
	if err != nil {
		return usagecore.Document{}, ErrIncompatibleDatabase
	}
	document, err := usagecore.NewDocument(usagecore.DocumentInput{
		AccountRef: parsedRef,
		ProviderID: providerID,
		Kind:       kind,
		Source:     source,
		CapturedAt: timeFromUnixMilli(capturedAtMS),
		Payload:    []byte(payload),
	})
	if err != nil {
		return usagecore.Document{}, ErrIncompatibleDatabase
	}
	return document, nil
}

// placeholders 生成 IN 子句的占位符串。
func placeholders(count int) string {
	if count <= 0 {
		return ""
	}
	return strings.TrimSuffix(strings.Repeat("?,", count), ",")
}

// ReplaceUsageDocumentQuotaState 更新账号快照文档上的物化额度状态。
//
// 状态由应用层用同一份文档与归一化事实派生；这里只做持久化，不重新计算。
func (store *Store) ReplaceUsageDocumentQuotaState(
	ctx context.Context,
	state usageapp.DocumentQuotaState,
) error {
	if store == nil || store.db == nil || ctx == nil || !state.AccountRef.IsValid() {
		return usageapp.ErrInvalidRequest
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	var remaining any
	if state.Remaining.Known {
		remaining = int64(state.Remaining.BasisPoints)
	}
	hasNumeric := 0
	if state.Remaining.Known {
		hasNumeric = 1
	}
	if _, err := store.db.ExecContext(
		ctx,
		`UPDATE account_usage_snapshots
		    SET quota_status = ?, quota_reason = ?, remaining_bps = ?, has_numeric_remaining = ?
		  WHERE account_ref = ?`,
		state.Status,
		state.Reason,
		remaining,
		hasNumeric,
		state.AccountRef.String(),
	); err != nil {
		return fmt.Errorf("写入账号额度状态失败: %w", err)
	}
	return nil
}

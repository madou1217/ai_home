package sqliteaccount

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
)

// accountOverviewSelectSQL 集中定义账号管理查询允许读取的公开事实。
//
// 单条 SQL 使用账号主键相关子查询读取有界派生快照，禁止选择凭据或资料 JSON。
const accountOverviewSelectSQL = `
	SELECT a.account_ref, a.provider_id, a.cli_account_id, a.enabled,
	       a.created_at_ms, a.updated_at_ms,
	       c.account_ref IS NOT NULL,
	       COALESCE(c.auth_kind, ''), COALESCE(c.auth_mode, ''),
	       p.account_ref IS NOT NULL,
	       COALESCE(p.display_name, ''), COALESCE(p.email, ''),
	       COALESCE(p.subscription_kind, ''), COALESCE(p.subscription_raw, ''),
	       COALESCE(p.updated_at_ms, 0),
	       (
	         SELECT json_object(
	           'stored_count', COUNT(*),
	           'effective_count', COALESCE(SUM(
	             CASE
	               WHEN m.manual_policy = 'force_enable'
	                 OR (m.manual_policy = 'inherit' AND m.upstream_available = 1)
	               THEN 1 ELSE 0
	             END
	           ), 0),
	           'updated_at_ms', COALESCE(MAX(m.updated_at_ms), 0)
	         )
	         FROM account_models AS m
	         WHERE m.account_ref = a.account_ref
	       ),
	       COALESCE((
	         SELECT json_group_array(json_object(
	           'limit_id', bounded_usage.limit_id,
	           'limit_name', bounded_usage.limit_name,
	           'bucket', bounded_usage.bucket,
	           'kind', bounded_usage.kind,
	           'scope', bounded_usage.scope,
	           'scope_key', bounded_usage.scope_key,
	           'remaining_bps', bounded_usage.remaining_bps,
	           'availability', bounded_usage.availability,
	           'window_seconds', bounded_usage.window_seconds,
	           'reset_at_ms', bounded_usage.reset_at_ms,
	           'source', bounded_usage.source,
	           'captured_at_ms', bounded_usage.captured_at_ms
	         ))
	         FROM (
	           SELECT u.limit_id, u.limit_name, u.bucket, u.kind, u.scope,
	                  u.scope_key, u.remaining_bps, u.availability,
	                  u.window_seconds, u.reset_at_ms, u.source, u.captured_at_ms
	           FROM account_usage AS u
	           WHERE u.account_ref = a.account_ref
	           ORDER BY u.limit_id, u.bucket
	           LIMIT 65
	         ) AS bounded_usage
	       ), '[]')
	FROM accounts AS a
	LEFT JOIN account_credentials AS c ON c.account_ref = a.account_ref
	LEFT JOIN account_profiles AS p ON p.account_ref = a.account_ref`

// accountOverviewSQL 是账号管理列表及查询计划验证的 keyset SQL 合同。
const accountOverviewSQL = accountOverviewSelectSQL + `
	WHERE a.account_ref > ?
	ORDER BY a.account_ref
	LIMIT ?`

// accountOverviewByRefSQL 是账号管理详情使用的主键点查 SQL 合同。
const accountOverviewByRefSQL = accountOverviewSelectSQL + `
	WHERE a.account_ref = ?
	LIMIT 1`

// accountOverviewByAliasSQL 使用账号表唯一索引点查 Provider 内数字别名。
const accountOverviewByAliasSQL = accountOverviewSelectSQL + `
	WHERE a.provider_id = ? AND a.cli_account_id = ?
	LIMIT 1`

var _ accountapp.AccountOverviewStore = (*Store)(nil)

// ListAccountOverviews 使用 keyset pagination 返回无敏感数据的账号管理投影。
func (store *Store) ListAccountOverviews(
	ctx context.Context,
	query accountapp.OverviewQuery,
) ([]accountapp.AccountOverview, error) {
	if !query.IsValid() {
		return nil, accountapp.ErrInvalidOverview
	}
	rows, err := store.db.QueryContext(
		ctx,
		accountOverviewSQL,
		query.AfterRef().String(),
		query.Limit(),
	)
	if err != nil {
		return nil, fmt.Errorf("查询账号管理投影失败: %w", err)
	}
	defer func() {
		_ = rows.Close()
	}()

	overviews := make([]accountapp.AccountOverview, 0, query.Limit())
	for rows.Next() {
		overview, err := store.scanAccountOverview(rows)
		if err != nil {
			return nil, err
		}
		overviews = append(overviews, overview)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历账号管理投影失败: %w", err)
	}
	return overviews, nil
}

// GetAccountOverview 按稳定账号身份读取无敏感数据的账号管理投影。
func (store *Store) GetAccountOverview(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) (accountapp.AccountOverview, error) {
	if !accountRef.IsValid() {
		return accountapp.AccountOverview{}, accountcore.ErrInvalidAccountRef
	}
	return store.scanAccountOverview(store.db.QueryRowContext(
		ctx,
		accountOverviewByRefSQL,
		accountRef.String(),
	))
}

// GetAccountOverviewByCLIAccountID 按 Provider 内数字别名点查无敏感投影。
func (store *Store) GetAccountOverviewByCLIAccountID(
	ctx context.Context,
	providerID string,
	cliAccountID accountcore.CLIAccountID,
) (accountapp.AccountOverview, error) {
	canonicalProviderID, found := store.catalog.CanonicalID(providerID)
	if !found || canonicalProviderID != providerID || !cliAccountID.IsValid() {
		return accountapp.AccountOverview{}, accountapp.ErrInvalidOverview
	}
	return store.scanAccountOverview(store.db.QueryRowContext(
		ctx,
		accountOverviewByAliasSQL,
		canonicalProviderID,
		cliAccountID.Int64(),
	))
}

// scanAccountOverview 校验账号、凭据类型和公开资料标量。
func (store *Store) scanAccountOverview(row rowScanner) (accountapp.AccountOverview, error) {
	var record accountRecord
	var input accountapp.AccountOverviewInput
	var profileUpdatedAtMS int64
	var modelSummaryJSON, usageSnapshotJSON string
	if err := row.Scan(
		&record.accountRef,
		&record.providerID,
		&record.cliAccountID,
		&record.enabled,
		&record.createdAtMS,
		&record.updatedAtMS,
		&input.HasCredential,
		&input.AuthKind,
		&input.AuthMode,
		&input.HasProfile,
		&input.DisplayName,
		&input.Email,
		&input.SubscriptionKind,
		&input.SubscriptionRaw,
		&profileUpdatedAtMS,
		&modelSummaryJSON,
		&usageSnapshotJSON,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return accountapp.AccountOverview{}, accountapp.ErrAccountNotFound
		}
		return accountapp.AccountOverview{}, fmt.Errorf("读取账号管理投影失败: %w", err)
	}
	account, err := store.restoreAccount(record)
	if err != nil {
		return accountapp.AccountOverview{}, err
	}
	input.Account = account
	modelSummary, err := restoreOverviewModelSummary(modelSummaryJSON)
	if err != nil {
		return accountapp.AccountOverview{}, err
	}
	input.ModelSummary = modelSummary
	usageSnapshot, hasUsageSnapshot, err := restoreOverviewUsageSnapshot(
		account,
		usageSnapshotJSON,
	)
	if err != nil {
		return accountapp.AccountOverview{}, err
	}
	input.HasUsageSnapshot = hasUsageSnapshot
	input.UsageSnapshot = usageSnapshot
	if input.HasProfile {
		input.ProfileUpdatedAt = time.UnixMilli(profileUpdatedAtMS).UTC()
	}
	overview, err := accountapp.NewAccountOverview(input)
	if err != nil {
		return accountapp.AccountOverview{}, ErrIncompatibleDatabase
	}
	return overview, nil
}

type overviewModelSummaryDocument struct {
	StoredCount    int64 `json:"stored_count"`
	EffectiveCount int64 `json:"effective_count"`
	UpdatedAtMS    int64 `json:"updated_at_ms"`
}

// restoreOverviewModelSummary 把单次列表 SQL 的模型聚合恢复为领域汇总。
func restoreOverviewModelSummary(
	document string,
) (accountapp.AccountModelSummary, error) {
	var persisted overviewModelSummaryDocument
	if err := json.Unmarshal([]byte(document), &persisted); err != nil {
		return accountapp.AccountModelSummary{}, ErrIncompatibleDatabase
	}
	if persisted.StoredCount == 0 {
		if persisted.EffectiveCount != 0 || persisted.UpdatedAtMS != 0 {
			return accountapp.AccountModelSummary{}, ErrIncompatibleDatabase
		}
		return accountapp.NewAccountModelSummary(accountapp.AccountModelSummaryInput{})
	}
	maxInt := int64(^uint(0) >> 1)
	if persisted.StoredCount < 0 ||
		persisted.StoredCount > maxInt ||
		persisted.EffectiveCount < 0 ||
		persisted.EffectiveCount > maxInt {
		return accountapp.AccountModelSummary{}, ErrIncompatibleDatabase
	}
	summary, err := accountapp.NewAccountModelSummary(accountapp.AccountModelSummaryInput{
		Known:          true,
		StoredCount:    int(persisted.StoredCount),
		EffectiveCount: int(persisted.EffectiveCount),
		UpdatedAt:      time.UnixMilli(persisted.UpdatedAtMS).UTC(),
	})
	if err != nil {
		return accountapp.AccountModelSummary{}, ErrIncompatibleDatabase
	}
	return summary, nil
}

type overviewUsageEntryDocument struct {
	LimitID       string `json:"limit_id"`
	LimitName     string `json:"limit_name"`
	Bucket        string `json:"bucket"`
	Kind          string `json:"kind"`
	Scope         string `json:"scope"`
	ScopeKey      string `json:"scope_key"`
	RemainingBPS  *int64 `json:"remaining_bps"`
	Availability  string `json:"availability"`
	WindowSeconds *int64 `json:"window_seconds"`
	ResetAtMS     *int64 `json:"reset_at_ms"`
	Source        string `json:"source"`
	CapturedAtMS  int64  `json:"captured_at_ms"`
}

// restoreOverviewUsageSnapshot 恢复最多 64 条额度事实；第 65 行只用于发现不兼容数据库。
func restoreOverviewUsageSnapshot(
	account accountcore.Account,
	document string,
) (usagecore.Snapshot, bool, error) {
	var persisted []overviewUsageEntryDocument
	if err := json.Unmarshal([]byte(document), &persisted); err != nil {
		return usagecore.Snapshot{}, false, ErrIncompatibleDatabase
	}
	if len(persisted) == 0 {
		return usagecore.Snapshot{}, false, nil
	}
	if len(persisted) > usagecore.MaxEntriesPerSnapshot {
		return usagecore.Snapshot{}, false, ErrIncompatibleDatabase
	}
	entries := make([]usagecore.EntryInput, 0, len(persisted))
	source := persisted[0].Source
	capturedAtMS := persisted[0].CapturedAtMS
	for _, row := range persisted {
		if row.Source != source || row.CapturedAtMS != capturedAtMS {
			return usagecore.Snapshot{}, false, ErrIncompatibleDatabase
		}
		entry := usagecore.EntryInput{
			LimitID:      row.LimitID,
			LimitName:    row.LimitName,
			Bucket:       row.Bucket,
			Kind:         usagecore.Kind(row.Kind),
			Scope:        usagecore.Scope(row.Scope),
			ScopeKey:     row.ScopeKey,
			Availability: usagecore.Availability(row.Availability),
		}
		if row.RemainingBPS != nil {
			if *row.RemainingBPS < 0 || *row.RemainingBPS > 10_000 {
				return usagecore.Snapshot{}, false, ErrIncompatibleDatabase
			}
			entry.HasRemaining = true
			entry.RemainingBasisPoints = uint16(*row.RemainingBPS)
		}
		if row.WindowSeconds != nil {
			entry.WindowSeconds = *row.WindowSeconds
		}
		if row.ResetAtMS != nil {
			entry.ResetAt = time.UnixMilli(*row.ResetAtMS).UTC()
		}
		entries = append(entries, entry)
	}
	snapshot, err := usagecore.NewSnapshot(usagecore.SnapshotInput{
		AccountRef: account.Ref(),
		ProviderID: account.ProviderID(),
		Source:     source,
		CapturedAt: time.UnixMilli(capturedAtMS).UTC(),
		Entries:    entries,
	})
	if err != nil {
		return usagecore.Snapshot{}, false, ErrIncompatibleDatabase
	}
	return snapshot, true, nil
}

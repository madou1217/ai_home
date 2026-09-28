package sqliteaccount

import (
	"context"
	"fmt"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// modelRefreshSweepSQL 是目录重扫及查询计划测试共享的 SQL 合同。
//
// 只返回已启用且持有凭据的账号：停用账号不参与路由，重扫它们只会让同 Provider
// 共享的失败退避拖慢可用账号。Provider 过滤为空串时不限定；查询不读取凭据文档。
const modelRefreshSweepSQL = `
	SELECT a.account_ref, a.provider_id
	FROM accounts AS a
	JOIN account_credentials AS c ON c.account_ref = a.account_ref
	WHERE a.account_ref > ?
	  AND a.enabled = 1
	  AND (? = '' OR a.provider_id = ?)
	ORDER BY a.account_ref
	LIMIT ?`

var _ accountapp.ModelRefreshSweepCandidateReader = (*Store)(nil)

// ListModelRefreshSweepCandidates 单次查询返回一页已启用且持有凭据的账号。
func (store *Store) ListModelRefreshSweepCandidates(
	ctx context.Context,
	query accountapp.ModelRefreshSweepQuery,
) ([]accountapp.ModelRefreshSweepCandidate, error) {
	if store == nil || store.db == nil || store.catalog == nil || query.Limit() < 1 {
		return nil, accountapp.ErrInvalidModelRefreshSweepQuery
	}
	rows, err := store.db.QueryContext(
		ctx,
		modelRefreshSweepSQL,
		query.AfterRef().String(),
		query.ProviderID(),
		query.ProviderID(),
		query.Limit(),
	)
	if err != nil {
		return nil, fmt.Errorf("查询账号模型目录重扫候选失败: %w", err)
	}
	defer func() {
		_ = rows.Close()
	}()

	candidates := make([]accountapp.ModelRefreshSweepCandidate, 0, query.Limit())
	for rows.Next() {
		var accountRefText string
		var providerID string
		if err := rows.Scan(&accountRefText, &providerID); err != nil {
			return nil, fmt.Errorf("读取账号模型目录重扫候选失败: %w", err)
		}
		accountRef, err := accountcore.ParseAccountRef(accountRefText)
		if err != nil {
			return nil, ErrIncompatibleDatabase
		}
		candidate, err := accountapp.NewInitialModelRefreshCandidate(
			store.catalog,
			accountRef,
			providerID,
		)
		if err != nil {
			return nil, ErrIncompatibleDatabase
		}
		candidates = append(candidates, candidate)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历账号模型目录重扫候选失败: %w", err)
	}
	return candidates, nil
}

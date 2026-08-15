package sqliteaccount

import (
	"context"
	"fmt"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// initialModelRefreshRecoverySQL 是启动恢复扫描及查询计划测试共享的 SQL 合同。
//
// JOIN 只确认凭据存在，NOT EXISTS 只判断是否已经物化过真实上游模型；查询不会
// 读取 credential_json，也不会为每个账号追加模型查询。
const initialModelRefreshRecoverySQL = `
	SELECT a.account_ref, a.provider_id
	FROM accounts AS a
	JOIN account_credentials AS c ON c.account_ref = a.account_ref
	WHERE a.account_ref > ?
	  AND NOT EXISTS (
		SELECT 1
		FROM account_models AS m
		WHERE m.account_ref = a.account_ref
		  AND m.upstream_available = 1
	  )
	ORDER BY a.account_ref
	LIMIT ?`

var _ accountapp.InitialModelRefreshCandidateReader = (*Store)(nil)

// ListInitialModelRefreshCandidates 单次查询返回已有凭据但尚无上游模型快照的账号。
func (store *Store) ListInitialModelRefreshCandidates(
	ctx context.Context,
	query accountapp.InitialModelRefreshRecoveryQuery,
) ([]accountapp.InitialModelRefreshCandidate, error) {
	if store == nil || store.db == nil || store.catalog == nil || !query.IsValid() {
		return nil, accountapp.ErrInvalidInitialModelRefreshRecoveryQuery
	}
	rows, err := store.db.QueryContext(
		ctx,
		initialModelRefreshRecoverySQL,
		query.AfterRef().String(),
		query.Limit(),
	)
	if err != nil {
		return nil, fmt.Errorf("查询首次模型刷新恢复候选失败: %w", err)
	}
	defer func() {
		_ = rows.Close()
	}()

	candidates := make(
		[]accountapp.InitialModelRefreshCandidate,
		0,
		query.Limit(),
	)
	for rows.Next() {
		var accountRefText string
		var providerID string
		if err := rows.Scan(&accountRefText, &providerID); err != nil {
			return nil, fmt.Errorf("读取首次模型刷新恢复候选失败: %w", err)
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
		return nil, fmt.Errorf("遍历首次模型刷新恢复候选失败: %w", err)
	}
	return candidates, nil
}

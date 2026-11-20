package sqliteaccount

import (
	"context"
	"fmt"
	"time"

	"github.com/madou1217/ai_home/application/modelprobes"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// modelProbeRetryCandidatesSQL 读取最近一次探测失败的已启用账号。
//
// 退避判定留在应用层（application/modelprobes 的声明式策略），这里只负责把
// 「失败事实」稳定地分页取出来；同一账号只有一行探测事实，因此按 account_ref
// 做 keyset 游标即可。停用账号与没有凭据的账号不参与自动重试，与周期重扫同口径。
const modelProbeRetryCandidatesSQL = `
	SELECT p.account_ref, a.provider_id, p.last_attempt_at_ms, p.last_error_code
	FROM account_model_probes AS p
	JOIN accounts AS a ON a.account_ref = p.account_ref
	JOIN account_credentials AS c ON c.account_ref = a.account_ref
	WHERE a.account_ref > ?
	  AND a.enabled = 1
	  AND p.last_source = 'error'
	  AND p.last_error_code <> ''
	ORDER BY a.account_ref
	LIMIT ?`

var _ modelprobes.RetryCandidateReader = (*Store)(nil)

// ListModelProbeRetryCandidates 单次查询返回一页失败的探测事实。
func (store *Store) ListModelProbeRetryCandidates(
	ctx context.Context,
	query modelprobes.RetryQuery,
) ([]modelprobes.RetryCandidate, error) {
	if store == nil || store.db == nil || !query.IsValid() {
		return nil, modelprobes.ErrInvalidProbeRetryQuery
	}
	rows, err := store.db.QueryContext(
		ctx,
		modelProbeRetryCandidatesSQL,
		query.AfterRef().String(),
		query.Limit(),
	)
	if err != nil {
		return nil, fmt.Errorf("查询模型探测到期重试候选失败: %w", err)
	}
	defer func() {
		_ = rows.Close()
	}()

	candidates := make([]modelprobes.RetryCandidate, 0, query.Limit())
	for rows.Next() {
		var (
			accountRefText string
			providerID     string
			attemptedAtMS  int64
			errorCode      string
		)
		if err := rows.Scan(
			&accountRefText,
			&providerID,
			&attemptedAtMS,
			&errorCode,
		); err != nil {
			return nil, fmt.Errorf("读取模型探测到期重试候选失败: %w", err)
		}
		accountRef, err := accountcore.ParseAccountRef(accountRefText)
		if err != nil {
			return nil, ErrIncompatibleDatabase
		}
		candidate, err := modelprobes.NewRetryCandidate(
			accountRef,
			providerID,
			errorCode,
			time.UnixMilli(attemptedAtMS).UTC(),
		)
		if err != nil {
			return nil, ErrIncompatibleDatabase
		}
		candidates = append(candidates, candidate)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历模型探测到期重试候选失败: %w", err)
	}
	return candidates, nil
}

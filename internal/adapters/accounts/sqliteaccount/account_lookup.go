package sqliteaccount

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// FindAccountRefByProviderEmail 按 Provider + 公开资料邮箱查找唯一账号。
//
// 原生导入的幂等兜底：Node 重复导入同一账号时，凭据派生 ref 可能与既有账号
// 不一致（历史身份种子差异），Register 会报账号冲突。邮箱是 agy 的稳定身份，
// 找到既有账号后导入方可直接返回它，而不是每 15 秒重试一次。
func (store *Store) FindAccountRefByProviderEmail(
	ctx context.Context,
	providerID string,
	email string,
) (accountcore.AccountRef, bool, error) {
	var zero accountcore.AccountRef
	if store == nil || store.db == nil || ctx == nil {
		return zero, false, ErrInvalidOpenOptions
	}
	provider := strings.TrimSpace(providerID)
	normalizedEmail := strings.ToLower(strings.TrimSpace(email))
	if provider == "" || normalizedEmail == "" {
		return zero, false, nil
	}
	var rawRef string
	err := store.db.QueryRowContext(
		ctx,
		`SELECT a.account_ref
		   FROM accounts a
		   LEFT JOIN account_profiles p ON p.account_ref = a.account_ref
		   LEFT JOIN account_credentials c ON c.account_ref = a.account_ref
		  WHERE a.provider_id = ?
		    AND (
		      lower(p.email) = ?
		      OR lower(json_extract(c.credential_json, '$.email')) = ?
		    )
		  LIMIT 1`,
		provider,
		normalizedEmail,
		normalizedEmail,
	).Scan(&rawRef)
	if errors.Is(err, sql.ErrNoRows) {
		return zero, false, nil
	}
	if err != nil {
		return zero, false, fmt.Errorf("按邮箱查找账号失败: %w", err)
	}
	ref, parseErr := accountcore.ParseAccountRef(rawRef)
	if parseErr != nil {
		return zero, false, fmt.Errorf("账号引用无效: %w", parseErr)
	}
	return ref, true, nil
}

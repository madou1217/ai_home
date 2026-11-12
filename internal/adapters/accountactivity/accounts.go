package accountactivity

// 活动候选账号的只读来源。
//
// 为什么读 Node 的 app-state.db 而不是 Go 的 accounts 表：领取动作由 Node 执行，
// 它必须能在**凭据库**里找到这个账号；把 Go 独有、Node 还没有凭据的账号列进来只会
// 在结果里制造 account_not_found 噪音。查询条件与 Node 的
// listAccountCredentialRecords 逐条一致（同一张 account_credentials + account_refs，
// 同一句「凭据非空」过滤），所以选项、批量目标与 Node 的候选集完全同源。
//
// 这里只做读：活动的任务状态、守卫与速率限制都在 Go，账号事实仍属于账号存储。

import (
	"context"
	"os"
	"regexp"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

// accountRefPattern 与 Node 的 isAccountRef 一致：acct_ + 20 位小写十六进制。
//
// 为什么 Go 也要校验：Node 的 listAccountCredentialRecords 在 mapCredentialRow 里丢弃
// 不符合该格式的 ref；Go 若不校验，参数下拉会给出 Node 根本不认的账号。
var accountRefPattern = regexp.MustCompile(`^acct_[a-f0-9]{20}$`)

// AccountLister 是活动的候选账号端口。
type AccountLister interface {
	ListByProvider(ctx context.Context, provider string) ([]string, error)
}

// CredentialAccountLister 读取 Node 凭据库中的账号引用。
type CredentialAccountLister struct {
	databasePath string
}

// NewCredentialAccountLister 创建只读账号来源；aiHomeDir 为空时报错。
func NewCredentialAccountLister(aiHomeDir string) (*CredentialAccountLister, error) {
	path, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return nil, err
	}
	return &CredentialAccountLister{databasePath: path}, nil
}

// ListByProvider 返回该 Provider 下凭据非空的账号引用（按 ref 排序）。
//
// 数据库或表缺失返回空清单：活动页在没有账号时本来就要显示「没有可领账号」，
// 把「还没初始化」伪装成 503 只会让整页失败。
func (lister *CredentialAccountLister) ListByProvider(ctx context.Context, provider string) ([]string, error) {
	normalized := strings.ToLower(strings.TrimSpace(provider))
	if normalized == "" {
		return nil, nil
	}
	if _, err := os.Stat(lister.databasePath); err != nil {
		return nil, nil
	}
	database, err := appstate.OpenReadOnly(ctx, lister.databasePath)
	if err != nil {
		return nil, err
	}
	defer func() { _ = database.Close() }()
	rows, err := database.QueryContext(ctx, `
		SELECT c.account_ref
		FROM account_credentials AS c
		INNER JOIN account_refs AS r ON r.account_ref = c.account_ref
		WHERE (c.env_json <> '{}' OR c.native_auth_json <> '{}')
		  AND r.provider = ?
		ORDER BY c.account_ref
	`, normalized)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "no such table") {
			return nil, nil
		}
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	refs := make([]string, 0, 16)
	for rows.Next() {
		var ref string
		if err := rows.Scan(&ref); err != nil {
			return nil, err
		}
		ref = strings.TrimSpace(ref)
		if !accountRefPattern.MatchString(ref) {
			continue
		}
		refs = append(refs, ref)
	}
	if err := rows.Err(); err != nil && !strings.Contains(strings.ToLower(err.Error()), "no such table") {
		return nil, err
	}
	return refs, nil
}

var _ AccountLister = (*CredentialAccountLister)(nil)

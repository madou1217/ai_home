package aihaccount

import (
	"context"
	"errors"
	"fmt"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

const (
	// DefaultListLimit 是账号 CLI 的默认可见行数，与 Management API 保持一致。
	DefaultListLimit = accountapp.DefaultOverviewLimit
	// MaxListLimit 为多取一行判断下一页保留容量，防止突破应用层查询上限。
	MaxListLimit = accountapp.MaxOverviewLimit - 1
)

// ErrInvalidListRequest 表示账号列表游标或页大小无效。
var ErrInvalidListRequest = errors.New("AIH 账号列表请求无效")

// ListOptions 是账号列表使用的稳定 keyset 分页输入。
type ListOptions struct {
	// AfterRef 是上一页最后一个 AccountRef；空值表示第一页。
	AfterRef string
	// Limit 是可见行数；零值使用 DefaultListLimit。
	Limit int
}

// ListResult 是一页账号及其稳定下一页游标。
type ListResult struct {
	Accounts     []AccountView
	Limit        int
	HasMore      bool
	NextAfterRef string
}

// ListAccounts 使用稳定 AccountRef 游标读取一页公开账号信息。
//
// 查询只选择基础账号、凭据类型和公开资料标量，不读取 credential_json、模型、
// usage 或运行态。多取一行只用于判断 has_more，内存始终受 Limit 上限约束。
func (app *App) ListAccounts(
	ctx context.Context,
	options ListOptions,
) (ListResult, error) {
	if app == nil || ctx == nil {
		return ListResult{}, ErrInvalidListRequest
	}
	if err := ctx.Err(); err != nil {
		return ListResult{}, err
	}
	limit := options.Limit
	if limit == 0 {
		limit = DefaultListLimit
	}
	if limit < 1 || limit > MaxListLimit {
		return ListResult{}, ErrInvalidListRequest
	}
	afterRef := accountcore.AccountRef("")
	var err error
	if options.AfterRef != "" {
		afterRef, err = accountcore.ParseAccountRef(options.AfterRef)
		if err != nil {
			return ListResult{}, ErrInvalidListRequest
		}
	}
	query, err := accountapp.NewOverviewQuery(afterRef, limit+1)
	if err != nil {
		return ListResult{}, ErrInvalidListRequest
	}
	overviews, err := app.accounts.ListAccountOverviews(ctx, query)
	if err != nil {
		return ListResult{}, fmt.Errorf("读取账号列表失败: %w", err)
	}
	hasMore := len(overviews) > limit
	if hasMore {
		overviews = overviews[:limit]
	}
	items := make([]AccountView, 0, len(overviews))
	for _, overview := range overviews {
		items = append(items, newAccountView(overview))
	}
	nextAfterRef := ""
	if hasMore && len(items) > 0 {
		nextAfterRef = items[len(items)-1].AccountRef
	}
	return ListResult{
		Accounts:     items,
		Limit:        limit,
		HasMore:      hasMore,
		NextAfterRef: nextAfterRef,
	}, nil
}

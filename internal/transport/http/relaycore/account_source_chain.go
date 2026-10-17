package relaycore

import (
	"context"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// AccountSourceChain 把多个账号来源串成**一个**来源，按顺序依次询问。
//
// 为什么需要它：同一入口上挂多个透传 Provider（家族四支 + cline）时，一个模型可能
// 由其中任意一个的账号承载。Handler 只接受一个 AccountSource，所以需要这一层把
// 「问哪个池」收敛起来——先问第一个来源，它的候选耗尽后再问下一个。
//
// 与 ProviderChain 的分工：ProviderChain 决定「这个账号该用谁的差异面」，
// AccountSourceChain 决定「去哪几个池里找账号」。两者配合，Handler 才能在一次
// 尝试循环里同时服务多个 Provider。
type AccountSourceChain struct {
	sources []AccountSource
}

// NewAccountSourceChain 组合若干账号来源；顺序即尝试顺序。
func NewAccountSourceChain(sources ...AccountSource) *AccountSourceChain {
	filtered := make([]AccountSource, 0, len(sources))
	for _, source := range sources {
		if source != nil {
			filtered = append(filtered, source)
		}
	}
	return &AccountSourceChain{sources: filtered}
}

var _ AccountSource = (*AccountSourceChain)(nil)

// Accounts 为每个来源各取一个游标，串成链式游标。
//
// 单个来源返回错误时不整体失败：跳过它并继续问下一个——一个 Provider 的目录问题
// 不该让另一个 Provider 的请求也拿不到账号。
func (chain *AccountSourceChain) Accounts(
	ctx context.Context,
	modelID runtimecore.ModelID,
) (AccountCursor, error) {
	if chain == nil {
		return &exhaustedAccountCursor{}, nil
	}
	cursors := make([]AccountCursor, 0, len(chain.sources))
	for _, source := range chain.sources {
		cursor, err := source.Accounts(ctx, modelID)
		if err != nil || cursor == nil {
			continue
		}
		cursors = append(cursors, cursor)
	}
	return &accountSourceChainCursor{cursors: cursors}, nil
}

// accountSourceChainCursor 依次耗尽每个来源的游标。
type accountSourceChainCursor struct {
	cursors []AccountCursor
	index   int
}

func (cursor *accountSourceChainCursor) Next(
	ctx context.Context,
) (accountcore.AccountRef, bool, error) {
	if cursor == nil {
		return "", false, nil
	}
	for cursor.index < len(cursor.cursors) {
		accountRef, found, err := cursor.cursors[cursor.index].Next(ctx)
		if err != nil {
			return "", false, err
		}
		if found {
			return accountRef, true, nil
		}
		cursor.index++
	}
	return "", false, nil
}

// exhaustedAccountCursor 是空来源链的游标。
type exhaustedAccountCursor struct{}

func (*exhaustedAccountCursor) Next(context.Context) (accountcore.AccountRef, bool, error) {
	return "", false, nil
}

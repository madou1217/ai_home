package accounts

import (
	"context"
	"errors"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// ErrInvalidManagementDependencies 表示账号管理用例没有完整的查询、写入或时钟依赖。
var ErrInvalidManagementDependencies = errors.New("账号管理依赖无效")

// AccountLifecycleStore 是账号管理命令需要的最小生命周期写入端口。
type AccountLifecycleStore interface {
	SetEnabled(
		ctx context.Context,
		accountRef accountcore.AccountRef,
		enabled bool,
		changedAt time.Time,
	) (accountcore.Account, error)
}

// Clock 返回账号生命周期命令使用的业务时间。
type Clock func() time.Time

// Management 编排账号管理查询和生命周期命令。
//
// 注册、凭据刷新、删除和导入导出属于独立用例，不应继续增加到该类型。
type Management struct {
	overviews AccountOverviewStore
	lifecycle AccountLifecycleStore
	clock     Clock
}

// NewManagement 使用细粒度端口创建账号管理用例。
func NewManagement(
	overviews AccountOverviewStore,
	lifecycle AccountLifecycleStore,
	clock Clock,
) (*Management, error) {
	if overviews == nil || lifecycle == nil || clock == nil {
		return nil, ErrInvalidManagementDependencies
	}
	return &Management{
		overviews: overviews,
		lifecycle: lifecycle,
		clock:     clock,
	}, nil
}

// ListAccountOverviews 返回稳定游标分页的无敏感数据账号列表。
func (management *Management) ListAccountOverviews(
	ctx context.Context,
	query OverviewQuery,
) ([]AccountOverview, error) {
	if !query.IsValid() {
		return nil, ErrInvalidOverview
	}
	return management.overviews.ListAccountOverviews(ctx, query)
}

// GetAccountOverview 按稳定账号身份返回单个无敏感数据管理投影。
func (management *Management) GetAccountOverview(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) (AccountOverview, error) {
	if !accountRef.IsValid() {
		return AccountOverview{}, accountcore.ErrInvalidAccountRef
	}
	return management.overviews.GetAccountOverview(ctx, accountRef)
}

// GetAccountOverviewByCLIAccountID 按 Provider 内数字别名返回无敏感管理投影。
func (management *Management) GetAccountOverviewByCLIAccountID(
	ctx context.Context,
	providerID string,
	cliAccountID accountcore.CLIAccountID,
) (AccountOverview, error) {
	if providerID == "" || !cliAccountID.IsValid() {
		return AccountOverview{}, ErrInvalidOverview
	}
	overview, err := management.overviews.GetAccountOverviewByCLIAccountID(
		ctx,
		providerID,
		cliAccountID,
	)
	if err != nil {
		return AccountOverview{}, err
	}
	account := overview.Account()
	if !account.IsValid() ||
		account.ProviderID() != providerID ||
		account.CLIAccountID() != cliAccountID {
		return AccountOverview{}, ErrInvalidOverview
	}
	return overview, nil
}

// SetAccountEnabled 使用应用时钟原子更新用户启停状态。
func (management *Management) SetAccountEnabled(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	enabled bool,
) (accountcore.Account, error) {
	if !accountRef.IsValid() {
		return accountcore.Account{}, accountcore.ErrInvalidAccountRef
	}
	return management.lifecycle.SetEnabled(
		ctx,
		accountRef,
		enabled,
		management.clock(),
	)
}

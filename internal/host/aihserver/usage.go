package aihserver

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	usageapp "github.com/madou1217/ai_home/application/accountusage"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	claudeusage "github.com/madou1217/ai_home/internal/adapters/claude/usage"
	codexusage "github.com/madou1217/ai_home/internal/adapters/codex/usage"
)

const (
	usageHTTPTimeout         = 10 * time.Second
	usageRefreshTimeout      = 12 * time.Second
	usageRefreshInterval     = 5 * time.Minute
	usageRefreshStagger      = 30 * time.Second
	usageRefreshBaseBackoff  = 5 * time.Second
	usageRefreshMaxBackoff   = 5 * time.Minute
	usageProviderConcurrency = 1
)

// usageComposition 保存账号额度服务和后台协调器生命周期。
type usageComposition struct {
	service     *usageapp.Service
	coordinator *usageapp.Coordinator
}

// usageCompositionDependencies 集中声明额度子系统的窄端口。
type usageCompositionDependencies struct {
	catalog     *providers.Catalog
	store       *sqliteaccount.Store
	credentials *accountcredentials.Resolver
	models      accountapp.AccountModelStore
	runtime     usageapp.RuntimeProjection
	httpClient  UsageHTTPClient
	clock       usageapp.Clock
}

// newUsageComposition 创建双 Provider Strategy、服务和周期刷新协调器。
func newUsageComposition(
	ctx context.Context,
	dependencies usageCompositionDependencies,
) (_ *usageComposition, resultErr error) {
	if ctx == nil ||
		dependencies.catalog == nil ||
		dependencies.store == nil ||
		dependencies.credentials == nil ||
		dependencies.models == nil ||
		dependencies.runtime == nil ||
		dependencies.clock == nil {
		return nil, usageapp.ErrInvalidDependencies
	}
	client := dependencies.httpClient
	if client == nil {
		client = &http.Client{
			Timeout:       usageHTTPTimeout,
			CheckRedirect: rejectOAuthRedirect,
		}
	}
	codexStrategy, err := codexusage.New(client)
	if err != nil {
		return nil, err
	}
	claudeStrategy, err := claudeusage.New(client)
	if err != nil {
		return nil, err
	}
	service, err := usageapp.NewService(usageapp.Dependencies{
		Catalog:     dependencies.catalog,
		Store:       dependencies.store,
		Credentials: dependencies.credentials,
		Models:      dependencies.models,
		Runtime:     dependencies.runtime,
		Strategies: []usageapp.ProviderStrategy{
			codexStrategy,
			claudeStrategy,
		},
		Clock: dependencies.clock,
	})
	if err != nil {
		return nil, err
	}
	coordinator, err := usageapp.NewCoordinator(usageapp.CoordinatorOptions{
		Catalog:   dependencies.catalog,
		Refresher: service,
		ProviderConcurrency: map[string]int{
			"codex":  usageProviderConcurrency,
			"claude": usageProviderConcurrency,
		},
		RefreshTimeout:  usageRefreshTimeout,
		RefreshInterval: usageRefreshInterval,
		StaggerWindow:   usageRefreshStagger,
		BaseBackoff:     usageRefreshBaseBackoff,
		MaxBackoff:      usageRefreshMaxBackoff,
		Clock:           dependencies.clock,
	})
	if err != nil {
		return nil, err
	}
	composition := &usageComposition{
		service:     service,
		coordinator: coordinator,
	}
	defer func() {
		if resultErr != nil {
			_ = composition.Close()
		}
	}()
	if err := seedUsageRefreshes(
		ctx,
		dependencies.store,
		service,
		coordinator,
	); err != nil {
		return nil, err
	}
	return composition, nil
}

// Close 停止额度调度和 Provider worker。
func (composition *usageComposition) Close() error {
	if composition == nil || composition.coordinator == nil {
		return nil
	}
	err := composition.coordinator.Close()
	composition.coordinator = nil
	return err
}

// ForgetAccount 同时取消额度刷新执行和周期调度中的旧账号代次。
func (composition *usageComposition) ForgetAccount(
	accountRef accountcore.AccountRef,
) {
	if composition == nil || !accountRef.IsValid() {
		return
	}
	if composition.service != nil {
		composition.service.ForgetAccount(accountRef)
	}
	if composition.coordinator != nil {
		composition.coordinator.ForgetAccount(accountRef)
	}
}

// seedUsageRefreshes 使用稳定 keyset 分页为已有凭据账号安排错峰刷新。
func seedUsageRefreshes(
	ctx context.Context,
	overviews accountapp.AccountOverviewStore,
	service *usageapp.Service,
	coordinator *usageapp.Coordinator,
) error {
	var afterRef accountcore.AccountRef
	for {
		query, err := accountapp.NewOverviewQuery(
			afterRef,
			accountapp.MaxOverviewLimit,
		)
		if err != nil {
			return err
		}
		accounts, err := overviews.ListAccountOverviews(ctx, query)
		if err != nil {
			return err
		}
		for _, overview := range accounts {
			if !overview.HasCredential() {
				continue
			}
			account := overview.Account()
			if err := service.RestoreUsageProjection(
				ctx,
				account.Ref(),
			); err != nil && !errors.Is(err, usageapp.ErrSnapshotNotFound) {
				return err
			}
			if err := coordinator.ScheduleInitialUsageRefresh(
				ctx,
				account.Ref(),
				account.ProviderID(),
			); err != nil {
				return err
			}
		}
		if len(accounts) < accountapp.MaxOverviewLimit {
			return nil
		}
		afterRef = accounts[len(accounts)-1].Account().Ref()
	}
}

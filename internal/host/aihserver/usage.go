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
	"github.com/madou1217/ai_home/internal/adapters/accounts/kirocred"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/adapters/clientversion"
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

// credentialSnapshotStore 是额度探测与模型发现共用的当前凭据读取端口。
type credentialSnapshotStore interface {
	GetCredentialSnapshot(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) (accountapp.CredentialSnapshot, error)
}

// credentialSnapshots 先完成必要 OAuth 刷新，再读取与 SQLite CAS 对齐的
// 当前凭据快照；额度与模型发现共用同一条刷新/代际链路，不各自维护刷新器。
type credentialSnapshots struct {
	resolver *accountcredentials.Resolver
	store    credentialSnapshotStore
}

// ResolveCredentialSnapshot 返回刷新完成后当前数据库中的凭据代次。
func (snapshots credentialSnapshots) ResolveCredentialSnapshot(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) (accountapp.CredentialSnapshot, error) {
	if _, err := snapshots.resolver.ResolveCredential(ctx, accountRef); err != nil {
		return accountapp.CredentialSnapshot{}, err
	}
	return snapshots.store.GetCredentialSnapshot(ctx, accountRef)
}

// RefreshCredential 在模型发现使用凭据前复用同一个解析器完成到期刷新。
//
// 模型发现原先只接了 kiro 专用刷新器；agy 这类 access token 只有 1h 的 Provider
// 会在 token 过期后仍拿库里的旧值直接探测，上游固定返回 401。这里改用与额度、
// 推理相同的刷新策略：到期判断、并发合并与 CAS 写回都由 resolver 负责。
// 未登记刷新策略的 Provider（例如 opencode 的静态凭据）保持原快照继续发现。
func (snapshots credentialSnapshots) RefreshCredential(
	ctx context.Context,
	snapshot accountapp.CredentialSnapshot,
) (accountapp.CredentialSnapshot, error) {
	if snapshots.resolver == nil || snapshots.store == nil {
		return accountapp.CredentialSnapshot{}, usageapp.ErrInvalidDependencies
	}
	if !snapshot.IsValid() {
		return accountapp.CredentialSnapshot{}, accountapp.ErrInvalidCredentialSnapshot
	}
	resolved, err := snapshots.resolver.Resolve(ctx, snapshot.AccountRef())
	if err != nil {
		if errors.Is(err, accountcredentials.ErrRefreshStrategyNotFound) {
			return snapshot, nil
		}
		return accountapp.CredentialSnapshot{}, err
	}
	// 刷新可能触发账号 re-key（身份变化），必须按解析结果的新引用读回快照；
	// 继续用入参的旧引用会 ErrCredentialNotFound，看起来像刷新失败。
	return snapshots.store.GetCredentialSnapshot(ctx, resolved.Binding().AccountRef())
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
	// codexVersions 提供模拟 Codex 客户端时自报的版本；为空时使用编译期最低版本。
	codexVersions clientversion.Source
	// aiHomeDir 是账号级出口绑定（app-state.db / 池运行文件）的数据根。
	aiHomeDir string
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
	strategies, providerConcurrency, err := buildUsageProviderStrategies(usageProviderContext{
		client:        client,
		codexVersions: dependencies.codexVersions,
		store:         dependencies.store,
		clock:         dependencies.clock,
		aiHomeDir:     dependencies.aiHomeDir,
	})
	if err != nil {
		return nil, err
	}
	kiroRefresher, err := kirocred.New(dependencies.store, client, dependencies.clock)
	if err != nil {
		return nil, err
	}
	service, err := usageapp.NewService(usageapp.Dependencies{
		Catalog:   dependencies.catalog,
		Store:     dependencies.store,
		Documents: dependencies.store,
		Credentials: credentialSnapshots{
			resolver: dependencies.credentials,
			store:    dependencies.store,
		},
		Models:     dependencies.models,
		Runtime:    dependencies.runtime,
		Strategies: strategies,
		Refresher:  kiroRefresher,
		Clock:      dependencies.clock,
	})
	if err != nil {
		return nil, err
	}
	coordinator, err := usageapp.NewCoordinator(usageapp.CoordinatorOptions{
		Catalog:             dependencies.catalog,
		Refresher:           service,
		ProviderConcurrency: providerConcurrency,
		RefreshTimeout:      usageRefreshTimeout,
		RefreshInterval:     usageRefreshInterval,
		StaggerWindow:       usageRefreshStagger,
		BaseBackoff:         usageRefreshBaseBackoff,
		MaxBackoff:          usageRefreshMaxBackoff,
		Clock:               dependencies.clock,
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

// ScheduleUsageRefresh 把生命周期信号转交给周期协调器。
func (composition *usageComposition) ScheduleUsageRefresh(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	providerID string,
) error {
	if composition == nil || composition.coordinator == nil {
		return usageapp.ErrInvalidSchedule
	}
	return composition.coordinator.ScheduleUsageRefresh(
		ctx,
		accountRef,
		providerID,
	)
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
			if !service.SupportsProvider(account.ProviderID()) {
				continue
			}
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

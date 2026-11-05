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
	agyusage "github.com/madou1217/ai_home/internal/adapters/agy/usage"
	claudeusage "github.com/madou1217/ai_home/internal/adapters/claude/usage"
	"github.com/madou1217/ai_home/internal/adapters/clientversion"
	clineusage "github.com/madou1217/ai_home/internal/adapters/cline/usage"
	codebuddyfamilyusage "github.com/madou1217/ai_home/internal/adapters/codebuddyfamily/usage"
	"github.com/madou1217/ai_home/internal/adapters/codex/codexidentity"
	codexusage "github.com/madou1217/ai_home/internal/adapters/codex/usage"
	kirousage "github.com/madou1217/ai_home/internal/adapters/kiro/usage"
	qoderusage "github.com/madou1217/ai_home/internal/adapters/qoder/usage"
	zcodeusage "github.com/madou1217/ai_home/internal/adapters/zcode/usage"
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

// usageCredentialSnapshots 先完成必要 OAuth 刷新，再读取与 SQLite CAS 对齐的
// 当前凭据快照；额度应用层无需依赖具体凭据解析器或数据库实现。
type usageCredentialSnapshots struct {
	resolver *accountcredentials.Resolver
	store    *sqliteaccount.Store
}

// ResolveCredentialSnapshot 返回刷新完成后当前数据库中的凭据代次。
func (snapshots usageCredentialSnapshots) ResolveCredentialSnapshot(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) (accountapp.CredentialSnapshot, error) {
	if _, err := snapshots.resolver.ResolveCredential(ctx, accountRef); err != nil {
		return accountapp.CredentialSnapshot{}, err
	}
	return snapshots.store.GetCredentialSnapshot(ctx, accountRef)
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
	var codexVersions clientversion.Source = clientversion.Static(codexidentity.Floor)
	if dependencies.codexVersions != nil {
		codexVersions = dependencies.codexVersions
	}
	codexStrategy, err := codexusage.NewWithClientVersion(client, codexVersions)
	if err != nil {
		return nil, err
	}
	claudeStrategy, err := claudeusage.New(client)
	if err != nil {
		return nil, err
	}
	// kiro 的额度是 GetUsageLimits 的 CREDIT 资源；过期 token 由 kirocred 先刷新。
	kiroStrategy, err := kirousage.New(client)
	if err != nil {
		return nil, err
	}
	// agy 的额度按模型计；凭据刷新由 credential resolver 的 agy 策略完成。
	agyStrategy, err := agyusage.New(client)
	if err != nil {
		return nil, err
	}
	// zcode 的额度是 plan 余额（与模型目录同一 balance 接口）。
	zcodeStrategy, err := zcodeusage.New(client)
	if err != nil {
		return nil, err
	}
	// cline 的额度来自 plan + usage-limits 两个端点。
	clineStrategy, err := clineusage.New(client)
	if err != nil {
		return nil, err
	}
	// Qoder 家族两个区域共用同一账号面协议；凭据是 CLI 的 opaque blob 时由
	// qodercred 用厂商 wasm 解密出 token（Node 侧同为 cli_wasm 来源）。
	qoderStrategies := make([]usageapp.ProviderStrategy, 0, 2)
	for _, providerID := range []string{"qoder", "qodercn"} {
		strategy, strategyErr := qoderusage.New(client, providerID)
		if strategyErr != nil {
			return nil, strategyErr
		}
		qoderStrategies = append(qoderStrategies, strategy)
	}
	// CodeBuddy 家族四支共用同一账单协议，按 Provider 各注册一条策略。
	familyStrategies := make([]usageapp.ProviderStrategy, 0, 4)
	for _, providerID := range []string{"codebuddy", "codebuddycn", "workbuddy", "workbuddycn"} {
		strategy, strategyErr := codebuddyfamilyusage.New(client, providerID)
		if strategyErr != nil {
			return nil, strategyErr
		}
		familyStrategies = append(familyStrategies, strategy)
	}
	kiroRefresher, err := kirocred.New(dependencies.store, client, dependencies.clock)
	if err != nil {
		return nil, err
	}
	service, err := usageapp.NewService(usageapp.Dependencies{
		Catalog:   dependencies.catalog,
		Store:     dependencies.store,
		Documents: dependencies.store,
		Credentials: usageCredentialSnapshots{
			resolver: dependencies.credentials,
			store:    dependencies.store,
		},
		Models:  dependencies.models,
		Runtime: dependencies.runtime,
		Strategies: append(append([]usageapp.ProviderStrategy{
			codexStrategy,
			claudeStrategy,
			kiroStrategy,
			agyStrategy,
			zcodeStrategy,
			clineStrategy,
		}, qoderStrategies...), familyStrategies...),
		Refresher: kiroRefresher,
		Clock:     dependencies.clock,
	})
	if err != nil {
		return nil, err
	}
	coordinator, err := usageapp.NewCoordinator(usageapp.CoordinatorOptions{
		Catalog:   dependencies.catalog,
		Refresher: service,
		ProviderConcurrency: map[string]int{
			"codex":       usageProviderConcurrency,
			"claude":      usageProviderConcurrency,
			"kiro":        usageProviderConcurrency,
			"agy":         usageProviderConcurrency,
			"zcode":       usageProviderConcurrency,
			"codebuddy":   usageProviderConcurrency,
			"codebuddycn": usageProviderConcurrency,
			"workbuddy":   usageProviderConcurrency,
			"workbuddycn": usageProviderConcurrency,
			"cline":       usageProviderConcurrency,
			"qoder":       usageProviderConcurrency,
			"qodercn":     usageProviderConcurrency,
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

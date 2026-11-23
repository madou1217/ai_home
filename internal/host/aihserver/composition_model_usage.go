package aihserver

import (
	"context"
	"crypto/rand"
	"fmt"
	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	usageapp "github.com/madou1217/ai_home/application/accountusage"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accountruntime/accountrecovery"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/adapters/clientversion"
	"github.com/madou1217/ai_home/internal/runtime/tokenrefreshdaemon"
	"log"
	"time"
)

// modelUsageRuntime 是模型管理、额度服务与凭据轮换的装配结果。
//
// 从 newHandlers 拆出：模型刷新、额度协调与轮换装饰器是一组相互依赖但
// 与 HTTP/路由无关的流水线，集中在一个文件后调整刷新策略不再修改主装配。
type modelUsageRuntime struct {
	recoveringReauthenticator        *accountrecovery.Reauthenticator
	recoveringModelManagement        *accountrecovery.ModelManagement
	modelRefresh                     *accountapp.ModelRefreshCoordinator
	management                       *accountapp.Management
	usage                            *usageComposition
	credentialRotator                *accountapp.StaticCredentialRotator
	modelRefreshingCredentialRotator *accountapp.StaticCredentialRotationModelRefreshDecorator
}

func newModelUsageRuntime(
	ctx context.Context,
	aiHomeDir string,
	catalog *providers.Catalog,
	store *sqliteaccount.Store,
	modelDiscovery *accountapp.ModelDiscovery,
	credentials *accountcredentials.Resolver,
	accountRuntime serverAccountRuntime,
	errorLog *log.Logger,
	usageClient UsageHTTPClient,
	egressClients *accountEgressClients,
	codexVersions *clientversion.Resolver,
	claudeVersions *clientversion.Resolver,
	reauthenticator accountapp.ReauthenticationService,
) (*modelUsageRuntime, error) {
	// 模型发现与额度/推理共用同一个 credential resolver：探测前先按到期窗口刷新
	// OAuth 并 CAS 落库。模型路径原先只接了 kiro 专用刷新器，agy 的 1h access token
	// 过期后仍会拿旧值打 loadCodeAssist，上游固定 401。
	modelCredentialRefresher := credentialSnapshots{
		resolver: credentials,
		store:    store,
	}
	modelManagement, err := accountapp.NewModelManagement(
		store,
		store,
		modelDiscovery,
		modelCredentialRefresher,
		// 探测事实与目录快照落在同一 aih.db，WebUI 批量读一次 JOIN 取齐。
		store,
		time.Now,
	)
	if err != nil {
		return nil, fmt.Errorf("创建账号模型管理用例失败: %w", err)
	}
	// 网关账号（自定义 base_url）的模型列表动态并入本地可路由目录，新模型不必
	// 等代理升级或 6 小时重扫才出现在目录里。
	modelManagement.SetRoutableModelSource(store)
	recoveringReauthenticator, err :=
		accountrecovery.NewReauthenticator(
			reauthenticator,
			accountRuntime,
		)
	if err != nil {
		return nil, fmt.Errorf(
			"创建账号重新认证恢复边界失败: %w",
			err,
		)
	}
	recoveringModelManagement, err :=
		accountrecovery.NewModelManagement(
			modelManagement,
			accountRuntime,
		)
	if err != nil {
		return nil, fmt.Errorf(
			"创建账号模型恢复边界失败: %w",
			err,
		)
	}
	modelRefresh, err := accountapp.NewModelRefreshCoordinator(
		accountapp.ModelRefreshCoordinatorOptions{
			Catalog:             catalog,
			Refresher:           recoveringModelManagement,
			ProviderConcurrency: modelRefreshProviderConcurrency(modelDiscovery.ProviderIDs()),
			PluginProviders:     modelDiscovery.PluginProviderIDs,
			RefreshTimeout:      modelRefreshTimeout,
			BaseBackoff:         modelRefreshBaseBackoff,
			MaxBackoff:          modelRefreshMaxBackoff,
			MaxAttempts:         modelRefreshMaxAttempts,
			Clock:               time.Now,
			Random:              rand.Reader,
			Observer: newModelRefreshObserver(errorLog, func(accountRef accountcore.AccountRef, _ error) bool {
				markCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				marked, markErr := tokenrefreshdaemon.MarkAccountAuthInvalid(
					markCtx,
					store,
					accountRuntime,
					accountRef,
					"模型目录认证被拒绝，请重新授权",
					time.Now(),
				)
				if markErr != nil {
					if errorLog != nil {
						errorLog.Printf("标记账号重新授权失败: account=%s err=%v", accountRef, markErr)
					}
					// 标记失败时仍记录本轮拒绝，避免静默。
					return true
				}
				return marked
			}),
		},
	)
	if err != nil {
		return nil, fmt.Errorf("创建账号模型异步刷新协调器失败: %w", err)
	}
	// 启用即刷新复用同一个协调器：账号从停用切到启用时投递一次，合并与重试
	// 仍由 Provider 队列负责；投递失败只记录，不回滚启停。
	management, err := accountapp.NewManagement(
		store,
		store,
		store,
		store,
		store,
		time.Now,
		accountapp.ManagementOptions{
			ModelRefresh: modelRefresh,
			ModelRefreshObserver: func(
				accountRef accountcore.AccountRef,
				providerID string,
				err error,
			) {
				errorLog.Printf(
					"账号启用后投递模型刷新失败 account=%s provider=%s: %v",
					accountRef,
					providerID,
					err,
				)
			},
		},
	)
	if err != nil {
		return nil, fmt.Errorf("创建账号管理用例失败: %w", err)
	}
	usage, err := newUsageComposition(
		ctx,
		usageCompositionDependencies{
			catalog:        catalog,
			store:          store,
			credentials:    credentials,
			models:         store,
			runtime:        accountRuntime,
			httpClient:     newEgressContextClient(usageClient, egressClients),
			egress:         managerAccountEgress{clients: egressClients},
			clock:          time.Now,
			codexVersions:  codexVersions,
			claudeVersions: claudeVersions,
			aiHomeDir:      aiHomeDir,
		},
	)
	if err != nil {
		return nil, fmt.Errorf("创建账号额度组合失败: %w", err)
	}
	// 额度耗尽类失败要立即刷新额度（快照才是额度真相），运行态装饰器在这里接上刷新入口。
	if binder, ok := accountRuntime.(interface {
		bindUsageRefresh(usageRefreshScheduler)
	}); ok {
		binder.bindUsageRefresh(usage.ScheduleUsageRefresh)
	}
	credentialRotator, err := accountapp.NewStaticCredentialRotator(
		catalog,
		store,
		time.Now,
		accountRuntime,
	)
	if err != nil {
		return nil, fmt.Errorf("创建静态账号凭据轮换用例失败: %w", err)
	}
	usageRefreshingCredentialRotator, err :=
		usageapp.NewStaticCredentialRotationDecorator(
			credentialRotator,
			usage,
		)
	if err != nil {
		return nil, fmt.Errorf("创建凭据轮换额度刷新边界失败: %w", err)
	}
	modelRefreshingCredentialRotator, err :=
		accountapp.NewStaticCredentialRotationModelRefreshDecorator(
			usageRefreshingCredentialRotator,
			modelRefresh,
		)
	if err != nil {
		return nil, fmt.Errorf("创建凭据轮换模型刷新边界失败: %w", err)
	}
	return &modelUsageRuntime{
		recoveringReauthenticator:        recoveringReauthenticator,
		recoveringModelManagement:        recoveringModelManagement,
		modelRefresh:                     modelRefresh,
		management:                       management,
		usage:                            usage,
		credentialRotator:                credentialRotator,
		modelRefreshingCredentialRotator: modelRefreshingCredentialRotator,
	}, nil
}

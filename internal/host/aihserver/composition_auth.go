package aihserver

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/madou1217/ai_home/application/accountauth"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/agyoauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/kirooauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/opencodeoauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/zcodeoauth"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/host/backupaccounts"
	"github.com/madou1217/ai_home/internal/runtime/accountbrowser"
	"github.com/madou1217/ai_home/internal/transport/http/accountauthapi"
	"github.com/madou1217/ai_home/internal/transport/http/accountsapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountaddapi"
)

// accountAuthInputs 是账号管理与账号登录装配的稳定依赖。
//
// 账号 handler 的端口类型直接复用 accountsapi 的声明；OAuth 登录作业单独一组，
// 避免调用方同时关心两套接口的差异。
type accountAuthInputs struct {
	ctx       context.Context
	aiHomeDir string
	catalog   *providers.Catalog
	store     *sqliteaccount.Store

	// 账号管理 handler
	management         accountsapi.Management
	models             accountsapi.ModelManagement
	usage              accountsapi.UsageManagement
	quotaStats         accountsapi.QuotaStatsManagement
	deletion           accountsapi.AccountDeletion
	defaults           accountsapi.ProviderDefaultManagement
	selections         accountsapi.LaunchAccountSelection
	credentialRotation accountsapi.StaticCredentialRotation
	registrar          accountsapi.Registrar
	importer           accountsapi.Importer
	staticCredentials  accountsapi.StaticCredentialFactory
	nativeAccounts     accountsapi.NativeAccountDecoder
	runtimeStates      accountsapi.RuntimeStateApplier
	authorizer         accountsapi.Authorizer

	// OAuth 登录作业
	oauthClient    *http.Client
	codexProvider  accountauth.OAuthProvider
	claudeProvider accountauth.OAuthProvider
	decoder        accountsapi.NativeAccountDecoder
	jobRegistrar   accountauth.Registrar
	reauth         accountauth.Reauthenticator
	tokenEvents    *tokenEventBus
	loginEgress    accountauth.LoginEgress
}

// accountAuthRuntime 是账号管理与登录作业的装配结果。
type accountAuthRuntime struct {
	accountsHandler *accountsapi.Handler
	jobs            *accountauth.Service
	httpHandler     *accountauthapi.Handler
}

// newAccountAuthRuntime 装配账号管理 handler、OAuth 登录策略与作业服务。
//
// 从 newHandlers 拆出：账号 CRUD 与登录作业共用同一份 store、注册器与鉴权，
// 集中在 composition_auth.go 后新增登录 Provider 只改这一个文件。
func newAccountAuthRuntime(inputs accountAuthInputs) (*accountAuthRuntime, error) {
	accountsHandler, err := accountsapi.NewHandler(accountsapi.Dependencies{
		BackupAccounts: backupaccounts.Handler(inputs.store, inputs.catalog),
		Management:     inputs.management,
		Models:         inputs.models,
		Usage:          inputs.usage,
		QuotaStats:     inputs.quotaStats,
		// 账号行的 token 用量直接读 Go 账本：与用量页同一份事实，不再回 Node 现算。
		TokenUsage:          inputs.store,
		Deletion:            inputs.deletion,
		Defaults:            inputs.defaults,
		Selections:          inputs.selections,
		CredentialRotation:  inputs.credentialRotation,
		Registrar:           inputs.registrar,
		Importer:            inputs.importer,
		StaticCredentials:   inputs.staticCredentials,
		NativeAccounts:      inputs.nativeAccounts,
		CredentialSnapshots: inputs.store,
		// 批量模型关系：WebUI 模型缓存读 Go 的入口（一次 JOIN，不做 N 次请求）。
		AccountModels: inputs.store,
		// 运行态写入后立即投影到征召资格索引。
		RuntimeStates: inputs.runtimeStates,
		// 探针由 Node 执行后推送，Go 只落库并在账号视图里回读。
		ProbeStates: accountProbeStateStore{store: inputs.store},
		// 自定义上游账号由 Node 标记排除：Go 拿到结论后直接从候选与目录里滤掉。
		RoutingExclusions: inputs.store,
		Authorizer:        inputs.authorizer,
	})
	if err != nil {
		return nil, fmt.Errorf("创建账号 HTTP Handler 失败: %w", err)
	}
	// codex/claude 浏览器登录、zcode（自定义协议）、opencode（设备码）与 agy
	// （Google 直连）的登录都已迁 Go；Node 侧策略文件删除后仍由同一个 Job 框架
	// 提供 Begin/Complete 与终态落库。
	agyLogin, err := agyoauth.NewLogin(inputs.oauthClient, time.Now)
	if err != nil {
		return nil, fmt.Errorf("创建 agy 登录策略失败: %w", err)
	}
	zcodeOAuth, err := zcodeoauth.New(inputs.oauthClient)
	if err != nil {
		return nil, fmt.Errorf("创建 zcode 登录策略失败: %w", err)
	}
	opencodeOAuth, err := opencodeoauth.New(inputs.oauthClient, time.Now)
	if err != nil {
		return nil, fmt.Errorf("创建 opencode 登录策略失败: %w", err)
	}
	// kiro 的 Builder ID 设备码登录同样固定走 Go：Node 只展示 user_code 与验证地址。
	kiroLogin, err := kirooauth.NewLogin(inputs.oauthClient, time.Now)
	if err != nil {
		return nil, fmt.Errorf("创建 kiro 登录策略失败: %w", err)
	}
	jobs, err := accountauth.NewService(accountauth.Dependencies{
		Providers: []accountauth.OAuthProvider{
			inputs.codexProvider,
			inputs.claudeProvider,
			zcodeOAuth,
			opencodeOAuth,
			agyLogin,
			kiroLogin,
		},
		Decoder:     inputs.decoder,
		Registrar:   inputs.jobRegistrar,
		Reauth:      inputs.reauth,
		Clock:       time.Now,
		GenerateID:  accountauth.NewRandomJobID,
		LoginEgress: inputs.loginEgress,
		// 公开快照落 aih.db：重启后仍能查询 Job 状态；未完成 Job 由 Rehydrate 标成 expired
		// （state/PKCE 只在内存，重启后无法继续，冒充 pending 会让前端一直等）。
		JobStore:  inputs.store,
		AliasPool: newAccountAliasPoolWriter(inputs.aiHomeDir),
		ProfileBinder: func(ctx context.Context, providerID, accountRef, jobID string) error {
			return accountbrowser.BindJobProfile(inputs.aiHomeDir, providerID, accountRef, jobID)
		},
		OnJobSnapshot: func(job accountauth.Job) {
			inputs.tokenEvents.PublishAuthJob(webuiaccountaddapi.NewJobView(job))
		},
	})
	if err != nil {
		return nil, fmt.Errorf("创建 OAuth Job 服务失败: %w", err)
	}
	if err := jobs.Rehydrate(inputs.ctx); err != nil {
		return nil, fmt.Errorf("恢复 OAuth Job 快照失败: %w", err)
	}
	accountAuthHandler, err := accountauthapi.NewHandler(
		accountauthapi.Dependencies{
			Jobs:       jobs,
			Authorizer: inputs.authorizer,

			JobRecords: inputs.store,
			JobWrites:  inputs.store,
			JobDeletes: inputs.store,
		},
	)
	if err != nil {
		return nil, fmt.Errorf("创建 OAuth Job HTTP Handler 失败: %w", err)
	}
	return &accountAuthRuntime{
		accountsHandler: accountsHandler,
		jobs:            jobs,
		httpHandler:     accountAuthHandler,
	}, nil
}

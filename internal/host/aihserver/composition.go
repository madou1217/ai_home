package aihserver

import (
	"context"
	"crypto/rand"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"sync"
	"time"

	"github.com/madou1217/ai_home/application/accountauth"
	"github.com/madou1217/ai_home/application/accountcredentials"
	"github.com/madou1217/ai_home/application/accountrouting"
	runtimeapp "github.com/madou1217/ai_home/application/accountruntime"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	usageapp "github.com/madou1217/ai_home/application/accountusage"
	"github.com/madou1217/ai_home/application/accountusagefeed"
	"github.com/madou1217/ai_home/application/claudegateway"
	"github.com/madou1217/ai_home/application/clauderelay"
	"github.com/madou1217/ai_home/application/codexwebsocket"
	"github.com/madou1217/ai_home/application/modelmetadata"
	"github.com/madou1217/ai_home/application/upstreamrules"
	"github.com/madou1217/ai_home/application/visionguard"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/agyoauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/claudeoauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/codexoauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/staticcredential"
	"github.com/madou1217/ai_home/internal/adapters/accountruntime/accountrecovery"
	runtimeinmemory "github.com/madou1217/ai_home/internal/adapters/accountruntime/inmemory"
	"github.com/madou1217/ai_home/internal/adapters/accounts/deletionprojection"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
	"github.com/madou1217/ai_home/internal/adapters/accounts/persistentsessionguard"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	agycodeassist "github.com/madou1217/ai_home/internal/adapters/agy/codeassist"
	claudemessages "github.com/madou1217/ai_home/internal/adapters/claude/messages"
	"github.com/madou1217/ai_home/internal/adapters/claude/transportpolicy"
	"github.com/madou1217/ai_home/internal/adapters/clientversion"
	codebuddyfamilymodelcatalog "github.com/madou1217/ai_home/internal/adapters/codebuddyfamily/modelcatalog"
	codexresponses "github.com/madou1217/ai_home/internal/adapters/codex/responses"
	"github.com/madou1217/ai_home/internal/adapters/codex/responseswebsocket"
	"github.com/madou1217/ai_home/internal/adapters/imageblob"
	"github.com/madou1217/ai_home/internal/adapters/images"
	"github.com/madou1217/ai_home/internal/adapters/modelmetadata/modelsdev"
	openaicompatmodelcatalog "github.com/madou1217/ai_home/internal/adapters/openaicompat/modelcatalog"
	"github.com/madou1217/ai_home/internal/adapters/upstreamfailure/configured"
	"github.com/madou1217/ai_home/internal/host/inferenceruntime"
	"github.com/madou1217/ai_home/internal/transport/http/accountauthapi"
	"github.com/madou1217/ai_home/internal/transport/http/accountoutcomesapi"
	"github.com/madou1217/ai_home/internal/transport/http/accountruntimeapi"
	"github.com/madou1217/ai_home/internal/transport/http/accountsapi"
	"github.com/madou1217/ai_home/internal/transport/http/accountusageeventsapi"
	"github.com/madou1217/ai_home/internal/transport/http/anthropicmessagesapi"
	"github.com/madou1217/ai_home/internal/transport/http/blobsapi"
	"github.com/madou1217/ai_home/internal/transport/http/claudenativerelay"
	"github.com/madou1217/ai_home/internal/transport/http/clauderelayleaseapi"
	"github.com/madou1217/ai_home/internal/transport/http/clientauth"
	"github.com/madou1217/ai_home/internal/transport/http/clinerelay"
	"github.com/madou1217/ai_home/internal/transport/http/codebuddyfamilyrelay"
	"github.com/madou1217/ai_home/internal/transport/http/codexresponseshttp"
	"github.com/madou1217/ai_home/internal/transport/http/codexresponsesws"
	"github.com/madou1217/ai_home/internal/transport/http/grokrelay"
	"github.com/madou1217/ai_home/internal/transport/http/imagesapi"
	"github.com/madou1217/ai_home/internal/transport/http/inferenceapi"
	"github.com/madou1217/ai_home/internal/transport/http/kimirelay"
	"github.com/madou1217/ai_home/internal/transport/http/modelaliasapi"
	"github.com/madou1217/ai_home/internal/transport/http/modelsapi"
	"github.com/madou1217/ai_home/internal/transport/http/relaycore"
	"github.com/madou1217/ai_home/internal/transport/http/shutdownapi"
	"github.com/madou1217/ai_home/internal/transport/http/upstreamrulesapi"
)

const (
	oauthHTTPTimeout = 10 * time.Second
	// claudeRelayHTTPTimeout 同样覆盖到响应正文读完，是 Relay 透传流的绝对上限，
	// 必须与流总时长兜底同量级（见 G3）。
	claudeRelayHTTPTimeout  = inferenceapi.StreamTotalTimeout
	modelCatalogHTTPTimeout = 15 * time.Second
	// modelRefreshFailureLogInterval 限制同一账号连续刷新失败的日志频率。
	modelRefreshFailureLogInterval = 5 * time.Minute
)

// serverHandlers 保存 Composition Root 创建的管理、目录、推理和 Relay 边界。
type serverHandlers struct {
	accounts           http.Handler
	accountAuth        http.Handler
	models             http.Handler
	blobs              http.Handler
	images             http.Handler
	tokenCount         http.Handler
	inference          http.Handler
	gemini             http.Handler
	codexResponsesWS   http.Handler
	codexResponsesHTTP http.Handler
	claudeRelayLeases  http.Handler
	claudeNativeRelay  http.Handler
	// familyRelay 是 CodeBuddy / WorkBuddy 家族的 chat completions 透传通道，
	// 挂在 chat completions 入口前面，服务不了的请求由它内部交回 Canonical。
	familyRelay   http.Handler
	catalogStatus func() catalogReadiness
	// observeCodexClient 从 Responses 入口的真实 Codex 客户端学习版本，见 client_version.go。
	observeCodexClient func(*http.Request)
	// accountOutcomes 是账号请求结果时间桶的只读管理接口。
	accountOutcomes http.Handler
	// accountRuntime 是账号当前运行态（阻塞 / cooldown / 最近结果）的只读管理接口。
	accountRuntime http.Handler
	// accountUsageEvents 是成功尝试 token 用量事件的增量只读管理接口。
	accountUsageEvents http.Handler
	// plugins 是插件发布投影的管理接口与推理入口的 gateway.request 闸门，见 plugin_runtime.go。
	plugins pluginHandlers
	// shutdown 是优雅退出端点；为空表示嵌入方没有提供退出回调，该端点不挂载。
	shutdown http.Handler
	// modelAliases 接收 Node 推送的模型别名投影（/v1/management/model-aliases）。
	modelAliases http.Handler
	// upstreamRules 接收 Node 推送的账号自定义上游错误规则投影
	// （/v1/management/upstream-error-rules）。
	upstreamRules http.Handler
}

// serverAccountRuntime 是账号恢复、征召读取和推理终态共享的唯一运行态。
type serverAccountRuntime interface {
	accountapp.DeletionCleanup
	accountrecovery.Runtime
	inferenceruntime.AccountRuntime
	usageapp.RuntimeProjection
	// accountrouting.AccountWeightSource 提供加权随机选号所需的剩余额度。
	accountrouting.AccountWeightSource
}

// New 装配 Provider Catalog、aih.db、账号用例、OAuth Strategy 和 HTTP 入站适配器。
func New(ctx context.Context, options Options) (*Server, error) {
	if err := validateOptions(options); err != nil {
		return nil, err
	}
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		return nil, fmt.Errorf("创建 Provider Catalog 失败: %w", err)
	}
	store, err := sqliteaccount.Open(ctx, sqliteaccount.OpenOptions{
		AIHomeDir: options.AIHomeDir,
		Catalog:   catalog,
	})
	if err != nil {
		return nil, fmt.Errorf("打开账号数据库失败: %w", err)
	}
	codexVersions, err := newCodexClientVersions(ctx, options.AIHomeDir)
	if err != nil {
		_ = store.Close()
		return nil, fmt.Errorf("创建 Codex 客户端版本解析器失败: %w", err)
	}
	modelModalities, err := modelsdev.New()
	if err != nil {
		_ = codexVersions.Close()
		_ = store.Close()
		return nil, fmt.Errorf("创建 models.dev 模态索引失败: %w", err)
	}
	agyModelWires := newAgyModelWires(options.AIHomeDir)
	modelDiscovery, err := newModelDiscovery(catalog, options.ModelDiscoverers, codexVersions, agyModelWires, modelModalities)
	if err != nil {
		_ = codexVersions.Close()
		_ = store.Close()
		return nil, err
	}
	inMemoryRuntime, err := runtimeinmemory.NewWithStore(
		ctx,
		time.Now,
		store,
		persistErrorObserver(options.ErrorLog),
	)
	if err != nil {
		_ = codexVersions.Close()
		_ = store.Close()
		return nil, fmt.Errorf("创建账号运行态失败: %w", err)
	}
	outcomeRecorder, err := newAccountOutcomeRecorder(ctx, store, options.ErrorLog)
	if err != nil {
		_ = codexVersions.Close()
		_ = store.Close()
		return nil, fmt.Errorf("创建账号结果记录器失败: %w", err)
	}
	// 所有运行态记账入口都经过装饰器，为账号页状态条计数，见 account_outcomes.go。
	accountRuntime := outcomeRecordingRuntime{
		serverAccountRuntime: inMemoryRuntime,
		outcomes:             outcomeRecorder,
		usage:                accountusagefeed.NewFeed(accountusagefeed.DefaultCapacity, time.Now()),
	}
	deletionGuard, err := persistentsessionguard.New(options.AIHomeDir)
	if err != nil {
		_ = store.Close()
		return nil, fmt.Errorf("创建账号持久会话删除保护失败: %w", err)
	}
	hostHomeDir, err := os.UserHomeDir()
	if err != nil {
		_ = store.Close()
		return nil, fmt.Errorf("解析 Provider 原生共享目录失败: %w", err)
	}
	deletionPreparation, err := deletionprojection.New(deletionprojection.Options{
		AIHomeDir:   options.AIHomeDir,
		HostHomeDir: hostHomeDir,
		Credentials: store,
		Clock:       time.Now,
	})
	if err != nil {
		_ = store.Close()
		return nil, fmt.Errorf("创建账号投影删除准备边界失败: %w", err)
	}
	handlers, resources, err := newHandlers(
		ctx,
		catalog,
		store,
		modelDiscovery,
		accountRuntime,
		deletionGuard,
		deletionPreparation,
		options.ManagementKey,
		options.ClientKey,
		options.RequestShutdown,
		options.InferenceHTTPClient,
		options.WebSocketHTTPClient,
		options.UsageHTTPClient,
		options.RelayHTTPClient,
		options.ErrorLog,
		newMessagesDecodeErrorObserver(options.ErrorLog),
		newClaudeUpstreamDecodeErrorObserver(options.ErrorLog),
		options.DelegateCredentialRefresh,
		options.UpstreamErrorRuleProviders,
		codexVersions,
		agyModelWires,
		modelModalities,
	)
	if err != nil {
		_ = codexVersions.Close()
		_ = store.Close()
		return nil, err
	}
	resources = append(resources, codexVersions, outcomeRecorder, store)
	return newServer(
		withManagementBrowserAccess(newRouter(handlers)),
		resources,
		options,
	), nil
}

// newHandlers 共享数据库、运行态和鉴权端口，并保持各 HTTP 边界隔离。
func newHandlers(
	ctx context.Context,
	catalog *providers.Catalog,
	store *sqliteaccount.Store,
	modelDiscovery *accountapp.ModelDiscovery,
	accountRuntime serverAccountRuntime,
	deletionGuard accountapp.DeletionGuard,
	deletionPreparation accountapp.DeletionPreparation,
	managementKey func() string,
	clientKey func() string,
	// requestShutdown 为空时不装配关闭端点，见 Options.RequestShutdown。
	requestShutdown func(),
	inferenceClient InferenceHTTPClient,
	webSocketHTTPClient *http.Client,
	usageClient UsageHTTPClient,
	relayHTTPClient InferenceHTTPClient,
	errorLog *log.Logger,
	decodeErrors func(error),
	upstreamDecodeErrors func(error),
	delegateCredentialRefresh bool,
	// upstreamErrorRuleProviders 声明 Go 已接入规则求值的 Provider；空表示能力关闭。
	upstreamErrorRuleProviders []string,
	codexVersions *clientversion.Resolver,
	agyModelWires *agycodeassist.ModelWireStore,
	modelModalities *modelsdev.Index,
) (_ serverHandlers, _ []io.Closer, resultErr error) {
	var usage *usageComposition
	var modelRefresh *accountapp.ModelRefreshCoordinator
	defer func() {
		if resultErr != nil && usage != nil {
			_ = usage.Close()
		}
		if resultErr != nil && modelRefresh != nil {
			_ = modelRefresh.Close()
		}
	}()
	registrar, err := accountapp.NewRegistrar(
		catalog,
		store,
		time.Now,
	)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建账号注册用例失败: %w", err)
	}
	reauthenticator, err := accountapp.NewReauthenticator(
		catalog,
		store,
		time.Now,
	)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建账号重新认证用例失败: %w", err)
	}
	management, err := accountapp.NewManagement(store, store, time.Now)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建账号管理用例失败: %w", err)
	}
	providerDefaults, err := accountapp.NewProviderDefaults(catalog, store, time.Now)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建 Provider 默认账号用例失败: %w", err)
	}
	launchAccountSelector, err := accountapp.NewLaunchAccountSelector(catalog, store)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建启动账号解析用例失败: %w", err)
	}
	modelManagement, err := accountapp.NewModelManagement(
		store,
		store,
		modelDiscovery,
		time.Now,
	)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建账号模型管理用例失败: %w", err)
	}
	recoveringReauthenticator, err :=
		accountrecovery.NewReauthenticator(
			reauthenticator,
			accountRuntime,
		)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf(
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
		return serverHandlers{}, nil, fmt.Errorf(
			"创建账号模型恢复边界失败: %w",
			err,
		)
	}
	modelRefresh, err = accountapp.NewModelRefreshCoordinator(
		accountapp.ModelRefreshCoordinatorOptions{
			Catalog:             catalog,
			Refresher:           recoveringModelManagement,
			ProviderConcurrency: modelRefreshProviderConcurrency(),
			RefreshTimeout:      modelRefreshTimeout,
			BaseBackoff:         modelRefreshBaseBackoff,
			MaxBackoff:          modelRefreshMaxBackoff,
			MaxAttempts:         modelRefreshMaxAttempts,
			Clock:               time.Now,
			Random:              rand.Reader,
			Observer:            newModelRefreshObserver(errorLog),
		},
	)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建账号模型异步刷新协调器失败: %w", err)
	}
	oauthClient := &http.Client{
		Timeout:       oauthHTTPTimeout,
		CheckRedirect: rejectOAuthRedirect,
	}
	codexProvider, err := codexoauth.New(oauthClient, time.Now)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建 Codex OAuth Strategy 失败: %w", err)
	}
	claudeProvider, err := claudeoauth.New(oauthClient, time.Now)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建 Claude OAuth Strategy 失败: %w", err)
	}
	agyProvider, err := agyoauth.New(oauthClient)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建 AGY OAuth Refresh Strategy 失败: %w", err)
	}
	// 家族四支没有 Go 侧刷新实现（Token 刷新由 Node 宿主完成并同步进凭据库），但
	// 凭据解析器要求每个 Provider 都有一条策略才能读取凭据，所以显式登记静态策略
	// （声明「永不刷新」，见 staticcredential 包注释）。Canonical 的组合同样登记，
	// 避免家族账号在两条解析链上出现「一条能读、一条读不到」的分叉。
	familyCredentialStrategies := make([]accountcredentials.RefreshStrategy, 0, len(codebuddyfamilyrelay.FamilyProviders))
	for _, providerID := range codebuddyfamilyrelay.FamilyProviders {
		strategy, err := staticcredential.New(providerID)
		if err != nil {
			return serverHandlers{}, nil, fmt.Errorf(
				"创建家族静态凭据策略失败(%s): %w",
				providerID,
				err,
			)
		}
		familyCredentialStrategies = append(familyCredentialStrategies, strategy)
	}
	credentials, err := accountcredentials.NewResolver(
		accountcredentials.Dependencies{
			Store: store,
			Strategies: append(
				[]accountcredentials.RefreshStrategy{
					codexProvider,
					claudeProvider,
					agyProvider,
				},
				familyCredentialStrategies...,
			),
			Clock:            time.Now,
			RefreshDelegated: delegateCredentialRefresh,
		},
	)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建账号凭据解析器失败: %w", err)
	}
	usage, err = newUsageComposition(
		ctx,
		usageCompositionDependencies{
			catalog:       catalog,
			store:         store,
			credentials:   credentials,
			models:        store,
			runtime:       accountRuntime,
			httpClient:    usageClient,
			clock:         time.Now,
			codexVersions: codexVersions,
		},
	)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建账号额度组合失败: %w", err)
	}
	credentialRotator, err := accountapp.NewStaticCredentialRotator(
		catalog,
		store,
		time.Now,
		accountRuntime,
	)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建静态账号凭据轮换用例失败: %w", err)
	}
	usageRefreshingCredentialRotator, err :=
		usageapp.NewStaticCredentialRotationDecorator(
			credentialRotator,
			usage,
		)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建凭据轮换额度刷新边界失败: %w", err)
	}
	modelRefreshingCredentialRotator, err :=
		accountapp.NewStaticCredentialRotationModelRefreshDecorator(
			usageRefreshingCredentialRotator,
			modelRefresh,
		)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建凭据轮换模型刷新边界失败: %w", err)
	}
	deleter, err := accountapp.NewDeleter(
		store,
		deletionGuard,
		deletionPreparation,
		modelRefresh,
		usage,
		accountRuntime,
		credentials,
	)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建账号删除用例失败: %w", err)
	}
	modelRefreshingRegistrar, err := accountapp.NewRegistrationModelRefreshDecorator(
		registrar,
		modelRefresh,
	)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建注册模型刷新边界失败: %w", err)
	}
	scheduledRegistrar, err := usageapp.NewRegistrationDecorator(
		modelRefreshingRegistrar,
		usage,
	)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建注册额度刷新边界失败: %w", err)
	}
	modelRefreshingReauthenticator, err :=
		accountapp.NewReauthenticationModelRefreshDecorator(
			recoveringReauthenticator,
			modelRefresh,
		)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建重登模型刷新边界失败: %w", err)
	}
	scheduledReauthenticator, err :=
		usageapp.NewReauthenticationDecorator(
			modelRefreshingReauthenticator,
			usage,
		)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建重登额度刷新边界失败: %w", err)
	}
	accountImporter, err := accountapp.NewAccountImporter(
		scheduledRegistrar,
		store,
		scheduledReauthenticator,
	)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建账号导入用例失败: %w", err)
	}
	authorizer, err := accountsapi.NewBearerAuthorizer(managementKey)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建账号管理鉴权失败: %w", err)
	}
	// 优雅退出端点只在嵌入方提供退出回调时装配：没有接收方的端点等于没有，
	// 而 Windows 上信号路径根本不执行（见 shutdownapi）。
	var shutdownHandler http.Handler
	if requestShutdown != nil {
		shutdown, shutdownErr := shutdownapi.NewHandler(shutdownapi.Dependencies{
			Authorizer:      authorizer,
			RequestShutdown: requestShutdown,
		})
		if shutdownErr != nil {
			return serverHandlers{}, nil, fmt.Errorf("创建关闭端点失败: %w", shutdownErr)
		}
		shutdownHandler = shutdown
	}
	clientAuthorizer, err := clientauth.NewAuthorizer(clientKey)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建客户端鉴权失败: %w", err)
	}
	decoder := nativeaccount.NewDecoder()
	credentialFactory := accountsapi.NewBuiltinStaticCredentialFactory()
	accountOutcomesHandler, err := accountoutcomesapi.NewHandler(authorizer, store)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建账号结果 Handler 失败: %w", err)
	}
	// 只有生产运行态（outcomeRecordingRuntime）支持快照；测试替身不挂该接口。
	var accountRuntimeHandler http.Handler
	if snapshotter, ok := accountRuntime.(runtimeapp.Snapshotter); ok {
		handler, err := accountruntimeapi.NewHandler(authorizer, snapshotter)
		if err != nil {
			return serverHandlers{}, nil, fmt.Errorf("创建账号运行态 Handler 失败: %w", err)
		}
		accountRuntimeHandler = handler
	}
	var accountUsageEventsHandler http.Handler
	if source, ok := accountRuntime.(accountusageeventsapi.Source); ok {
		handler, err := accountusageeventsapi.NewHandler(authorizer, source)
		if err != nil {
			return serverHandlers{}, nil, fmt.Errorf("创建账号用量事件 Handler 失败: %w", err)
		}
		accountUsageEventsHandler = handler
	}
	accountsHandler, err := accountsapi.NewHandler(accountsapi.Dependencies{
		Management:         management,
		Models:             recoveringModelManagement,
		Usage:              usage.service,
		Deletion:           deleter,
		Defaults:           providerDefaults,
		Selections:         launchAccountSelector,
		CredentialRotation: modelRefreshingCredentialRotator,
		Registrar:          scheduledRegistrar,
		Importer:           accountImporter,
		StaticCredentials:  credentialFactory,
		NativeAccounts:     decoder,
		Authorizer:         authorizer,
	})
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建账号 HTTP Handler 失败: %w", err)
	}
	jobs, err := accountauth.NewService(accountauth.Dependencies{
		Providers: []accountauth.OAuthProvider{
			codexProvider,
			claudeProvider,
		},
		Decoder:    decoder,
		Registrar:  scheduledRegistrar,
		Reauth:     scheduledReauthenticator,
		Clock:      time.Now,
		GenerateID: accountauth.NewRandomJobID,
	})
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建 OAuth Job 服务失败: %w", err)
	}
	accountAuthHandler, err := accountauthapi.NewHandler(
		accountauthapi.Dependencies{
			Jobs:       jobs,
			Authorizer: authorizer,
		},
	)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建 OAuth Job HTTP Handler 失败: %w", err)
	}
	relayLeases, err := clauderelay.NewLeaseRegistry(
		clauderelay.Dependencies{
			Random: rand.Reader,
			Clock:  time.Now,
		},
	)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建 Claude Relay 租约注册表失败: %w", err)
	}
	relayAuthorizer, err := claudenativerelay.NewScopedTokenAuthorizer(
		relayLeases,
	)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建 Claude Relay 鉴权失败: %w", err)
	}
	// 生产默认使用拒绝重定向的独立客户端；仅测试可注入替身。
	var relayClient claudenativerelay.HTTPClient = &http.Client{
		Transport:     newUpstreamTransport(),
		Timeout:       claudeRelayHTTPTimeout,
		CheckRedirect: rejectOAuthRedirect,
	}
	if relayHTTPClient != nil {
		relayClient = relayHTTPClient
	}
	// 模态索引与图片仓必须在推理组合之前创建：vision guard 同时需要两者，
	// 而它要在推理运行时装配时就注入。这里只创建一次，后续 modelsapi、Kimi runtime
	// descriptor sink 与图片入口复用。
	imageBlobs := imageblob.NewStore(0)
	visionGuard, err := visionguard.New(visionguard.Dependencies{
		Modalities: modelModalities,
		Blobs:      images.BlobStoreAdapter{Store: imageBlobs},
	})
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建 vision guard 失败: %w", err)
	}
	// 选号策略与 Node 共用同一个环境变量；留空取 Node 同构的默认值，无法识别的取值
	// 直接失败，避免两端静默使用不同策略。
	selectionStrategy, err := accountrouting.ParseSelectionStrategy(
		os.Getenv("AIH_SERVER_STRATEGY"),
	)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("解析账号选号策略失败: %w", err)
	}
	// 账号自定义上游错误规则投影：Node 是规则 owner，Go 只持有可求值的规则集合。
	// 能力集合为空时 Go 不承接任何账号，投影全部被丢弃、Node 继续自己执行规则。
	//
	// 必须在推理组合之前创建：分类点（Canonical Adapter 与原生传输 Handler）在
	// 装配时就注入同一个求值端口，避免出现「投影已接收但没有任何分类点使用它」。
	upstreamRulesStore, err := upstreamrules.NewStore(upstreamrules.Options{
		SupportedProviders: upstreamErrorRuleProviders,
	})
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建上游错误规则投影失败: %w", err)
	}
	upstreamRuleEvaluator := configured.NewEvaluator(upstreamRulesStore)
	inference, err := newInferenceComposition(
		ctx,
		inferenceCompositionDependencies{
			catalog:        catalog,
			store:          store,
			runtime:        accountRuntime,
			weights:        accountRuntime,
			strategy:       selectionStrategy,
			models:         recoveringModelManagement,
			modelRefreshes: modelRefresh,
			credentialRefresh: append(
				[]accountcredentials.RefreshStrategy{
					codexProvider,
					claudeProvider,
					agyProvider,
				},
				familyCredentialStrategies...,
			),
			delegateCredentialRefresh: delegateCredentialRefresh,
			authorizer:                clientAuthorizer,
			httpClient:                inferenceClient,
			decodeErrors:              decodeErrors,
			responsesDecodeErrors:     newResponsesDecodeErrorObserver(errorLog),
			upstreamDecodeErrors:      upstreamDecodeErrors,
			clock:                     time.Now,
			requestRewriter:           visionGuard,
			effortLadders:             modelModalities,
			codexVersions:             codexVersions,
			codexRejections:           newCodexRejectionObserver(errorLog),
			agyModelWires:             agyModelWires,
			upstreamRules:             upstreamRuleEvaluator,
			componentLog:              errorLog,
		},
	)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建生产推理组合失败: %w", err)
	}
	// 别名投影管理接口：Node 推送后立即重建目录，让 applied_generation 追平。
	modelAliasesHandler, err := modelaliasapi.NewHandler(modelaliasapi.Dependencies{
		Authorizer:  authorizer,
		Store:       inference.modelAliases,
		Refresh:     inference.catalogRefresh.Refresh,
		Compilation: inference.models.AliasCompilation,
	})
	if err != nil {
		_ = inference.Close()
		return serverHandlers{}, nil, fmt.Errorf("创建模型别名投影接口失败: %w", err)
	}
	upstreamRulesHandler, err := upstreamrulesapi.NewHandler(upstreamrulesapi.Dependencies{
		Authorizer: authorizer,
		Store:      upstreamRulesStore,
	})
	if err != nil {
		_ = inference.Close()
		return serverHandlers{}, nil, fmt.Errorf("创建上游错误规则投影接口失败: %w", err)
	}
	claudeGatewayPolicy, err := transportpolicy.NewGatewayPolicy(
		inference.claudeUpstream,
	)
	if err != nil {
		_ = inference.Close()
		return serverHandlers{}, nil, fmt.Errorf(
			"创建 Claude Gateway 传输策略失败: %w",
			err,
		)
	}
	codexHTTPHandler, err := codexresponseshttp.NewHandler(codexresponseshttp.Dependencies{
		Authorizer:     clientAuthorizer,
		Accounts:       codexHTTPAccountSource{catalog: catalog, routes: inference.models, recruiter: inference.recruiter, transport: inference.codexUpstream},
		Upstream:       inference.codexUpstream,
		Fallback:       inference.handler,
		Attempts:       accountRuntime,
		Credentials:    credentials,
		ModelRefreshes: inference.modelRefreshes,
		Clock:          time.Now,
		Rules:          upstreamRuleEvaluator,
		FailureLog:     newCodexResponsesFailureLogger(errorLog),
	})
	if err != nil {
		_ = inference.Close()
		return serverHandlers{}, nil, fmt.Errorf("创建 Codex Native HTTP Handler 失败: %w", err)
	}
	codexGatewayPolicy, err := claudegateway.NewCanonicalPolicy(
		"codex",
		inference.codexUpstream,
	)
	if err != nil {
		_ = inference.Close()
		return serverHandlers{}, nil, fmt.Errorf(
			"创建 Codex Gateway Canonical 策略失败: %w",
			err,
		)
	}
	claudeGatewaySelector, err := claudegateway.NewSelector(
		claudegateway.Dependencies{
			Catalog:   catalog,
			Recruiter: inference.recruiter,
			Transports: map[string]claudegateway.TransportPolicy{
				"claude": claudeGatewayPolicy,
				"codex":  codexGatewayPolicy,
			},
			Leases: relayLeases,
		},
	)
	if err != nil {
		_ = inference.Close()
		return serverHandlers{}, nil, fmt.Errorf(
			"创建 Claude Gateway 账号选择器失败: %w",
			err,
		)
	}
	relayLeaseHandler, err := clauderelayleaseapi.NewHandler(
		clauderelayleaseapi.Dependencies{
			Authorizer: clientAuthorizer,
			Selector:   claudeGatewaySelector,
		},
	)
	if err != nil {
		_ = inference.Close()
		return serverHandlers{}, nil, fmt.Errorf(
			"创建 Claude Relay 租约 Handler 失败: %w",
			err,
		)
	}
	relayAccounts, err := newRelayAccountSource(
		catalog,
		inference.recruiter,
		claudeGatewayPolicy,
	)
	if err != nil {
		_ = inference.Close()
		return serverHandlers{}, nil, fmt.Errorf(
			"创建 Claude Relay 账号来源失败: %w",
			err,
		)
	}
	nativeRelayHandler, err := claudenativerelay.NewHandler(
		claudenativerelay.Dependencies{
			Authorizer:        relayAuthorizer,
			Accounts:          relayAccounts,
			Fallback:          inference.handler,
			Credentials:       credentials,
			Client:            relayClient,
			Attempts:          accountRuntime,
			ModelRefreshes:    inference.modelRefreshes,
			Clock:             time.Now,
			Rules:             upstreamRuleEvaluator,
			StreamDisconnects: newRelayDisconnectObserver(errorLog),
		},
	)
	if err != nil {
		_ = inference.Close()
		return serverHandlers{}, nil, fmt.Errorf(
			"创建 Claude Native Relay Handler 失败: %w",
			err,
		)
	}
	// 家族透传通道（CodeBuddy / WorkBuddy 四支）与 Native Relay 共用凭据解析、上游客户端
	// 与运行态记账；能承载的家族请求直连家族官方端点，其余交回 Canonical（见包注释）。
	//
	// 账号来源与 Native Relay 同构（未钉选走 Canonical 的调度器，钉选只认该账号）：
	// 家族模型目录经无客户端 HTTP 通道进入 Go 的账号索引后，未钉选征召按家族表链式
	// 开启多个会话；模型没有家族候选时安静交回 Canonical。Node 侧交还门按「透传通道」
	// 判定哪些模型交给这里，本通道不为「别的 Provider 的模型」兜底。
	familyRelayAccounts, err := newFamilyRelayAccountSource(
		catalog,
		inference.recruiter,
		familyRelayTransportPolicy{},
	)
	if err != nil {
		_ = inference.Close()
		return serverHandlers{}, nil, fmt.Errorf(
			"创建家族透传账号来源失败: %w",
			err,
		)
	}
	// cline 透传：与家族共用 chat completions 入口，但服务的是 cline 账号。
	// 它是 relaycore「多数派零覆盖」的验证用例——上游就是标准 OpenAI 兼容端点。
	clineRelayAccounts, err := newProviderRelayAccountSource(
		clinerelay.ProviderID,
		catalog,
		inference.recruiter,
		clineRelayTransportPolicy{},
	)
	if err != nil {
		_ = inference.Close()
		return serverHandlers{}, nil, fmt.Errorf("创建 cline 透传账号来源失败: %w", err)
	}
	// grok 透传：与 cline 同属「多数派零覆盖」（标准 OpenAI 端点，无硬约束）。
	grokRelayAccounts, err := newProviderRelayAccountSource(
		grokrelay.ProviderID,
		catalog,
		inference.recruiter,
		grokRelayTransportPolicy{},
	)
	if err != nil {
		_ = inference.Close()
		return serverHandlers{}, nil, fmt.Errorf("创建 grok 透传账号来源失败: %w", err)
	}
	// kimi 透传：两处差异（设备指纹头 + 请求体字段翻译），且都**依赖账号**，
	// 因此它的 Provider 是「按账号组装」的适配器（见 kimi_relay_provider.go）。
	kimiRelayAccounts, err := newProviderRelayAccountSource(
		kimirelay.ProviderID,
		catalog,
		inference.recruiter,
		kimiRelayTransportPolicy{},
	)
	if err != nil {
		_ = inference.Close()
		return serverHandlers{}, nil, fmt.Errorf("创建 kimi 透传账号来源失败: %w", err)
	}
	// 同一入口上挂多个透传 Provider：**一个** relaycore.Handler + ProviderChain
	// + 合并的账号来源。
	//
	// 为什么不是两个 Handler 串接：每个 Handler 在「服务不了」时交回 Canonical，
	// 串接会让第一个 Handler 直接交还、第二个永远轮不到。分派必须发生在**账号所属
	// Provider** 这一层——链按账号解析 Provider，账号来源按模型汇总两个池。
	familyRelayHandler, err := codebuddyfamilyrelay.NewHandler(
		codebuddyfamilyrelay.Dependencies{
			Accounts: relaycore.NewAccountSourceChain(
				clineRelayAccounts,
				grokRelayAccounts,
				kimiRelayAccounts,
				familyRelayAccounts,
			),
			Fallback:    inference.handler,
			Credentials: credentials,
			Client:      relayClient,
			Attempts:    accountRuntime,
			Clock:       time.Now,
			// 同一入口上还要服务 cline / grok / kimi：把它们的 Provider 接进链里。
			// kimi 的 Provider 是「按账号组装」的适配器（设备指纹依赖账号）。
			ExtraProviders: []relaycore.Provider{
				clinerelay.NewProvider(""),
				grokrelay.NewProvider(""),
				newKimiRelayProvider(kimiClientVersion()),
			},
		},
	)
	if err != nil {
		_ = inference.Close()
		return serverHandlers{}, nil, fmt.Errorf(
			"创建家族透传 Handler 失败: %w",
			err,
		)
	}
	if webSocketHTTPClient == nil {
		webSocketHTTPClient = &http.Client{
			CheckRedirect: rejectOAuthRedirect,
			// Codex Responses 上游可以是**另一台 aih 网关**（本机 → 远程 server），
			// 这类账号的 base_url 是明文 http://，于是 WS 目标也是明文 ws://。
			// 明文 WS 经 HTTP 代理时会退化成 absolute-form `GET http://…`（不是 CONNECT
			// 隧道），代理按普通 HTTP 处理，握手 101 之后**永远读不到数据** —— 实测拨号
			// 成功、首帧写出成功，但 20s 读不到任何响应，WebUI 会话表现为
			// `stream disconnected before completion: error sending request`。
			// 修复：明文 ws:// 直连，不交给代理；wss:// 仍按环境代理走 CONNECT。
			// 只影响 WS 拨号，HTTP 推理路径仍走既有的代理/账号出口配置。
			Transport: &http.Transport{
				Proxy: func(request *http.Request) (*url.URL, error) {
					if request != nil && request.URL != nil && request.URL.Scheme == "http" {
						return nil, nil
					}
					return http.ProxyFromEnvironment(request)
				},
			},
		}
	}
	webSocketDialer, err := responseswebsocket.NewDialerWithClientVersion(webSocketHTTPClient, codexVersions)
	if err != nil {
		_ = inference.Close()
		return serverHandlers{}, nil, fmt.Errorf(
			"创建 Codex Responses WebSocket Dialer 失败: %w",
			err,
		)
	}
	webSocketSelector, err := codexwebsocket.NewSelector(
		codexwebsocket.Dependencies{
			Catalog:    catalog,
			Routes:     inference.models,
			Recruiter:  inference.recruiter,
			Transports: webSocketDialer,
			// 钉选账号进入 (账号,模型) 冷却时回落到整个池，而不是死守单候选。
			Eligibility: inference.Runtime(),
		},
	)
	if err != nil {
		_ = inference.Close()
		return serverHandlers{}, nil, fmt.Errorf(
			"创建 Codex Responses WebSocket 选择器失败: %w",
			err,
		)
	}
	modelSweep, err := accountapp.NewModelRefreshSweep(catalog, store, modelRefresh)
	if err != nil {
		_ = inference.Close()
		return serverHandlers{}, nil, fmt.Errorf("创建账号模型目录重扫用例失败: %w", err)
	}
	routeMissRefresh, err := accountapp.NewRouteMissModelRefresh(
		accountapp.RouteMissModelRefreshOptions{
			Sweeper:      modelSweep,
			MinInterval:  routeMissRefreshMinInterval,
			SweepTimeout: modelRefreshSweepTimeout,
			Clock:        time.Now,
			Observer: func(providerID string, err error) {
				if errorLog != nil {
					errorLog.Printf("路由未命中触发 %s 模型目录重扫失败: %v", providerID, err)
				}
			},
		},
	)
	if err != nil {
		_ = inference.Close()
		return serverHandlers{}, nil, fmt.Errorf("创建路由未命中模型刷新触发器失败: %w", err)
	}
	webSocketHandler, err := codexresponsesws.NewHandler(
		codexresponsesws.Dependencies{
			Authorizer:             clientAuthorizer,
			Selector:               webSocketSelector,
			Upstream:               webSocketDialer,
			Attempts:               accountRuntime,
			CredentialObservations: credentials,
			ModelRefreshes:         inference.modelRefreshes,
			RouteMisses:            routeMissRefresh,
			Clock:                  time.Now,
			Rules:                  upstreamRuleEvaluator,
		},
	)
	if err != nil {
		_ = routeMissRefresh.Close()
		_ = inference.Close()
		return serverHandlers{}, nil, fmt.Errorf(
			"创建 Codex Responses WebSocket Handler 失败: %w",
			err,
		)
	}
	modelsHandler, err := modelsapi.NewHandler(modelsapi.Dependencies{
		Models:     inference.models,
		Modalities: modelModalities,
		Reasoning:  modelModalities,
		Aliases:    inference.models,
		Authorizer: clientAuthorizer,
	})
	if err != nil {
		_ = inference.Close()
		return serverHandlers{}, nil, fmt.Errorf("创建本地模型目录 Handler 失败: %w", err)
	}
	blobsHandler, err := blobsapi.NewHandler(blobsapi.Dependencies{
		Blobs:      imageBlobs,
		Authorizer: clientAuthorizer,
	})
	if err != nil {
		_ = inference.Close()
		return serverHandlers{}, nil, fmt.Errorf("创建图片 blob Handler 失败: %w", err)
	}
	// 图片入口与 blob 取回共用同一个进程内图片仓，因此 response_format=url 生成的
	// 图片能被 GET /v1/blobs/{id} 取回。
	imageHandler, err := imagesapi.NewHandler(imagesapi.Dependencies{
		Registry: images.NewRegistry(
			images.ChatGPTCodexBaseURL,
			agycodeassist.GenerateContentURL,
		),
		Accounts: imageAccountSource{
			catalog:    catalog,
			recruiter:  inference.recruiter,
			transports: imageTransportPolicy{},
		},
		Providers: imageProviderResolver{
			catalog: catalog,
			models:  inference.models,
		},
		HTTP:       http.DefaultClient,
		Authorizer: clientAuthorizer,
		Blobs:      images.BlobStoreAdapter{Store: imageBlobs},
	})
	if err != nil {
		_ = inference.Close()
		return serverHandlers{}, nil, fmt.Errorf("创建图片 Handler 失败: %w", err)
	}
	// count_tokens 是纯本地估算：不选账号、不发上游请求，因此只依赖客户端鉴权。
	tokenCountHandler, err := anthropicmessagesapi.NewTokenCountHandler(
		anthropicmessagesapi.TokenCountDependencies{
			Authorizer: clientAuthorizer,
		},
	)
	if err != nil {
		_ = inference.Close()
		return serverHandlers{}, nil, fmt.Errorf("创建 count_tokens Handler 失败: %w", err)
	}
	initialModelRecovery, err := accountapp.NewInitialModelRefreshRecovery(
		catalog,
		store,
		modelRefresh,
	)
	if err != nil {
		_ = webSocketHandler.Close()
		_ = routeMissRefresh.Close()
		_ = inference.Close()
		return serverHandlers{}, nil, fmt.Errorf("创建首次模型刷新恢复用例失败: %w", err)
	}
	initialModelRecoveryWorker, err := startInitialModelRefreshRecoveryWorker(
		ctx,
		initialModelRecovery,
		errorLog,
	)
	if err != nil {
		_ = webSocketHandler.Close()
		_ = routeMissRefresh.Close()
		_ = inference.Close()
		return serverHandlers{}, nil, fmt.Errorf("启动首次模型刷新恢复 worker 失败: %w", err)
	}
	modelSweepWorker, err := startModelRefreshSweepWorker(
		ctx,
		modelSweep,
		modelRefreshSweepInitialDelay,
		modelRefreshSweepInterval,
		errorLog,
	)
	if err != nil {
		_ = initialModelRecoveryWorker.Close()
		_ = webSocketHandler.Close()
		_ = routeMissRefresh.Close()
		_ = inference.Close()
		return serverHandlers{}, nil, fmt.Errorf("启动账号模型目录周期重扫 worker 失败: %w", err)
	}
	plugins := newPluginHandlers(authorizer, clientAuthorizer, accountProviderResolver(store))
	return serverHandlers{
		plugins:            plugins,
		accounts:           accountsHandler,
		accountAuth:        accountAuthHandler,
		models:             modelsHandler,
		blobs:              blobsHandler,
		images:             imageHandler,
		tokenCount:         tokenCountHandler,
		inference:          inference.handler,
		gemini:             inference.gemini,
		codexResponsesWS:   webSocketHandler,
		codexResponsesHTTP: codexHTTPHandler,
		observeCodexClient: observeCodexClientVersion(codexVersions, clientAuthorizer),
		accountOutcomes:    accountOutcomesHandler,
		accountRuntime:     accountRuntimeHandler,
		accountUsageEvents: accountUsageEventsHandler,
		claudeRelayLeases:  relayLeaseHandler,
		claudeNativeRelay:  nativeRelayHandler,
		familyRelay:        familyRelayHandler,
		shutdown:           shutdownHandler,
		modelAliases:       modelAliasesHandler,
		upstreamRules:      upstreamRulesHandler,
		catalogStatus: func() catalogReadiness {
			status := inference.models.Status()
			return catalogReadiness{
				ready:      status.Ready,
				stale:      status.Stale,
				modelCount: status.ModelCount,
				routeCount: status.RouteCount,
				accounts:   accountCountsByProvider(catalog, store),
			}
		},
	}, []io.Closer{
		plugins,
		modelSweepWorker,
		initialModelRecoveryWorker,
		webSocketHandler,
		routeMissRefresh,
		inference,
		usage,
		modelRefresh,
	}, nil
}

// newModelRefreshObserver 记录账号模型异步刷新失败的低敏事实。
//
// 单账号刷新失败会保留旧目录并按退避静默重试，路由目录因此可能长期冻结：上游新增
// 模型后该账号仍然不可路由，而请求在选号阶段就失败、不会触发按账号的纠错刷新。这条
// 日志是唯一能看见「哪个账号、因为什么刷新不上去」的线索，必须显式落盘。
//
// 协调器对失败账号按不超过 1 分钟的退避重试，最多 modelRefreshMaxAttempts 次后放弃；
// 未节流时单个坏账号仍会写出大量日志，这里按账号节流，首次失败立即可见，成功后清除
// 节流使下次失败重新可见。放弃是终态，单独记录并清掉节流，避免「静默放弃」。
func newModelRefreshObserver(logger *log.Logger) accountapp.ModelRefreshObserver {
	if logger == nil {
		return nil
	}
	var mu sync.Mutex
	lastLogged := make(map[accountcore.AccountRef]time.Time)
	return func(result accountapp.ModelRefreshResult) {
		if result.Err == nil {
			mu.Lock()
			delete(lastLogged, result.AccountRef)
			mu.Unlock()
			return
		}
		now := time.Now()
		mu.Lock()
		if result.Exhausted {
			delete(lastLogged, result.AccountRef)
		} else {
			previous, seen := lastLogged[result.AccountRef]
			if seen && now.Sub(previous) < modelRefreshFailureLogInterval {
				mu.Unlock()
				return
			}
			lastLogged[result.AccountRef] = now
		}
		mu.Unlock()
		if result.Exhausted {
			logger.Printf(
				"账号模型刷新放弃: provider=%s account=%s attempts=%d err=%v（等待下次周期重扫）",
				result.ProviderID,
				result.AccountRef,
				result.Attempts,
				result.Err,
			)
			return
		}
		logger.Printf(
			"账号模型刷新失败: provider=%s account=%s err=%v",
			result.ProviderID,
			result.AccountRef,
			result.Err,
		)
	}
}

// newClaudeUpstreamDecodeErrorObserver 只记录上游事件类型、字段形状和状态机位置。
func newClaudeUpstreamDecodeErrorObserver(logger *log.Logger) func(error) {
	if logger == nil {
		return nil
	}
	return func(err error) {
		logger.Printf("%v", err)
	}
}

// newMessagesDecodeErrorObserver 只记录 Decoder 已脱敏的错误类别和字段路径。
func newMessagesDecodeErrorObserver(logger *log.Logger) func(error) {
	if logger == nil {
		return nil
	}
	return func(err error) {
		logger.Printf("Anthropic Messages decode rejected: %v", err)
	}
}

// persistErrorObserver 把账号模型 cooldown 的持久化失败写进 ErrorLog。
//
// 写失败不会让请求失败（cooldown 在本进程内已生效），所以这条日志是唯一能看见
// 「重启后会丢掉冷却」的线索，必须显式落盘而不是静默吞掉。
func persistErrorObserver(logger *log.Logger) func(error) {
	if logger == nil {
		return nil
	}
	return func(err error) {
		logger.Printf("账号模型冷却持久化失败: %v", err)
	}
}

// newRelayDisconnectObserver 记录 Claude relay 流中途断开（上游或客户端一侧）。
//
// 上游中途断开时访问日志仍是 200，客户端却报 "Connection lost mid-response"；
// 这条日志是区分代理/网络链路断开与客户端断开的唯一线索。
func newRelayDisconnectObserver(logger *log.Logger) func(claudenativerelay.StreamDisconnect) {
	if logger == nil {
		return nil
	}
	return func(event claudenativerelay.StreamDisconnect) {
		logger.Printf(
			"Claude relay stream disconnected mid-response: side=%s model=%s account=%s elapsed=%s error=%q",
			event.Side,
			event.Model,
			event.AccountRef,
			event.Elapsed.Round(time.Millisecond),
			event.Error,
		)
	}
}

// newCodexRejectionObserver 记录上游拒绝请求参数的低敏诊断（不含请求体与凭据）。
//
// 客户端只收到"上游拒绝当前请求参数"，这条日志是定位编码与上游合同差异的唯一线索。
func newCodexRejectionObserver(logger *log.Logger) func(codexresponses.UpstreamRejection) {
	if logger == nil {
		return nil
	}
	return func(rejection codexresponses.UpstreamRejection) {
		logger.Printf(
			"Codex upstream rejected request: model=%s status=%d type=%q code=%q param=%q message=%q",
			rejection.Model,
			rejection.StatusCode,
			rejection.Type,
			rejection.Code,
			rejection.Param,
			rejection.Message,
		)
	}
}

// newResponsesDecodeErrorObserver 只记录 Decoder 已脱敏的错误类别和字段路径。
//
// 被拒收的请求会由 Node 宿主接手，这条日志是 Go 协议覆盖缺口的唯一清单。
func newResponsesDecodeErrorObserver(logger *log.Logger) func(error) {
	if logger == nil {
		return nil
	}
	return func(err error) {
		logger.Printf("OpenAI Responses decode rejected: %v", err)
	}
}

// modelRefreshProviderConcurrency 声明拥有独立刷新队列的 Provider 及其并发。
//
// Canonical 三支各一条队列；家族四支的刷新形态是同一个 HTTP 目录端点
// （internal/adapters/codebuddyfamily/modelcatalog），同样各占一条、并发 1。
// 漏登记的代价是静默的：账号不会被扫描/首次恢复刷新，模型目录永远为空。
func modelRefreshProviderConcurrency() map[string]int {
	concurrency := map[string]int{
		string(inference.ProviderCodex):  modelRefreshConcurrency,
		string(inference.ProviderClaude): modelRefreshConcurrency,
		string(inference.ProviderAgy):    modelRefreshConcurrency,
	}
	// 透传通道服务的 Provider 同样要有刷新队列，且与目录构建共用同一份声明。
	//
	// 为什么必须显式列：队列只在协调器构造时按这张表建立，**没有队列的 Provider 永远
	// 不会被重扫**——表现是静默的（账号在池里、模型目录一直为空、请求被判成
	// model_not_routable 交还 Node），等于透传通道白接。
	for _, providerID := range relayProviderIDs() {
		concurrency[providerID] = modelRefreshConcurrency
	}
	return concurrency
}

// newModelDiscovery 创建生产 Codex/Claude 目录源，或使用测试显式注入的策略。
func newModelDiscovery(
	catalog *providers.Catalog,
	injected []accountapp.ProviderModelDiscoverer,
	codexVersions clientversion.Source,
	agyModelWires agycodeassist.ModelWireWriter,
	modalityRegistrar modelmetadata.ModelDescriptorRegistrar,
) (*accountapp.ModelDiscovery, error) {
	strategies := injected
	if len(strategies) == 0 {
		client := &http.Client{
			Timeout:       modelCatalogHTTPTimeout,
			CheckRedirect: rejectOAuthRedirect,
		}
		codexSource, err := codexresponses.NewModelCatalogSourceWithClientVersion(client, codexVersions)
		if err != nil {
			return nil, fmt.Errorf("创建 Codex 模型目录源失败: %w", err)
		}
		claudeSource, err := claudemessages.NewModelCatalogSource(client)
		if err != nil {
			return nil, fmt.Errorf("创建 Claude 模型目录源失败: %w", err)
		}
		agySource, err := agycodeassist.NewModelCatalogSourceWithWireModels(client, agyModelWires)
		if err != nil {
			return nil, fmt.Errorf("创建 AGY 模型目录源失败: %w", err)
		}
		familySources, err := codebuddyfamilymodelcatalog.NewModelCatalogSources(client)
		if err != nil {
			return nil, fmt.Errorf("创建家族模型目录源失败: %w", err)
		}
		// kimi / grok 的透传通道已接入（见 relaycore），但账号的**模型目录**要单独发现：
		// 没有目录，Go 就不知道这两个 Provider 有哪些模型可路由，请求会被判成
		// model_not_routable 交还 Node —— 等于通道白接。
		//
		// 两者都是标准 OpenAI 兼容端点（GET {base}/models），因此共用同一实现，
		// 差异只在端点与凭据取法。
		kimiSource, err := openaicompatmodelcatalog.New(client, openaicompatmodelcatalog.Options{
			ProviderID:  kimirelay.ProviderID,
			Endpoint:    kimirelay.KimiCodeBaseURL + openaicompatmodelcatalog.ModelsPath,
			Token:       kimirelay.AccessTokenFromCredential,
			Descriptors: modalityRegistrar,
		})
		if err != nil {
			return nil, fmt.Errorf("创建 kimi 模型目录源失败: %w", err)
		}
		grokSource, err := openaicompatmodelcatalog.New(client, openaicompatmodelcatalog.Options{
			ProviderID: grokrelay.ProviderID,
			Endpoint:   grokrelay.DefaultBaseURL + openaicompatmodelcatalog.ModelsPath,
			Token:      grokrelay.AccessTokenFromCredential,
			// grok 的 GET /models 只认 API Key：OAuth 账号会被 403，因此明确跳过
			// （那些账号的目录只能靠本地 CLI，Go 服务端没有 —— 这是能力边界，不是缺陷）。
			SupportsCredential: grokrelay.SupportsHTTPModelDiscovery,
		})
		if err != nil {
			return nil, fmt.Errorf("创建 grok 模型目录源失败: %w", err)
		}
		strategies = []accountapp.ProviderModelDiscoverer{
			codexSource,
			claudeSource,
			agySource,
			kimiSource,
			grokSource,
		}
		strategies = append(strategies, familySources...)
	}
	discovery, err := accountapp.NewModelDiscovery(catalog, strategies)
	if err != nil {
		return nil, fmt.Errorf("创建账号模型发现注册表失败: %w", err)
	}
	return discovery, nil
}

// rejectOAuthRedirect 防止 Token 或 Profile 请求被重定向到未审计主机。
func rejectOAuthRedirect(
	_ *http.Request,
	_ []*http.Request,
) error {
	return http.ErrUseLastResponse
}

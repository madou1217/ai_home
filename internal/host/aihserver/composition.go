package aihserver

import (
	"context"
	"crypto/rand"
	"fmt"
	"io"
	"log"
	"net/http"
	"time"

	"github.com/madou1217/ai_home/application/accountauth"
	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	usageapp "github.com/madou1217/ai_home/application/accountusage"
	"github.com/madou1217/ai_home/application/claudegateway"
	"github.com/madou1217/ai_home/application/clauderelay"
	"github.com/madou1217/ai_home/application/codexwebsocket"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/agyoauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/claudeoauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/codexoauth"
	"github.com/madou1217/ai_home/internal/adapters/accountruntime/accountrecovery"
	runtimeinmemory "github.com/madou1217/ai_home/internal/adapters/accountruntime/inmemory"
	"github.com/madou1217/ai_home/internal/adapters/accounts/cliproxyapi"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sub2api"
	agycodeassist "github.com/madou1217/ai_home/internal/adapters/agy/codeassist"
	claudemessages "github.com/madou1217/ai_home/internal/adapters/claude/messages"
	"github.com/madou1217/ai_home/internal/adapters/claude/transportpolicy"
	codexresponses "github.com/madou1217/ai_home/internal/adapters/codex/responses"
	"github.com/madou1217/ai_home/internal/adapters/codex/responseswebsocket"
	"github.com/madou1217/ai_home/internal/adapters/modelmetadata/modelsdev"
	"github.com/madou1217/ai_home/internal/host/inferenceruntime"
	"github.com/madou1217/ai_home/internal/transport/http/accountauthapi"
	"github.com/madou1217/ai_home/internal/transport/http/accountsapi"
	"github.com/madou1217/ai_home/internal/transport/http/claudenativerelay"
	"github.com/madou1217/ai_home/internal/transport/http/clauderelayleaseapi"
	"github.com/madou1217/ai_home/internal/transport/http/clientauth"
	"github.com/madou1217/ai_home/internal/transport/http/codexresponsesws"
	"github.com/madou1217/ai_home/internal/transport/http/modelsapi"
)

const (
	oauthHTTPTimeout        = 10 * time.Second
	claudeRelayHTTPTimeout  = 10 * time.Minute
	modelCatalogHTTPTimeout = 15 * time.Second
)

// serverHandlers 保存 Composition Root 创建的管理、目录、推理和 Relay 边界。
type serverHandlers struct {
	accounts          http.Handler
	accountAuth       http.Handler
	models            http.Handler
	inference         http.Handler
	codexResponsesWS  http.Handler
	claudeRelayLeases http.Handler
	claudeNativeRelay http.Handler
	catalogStatus     func() catalogReadiness
}

// serverAccountRuntime 是账号恢复、征召读取和推理终态共享的唯一运行态。
type serverAccountRuntime interface {
	accountapp.DeletionCleanup
	accountrecovery.Runtime
	inferenceruntime.AccountRuntime
	usageapp.RuntimeProjection
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
	modelDiscovery, err := newModelDiscovery(catalog, options.ModelDiscoverers)
	if err != nil {
		_ = store.Close()
		return nil, err
	}
	accountRuntime, err := runtimeinmemory.New(time.Now)
	if err != nil {
		_ = store.Close()
		return nil, fmt.Errorf("创建账号运行态失败: %w", err)
	}
	handlers, resources, err := newHandlers(
		ctx,
		catalog,
		store,
		modelDiscovery,
		accountRuntime,
		options.ManagementKey,
		options.ClientKey,
		options.InferenceHTTPClient,
		options.WebSocketHTTPClient,
		options.UsageHTTPClient,
		options.RelayHTTPClient,
		newMessagesDecodeErrorObserver(options.ErrorLog),
		newClaudeUpstreamDecodeErrorObserver(options.ErrorLog),
	)
	if err != nil {
		_ = store.Close()
		return nil, err
	}
	resources = append(resources, store)
	return newServer(
		newRouter(handlers),
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
	managementKey func() string,
	clientKey func() string,
	inferenceClient InferenceHTTPClient,
	webSocketHTTPClient *http.Client,
	usageClient UsageHTTPClient,
	relayHTTPClient InferenceHTTPClient,
	decodeErrors func(error),
	upstreamDecodeErrors func(error),
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
	exportReader, err := accountapp.NewExportReader(store, store, store)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建账号导出读取器失败: %w", err)
	}
	accountExporter, err := sub2api.NewExporter(exportReader, time.Now)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建账号标准导出器失败: %w", err)
	}
	cliProxyAPIExporter, err := cliproxyapi.NewExporter(exportReader)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf(
			"创建 CLIProxyAPI 账号导出器失败: %w",
			err,
		)
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
			Catalog:   catalog,
			Refresher: recoveringModelManagement,
			ProviderConcurrency: map[string]int{
				string(inference.ProviderCodex):  modelRefreshConcurrency,
				string(inference.ProviderClaude): modelRefreshConcurrency,
				string(inference.ProviderAgy):    modelRefreshConcurrency,
			},
			RefreshTimeout: modelRefreshTimeout,
			BaseBackoff:    modelRefreshBaseBackoff,
			MaxBackoff:     modelRefreshMaxBackoff,
			Clock:          time.Now,
			Random:         rand.Reader,
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
	credentials, err := accountcredentials.NewResolver(
		accountcredentials.Dependencies{
			Store: store,
			Strategies: []accountcredentials.RefreshStrategy{
				codexProvider,
				claudeProvider,
				agyProvider,
			},
			Clock: time.Now,
		},
	)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建账号凭据解析器失败: %w", err)
	}
	usage, err = newUsageComposition(
		ctx,
		usageCompositionDependencies{
			catalog:     catalog,
			store:       store,
			credentials: credentials,
			models:      store,
			runtime:     accountRuntime,
			httpClient:  usageClient,
			clock:       time.Now,
		},
	)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建账号额度组合失败: %w", err)
	}
	credentialRotator, err := accountapp.NewStaticCredentialRotator(
		catalog,
		store,
		time.Now,
		usage,
		accountRuntime,
	)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建静态账号凭据轮换用例失败: %w", err)
	}
	modelRefreshingCredentialRotator, err :=
		accountapp.NewStaticCredentialRotationModelRefreshDecorator(
			credentialRotator,
			modelRefresh,
		)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建凭据轮换模型刷新边界失败: %w", err)
	}
	deleter, err := accountapp.NewDeleter(
		store,
		modelRefresh,
		usage,
		accountRuntime,
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
		usage.coordinator,
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
			usage.coordinator,
		)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建重登额度刷新边界失败: %w", err)
	}
	authorizer, err := accountsapi.NewBearerAuthorizer(managementKey)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建账号管理鉴权失败: %w", err)
	}
	clientAuthorizer, err := clientauth.NewAuthorizer(clientKey)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建客户端鉴权失败: %w", err)
	}
	decoder := nativeaccount.NewDecoder()
	sub2APIDecoder := sub2api.NewDecoder()
	credentialFactory := accountsapi.NewBuiltinAPIKeyCredentialFactory()
	accountsHandler, err := accountsapi.NewHandler(accountsapi.Dependencies{
		Management:          management,
		Models:              recoveringModelManagement,
		Usage:               usage.service,
		Deletion:            deleter,
		Defaults:            providerDefaults,
		Selections:          launchAccountSelector,
		CredentialRotation:  modelRefreshingCredentialRotator,
		Sub2APIExporter:     accountExporter,
		CLIProxyAPIExporter: cliProxyAPIExporter,
		Registrar:           scheduledRegistrar,
		APIKeys:             credentialFactory,
		StaticCredentials:   credentialFactory,
		NativeAccounts:      decoder,
		Sub2APIAccounts:     sub2APIDecoder,
		Authorizer:          authorizer,
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
		Timeout:       claudeRelayHTTPTimeout,
		CheckRedirect: rejectOAuthRedirect,
	}
	if relayHTTPClient != nil {
		relayClient = relayHTTPClient
	}
	inference, err := newInferenceComposition(
		ctx,
		inferenceCompositionDependencies{
			catalog:        catalog,
			store:          store,
			runtime:        accountRuntime,
			models:         recoveringModelManagement,
			modelRefreshes: modelRefresh,
			credentialRefresh: []accountcredentials.RefreshStrategy{
				codexProvider,
				claudeProvider,
				agyProvider,
			},
			authorizer:           clientAuthorizer,
			httpClient:           inferenceClient,
			decodeErrors:         decodeErrors,
			upstreamDecodeErrors: upstreamDecodeErrors,
			clock:                time.Now,
		},
	)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建生产推理组合失败: %w", err)
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
			Authorizer:     relayAuthorizer,
			Accounts:       relayAccounts,
			Fallback:       inference.handler,
			Credentials:    credentials,
			Client:         relayClient,
			Attempts:       accountRuntime,
			ModelRefreshes: inference.modelRefreshes,
			Clock:          time.Now,
		},
	)
	if err != nil {
		_ = inference.Close()
		return serverHandlers{}, nil, fmt.Errorf(
			"创建 Claude Native Relay Handler 失败: %w",
			err,
		)
	}
	if webSocketHTTPClient == nil {
		webSocketHTTPClient = &http.Client{
			CheckRedirect: rejectOAuthRedirect,
		}
	}
	webSocketDialer, err := responseswebsocket.NewDialer(webSocketHTTPClient)
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
		},
	)
	if err != nil {
		_ = inference.Close()
		return serverHandlers{}, nil, fmt.Errorf(
			"创建 Codex Responses WebSocket 选择器失败: %w",
			err,
		)
	}
	webSocketHandler, err := codexresponsesws.NewHandler(
		codexresponsesws.Dependencies{
			Authorizer:     clientAuthorizer,
			Selector:       webSocketSelector,
			Upstream:       webSocketDialer,
			Attempts:       accountRuntime,
			ModelRefreshes: inference.modelRefreshes,
			Clock:          time.Now,
		},
	)
	if err != nil {
		_ = inference.Close()
		return serverHandlers{}, nil, fmt.Errorf(
			"创建 Codex Responses WebSocket Handler 失败: %w",
			err,
		)
	}
	modelModalities, err := modelsdev.New()
	if err != nil {
		_ = inference.Close()
		return serverHandlers{}, nil, fmt.Errorf(
			"创建 models.dev 模态索引失败: %w",
			err,
		)
	}
	modelsHandler, err := modelsapi.NewHandler(modelsapi.Dependencies{
		Models:     inference.models,
		Modalities: modelModalities,
		Authorizer: clientAuthorizer,
	})
	if err != nil {
		_ = inference.Close()
		return serverHandlers{}, nil, fmt.Errorf("创建本地模型目录 Handler 失败: %w", err)
	}
	return serverHandlers{
		accounts:          accountsHandler,
		accountAuth:       accountAuthHandler,
		models:            modelsHandler,
		inference:         inference.handler,
		codexResponsesWS:  webSocketHandler,
		claudeRelayLeases: relayLeaseHandler,
		claudeNativeRelay: nativeRelayHandler,
		catalogStatus: func() catalogReadiness {
			status := inference.models.Status()
			return catalogReadiness{
				ready:      status.Ready,
				stale:      status.Stale,
				modelCount: status.ModelCount,
				routeCount: status.RouteCount,
			}
		},
	}, []io.Closer{webSocketHandler, inference, usage, modelRefresh}, nil
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

// newModelDiscovery 创建生产 Codex/Claude 目录源，或使用测试显式注入的策略。
func newModelDiscovery(
	catalog *providers.Catalog,
	injected []accountapp.ProviderModelDiscoverer,
) (*accountapp.ModelDiscovery, error) {
	strategies := injected
	if len(strategies) == 0 {
		client := &http.Client{
			Timeout:       modelCatalogHTTPTimeout,
			CheckRedirect: rejectOAuthRedirect,
		}
		codexSource, err := codexresponses.NewModelCatalogSource(client)
		if err != nil {
			return nil, fmt.Errorf("创建 Codex 模型目录源失败: %w", err)
		}
		claudeSource, err := claudemessages.NewModelCatalogSource(client)
		if err != nil {
			return nil, fmt.Errorf("创建 Claude 模型目录源失败: %w", err)
		}
		agySource, err := agycodeassist.NewModelCatalogSource(client)
		if err != nil {
			return nil, fmt.Errorf("创建 AGY 模型目录源失败: %w", err)
		}
		strategies = []accountapp.ProviderModelDiscoverer{
			codexSource,
			claudeSource,
			agySource,
		}
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

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
	"github.com/madou1217/ai_home/application/modelalias"
	"github.com/madou1217/ai_home/application/modelcatalog"
	"github.com/madou1217/ai_home/application/modelmetadata"
	upstreammappingapp "github.com/madou1217/ai_home/application/upstreammapping"
	"github.com/madou1217/ai_home/application/upstreamrules"
	"github.com/madou1217/ai_home/application/visionguard"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/agyoauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/claudeoauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/clineoauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/codexoauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/geminioauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/grokoauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/kimioauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/kirooauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/opencodeoauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/staticcredential"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/tokenrefresh"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/zcodeoauth"
	"github.com/madou1217/ai_home/internal/adapters/accountruntime/accountrecovery"
	runtimeinmemory "github.com/madou1217/ai_home/internal/adapters/accountruntime/inmemory"
	"github.com/madou1217/ai_home/internal/adapters/accounts/deletionprojection"
	"github.com/madou1217/ai_home/internal/adapters/accounts/kirocred"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
	"github.com/madou1217/ai_home/internal/adapters/accounts/persistentsessionguard"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	agycodeassist "github.com/madou1217/ai_home/internal/adapters/agy/codeassist"
	"github.com/madou1217/ai_home/internal/adapters/claude/transportpolicy"
	"github.com/madou1217/ai_home/internal/adapters/clientversion"
	codexresponses "github.com/madou1217/ai_home/internal/adapters/codex/responses"
	"github.com/madou1217/ai_home/internal/adapters/codex/responseswebsocket"
	"github.com/madou1217/ai_home/internal/adapters/imageblob"
	"github.com/madou1217/ai_home/internal/adapters/images"
	"github.com/madou1217/ai_home/internal/adapters/modelmetadata/modelsdev"
	"github.com/madou1217/ai_home/internal/adapters/upstreamfailure/configured"
	"github.com/madou1217/ai_home/internal/adapters/usagepricing"
	"github.com/madou1217/ai_home/internal/host/inferenceruntime"
	"github.com/madou1217/ai_home/internal/transport/http/accountauthapi"
	"github.com/madou1217/ai_home/internal/transport/http/accountoutcomesapi"
	accountrulesapi "github.com/madou1217/ai_home/internal/transport/http/accountrulesapi"
	"github.com/madou1217/ai_home/internal/transport/http/accountruntimeapi"
	"github.com/madou1217/ai_home/internal/transport/http/accountsapi"
	"github.com/madou1217/ai_home/internal/transport/http/accountusageeventsapi"
	"github.com/madou1217/ai_home/internal/transport/http/anthropicmessagesapi"
	"github.com/madou1217/ai_home/internal/transport/http/blobsapi"
	"github.com/madou1217/ai_home/internal/transport/http/claudenativerelay"
	"github.com/madou1217/ai_home/internal/transport/http/clauderelayleaseapi"
	"github.com/madou1217/ai_home/internal/transport/http/clientauth"
	"github.com/madou1217/ai_home/internal/transport/http/clientpropsapi"
	"github.com/madou1217/ai_home/internal/transport/http/codebuddyfamilyrelay"
	"github.com/madou1217/ai_home/internal/transport/http/codexresponseshttp"
	"github.com/madou1217/ai_home/internal/transport/http/codexresponsesws"
	"github.com/madou1217/ai_home/internal/transport/http/imagesapi"
	"github.com/madou1217/ai_home/internal/transport/http/inferenceapi"
	"github.com/madou1217/ai_home/internal/transport/http/managementmetricsapi"
	"github.com/madou1217/ai_home/internal/transport/http/managementstatusapi"
	"github.com/madou1217/ai_home/internal/transport/http/modelaliasapi"
	"github.com/madou1217/ai_home/internal/transport/http/modelaliaswebui"
	"github.com/madou1217/ai_home/internal/transport/http/modelcatalogapi"
	"github.com/madou1217/ai_home/internal/transport/http/modelsapi"
	"github.com/madou1217/ai_home/internal/transport/http/relaycore"
	"github.com/madou1217/ai_home/internal/transport/http/shutdownapi"
	upstreammappingapi "github.com/madou1217/ai_home/internal/transport/http/upstreammappingapi"
	"github.com/madou1217/ai_home/internal/transport/http/usagestatsapi"
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
	clientProps        http.Handler
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
	// webUI 托管 Web UI 构建产物（/ui/*）；nil 表示不由 Go 承接。
	webUI http.Handler
	// frontDoor 是公开端口的兜底反代；nil 表示不接管公开端口。
	frontDoor http.Handler
	// usageStats 是 Go 持久化 token 账本的只读统计接口。
	usageStats http.Handler
	// usageImport 接收 Node 历史用量的一次性批量导入（幂等，可重试）。
	usageImport http.Handler
	// usageBuckets 是按日/周聚合的 token 桶（额度统计页图表）。
	usageBuckets  http.Handler
	usageModels   http.Handler
	usageSessions http.Handler
	// plugins 是插件发布投影的管理接口与推理入口的 gateway.request 闸门，见 plugin_runtime.go。
	plugins pluginHandlers
	// shutdown 是优雅退出端点；为空表示嵌入方没有提供退出回调，该端点不挂载。
	shutdown http.Handler
	// modelAliases 接收 Node 推送的模型别名投影（/v1/management/model-aliases）。
	modelAliases http.Handler
	// modelAliasesWebUI 提供别名 CRUD 的 WebUI 契约（/v1/management/webui/model-aliases）。
	modelAliasesWebUI http.Handler
	// upstreamMappingGroups 是 Go 自有的上游错误映射组 CRUD
	// （/v1/management/upstream-error-mapping-groups）。
	upstreamMappingGroups http.Handler
	// accountRules 是账号级上游错误规则（/v1/management/accounts/{ref}/upstream-error-rules）。
	accountRules http.Handler
	// modelCatalog 接收 Node 的全局公共模型目录投影；不参与 Go 路由选号。
	modelCatalog      http.Handler
	managementStatus  http.Handler
	managementMetrics http.Handler
	metrics           *metricsRecorder
}

// serverAccountRuntime 是账号恢复、征召读取和推理终态共享的唯一运行态。
type serverAccountRuntime interface {
	accountapp.DeletionCleanup
	accountrecovery.Runtime
	inferenceruntime.AccountRuntime
	usageapp.RuntimeProjection
	// accountrouting.AccountWeightSource 提供加权随机选号所需的剩余额度。
	accountrouting.AccountWeightSource
	// 持久化运行态 → 征召资格：账号 enabled 只表示用户意图，auth_invalid 等
	// 运行态阻塞必须单独参与征召（见 docs/plans/2026-11-06-account-enable-unification.md）。
	ApplyAccountState(ctx context.Context, state runtimecore.AccountState) error
	ClearAccountState(ctx context.Context, accountRef accountcore.AccountRef) error
}

// New 装配 Provider Catalog、aih.db、账号用例、OAuth Strategy 和 HTTP 入站适配器。
func New(ctx context.Context, options Options) (*Server, error) {
	if err := validateOptions(options); err != nil {
		return nil, err
	}
	webUI, err := newWebUIHandler(options.WebDir)
	if err != nil {
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
	// 图片专用模型不在账号的对话模型快照里，但该 Provider 的凭据确实能出图：合成进路由索引，
	// 否则「只写 model」的图片请求会 503，/v1/models 也不会列出这些模型。
	store.SetSynthesizedModelSource(images.NativeImageModelIDs)
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
	// 启动时把持久化的账号运行态投影进征召索引：Node 推来的 auth_invalid 阻塞
	// 不能因为进程重启就消失。读失败直接失败启动——带着未知阻塞跑路由更危险。
	seededStates, seedErr := store.ListAccountStates(ctx)
	if seedErr != nil {
		_ = codexVersions.Close()
		_ = store.Close()
		return nil, fmt.Errorf("加载账号运行态失败: %w", seedErr)
	}
	for _, state := range seededStates {
		if seedErr := inMemoryRuntime.ApplyAccountState(ctx, state); seedErr != nil {
			_ = codexVersions.Close()
			_ = store.Close()
			return nil, fmt.Errorf("投影账号运行态失败: %w", seedErr)
		}
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
		usageLedger:          store,
		accounts:             store,
		errorLog:             options.ErrorLog,
		quotaRefresh:         newQuotaFailureRefresh(store, time.Now, options.ErrorLog),
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
	handlers, resources, err := newHandlers(handlerDependencies{
		Context:                    ctx,
		Catalog:                    catalog,
		Store:                      store,
		AIHomeDir:                  options.AIHomeDir,
		ModelDiscovery:             modelDiscovery,
		Runtime:                    accountRuntime,
		AttemptUsage:               accountRuntime,
		ImageUsage:                 accountRuntime,
		ImageOutcomes:              accountRuntime,
		DeletionGuard:              deletionGuard,
		DeletionPreparation:        deletionPreparation,
		ManagementKey:              options.ManagementKey,
		ClientKey:                  options.ClientKey,
		RequestShutdown:            options.RequestShutdown,
		InferenceClient:            options.InferenceHTTPClient,
		WebSocketHTTPClient:        options.WebSocketHTTPClient,
		UsageClient:                options.UsageHTTPClient,
		RelayHTTPClient:            options.RelayHTTPClient,
		ErrorLog:                   options.ErrorLog,
		DecodeErrors:               newMessagesDecodeErrorObserver(options.ErrorLog),
		UpstreamDecodeErrors:       newClaudeUpstreamDecodeErrorObserver(options.ErrorLog),
		DelegateCredentialRefresh:  options.DelegateCredentialRefresh,
		UpstreamErrorRuleProviders: options.UpstreamErrorRuleProviders,
		CodexVersions:              codexVersions,
		AGYModelWires:              agyModelWires,
		ModelModalities:            modelModalities,
		RouteObserver:              codexresponsesws.FileRouteObserver{AIHomeDir: options.AIHomeDir},
	})
	if err != nil {
		_ = codexVersions.Close()
		_ = store.Close()
		return nil, err
	}
	handlers.webUI = webUI
	frontDoor, err := newFrontDoorFromOptions(options)
	if err != nil {
		_ = codexVersions.Close()
		_ = store.Close()
		return nil, err
	}
	handlers.frontDoor = frontDoor
	resources = append(resources, codexVersions, outcomeRecorder, store)
	return newServer(
		withManagementBrowserAccess(handlers.metrics.Middleware(newRouter(handlers))),
		resources,
		options,
	), nil
}

// handlerDependencies 汇总 newHandlers 的全部输入。
//
// 为什么是结构体而不是位置参数：这里曾经有 26 个位置参数，其中同一个运行态对象连续
// 占了三格（运行态 / 生图用量 / 生图结果）。新增一个 Provider 能力时，少写一个参数或
// 调换两个同类型参数都会**静默**把依赖接到错误的端口上——三个同类型参数编译器不会报错。
// 具名字段把这类错误变成编译错误，也让新增依赖的 diff 只有一行。
type handlerDependencies struct {
	Context context.Context
	Catalog *providers.Catalog
	Store   *sqliteaccount.Store
	// AIHomeDir 供宿主事实读取（如 zcode 官方 harness）；不参与账号存储。
	AIHomeDir      string
	ModelDiscovery *accountapp.ModelDiscovery
	// Runtime 同时实现运行态、生图用量与生图结果三个端口。
	Runtime serverAccountRuntime
	// AttemptUsage 记录透传通道的真实 token 用量（由运行态装饰器实现）。
	AttemptUsage relaycore.UsageRecorder
	// ImageUsage 记录生图的 token 用量（与推理路径同一个用量管道）；为 nil 时不记账。
	ImageUsage imagesapi.UsageRecorder
	// ImageOutcomes 记录生图成功（账号页最近成功 + 清 cooldown）；为 nil 时不记录。
	ImageOutcomes             imagesapi.ImageOutcomes
	DeletionGuard             accountapp.DeletionGuard
	DeletionPreparation       accountapp.DeletionPreparation
	ManagementKey             func() string
	ClientKey                 func() string
	RequestShutdown           func()
	InferenceClient           InferenceHTTPClient
	WebSocketHTTPClient       *http.Client
	UsageClient               UsageHTTPClient
	RelayHTTPClient           InferenceHTTPClient
	ErrorLog                  *log.Logger
	DecodeErrors              func(error)
	UpstreamDecodeErrors      func(error)
	DelegateCredentialRefresh bool
	// UpstreamErrorRuleProviders 声明 Go 已接入规则求值的 Provider；空表示能力关闭。
	UpstreamErrorRuleProviders []string
	CodexVersions              *clientversion.Resolver
	AGYModelWires              *agycodeassist.ModelWireStore
	ModelModalities            *modelsdev.Index
	// RouteObserver 落原生 WS 每轮选号（终端标题的当前路由帧）；Node 看不到 WS 管道里的选号。
	RouteObserver codexresponsesws.RouteObserver
}

// newHandlers 共享数据库、运行态和鉴权端口，并保持各 HTTP 边界隔离。
func newHandlers(dependencies handlerDependencies) (_ serverHandlers, _ []io.Closer, resultErr error) {
	// 局部别名让下面这段长流水线保持原有可读性；新增依赖只需在结构体里加字段。
	ctx := dependencies.Context
	catalog := dependencies.Catalog
	store := dependencies.Store
	aiHomeDir := dependencies.AIHomeDir
	modelDiscovery := dependencies.ModelDiscovery
	accountRuntime := dependencies.Runtime
	attemptUsage := dependencies.AttemptUsage
	imageUsage := dependencies.ImageUsage
	imageOutcomes := dependencies.ImageOutcomes
	deletionGuard := dependencies.DeletionGuard
	deletionPreparation := dependencies.DeletionPreparation
	managementKey := dependencies.ManagementKey
	clientKey := dependencies.ClientKey
	requestShutdown := dependencies.RequestShutdown
	inferenceClient := dependencies.InferenceClient
	webSocketHTTPClient := dependencies.WebSocketHTTPClient
	usageClient := dependencies.UsageClient
	relayHTTPClient := dependencies.RelayHTTPClient
	errorLog := dependencies.ErrorLog
	decodeErrors := dependencies.DecodeErrors
	upstreamDecodeErrors := dependencies.UpstreamDecodeErrors
	delegateCredentialRefresh := dependencies.DelegateCredentialRefresh
	upstreamErrorRuleProviders := dependencies.UpstreamErrorRuleProviders
	codexVersions := dependencies.CodexVersions
	agyModelWires := dependencies.AGYModelWires
	modelModalities := dependencies.ModelModalities
	routeObserver := dependencies.RouteObserver
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
	providerDefaults, err := accountapp.NewProviderDefaults(catalog, store, time.Now)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建 Provider 默认账号用例失败: %w", err)
	}
	launchAccountSelector, err := accountapp.NewLaunchAccountSelector(catalog, store)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建启动账号解析用例失败: %w", err)
	}
	// kiro 的 OAuth 凭据在发现前刷新；刷新走纯 HTTP 并 CAS 回写。
	kiroRefresher, err := kirocred.New(
		store,
		&http.Client{
			Timeout:       modelCatalogHTTPTimeout,
			CheckRedirect: rejectOAuthRedirect,
		},
		time.Now,
	)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建 kiro 凭据刷新器失败: %w", err)
	}
	// kiro 的 access token 会过期：推理已由 Go 承接，凭据解析必须能刷新，
	// 否则 relay 拿着过期 token 打上游（真机 403 AccessDeniedException）。
	kiroProvider, err := kirooauth.New(kiroRefresher)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建 kiro 凭据刷新策略失败: %w", err)
	}
	modelManagement, err := accountapp.NewModelManagement(
		store,
		store,
		modelDiscovery,
		kiroRefresher,
		// 探测事实与目录快照落在同一 aih.db，WebUI 批量读一次 JOIN 取齐。
		store,
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
			ProviderConcurrency: modelRefreshProviderConcurrency(modelDiscovery.ProviderIDs()),
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
		return serverHandlers{}, nil, fmt.Errorf("创建账号管理用例失败: %w", err)
	}
	oauthClient := &http.Client{
		Timeout:       oauthHTTPTimeout,
		CheckRedirect: rejectOAuthRedirect,
	}
	// kimi access_token 只有 15 分钟，刷新走 auth.kimi.com 的 form 合同（与 CLI 一致）。
	kimiProvider, err := kimioauth.New(oauthClient, kimioauth.Options{ClientVersion: kimiClientVersion()})
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建 kimi OAuth Refresh Strategy 失败: %w", err)
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
	// gemini / grok / cline 的刷新已迁 Go：三家只做协议交换，到期判断与 CAS 写回
	// 由 accountcredentials.Resolver 统一负责。
	geminiProvider, err := geminioauth.New(oauthClient, geminioauth.Options{})
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建 Gemini OAuth Refresh Strategy 失败: %w", err)
	}
	grokProvider, err := grokoauth.New(oauthClient, grokoauth.Options{})
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建 Grok OAuth Refresh Strategy 失败: %w", err)
	}
	clineProvider, err := clineoauth.New(oauthClient, clineoauth.Options{})
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建 Cline OAuth Refresh Strategy 失败: %w", err)
	}
	geminiStrategy, err := tokenrefresh.NewStrategy(geminiProvider)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建 Gemini 刷新策略失败: %w", err)
	}
	grokStrategy, err := tokenrefresh.NewStrategy(grokProvider)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建 Grok 刷新策略失败: %w", err)
	}
	clineStrategy, err := tokenrefresh.NewStrategy(clineProvider)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建 Cline 刷新策略失败: %w", err)
	}
	// 家族四支与 Qoder 双区没有 Go 侧刷新实现（Token 刷新由 Node 宿主/官方 CLI 完成并
	// 同步进凭据库），但凭据解析器要求每个 Provider 都有一条策略才能读取凭据，所以显式
	// 登记静态策略（声明「永不刷新」，见 staticcredential 包注释）。Canonical 的组合
	// 同样登记，避免这些账号在两条解析链上出现「一条能读、一条读不到」的分叉。
	//
	// Qoder 额度 refresh 走的就是这条链路：凭据是 CLI 的 opaque blob，token 由
	// qodercred 用厂商 wasm 解密，不需要（也没有）Go 侧 OAuth 刷新。
	// 这里列的是「Go 已有采集/转发能力、但 Token 刷新仍归 Node 或厂商 CLI」的 Provider：
	// 缺一条策略，凭据解析就直接失败，额度协调器与显式 refresh 都会 500。
	// kiro / zcode / cline 的 Node 探针早已下线（descriptor quota.supported=false），
	// 没有静态策略时它们的 Go 采集根本跑不起来，只能靠 Node 进程的旧连接推数据。
	// grok 同理：Go 侧没有 OAuth 刷新实现，token 由 Node 的 token-refresh-daemon 续期后
	// 经 go-account-sync 推进来；不登记静态策略，凭据解析与额度采集都会直接失败。
	staticCredentialProviders := append(
		append([]string{}, codebuddyfamilyrelay.FamilyProviders...),
		"qoder",
		"qodercn",
		"zcode",
	)
	staticCredentialStrategies := make(
		[]accountcredentials.RefreshStrategy,
		0,
		len(staticCredentialProviders),
	)
	for _, providerID := range staticCredentialProviders {
		strategy, err := staticcredential.New(providerID)
		if err != nil {
			return serverHandlers{}, nil, fmt.Errorf(
				"创建静态凭据策略失败(%s): %w",
				providerID,
				err,
			)
		}
		staticCredentialStrategies = append(staticCredentialStrategies, strategy)
	}
	// 两处解析器（WebUI/账号域与推理）共用同一份刷新策略集合：
	// 新增 Provider 只改这一处调用，不再维护两份字面量列表。
	credentialRefreshStrategies := func(oauth ...accountcredentials.RefreshStrategy) []accountcredentials.RefreshStrategy {
		return append(oauth, staticCredentialStrategies...)
	}
	credentials, err := accountcredentials.NewResolver(
		accountcredentials.Dependencies{
			Store: store,
			Strategies: credentialRefreshStrategies(
				codexProvider,
				claudeProvider,
				agyProvider,
				kimiProvider,
				kiroProvider,
				geminiStrategy,
				grokStrategy,
				clineStrategy,
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
	clientPropsHandler, err := clientpropsapi.NewHandler(clientpropsapi.Dependencies{
		Authorizer: clientAuthorizer,
	})
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建客户端属性 Handler 失败: %w", err)
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
	usageStatsHandler, err := usagestatsapi.NewHandler(authorizer, store)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建 Go 用量统计 Handler 失败: %w", err)
	}
	// 成本口径：定价表由 Node 维护，Go 只读；表不存在时成本标为「未知」而不是 0 元。
	costCalculator, err := usagepricing.NewModelCostCalculator(store, providerIDs(catalog))
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建 Go 用量成本计算器失败: %w", err)
	}
	usageModelsHandler, err := usagestatsapi.NewModelsHandler(authorizer, store, costCalculator)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建 Go 模型用量 Handler 失败: %w", err)
	}
	usageSessionsHandler, err := usagestatsapi.NewSessionsHandler(authorizer, store)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建 Go 会话用量 Handler 失败: %w", err)
	}
	usageImportHandler, err := usagestatsapi.NewImportHandler(authorizer, store)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建 Go 用量导入 Handler 失败: %w", err)
	}
	usageBucketsHandler, err := usagestatsapi.NewBucketsHandler(authorizer, store)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建 Go 用量桶 Handler 失败: %w", err)
	}
	// 窗口统计与模型用量共用同一份定价快照：两处口径必须一致，否则同一账号
	// 在「模型用量」和「额度统计」两个页面会显示不同的成本。
	windowPricer, err := usagepricing.NewWindowPricer(costCalculator)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建额度窗口定价端口失败: %w", err)
	}
	quotaStatsService, err := usageapp.NewQuotaStatsService(usageapp.QuotaStatsDependencies{
		Samples:   store,
		Usage:     store,
		Ledger:    store,
		Events:    store,
		Snapshots: store,
		Clock:     time.Now,
		Pricer:    windowPricer,
	})
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建额度统计服务失败: %w", err)
	}
	accountsHandler, err := accountsapi.NewHandler(accountsapi.Dependencies{
		Management: management,
		Models:     recoveringModelManagement,
		Usage:      usage.service,
		QuotaStats: quotaStatsService,
		// 账号行的 token 用量直接读 Go 账本：与用量页同一份事实，不再回 Node 现算。
		TokenUsage:          store,
		Deletion:            deleter,
		Defaults:            providerDefaults,
		Selections:          launchAccountSelector,
		CredentialRotation:  modelRefreshingCredentialRotator,
		Registrar:           scheduledRegistrar,
		Importer:            accountImporter,
		StaticCredentials:   credentialFactory,
		NativeAccounts:      decoder,
		CredentialSnapshots: store,
		// 批量模型关系：WebUI 模型缓存读 Go 的入口（一次 JOIN，不做 N 次请求）。
		AccountModels: store,
		// 运行态写入后立即投影到征召资格索引。
		RuntimeStates: accountRuntime,
		// 探针由 Node 执行后推送，Go 只落库并在账号视图里回读。
		ProbeStates: accountProbeStateStore{store: store},
		// 自定义上游账号由 Node 标记排除：Go 拿到结论后直接从候选与目录里滤掉。
		RoutingExclusions: store,
		Authorizer:        authorizer,
	})
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建账号 HTTP Handler 失败: %w", err)
	}
	// zcode（自定义协议）与 opencode（设备码）的登录已迁 Go；Node 侧策略文件删除后
	// 仍然由同一个 Job 框架提供 Begin/Complete 与终态落库。
	zcodeOAuth, err := zcodeoauth.New(oauthClient)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建 zcode 登录策略失败: %w", err)
	}
	opencodeOAuth, err := opencodeoauth.New(oauthClient, time.Now)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建 opencode 登录策略失败: %w", err)
	}
	jobs, err := accountauth.NewService(accountauth.Dependencies{
		Providers: []accountauth.OAuthProvider{
			codexProvider,
			claudeProvider,
			zcodeOAuth,
			opencodeOAuth,
		},
		Decoder:    decoder,
		Registrar:  scheduledRegistrar,
		Reauth:     scheduledReauthenticator,
		Clock:      time.Now,
		GenerateID: accountauth.NewRandomJobID,
		// 公开快照落 aih.db：重启后仍能查询 Job 状态；未完成 Job 由 Rehydrate 标成 expired
		// （state/PKCE 只在内存，重启后无法继续，冒充 pending 会让前端一直等）。
		JobStore: store,
	})
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建 OAuth Job 服务失败: %w", err)
	}
	if err := jobs.Rehydrate(ctx); err != nil {
		return serverHandlers{}, nil, fmt.Errorf("恢复 OAuth Job 快照失败: %w", err)
	}
	accountAuthHandler, err := accountauthapi.NewHandler(
		accountauthapi.Dependencies{
			Jobs:       jobs,
			Authorizer: authorizer,
			JobRecords: store,
			JobWrites:  store,
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
	// 映射组是 Go 自己的写入口：组与规则落 aih.db，Node 的账号级规则链路不参与。
	// 它同时是账号规则拼装的组来源，因此必须先于规则服务创建。
	upstreamMappingService, err := upstreammappingapp.NewService(
		sqliteaccount.NewUpstreamErrorMappingRepository(store),
		providerIDs(catalog),
	)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建上游错误映射组服务失败: %w", err)
	}
	// 账号级上游错误规则：规则与组挂载落 aih.db，有效规则由 Go 拼装。
	// 能力集合为空时 Go 不承接任何账号，账号仍由 Node 承接。
	//
	// 必须在推理组合之前创建：分类点（Canonical Adapter 与原生传输 Handler）在
	// 装配时就注入同一个求值端口，避免出现「投影已接收但没有任何分类点使用它」。
	upstreamRulesService, err := upstreamrules.NewService(upstreamrules.Options{
		Repository:         sqliteaccount.NewUpstreamErrorRuleRepository(store),
		Groups:             upstreamMappingService,
		SupportedProviders: upstreamErrorRuleProviders,
	})
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建上游错误规则服务失败: %w", err)
	}
	upstreamRuleEvaluator := configured.NewEvaluator(upstreamRulesService)
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
			credentialRefresh: credentialRefreshStrategies(
				codexProvider,
				claudeProvider,
				agyProvider,
				kimiProvider,
				kiroProvider,
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
	// 别名 CRUD：与投影接口共用同一个 Store 和代次，写进去立刻参与路由编译。
	aliasService, err := modelalias.NewService(inference.modelAliases, providerIDs(catalog))
	if err != nil {
		_ = inference.Close()
		return serverHandlers{}, nil, fmt.Errorf("创建模型别名写服务失败: %w", err)
	}
	// 目标校验与 /targets 用同一份目录数据：写入口和下拉选项必须看到同一批模型，
	// 否则会出现「下拉里有、保存时说没有」。
	aliasService.SetTargetCatalog(func(provider, target string) (bool, bool) {
		models, listErr := inference.models.ListRoutableModels(context.Background())
		if listErr != nil {
			// 目录不可用时不做判定：不能因为还没构建完就拒绝保存别名。
			return true, false
		}
		list, known := groupAliasTargets(models)[provider]
		if !known {
			// 这个 Provider 不在路由目录里（只有展示模型 / 当前无可用账号）：
			// 没有证据，放行。
			return true, false
		}
		for _, model := range list {
			if model == target {
				return true, true
			}
		}
		return false, true
	})
	modelAliasesWebUIHandler, err := modelaliaswebui.NewHandler(modelaliaswebui.Dependencies{
		Authorizer: authorizer,
		Service:    aliasService,
		Refresh:    inference.catalogRefresh.Refresh,
		// 目标候选来自当前已发布的路由目录：没有目录时返回空表（接口 200），
		// 而不是让前端把「还没构建完」当成服务不可用。
		Targets: func() map[string][]string {
			models, listErr := inference.models.ListRoutableModels(context.Background())
			if listErr != nil {
				return nil
			}
			return groupAliasTargets(models)
		},
	})
	if err != nil {
		_ = inference.Close()
		return serverHandlers{}, nil, fmt.Errorf("创建模型别名 WebUI 接口失败: %w", err)
	}
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
	modelCatalogStore, err := modelcatalog.NewStore()
	if err != nil {
		_ = inference.Close()
		return serverHandlers{}, nil, fmt.Errorf("创建全局模型目录投影 Store 失败: %w", err)
	}
	modelCatalogHandler, err := modelcatalogapi.NewHandler(modelcatalogapi.Dependencies{
		Authorizer: authorizer,
		Store:      modelCatalogStore,
		Routable:   store,
	})
	if err != nil {
		_ = inference.Close()
		return serverHandlers{}, nil, fmt.Errorf("创建全局模型目录投影接口失败: %w", err)
	}
	managementStatusHandler, err := managementstatusapi.NewHandler(authorizer, managementStatusSource{
		catalog: catalog,
		store:   store,
		status: func() catalogReadiness {
			state := inference.models.Status()
			return catalogReadiness{
				ready:      state.Ready,
				stale:      state.Stale,
				modelCount: state.ModelCount,
				routeCount: state.RouteCount,
				accounts:   accountCountsByProvider(catalog, store),
			}
		},
		strategy: selectionStrategy,
	})
	if err != nil {
		_ = inference.Close()
		return serverHandlers{}, nil, fmt.Errorf("创建管理状态 Handler 失败: %w", err)
	}
	metrics := newMetricsRecorder()
	managementMetricsHandler, err := managementmetricsapi.NewHandler(authorizer, metricsSource{recorder: metrics})
	if err != nil {
		_ = inference.Close()
		return serverHandlers{}, nil, fmt.Errorf("创建管理指标 Handler 失败: %w", err)
	}
	accountRulesHandler, err := accountrulesapi.NewHandler(accountrulesapi.Dependencies{
		Authorizer: authorizer,
		Service:    upstreamRulesService,
	})
	if err != nil {
		_ = inference.Close()
		return serverHandlers{}, nil, fmt.Errorf("创建账号级上游错误规则接口失败: %w", err)
	}
	upstreamMappingHandler, err := upstreammappingapi.NewHandler(upstreammappingapi.Dependencies{
		Authorizer: authorizer,
		Service:    upstreamMappingService,
	})
	if err != nil {
		_ = inference.Close()
		return serverHandlers{}, nil, fmt.Errorf("创建上游错误映射组接口失败: %w", err)
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
	// 单 Provider 透传模块：账号来源与 Provider 变体由同一张注册表构造（见 relay_modules.go）。
	relayModules, err := buildRelayModules(relayBuildContext{
		Catalog:   catalog,
		Recruiter: inference.recruiter,
		AIHomeDir: aiHomeDir,
	})
	if err != nil {
		_ = inference.Close()
		return serverHandlers{}, nil, err
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
				append(relayModuleAccounts(relayModules), familyRelayAccounts)...,
			),
			Fallback:    inference.handler,
			Credentials: credentials,
			Client:      relayClient,
			Attempts:    accountRuntime,
			Clock:       time.Now,
			// 同一入口上还要服务 cline / grok / kimi：把它们的 Provider 接进链里。
			// kimi 的 Provider 是「按账号组装」的适配器（设备指纹依赖账号）。
			ExtraProviders: relayModuleProviders(relayModules),
			// 用量由 relaycore 在流结束时结算（首个字节前无法得知 token 数）。
			Usage: attemptUsage,
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
			Routes:                 routeObserver,
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
		Catalog:    modelCatalogStore,
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
			images.NewFetcher(http.DefaultClient),
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
		Usage:      imageUsage,
		Outcomes:   imageOutcomes,
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
		plugins:               plugins,
		accounts:              accountsHandler,
		accountAuth:           accountAuthHandler,
		clientProps:           clientPropsHandler,
		models:                modelsHandler,
		blobs:                 blobsHandler,
		images:                imageHandler,
		tokenCount:            tokenCountHandler,
		inference:             inference.handler,
		gemini:                inference.gemini,
		codexResponsesWS:      webSocketHandler,
		codexResponsesHTTP:    codexHTTPHandler,
		observeCodexClient:    observeCodexClientVersion(codexVersions, clientAuthorizer),
		accountOutcomes:       accountOutcomesHandler,
		accountRuntime:        accountRuntimeHandler,
		accountUsageEvents:    accountUsageEventsHandler,
		usageStats:            usageStatsHandler,
		usageModels:           usageModelsHandler,
		usageSessions:         usageSessionsHandler,
		usageImport:           usageImportHandler,
		usageBuckets:          usageBucketsHandler,
		claudeRelayLeases:     relayLeaseHandler,
		claudeNativeRelay:     nativeRelayHandler,
		familyRelay:           familyRelayHandler,
		shutdown:              shutdownHandler,
		modelAliases:          modelAliasesHandler,
		modelAliasesWebUI:     modelAliasesWebUIHandler,
		upstreamMappingGroups: upstreamMappingHandler,
		accountRules:          accountRulesHandler,
		modelCatalog:          modelCatalogHandler,
		managementStatus:      managementStatusHandler,
		managementMetrics:     managementMetricsHandler,
		metrics:               metrics,
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

// modelRefreshProviderConcurrency 按已装配的模型发现策略声明刷新队列。
//
// 队列必须与发现策略同源：只写在发现注册表里、没有队列的 Provider 永远不会被
// 周期重扫（静默失效：账号在池里、模型目录一直为空）。
//
// Canonical 三支各一条队列；家族四支的刷新形态是同一个 HTTP 目录端点
// （internal/adapters/codebuddyfamily/modelcatalog），同样各占一条、并发 1。
// 漏登记的代价是静默的：账号不会被扫描/首次恢复刷新，模型目录永远为空。
func modelRefreshProviderConcurrency(providerIDs []string) map[string]int {
	concurrency := make(map[string]int, len(providerIDs)+3)
	// 透传通道服务的 Provider 即使暂时没有发现策略也要有队列（目录可能由别名/投影补）。
	for _, providerID := range relayProviderIDs() {
		concurrency[providerID] = modelRefreshConcurrency
	}
	for _, providerID := range providerIDs {
		concurrency[providerID] = modelRefreshConcurrency
	}
	return concurrency
}

// newModelDiscovery 创建生产模型目录源（见 model_providers.go 注册表），
// 或使用测试显式注入的策略。
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
		built, err := buildModelProviderSources(modelProviderContext{
			client:            client,
			codexVersions:     codexVersions,
			agyModelWires:     agyModelWires,
			modalityRegistrar: modalityRegistrar,
		})
		if err != nil {
			return nil, err
		}
		strategies = built
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

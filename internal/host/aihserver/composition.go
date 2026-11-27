package aihserver

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/madou1217/ai_home/application/accountoutcomes"
	"github.com/madou1217/ai_home/application/accountrouting"
	runtimeapp "github.com/madou1217/ai_home/application/accountruntime"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	usageapp "github.com/madou1217/ai_home/application/accountusage"
	"github.com/madou1217/ai_home/application/accountusagefeed"
	"github.com/madou1217/ai_home/application/admission"
	"github.com/madou1217/ai_home/application/claudegateway"
	"github.com/madou1217/ai_home/application/clauderelay"
	clientkeysapp "github.com/madou1217/ai_home/application/clientkeys"
	"github.com/madou1217/ai_home/application/clientkeystats"
	"github.com/madou1217/ai_home/application/codexwebsocket"
	"github.com/madou1217/ai_home/application/modelalias"
	"github.com/madou1217/ai_home/application/modelcatalog"
	"github.com/madou1217/ai_home/application/modelmetadata"
	"github.com/madou1217/ai_home/application/modelprobes"
	upstreammappingapp "github.com/madou1217/ai_home/application/upstreammapping"
	"github.com/madou1217/ai_home/application/upstreamrules"
	"github.com/madou1217/ai_home/application/visionguard"
	capabilitybaseline "github.com/madou1217/ai_home/contracts/model-capabilities"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accountremoval"
	"github.com/madou1217/ai_home/internal/adapters/accountruntime/accountrecovery"
	runtimeinmemory "github.com/madou1217/ai_home/internal/adapters/accountruntime/inmemory"
	"github.com/madou1217/ai_home/internal/adapters/accounts/deletionprojection"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	agycodeassist "github.com/madou1217/ai_home/internal/adapters/agy/codeassist"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/adapters/claude/transportpolicy"
	"github.com/madou1217/ai_home/internal/adapters/clientversion"
	"github.com/madou1217/ai_home/internal/adapters/codex/responseswebsocket"
	"github.com/madou1217/ai_home/internal/adapters/imageblob"
	"github.com/madou1217/ai_home/internal/adapters/images"
	capabilitycontract "github.com/madou1217/ai_home/internal/adapters/modelcapabilities/contract"
	capabilityprojection "github.com/madou1217/ai_home/internal/adapters/modelcapabilities/projection"
	"github.com/madou1217/ai_home/internal/adapters/modelcatalogsettings"
	"github.com/madou1217/ai_home/internal/adapters/modelmetadata/aliasdisplay"
	modelsdevpricing "github.com/madou1217/ai_home/internal/adapters/modelpricing/modelsdev"
	"github.com/madou1217/ai_home/internal/adapters/sshremote"
	"github.com/madou1217/ai_home/internal/adapters/upstreamfailure/configured"
	"github.com/madou1217/ai_home/internal/adapters/usagepricing"
	"github.com/madou1217/ai_home/internal/host/inferenceruntime"
	"github.com/madou1217/ai_home/internal/host/worknative"
	"github.com/madou1217/ai_home/internal/runtime/accountwriterlease"
	"github.com/madou1217/ai_home/internal/runtime/chatruntime"
	"github.com/madou1217/ai_home/internal/runtime/codexmodelcatalog"
	"github.com/madou1217/ai_home/internal/runtime/desktoptranslation"
	runtimeegress "github.com/madou1217/ai_home/internal/runtime/egress"
	"github.com/madou1217/ai_home/internal/runtime/failureprovenance"
	"github.com/madou1217/ai_home/internal/runtime/managementops"
	"github.com/madou1217/ai_home/internal/runtime/outboundproxy"
	"github.com/madou1217/ai_home/internal/runtime/persistent"
	"github.com/madou1217/ai_home/internal/runtime/pricingresolver"
	"github.com/madou1217/ai_home/internal/runtime/providercliupgrade"
	"github.com/madou1217/ai_home/internal/runtime/proxyserve"
	"github.com/madou1217/ai_home/internal/runtime/pty"
	"github.com/madou1217/ai_home/internal/runtime/renderplugin"
	"github.com/madou1217/ai_home/internal/runtime/sessionevents"
	"github.com/madou1217/ai_home/internal/runtime/sshproxy"
	"github.com/madou1217/ai_home/internal/runtime/sshtunnel"
	"github.com/madou1217/ai_home/internal/runtime/subaggregator"
	"github.com/madou1217/ai_home/internal/runtime/terminalsession"
	"github.com/madou1217/ai_home/internal/runtime/windowactivation"
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
	"github.com/madou1217/ai_home/internal/transport/http/codexresponseshttp"
	"github.com/madou1217/ai_home/internal/transport/http/codexresponsesws"
	"github.com/madou1217/ai_home/internal/transport/http/geminiapi"
	"github.com/madou1217/ai_home/internal/transport/http/imagesapi"
	"github.com/madou1217/ai_home/internal/transport/http/inferenceapi"
	"github.com/madou1217/ai_home/internal/transport/http/managementmetricsapi"
	"github.com/madou1217/ai_home/internal/transport/http/managementstatusapi"
	"github.com/madou1217/ai_home/internal/transport/http/modelaliasapi"
	"github.com/madou1217/ai_home/internal/transport/http/modelaliaswebui"
	"github.com/madou1217/ai_home/internal/transport/http/modelcatalogapi"
	"github.com/madou1217/ai_home/internal/transport/http/modelsapi"
	"github.com/madou1217/ai_home/internal/transport/http/openaichatcompletionsapi"
	"github.com/madou1217/ai_home/internal/transport/http/openairesponsesapi"
	"github.com/madou1217/ai_home/internal/transport/http/relaycore"
	"github.com/madou1217/ai_home/internal/transport/http/shutdownapi"
	upstreammappingapi "github.com/madou1217/ai_home/internal/transport/http/upstreammappingapi"
	"github.com/madou1217/ai_home/internal/transport/http/usagestatsapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountsapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuisshapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiterminalapi"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	// 与 Node agy-token-refresh 的默认刷新超时一致（15s）；共享隧道繁忙时
	// 10s 会偏紧。
	oauthHTTPTimeout = 15 * time.Second
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
	familyRelay http.Handler
	// relayMessages / relayResponses 是同一套透传账号在 Anthropic Messages /
	// OpenAI Responses 入口上的跨协议桥；只有 Canonical 目录没有路由的模型才进桥。
	relayMessages  http.Handler
	relayResponses http.Handler
	catalogStatus  func() catalogReadiness
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
	// subAggregatorPublic 托管 /sub/{token} 免鉴权聚合订阅公开拉取。
	subAggregatorPublic http.Handler
	// codexAppServer 托管 /v0/codex/app-server 与根路径 WebSocket 升级代理。
	codexAppServer http.Handler
	// remoteWebUI resolves profiles and streams remote WebUI requests in Go.
	remoteWebUI *remoteWebUIProxy
	// frontDoor 是已退役前置门的历史字段，仅供对照测试；生产路由不再使用。
	frontDoor http.Handler
	// clientIdentity 给携带客户端 Key 的请求注入调用方身份与请求统计作用域。
	clientIdentity func(http.Handler) http.Handler
	// webUITerminal 是 WebUI 底部终端的会话与 SSE 入口（挂管理前缀，Node 反代）。
	webUITerminal http.Handler
	// webuiAccounts 是账号页读模型（camelCase，字段与 Node 行同名）。
	webuiAccounts http.Handler
	// webuiRoutes 是 WebUI 管理面的全部路由（各能力自己声明，router 统一挂载）。
	webuiRoutes        []webuiRoute
	desktopTranslation *desktoptranslation.Service
	// webUIChat 是聊天轮次入口：管理前缀与浏览器 /v0/webui/chat/* 均由 Go 应答。
	webUIChat http.Handler
	// usageStats 是 Go 持久化 token 账本的只读统计接口。
	usageStats http.Handler
	// usageImport 接收 Node 历史用量的一次性批量导入（幂等，可重试）。
	usageImport http.Handler
	// usageBuckets 是按日/周聚合的 token 桶（额度统计页图表）。
	usageBuckets http.Handler
	// usageQuotaBuckets 是按额度档位聚合的 token 用量。
	usageQuotaBuckets http.Handler
	usageModels       http.Handler
	usageSessions     http.Handler
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
	warmupDeps        webuiRouteDependencies
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
	// 失败命中环形缓冲是进程级诊断面：所有推理入口共享同一次安装。
	failureprovenance.Install()
	// 前置门只在 Go 拥有公开端口时装配；目标为空时返回 nil，路由表保持 404。
	// 地址校验放在获取任何资源之前，非法配置不会留下需要清理的租约。
	frontDoor, err := newFrontDoorHandler(options.FrontDoorBaseURL)
	if err != nil {
		return nil, fmt.Errorf("创建前置门处理器失败: %w", err)
	}
	writerLease, err := acquireAccountWriterLease(ctx, options.AIHomeDir)
	if err != nil {
		return nil, err
	}
	leaseTransferred := false
	defer func() {
		if !leaseTransferred {
			_ = writerLease.Close()
		}
	}()
	webUI, err := newWebUIHandler(options.WebDir)
	if err != nil {
		return nil, err
	}
	remoteWebUI, err := newRemoteWebUIProxy(options.AIHomeDir, options.ManagementKey)
	if err != nil {
		return nil, fmt.Errorf("创建远端 WebUI 代理失败: %w", err)
	}
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		return nil, fmt.Errorf("创建 Provider Catalog 失败: %w", err)
	}
	store, err := sqliteaccount.Open(ctx, sqliteaccount.OpenOptions{
		AIHomeDir:          options.AIHomeDir,
		Catalog:            catalog,
		WatchModelSettings: true,
		ModelSettingsLogf:  log.Printf,
	})
	if err != nil {
		return nil, fmt.Errorf("打开账号数据库失败: %w", err)
	}
	// 身份事实按当前凭据重新解析并写入 account_identities；不读取任何历史展示名，
	// 也不回退兼容表。启动时同步跑一次，新账号在注册/改凭据/重新认证路径即时刷新。
	if changed, identityErr := store.ReparseAccountIdentities(ctx); identityErr != nil {
		log.Printf("[accounts] 身份重解析失败: %v", identityErr)
	} else if changed > 0 {
		log.Printf("[accounts] 身份重解析完成: %d 个账号", changed)
	}
	// 图片专用模型不在账号的对话模型快照里，但该 Provider 的凭据确实能出图：合成进路由索引，
	// 否则「只写 model」的图片请求会 503，/v1/models 也不会列出这些模型。
	store.SetSynthesizedModelSource(images.NativeImageModelIDs)
	modelCatalogStore, err := modelcatalog.NewStore()
	if err != nil {
		_ = store.Close()
		return nil, fmt.Errorf("创建全局模型目录投影 Store 失败: %w", err)
	}
	clientVersions, err := newClientVersions(ctx, options.AIHomeDir)
	if err != nil {
		_ = store.Close()
		return nil, fmt.Errorf("创建客户端版本解析器失败: %w", err)
	}
	codexVersions := clientVersions.Codex
	// 能力事实走独立的能力抽象：上游账号目录声明优先，models.dev 只作为兼容来源
	// （它与 pricing 插件是两套不同的抽象，绝不共用）。
	capabilityContract, err := capabilitycontract.New(capabilitybaseline.Embedded())
	if err != nil {
		_ = clientVersions.Close()
		_ = store.Close()
		return nil, fmt.Errorf("加载模型能力基线失败: %w", err)
	}
	// 能力事实按权威顺序合并：上游账号目录声明（注册表内部最高）→ aih.db 投影 →
	// 冻结能力基线。models.dev 不再参与任何能力事实（它只是价格插件）。
	modelModalities := modelmetadata.NewCapabilityRegistry(modelmetadata.CapabilityRegistryOptions{
		Sources: []modelmetadata.FactsSource{
			capabilityprojection.New(modelCatalogStore),
			capabilityContract,
		},
		SourceID: "capabilities",
	})
	agyModelWires := newAgyModelWires(options.AIHomeDir)
	modelDiscovery, err := newModelDiscovery(catalog, options.ModelDiscoverers, codexVersions, agyModelWires, modelModalities, options.AIHomeDir)
	if err != nil {
		_ = clientVersions.Close()
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
		_ = clientVersions.Close()
		_ = store.Close()
		return nil, fmt.Errorf("创建账号运行态失败: %w", err)
	}
	// 启动时把持久化的账号运行态投影进征召索引：Node 推来的 auth_invalid 阻塞
	// 不能因为进程重启就消失。读失败直接失败启动——带着未知阻塞跑路由更危险。
	seededStates, seedErr := store.ListAccountStates(ctx)
	if seedErr != nil {
		_ = clientVersions.Close()
		_ = store.Close()
		return nil, fmt.Errorf("加载账号运行态失败: %w", seedErr)
	}
	for _, state := range seededStates {
		if seedErr := inMemoryRuntime.ApplyAccountState(ctx, state); seedErr != nil {
			_ = clientVersions.Close()
			_ = store.Close()
			return nil, fmt.Errorf("投影账号运行态失败: %w", seedErr)
		}
	}
	outcomeRecorder, err := newAccountOutcomeRecorder(ctx, store, options.ErrorLog)
	if err != nil {
		_ = clientVersions.Close()
		_ = store.Close()
		return nil, fmt.Errorf("创建账号结果记录器失败: %w", err)
	}
	// Initialize the existing management projection before any inference handler
	// receives the fact writer. Both tables share aih.db; every new fact below
	// is projected in the account writer's own transaction, not a Node poller.
	usageDBPath, err := sqliteaccount.DatabasePath(options.AIHomeDir)
	if err != nil {
		_ = outcomeRecorder.Close()
		_ = clientVersions.Close()
		_ = store.Close()
		return nil, err
	}
	usageProjection, err := managementops.NewUsageStore(ctx, usageDBPath, catalogProviderIDs(catalog), time.Now)
	if err != nil {
		_ = outcomeRecorder.Close()
		_ = clientVersions.Close()
		_ = store.Close()
		return nil, fmt.Errorf("打开 Go 用量事实投影失败: %w", err)
	}
	projectionTransferred := false
	defer func() {
		if !projectionTransferred {
			_ = usageProjection.Close()
		}
	}()
	// 所有运行态记账入口都经过装饰器，为账号页状态条计数，见 account_outcomes.go。
	tokenEvents := newTokenEventBus()
	accountRuntime := outcomeRecordingRuntime{
		serverAccountRuntime:       inMemoryRuntime,
		outcomes:                   outcomeRecorder,
		usage:                      accountusagefeed.NewFeed(accountusagefeed.DefaultCapacity, time.Now()),
		usageLedger:                &projectedUsageLedger{facts: store, projection: usageProjection},
		accounts:                   store,
		errorLog:                   options.ErrorLog,
		quotaRefresh:               newQuotaFailureRefresh(store, time.Now, options.ErrorLog),
		credentialRejectionRefresh: newCredentialRejectionRefresh(),
		tokenEvents:                tokenEvents,
	}
	// 账号删除的宿主运行时探测与强制释放都在 Go 侧完成：Node 不再为删除提供
	// 宿主清理回调，tmux 会话按登记 + 账号 socket 两份事实核对，探测不确定即失败关闭。
	deletionOccupancy, err := accountremoval.New(accountremoval.Options{AIHomeDir: options.AIHomeDir})
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
	webuiAccountsSource, err := webuiaccountsapi.OpenSQLiteSource(webuiaccountsapi.SQLiteOptions{AIHomeDir: options.AIHomeDir})
	if err != nil {
		_ = clientVersions.Close()
		_ = store.Close()
		return nil, fmt.Errorf("打开账号页读模型数据源失败: %w", err)
	}
	deferredGateway := &deferredHTTPHandler{}
	// HTTP 流生命周期与 Router 的 readyz 共享同一个登记器：重启前的活跃推理
	// 判断必须和关闭时实际等待的流使用同一份事实。
	streams := newStreamShutdown()
	handlers, resources, err := newHandlers(handlerDependencies{
		TranslationGateway:         deferredGateway,
		Context:                    ctx,
		WebUIAccountsSource:        webuiAccountsSource,
		Catalog:                    catalog,
		Store:                      store,
		AIHomeDir:                  options.AIHomeDir,
		ProxyPool:                  options.ProxyPool,
		NodeBaseURL:                options.NodeBaseURL,
		SelfBaseURL:                options.SelfBaseURL,
		DesktopManagedByHost:       options.DesktopManagedByHost,
		CodexHooks:                 options.CodexHooks,
		ModelDiscovery:             modelDiscovery,
		Runtime:                    accountRuntime,
		OutcomeRecorder:            outcomeRecorder,
		AttemptUsage:               accountRuntime,
		ImageUsage:                 accountRuntime,
		ImageOutcomes:              accountRuntime,
		DeletionOccupancy:          deletionOccupancy,
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
		ClaudeVersions:             clientVersions.Claude,
		AGYModelWires:              agyModelWires,
		ModelModalities:            modelModalities,
		ModelCatalogStore:          modelCatalogStore,
		RouteObserver:              codexresponsesws.FileRouteObserver{AIHomeDir: options.AIHomeDir},
		HostHomeDir:                hostHomeDir,
		TokenEvents:                tokenEvents,
	})
	if err != nil {
		_ = webuiAccountsSource.Close()
		_ = clientVersions.Close()
		_ = store.Close()
		return nil, err
	}
	handlers.webUI = webUI
	handlers.remoteWebUI = remoteWebUI
	handlers.frontDoor = frontDoor
	catalogStatus := handlers.catalogStatus
	handlers.catalogStatus = func() catalogReadiness {
		status := catalogReadiness{}
		if catalogStatus != nil {
			status = catalogStatus()
		}
		return status
	}
	webuiAccountsAuthorizer, err := accountsapi.NewBearerAuthorizer(options.ManagementKey)
	if err != nil {
		_ = webuiAccountsSource.Close()
		_ = clientVersions.Close()
		_ = store.Close()
		return nil, fmt.Errorf("创建账号页读模型鉴权失败: %w", err)
	}
	webuiAccountsHandler, err := webuiaccountsapi.NewHandler(webuiaccountsapi.Dependencies{
		Authorizer: webuiAccountsAuthorizer,
		Source:     webuiAccountsSource,
	})
	if err != nil {
		_ = webuiAccountsSource.Close()
		_ = clientVersions.Close()
		_ = store.Close()
		return nil, fmt.Errorf("创建账号页读模型接口失败: %w", err)
	}
	resources = append(resources, webuiAccountsSource)
	handlers.webuiAccounts = webuiAccountsHandler
	resources = append(resources, clientVersions, outcomeRecorder, usageProjection, store, writerLease)
	projectionTransferred = true
	leaseTransferred = true
	rootHandler := withManagementBrowserAccess(handlers.metrics.Middleware(newRouter(handlers)))
	// CodeBuddy 网关档的 models.json 投影：账号/模型写请求后防抖刷新，
	// 启动后先做一次初始刷新，周期对账兜底漏事件。
	if codeBuddyModels := newCodeBuddyModelsProjection(options); codeBuddyModels != nil {
		codeBuddyModels.Start(ctx)
		resources = append(resources, codeBuddyModels)
		rootHandler = withCodeBuddyModelsTrigger(rootHandler, codeBuddyModels.Trigger)
	}
	deferredGateway.set(rootHandler)
	resources = append(resources, startServerWarmups(ctx, rootHandler, handlers.warmupDeps, options.ManagementKey))
	server := newServer(rootHandler, resources, options, streams)
	server.desktopTranslation = handlers.desktopTranslation
	return server, nil
}

// handlerDependencies 汇总 newHandlers 的全部输入。
//
// 为什么是结构体而不是位置参数：这里曾经有 26 个位置参数，其中同一个运行态对象连续
// 占了三格（运行态 / 生图用量 / 生图结果）。新增一个 Provider 能力时，少写一个参数或
// 调换两个同类型参数都会**静默**把依赖接到错误的端口上——三个同类型参数编译器不会报错。
// 具名字段把这类错误变成编译错误，也让新增依赖的 diff 只有一行。
// modelSettingsLoader 让定价 Resolver 读取 appstate 中的账号模型自定义价格。
type modelSettingsLoader struct{ path string }

func (loader modelSettingsLoader) Load(ctx context.Context) (modelcatalogsettings.Settings, error) {
	return modelcatalogsettings.Load(ctx, loader.path)
}

type handlerDependencies struct {
	Context context.Context
	Catalog *providers.Catalog
	Store   *sqliteaccount.Store
	// AIHomeDir 供宿主事实读取（如 zcode 官方 harness）；不参与账号存储。
	AIHomeDir string
	// ProxyPool 是进程级上游代理池，WebUI 保存后热更新。
	ProxyPool *outboundproxy.Manager
	// NodeBaseURL 是 Node 回环地址；插件实例启停回调 Node 内部协议时需要。
	NodeBaseURL string
	// SelfBaseURL 是本进程回环地址；内部回调不该绕道 Node。
	SelfBaseURL          string
	DesktopManagedByHost bool
	// CodexHooks preserves explicit native-server hook startup options.
	CodexHooks     CodexHooksOptions
	ModelDiscovery *accountapp.ModelDiscovery
	// Runtime 同时实现运行态、生图用量与生图结果三个端口。
	Runtime         serverAccountRuntime
	OutcomeRecorder *accountoutcomes.Recorder
	// AttemptUsage 记录透传通道的真实 token 用量（由运行态装饰器实现）。
	AttemptUsage relaycore.UsageRecorder
	// ImageUsage 记录生图的 token 用量（与推理路径同一个用量管道）；为 nil 时不记账。
	ImageUsage imagesapi.UsageRecorder
	// ImageOutcomes 记录生图成功（账号页最近成功 + 清 cooldown）；为 nil 时不记录。
	ImageOutcomes             imagesapi.ImageOutcomes
	DeletionOccupancy         accountapp.DeletionOccupancy
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
	ClaudeVersions             *clientversion.Resolver
	AGYModelWires              *agycodeassist.ModelWireStore
	ModelModalities            modelmetadata.Catalog
	ModelCatalogStore          *modelcatalog.Store
	// RouteObserver 落原生 WS 每轮选号（终端标题的当前路由帧）；Node 看不到 WS 管道里的选号。
	RouteObserver codexresponsesws.RouteObserver
	// HostHomeDir 是宿主 CLI 配置文件所在家目录；工具权限设置的 host* 探测需要它。
	HostHomeDir string
	// TokenEvents 把推理结算的 token 用量注入账号实时流；晚绑定到 Hub。
	TokenEvents *tokenEventBus
	// WebUIAccountsSource 是账号页读模型数据源；watch 快照与列表共用同一份只读连接。
	WebUIAccountsSource webuiaccountsapi.Source
	// ReverseTunnels 维护 ssh_connections.reverseTunnel；由 newHandlers 创建并随进程关闭。
	ReverseTunnels     *sshtunnel.Supervisor
	TranslationGateway http.Handler
}

// newHandlers 共享数据库、运行态和鉴权端口，并保持各 HTTP 边界隔离。
func newHandlers(dependencies handlerDependencies) (_ serverHandlers, _ []io.Closer, resultErr error) {
	// 价格插件配置在 app_kv；必须在 Default() 首次调用前注入。
	pricingresolver.Configure(dependencies.Store)
	// 局部别名让下面这段长流水线保持原有可读性；新增依赖只需在结构体里加字段。
	ctx := dependencies.Context
	catalog := dependencies.Catalog
	store := dependencies.Store
	aiHomeDir := dependencies.AIHomeDir
	if settingsPath, pathErr := appstate.DatabasePath(aiHomeDir); pathErr == nil {
		pricingresolver.ConfigureManual(modelSettingsLoader{path: settingsPath})
	}
	nodeBaseURL := dependencies.NodeBaseURL
	selfBaseURL := dependencies.SelfBaseURL
	modelDiscovery := dependencies.ModelDiscovery
	accountRuntime := dependencies.Runtime
	attemptUsage := dependencies.AttemptUsage
	imageUsage := dependencies.ImageUsage
	imageOutcomes := dependencies.ImageOutcomes
	deletionOccupancy := dependencies.DeletionOccupancy
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
	claudeVersions := dependencies.ClaudeVersions
	agyModelWires := dependencies.AGYModelWires
	modelModalities := dependencies.ModelModalities
	modelCatalogStore := dependencies.ModelCatalogStore
	routeObserver := dependencies.RouteObserver
	var usage *usageComposition
	var modelRefresh *accountapp.ModelRefreshCoordinator
	var hooksRuntime *codexHooksRuntime
	var sessionEventBus *sessionevents.Bus
	var backgroundDaemons *backgroundDaemonsRuntime
	var housekeepingDaemons *HousekeepingDaemons
	var distributionUpdates io.Closer
	var upgradeScheduler *providercliupgrade.Scheduler
	var windowScheduler *windowactivation.Scheduler
	var proxyServeManager *proxyserve.Manager
	var pluginBundle *localPluginRuntimeBundle
	var egressManager *runtimeegress.Manager
	// 刷新/额度/Relay/图片共用同一份账号出口解析与连接池；Manager 在组合根
	// 后段创建，这里用延迟取值。
	egressClients := newAccountEgressClients(func() *runtimeegress.Manager {
		return egressManager
	}, 0)
	var chatRuntimeService *chatruntime.Service
	var requirementsRuntimeService *requirementsRuntime
	var clipboardRuntimeService *clipboardRuntime
	var chatPrewarmCloser io.Closer
	var watchWSCloser io.Closer
	defer func() {
		if resultErr != nil && watchWSCloser != nil {
			_ = watchWSCloser.Close()
		}
		if resultErr != nil && usage != nil {
			_ = usage.Close()
		}
		if resultErr != nil && modelRefresh != nil {
			_ = modelRefresh.Close()
		}
		if resultErr != nil && hooksRuntime != nil {
			_ = hooksRuntime.Close()
		}
		if resultErr != nil && sessionEventBus != nil {
			sessionEventBus.Close()
		}
		if resultErr != nil && backgroundDaemons != nil {
			_ = backgroundDaemons.Close()
		}
		if resultErr != nil && housekeepingDaemons != nil {
			_ = housekeepingDaemons.Close()
		}
		if resultErr != nil && upgradeScheduler != nil {
			_ = upgradeScheduler.Close()
		}
		if resultErr != nil && windowScheduler != nil {
			_ = windowScheduler.Close()
		}
		if resultErr != nil && proxyServeManager != nil {
			proxyServeManager.Close()
		}
		if resultErr != nil && pluginBundle != nil {
			_ = pluginBundle.Close()
		}
		if resultErr != nil && egressManager != nil {
			_ = egressManager.Close()
		}
		if resultErr != nil && chatPrewarmCloser != nil {
			_ = chatPrewarmCloser.Close()
		}
		if resultErr != nil && clipboardRuntimeService != nil {
			_ = clipboardRuntimeService.Close()
		}
		if resultErr != nil && requirementsRuntimeService != nil {
			_ = requirementsRuntimeService.Close()
		}
		if resultErr != nil && chatRuntimeService != nil {
			_ = chatRuntimeService.Close()
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
	credentialRuntime, err := newCredentialRefreshRuntime(
		ctx,
		aiHomeDir,
		store,
		errorLog,
		egressClients,
		delegateCredentialRefresh,
	)
	if err != nil {
		return serverHandlers{}, nil, err
	}
	oauthClient := credentialRuntime.oauthClient
	codexProvider := credentialRuntime.codexProvider
	claudeProvider := credentialRuntime.claudeProvider
	upstream429Store := credentialRuntime.upstream429Store
	upstream429Controller := credentialRuntime.upstream429Controller
	credentials := credentialRuntime.credentials
	ownsCredentialRefresh := credentialRuntime.ownsCredentialRefresh
	modelUsage, err := newModelUsageRuntime(
		ctx,
		aiHomeDir,
		catalog,
		store,
		modelDiscovery,
		credentials,
		accountRuntime,
		errorLog,
		usageClient,
		egressClients,
		codexVersions,
		claudeVersions,
		reauthenticator,
	)
	if err != nil {
		return serverHandlers{}, nil, err
	}
	recoveringReauthenticator := modelUsage.recoveringReauthenticator
	recoveringModelManagement := modelUsage.recoveringModelManagement
	modelRefresh = modelUsage.modelRefresh
	management := modelUsage.management
	usage = modelUsage.usage
	credentialRotator := modelUsage.credentialRotator
	modelRefreshingCredentialRotator := modelUsage.modelRefreshingCredentialRotator
	// 宿主投影（直连授权回收 + AIH Server 落点）由 Go 自己承接。宿主配置文件
	// 同步仍是 Node 的投影，通过 GatewaySync 端口注入；端口缺省时按 Node 同款
	// 原因码如实上报，绝不先写档位再等宿主。
	deletionLifecycle, err := newAccountDeletionLifecycle(accountDeletionInputs{
		aiHomeDir:          aiHomeDir,
		hostHomeDir:        dependencies.HostHomeDir,
		catalog:            catalog,
		store:              store,
		nodeBaseURL:        nodeBaseURL,
		managementKey:      managementKey,
		occupancy:          deletionOccupancy,
		preparation:        deletionPreparation,
		chatRuntimeService: func() *chatruntime.Service { return chatRuntimeService },
		upstream429Store:   upstream429Store,
		modelRefresh:       modelRefresh,
		usage:              usage,
		accountRuntime:     accountRuntime,
		credentials:        credentials,
	})
	if err != nil {
		return serverHandlers{}, nil, err
	}
	deletionHost := deletionLifecycle.host
	deletionRuntime := deletionLifecycle.guard
	accountLifecycle, err := newAccountRegistrationRuntime(
		registrar,
		modelRefresh,
		usage,
		recoveringReauthenticator,
		store,
	)
	if err != nil {
		return serverHandlers{}, nil, err
	}
	scheduledRegistrar := accountLifecycle.registrar
	scheduledReauthenticator := accountLifecycle.reauthenticator
	accountImporter := accountLifecycle.importer
	authorizer, err := accountsapi.NewBearerAuthorizer(managementKey)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建账号管理鉴权失败: %w", err)
	}
	// WebUI 终端：PTY 会话、回放缓冲与 mux SSE 全部由 Go 承接，Node 只做管理密钥后的反代。
	// ExitRetention 对齐 Node「退出后 250ms 清理」的语义：否则连续开关终端会让已退出
	// 会话在保留期内继续占住 24 个会话名额。
	startupContext := dependencies.Context
	if startupContext == nil {
		startupContext = context.Background()
	}
	appStateDatabasePath, _ := appstate.DatabasePath(aiHomeDir)
	knownHostKeys := make(map[string]string)
	if raw, found, readErr := appstate.ReadKV(startupContext, appStateDatabasePath, "ssh_known_hosts"); readErr == nil && found {
		var records map[string]struct {
			Fingerprint string `json:"fingerprint"`
		}
		if json.Unmarshal([]byte(raw), &records) == nil {
			for id, record := range records {
				if strings.TrimSpace(record.Fingerprint) != "" {
					knownHostKeys[strings.ToLower(id)] = record.Fingerprint
				}
			}
		}
	}
	sshProxySupervisor := sshproxy.New(aiHomeDir, dependencies.HostHomeDir, knownHostKeys)
	sshTunnelSupervisor := sshtunnel.NewWithHostKeys(dependencies.HostHomeDir, knownHostKeys, func(ctx context.Context, config sshremote.Config, remotePort, localPort int) (sshtunnel.Tunnel, error) {
		return sshremote.OpenReverseTunnel(ctx, config, remotePort, localPort)
	})
	if sshSource, sourceErr := webuisshapi.OpenSource(dependencies.AIHomeDir); sourceErr == nil {
		if raw, found, readErr := sshSource.ReadConnections(startupContext); readErr == nil && found {
			_ = sshTunnelSupervisor.Reconcile([]byte(raw))
			_ = sshProxySupervisor.Reconcile([]byte(raw))
		}
	}
	if dependencies.Context != nil {
		go func() {
			<-dependencies.Context.Done()
			sshTunnelSupervisor.Close()
			sshProxySupervisor.Close()
		}()
	}
	terminalService := terminalsession.NewService(pty.NewStarter(), terminalsession.Options{
		MaxSessions:   64, // Multiple overviews each own a separate borrowed client.
		ExitRetention: 250 * time.Millisecond,
		// WebUI SSH 终端：Node 传入连接事实，Go 直接建 SSH PTY。
		RemoteStarter: func(ctx context.Context, remote terminalsession.RemoteSpec, size pty.Size) (pty.Session, error) {
			config, ok := remote.Config.(sshremote.Config)
			if !ok {
				return nil, errors.New("SSH 终端配置类型无效")
			}
			return sshremote.OpenReconnectingPTY(ctx, config, remote.Command, sshremote.PTYOptions{
				Cols: size.Cols,
				Rows: size.Rows,
				Env:  remote.Env,
			})
		},
	})
	// 同一个 tmux 探测实例同时服务 WebUI 终端与 SSH 工作区状态，避免两套实现漂移。
	terminalDurable := webuiterminalapi.NewTmuxStore()
	webUITerminalHandler, err := webuiterminalapi.NewHandler(webuiterminalapi.Dependencies{
		Authorizer:     authorizer,
		Sessions:       terminalService,
		Durable:        terminalDurable,
		NativeSessions: &persistent.TmuxSessionStore{AIHomeDir: aiHomeDir},
	})
	if err != nil {
		_ = terminalService.Close()
		return serverHandlers{}, nil, fmt.Errorf("创建 WebUI 终端接口失败: %w", err)
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
	clientKeyService, err := clientkeysapp.NewService(store, clientKey, time.Now)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建客户端 API Key 服务失败: %w", err)
	}
	clientKeyStats, err := clientkeystats.NewTracker(clientkeystats.Options{Store: store, Clock: time.Now})
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建客户端 Key 统计器失败: %w", err)
	}
	clientkeystats.Install(clientKeyStats)
	go clientKeyService.Start(ctx)
	go clientKeyStats.Start(ctx)
	// 并发准入控制器：系统/Key/账号/账号+模型四层天花板、有界 FIFO 队列。
	// 初始配置来自 server 配置的 concurrency 对象；未配置时回落旧环境变量默认值。
	admissionController := admission.NewController(startupConcurrencyConfig(ctx, aiHomeDir))
	admissionController.SetKeyLimitSource(func(keyID string) (admission.KeyLimits, bool) {
		limits, ok := clientKeyService.Limits(keyID)
		if !ok {
			return admission.KeyLimits{}, false
		}
		return admission.KeyLimits{
			MaxConcurrency:  limits.MaxConcurrency,
			RPMLimit:        limits.RPMLimit,
			TPMLimit:        limits.TPMLimit,
			DailyTokenLimit: limits.DailyTokenLimit,
		}, true
	})
	admissionController.SetRateWindows(clientKeyStats)
	admissionController.SetRateRecorder(clientKeyStats)
	admission.Install(admissionController)
	go admissionController.RefreshAccountLimitsLoop(ctx, store, 5*time.Second)
	go refreshAdmissionConfigLoop(ctx, admissionController, aiHomeDir, 5*time.Second)
	clientAuthorizer, err := clientauth.NewAuthorizer(
		clientKey,
		clientauth.WithManagedKeys(clientKeyService),
		clientauth.WithStatsTracker(clientKeyStats),
	)
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
	// 成本口径：优先走统一 Resolver（models.dev 内置来源 + 后续自定义插件），
	// 旧定价表只作为未收录模型的兜底；都没有时成本标为「未知」而不是 0 元。
	var costCalculator *usagepricing.ModelCostCalculator
	pricingResolver, pricingErr := pricingresolver.Default()
	// 别名展开属于目录数据源能力，由组合层注入具体插件；transport 只依赖接口。
	modelAliasExpander, _ := modelsdevpricing.New()
	if pricingErr == nil {
		costCalculator, err = usagepricing.NewModelCostCalculatorWithResolver(store, pricingResolver, providerIDs(catalog))
	} else {
		costCalculator, err = usagepricing.NewModelCostCalculator(store, providerIDs(catalog))
	}
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
	usageQuotaBucketsHandler, err := usagestatsapi.NewQuotaBucketsHandler(authorizer, store)
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建 Go 额度档位用量 Handler 失败: %w", err)
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
	accountAuth, err := newAccountAuthRuntime(accountAuthInputs{
		ctx:                ctx,
		aiHomeDir:          aiHomeDir,
		catalog:            catalog,
		store:              store,
		management:         management,
		models:             recoveringModelManagement,
		usage:              usage.service,
		quotaStats:         quotaStatsService,
		deletion:           deletionRuntime,
		defaults:           providerDefaults,
		selections:         launchAccountSelector,
		credentialRotation: modelRefreshingCredentialRotator,
		registrar:          scheduledRegistrar,
		importer:           accountImporter,
		staticCredentials:  credentialFactory,
		nativeAccounts:     decoder,
		runtimeStates:      accountRuntime,
		authorizer:         authorizer,
		oauthClient:        oauthClient,
		codexProvider:      codexProvider,
		claudeProvider:     claudeProvider,
		decoder:            decoder,
		jobRegistrar:       scheduledRegistrar,
		reauth:             scheduledReauthenticator,
		tokenEvents:        dependencies.TokenEvents,
		loginEgress:        newLoginEgress(sshproxy.NewLeaseManager(sshProxySupervisor, aiHomeDir, egressManager)),
	})
	if err != nil {
		return serverHandlers{}, nil, err
	}
	accountsHandler := accountAuth.accountsHandler
	jobs := accountAuth.jobs
	accountAuthHandler := accountAuth.httpHandler
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
		Transport:     wrapOutboundTransport(newUpstreamTransport()),
		Timeout:       claudeRelayHTTPTimeout,
		CheckRedirect: rejectOAuthRedirect,
	}
	if relayHTTPClient != nil {
		relayClient = relayHTTPClient
	}
	// Relay 与 Canonical 共用同一份出口 Manager；Manager 在组合根后段创建，
	// 这里用延迟取值避免把 nil 固化进解析器。
	relayEgress := newRelayAccountEgress(func() *runtimeegress.Manager {
		return egressManager
	}, claudeRelayHTTPTimeout)
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
	upstreamRulesRepository := sqliteaccount.NewUpstreamErrorRuleRepository(store)
	if _, err := upstreamRulesRepository.AuthoritySnapshot(ctx); err != nil {
		return serverHandlers{}, nil, fmt.Errorf("admit Go upstream-rule authority: %w", err)
	}
	upstreamRulesService, err := upstreamrules.NewService(upstreamrules.Options{
		Repository:         upstreamRulesRepository,
		Groups:             upstreamMappingService,
		SupportedProviders: upstreamErrorRuleProviders,
	})
	if err != nil {
		return serverHandlers{}, nil, fmt.Errorf("创建上游错误规则服务失败: %w", err)
	}
	upstreamRuleEvaluator := configured.NewEvaluator(upstreamRulesService)
	// 选号前额度门禁：与 Node account-usage-gate 同口径，阈值读 config:usage。
	usageGate := newUsageSchedulingGate(usage.service, aiHomeDir, time.Now)
	inference, err := newInferenceRuntime(inferenceRuntimeInputs{
		ctx:                       ctx,
		catalog:                   catalog,
		store:                     store,
		runtime:                   accountRuntime,
		weights:                   accountRuntime,
		usageGate:                 usageGate,
		strategy:                  selectionStrategy,
		models:                    recoveringModelManagement,
		modelRefreshes:            modelRefresh,
		credentials:               credentials,
		delegateCredentialRefresh: delegateCredentialRefresh,
		ownsCredentialRefresh:     ownsCredentialRefresh,
		authorizer:                clientAuthorizer,
		httpClient:                inferenceClient,
		decodeErrors:              decodeErrors,
		upstreamDecodeErrors:      upstreamDecodeErrors,
		errorLog:                  errorLog,
		requestRewriter:           visionGuard,
		effortLadders:             modelModalities,
		codexVersions:             codexVersions,
		claudeVersions:            claudeVersions,
		agyModelWires:             agyModelWires,
		upstreamRules:             upstreamRuleEvaluator,
		upstream429Retries:        upstream429Controller,
		egressManager:             func() *runtimeegress.Manager { return egressManager },
	})
	if err != nil {
		return serverHandlers{}, nil, err
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
	aliasService.SetDisplaySource(func(ctx context.Context, pattern string) ([]string, error) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		return aliasdisplay.List(pattern, time.Now().UTC())
	})
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
	if modelCatalogStore == nil {
		modelCatalogStore, err = modelcatalog.NewStore()
		if err != nil {
			_ = inference.Close()
			return serverHandlers{}, nil, fmt.Errorf("创建全局模型目录投影 Store 失败: %w", err)
		}
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
	subAggAIHome := strings.TrimSpace(aiHomeDir)
	if subAggAIHome == "" && strings.TrimSpace(dependencies.HostHomeDir) != "" {
		subAggAIHome = filepath.Join(strings.TrimSpace(dependencies.HostHomeDir), ".ai_home")
	}
	var subAggSvc *subaggregator.Service
	if subAggAIHome != "" {
		renderCatalog := renderplugin.Load(subAggAIHome)
		if !renderCatalog.Available() && errorLog != nil {
			errorLog.Printf("订阅渲染插件不可用：未发现 aih-render-* 或 plugins/renderers manifest")
		}
		subAggSvc = subaggregator.NewService(subAggAIHome, subaggregator.ServiceOptions{
			HostHomeDir: strings.TrimSpace(dependencies.HostHomeDir),
			Rendering:   renderCatalog,
		})
	}
	subAggregatorPublicHandler, err := newPublicSubaggregatorHandlerWithService(subAggSvc)
	if err != nil {
		_ = inference.Close()
		return serverHandlers{}, nil, err
	}
	if hooksAIHome := strings.TrimSpace(aiHomeDir); hooksAIHome != "" {
		sessionEventBus = newManagedSessionEventBus(ctx, sessionevents.BusOptions{
			AIHomeDir:   hooksAIHome,
			HostHomeDir: dependencies.HostHomeDir,
		})
		hookOptions := buildCodexHooksDaemonOptions(Options{
			AIHomeDir:   hooksAIHome,
			NodeBaseURL: nodeBaseURL,
			SelfBaseURL: dependencies.SelfBaseURL,
			CodexHooks:  dependencies.CodexHooks,
		}, hooksAIHome, sessionEventBus, errorLog)
		hookOptions.Context = ctx
		hookOptions.HostHomeDir = dependencies.HostHomeDir
		hooksRuntime, err = startCodexHooksDaemons(hookOptions)
		if err != nil {
			_ = inference.Close()
			return serverHandlers{}, nil, err
		}
	}
	codexAppServerHandler, err := newCodexAppServerWSHandler(clientAuthorizer, dependencies)
	if err != nil {
		_ = inference.Close()
		return serverHandlers{}, nil, fmt.Errorf("创建 Codex app-server 代理失败: %w", err)
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
	// 原生 Messages 上游投影：官方 OAuth 与厂商契约登记的 Anthropic 兼容端点
	// 共用同一条判断，租约选择与 native relay 都只依赖这个抽象。
	messagesUpstream := transportpolicy.NewDefaultMessagesUpstream()
	claudeGatewayPolicy, err := transportpolicy.NewGatewayPolicy(
		inference.claudeUpstream,
		messagesUpstream,
	)
	if err != nil {
		_ = inference.Close()
		return serverHandlers{}, nil, fmt.Errorf(
			"创建 Claude Gateway 传输策略失败: %w",
			err,
		)
	}
	codexHTTPHandler, err := codexresponseshttp.NewHandler(codexresponseshttp.Dependencies{
		Authorizer:         clientAuthorizer,
		Accounts:           codexHTTPAccountSource{catalog: catalog, routes: inference.Routes(), recruiter: inference.recruiter, transport: inference.codexUpstream},
		Upstream:           inference.codexUpstream,
		Fallback:           inference.handler,
		Attempts:           accountRuntime,
		Credentials:        credentials,
		ModelRefreshes:     inference.modelRefreshes,
		Upstream429Retries: upstream429Controller,
		Clock:              time.Now,
		Rules:              upstreamRuleEvaluator,
		FailureLog:         newCodexResponsesFailureLogger(errorLog),
		Ladders:            modelModalities,
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
	nativeRelayHandler, err := newClaudeNativeRelay(claudeNativeRelayInputs{
		catalog:          catalog,
		recruiter:        inference.recruiter,
		claudePolicy:     claudeGatewayPolicy,
		authorizer:       relayAuthorizer,
		credentials:      credentials,
		client:           relayClient,
		egress:           relayEgress,
		attempts:         accountRuntime,
		modelRefreshes:   inference.modelRefreshes,
		upstream429:      upstream429Controller,
		rules:            upstreamRuleEvaluator,
		errorLog:         errorLog,
		fallback:         inference.handler,
		messagesUpstream: messagesUpstream,
		clientVersions:   claudeVersions,
	})
	if err != nil {
		_ = inference.Close()
		return serverHandlers{}, nil, err
	}
	// 家族透传通道（CodeBuddy / WorkBuddy 四支）与 Native Relay 共用凭据解析、上游客户端
	// 与运行态记账；能承载的家族请求直连家族官方端点，其余交回 Canonical（见包注释）。
	//
	// 账号来源与 Native Relay 同构（未钉选走 Canonical 的调度器，钉选只认该账号）：
	// 家族模型目录经无客户端 HTTP 通道进入 Go 的账号索引后，未钉选征召按家族表链式
	// 开启多个会话；模型没有家族候选时安静交回 Canonical。Node 侧交还门按「透传通道」
	// 判定哪些模型交给这里，本通道不为「别的 Provider 的模型」兜底。
	familyRelayClient := newFamilyFingerprintHTTPClient()
	if relayHTTPClient != nil {
		familyRelayClient = relayHTTPClient
	}
	familyRelay, err := newFamilyRelayRuntime(familyRelayInputs{
		catalog:          catalog,
		recruiter:        inference.recruiter,
		aiHomeDir:        aiHomeDir,
		aliases:          inference.modelAliases,
		store:            dependencies.Store,
		fallback:         inference.handler,
		credentials:      credentials,
		client:           familyRelayClient,
		egress:           familyFingerprintEgress{base: relayEgress},
		attempts:         accountRuntime,
		upstream429:      upstream429Controller,
		usage:            attemptUsage,
		gate:             usageGate,
		routeChecker:     inference.models,
		messagesFallback: nativeRelayHandler,
		responsesFallback: responsesDispatcher{
			canonical:  inference.handler,
			nativeHTTP: codexHTTPHandler,
		},
	})
	if err != nil {
		_ = inference.Close()
		return serverHandlers{}, nil, err
	}
	familyRelayHandler := familyRelay.handler
	pluginProviders := familyRelay.pluginProviders
	// 窗口激活探测回环处理器：直接覆盖 codex /v1/responses、agy /v1beta/models/ 与 /v1/chat/completions，
	// 在 Go 进程内完成 /v1/* 极小探测而不绕经 Node 网关。
	windowProbeMux := http.NewServeMux()
	windowProbeMux.Handle(geminiapi.BetaPathPrefix, inference.gemini)
	windowProbeMux.Handle(openairesponsesapi.Path, responsesDispatcher{
		canonical:  inference.handler,
		nativeHTTP: codexHTTPHandler,
	})
	windowProbeMux.Handle(openaichatcompletionsapi.Path, familyRelayHandler)
	pluginRuntime := newPluginBundleRuntime(pluginBundleInputs{
		ctx:              ctx,
		aiHomeDir:        aiHomeDir,
		authorizer:       authorizer,
		clientAuthorizer: clientAuthorizer,
		store:            store,
		pluginProviders:  pluginProviders,
		catalog:          catalog,
		modelDiscovery:   modelDiscovery,
		inference:        inference,
		errorLog:         errorLog,
	})
	pluginBundle = pluginRuntime.bundle
	sharedPricingService := pluginRuntime.pricing
	egressActivity, err := newEgressActivityRuntime(
		ctx,
		aiHomeDir,
		dependencies.HostHomeDir,
		catalog,
		store,
		accountRuntime,
		dependencies.TokenEvents,
		dependencies.OutcomeRecorder,
		errorLog,
	)
	if err != nil {
		return serverHandlers{}, nil, err
	}
	egressManager = egressActivity.manager
	activityDaemon := egressActivity.activity
	desktopChanged := &desktopSettingsNotifier{}
	nativeWork, nativeWorkErr := worknative.New(worknative.Options{AIHomeDir: aiHomeDir, HostHomeDir: dependencies.HostHomeDir, Catalog: catalog, Store: store, Credentials: credentials, GatewayURL: selfBaseURL, GatewayKey: clientKey})
	if nativeWorkErr != nil {
		return serverHandlers{}, nil, fmt.Errorf("装配 WORK 原生启动边界失败: %w", nativeWorkErr)
	}
	imageEgress := newImageAccountEgress(func() *runtimeegress.Manager {
		return egressManager
	})
	webuiDeps := newWebUIDependencies(webuiDependenciesInputs{
		host:                  dependencies,
		authorizer:            authorizer,
		aiHomeDir:             aiHomeDir,
		catalog:               catalog,
		nodeBaseURL:           nodeBaseURL,
		selfBaseURL:           selfBaseURL,
		managementKey:         managementKey,
		clientKey:             clientKey,
		requestShutdown:       requestShutdown,
		desktopChanged:        desktopChanged,
		metrics:               metrics,
		modelModalities:       modelModalities,
		modelAliasExpander:    modelAliasExpander,
		modelAliasDisplay:     inference.models,
		metadataResolver:      pricingResolver,
		chatModels:            inference.models,
		egressManager:         egressManager,
		upstream429Store:      upstream429Store,
		sshProxies:            sshProxySupervisor,
		reverseTunnels:        sshTunnelSupervisor,
		imageEgress:           imageEgress,
		upstream429Controller: upstream429Controller,
		accountRuntime:        accountRuntime,
		credentials:           credentials,
		upstreamRules:         upstreamRuleEvaluator,
		nativeWork:            nativeWork,
		authJobs:              jobs,
		accountsHandler:       accountsHandler,
		credentialEditor:      credentialRotator,
		providerDefaults:      providerDefaults,
		modelRefresher:        recoveringModelManagement,
		usageService:          usage.service,
		quotaStats:            quotaStatsService,
		terminalProbe: func(sessionKey string) string {
			return string(terminalDurable.Probe(sessionKey).State)
		},
		accountDeletion:           deletionRuntime,
		accountHostGrant:          deletionHost,
		accountImporter:           accountImporter,
		accountActivity:           hookSessionActivityTracker{activity: activityDaemon.Activity()},
		credentialRefresher:       credentials,
		delegateCredentialRefresh: delegateCredentialRefresh,
		terminalHandler:           webUITerminalHandler,
		subAggregator:             subAggSvc,
		sessionEventBus:           sessionEventBus,
		codexHooks:                hooksRuntime,
		familyRelayHandler:        familyRelayHandler,
		pluginBundle:              pluginBundle,
		pricingService:            sharedPricingService,
	})
	startupRuntime, err := newWebUIStartupRuntime(webuiStartupRuntimeInputs{
		ctx:            ctx,
		webuiDeps:      &webuiDeps,
		clientKey:      clientKey,
		windowProbeMux: windowProbeMux,
		authorizer:     authorizer,
		aiHomeDir:      aiHomeDir,
	})
	upgradeScheduler = startupRuntime.upgradeScheduler
	windowScheduler = startupRuntime.windowScheduler
	proxyServeManager = startupRuntime.proxyServeManager
	watchWSCloser = startupRuntime.watchWSCloser
	distributionUpdates = startupRuntime.distributionUpdates
	backgroundDaemons = startupRuntime.backgroundDaemons
	housekeepingDaemons = startupRuntime.housekeepingDaemons
	if err != nil {
		_ = inference.Close()
		return serverHandlers{}, nil, err
	}
	webuiRoutes := startupRuntime.routes
	// 内部聊天入口：账号来源与 Provider 链与家族透传同一批对象。
	chatRuntime, err := newWebUIChatRuntime(webuiChatRuntimeInputs{
		ctx:            ctx,
		host:           dependencies,
		webuiDeps:      webuiDeps,
		authorizer:     authorizer,
		familyRelay:    familyRelay,
		modelAliases:   inference.modelAliases,
		credentials:    credentials,
		relayClient:    relayClient,
		accountRuntime: accountRuntime,
		attemptUsage:   attemptUsage,
	})
	if err != nil {
		_ = inference.Close()
		return serverHandlers{}, nil, err
	}
	webUIChatHandler := chatRuntime.handler
	chatRuntimeService = chatRuntime.service
	chatPrewarmCloser = chatRuntime.prewarmCloser
	webuiRoutes = append(webuiRoutes, chatRuntime.routes...)
	requirementsRuntimeService, requirementRoutes, requirementErr := newRequirementsRuntime(ctx, webuiDeps, chatRuntimeService)
	if requirementErr != nil {
		_ = chatRuntimeService.Close()
		return serverHandlers{}, nil, fmt.Errorf("装配需求管理调度器失败: %w", requirementErr)
	}
	webuiRoutes = append(webuiRoutes, requirementRoutes...)
	clipboardRuntimeService, clipboardRoutes, clipboardErr := newClipboardRuntime(ctx, webuiDeps)
	if clipboardErr != nil {
		return serverHandlers{}, nil, fmt.Errorf("装配剪贴板服务失败: %w", clipboardErr)
	}
	webuiRoutes = append(webuiRoutes, clipboardRoutes...)
	launcherRuntimeService, launcherRoutes, launcherErr := newLauncherRuntime(ctx, webuiDeps)
	if launcherErr != nil {
		return serverHandlers{}, nil, fmt.Errorf("装配应用启动器服务失败: %w", launcherErr)
	}
	webuiRoutes = append(webuiRoutes, launcherRoutes...)
	var desktopTranslationService *desktoptranslation.Service
	if !dependencies.DesktopManagedByHost {
		var desktopRoutes []webuiRoute
		var desktopErr error
		desktopTranslationService, desktopRoutes, desktopErr = newDesktopTranslation(ctx, webuiDeps, chatRuntimeService, clipboardRuntimeService)
		if desktopErr != nil {
			return serverHandlers{}, nil, fmt.Errorf("装配桌面翻译宿主失败: %w", desktopErr)
		}
		launcherRuntimeService.bindDesktopShow(desktopTranslationService)
		// Clipboard settings changes (WebUI or CLI) re-send configure so the native
		// ⌘⌥V shortcut follows capture/sync without restarting the helper.
		clipboardRuntimeService.AddSettingsHook(func() {
			go desktopTranslationService.ReconcileDesktopFeatures(context.Background())
		})
		desktopChanged.attach(desktopTranslationService)
		webuiRoutes = append(webuiRoutes, desktopRoutes...)
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
			Routes:     inference.Routes(),
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
	// 失败探测的到期重试：退避节奏由 application/modelprobes 声明，执行仍复用
	// 同一个 ModelRefreshCoordinator，不引入第二套刷新状态机。
	probeRetry, err := modelprobes.NewProbeRetry(store, modelRefresh, time.Now)
	if err != nil {
		_ = inference.Close()
		return serverHandlers{}, nil, fmt.Errorf("创建账号模型探测到期重试用例失败: %w", err)
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
			Upstream429Retries:     upstream429Controller,
			ModelRefreshes:         inference.modelRefreshes,
			RouteMisses:            routeMissRefresh,
			Clock:                  time.Now,
			Rules:                  upstreamRuleEvaluator,
			Routes:                 routeObserver,
			Ladders:                modelModalities,
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
		ServiceTiers:    codexmodelcatalog.NewReader(),
		ContextWindows:  codexmodelcatalog.NewContextReader(),
		Models:          inference.models,
		Catalog:         modelCatalogStore,
		ProviderCatalog: catalog,
		Modalities:      modelModalities,
		Reasoning:       modelModalities,
		Aliases:         inference.models,
		Authorizer:      clientAuthorizer,
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
			images.EffectiveCodexImageBaseURL(),
			agycodeassist.GenerateContentURL(),
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
		HTTP:                   http.DefaultClient,
		AccountEgress:          imageEgress.HTTPForAccount,
		Authorizer:             clientAuthorizer,
		Blobs:                  images.BlobStoreAdapter{Store: imageBlobs},
		Usage:                  imageUsage,
		Outcomes:               imageOutcomes,
		Upstream429Retries:     upstream429Controller,
		Attempts:               accountRuntime,
		CredentialObservations: credentials,
		Rules:                  upstreamRuleEvaluator,
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
	modelProbeRetryWorker, err := startModelProbeRetryWorker(
		ctx,
		probeRetry,
		errorLog,
	)
	if err != nil {
		_ = modelSweepWorker.Close()
		_ = initialModelRecoveryWorker.Close()
		_ = webSocketHandler.Close()
		_ = routeMissRefresh.Close()
		_ = inference.Close()
		return serverHandlers{}, nil, fmt.Errorf("启动账号模型探测到期重试 worker 失败: %w", err)
	}
	return serverHandlers{
		plugins:               pluginBundle.Handlers,
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
		clientIdentity:        clientAuthorizer.Middleware,
		webUIChat:             webUIChatHandler,
		webUITerminal:         webUITerminalHandler,
		accountOutcomes:       accountOutcomesHandler,
		accountRuntime:        accountRuntimeHandler,
		accountUsageEvents:    accountUsageEventsHandler,
		usageStats:            usageStatsHandler,
		usageModels:           usageModelsHandler,
		usageSessions:         usageSessionsHandler,
		usageImport:           usageImportHandler,
		usageBuckets:          usageBucketsHandler,
		usageQuotaBuckets:     usageQuotaBucketsHandler,
		claudeRelayLeases:     relayLeaseHandler,
		claudeNativeRelay:     nativeRelayHandler,
		familyRelay:           familyRelayHandler,
		relayMessages:         familyRelay.messagesHandler,
		relayResponses:        familyRelay.responsesHandler,
		shutdown:              shutdownHandler,
		modelAliases:          modelAliasesHandler,
		modelAliasesWebUI:     modelAliasesWebUIHandler,
		upstreamMappingGroups: upstreamMappingHandler,
		accountRules:          accountRulesHandler,
		modelCatalog:          modelCatalogHandler,
		webuiRoutes:           webuiRoutes,
		desktopTranslation:    desktopTranslationService,
		subAggregatorPublic:   subAggregatorPublicHandler,
		codexAppServer:        codexAppServerHandler,
		managementStatus:      managementStatusHandler,
		managementMetrics:     managementMetricsHandler,
		metrics:               metrics,
		warmupDeps:            webuiDeps,
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
	}, func() []io.Closer {
		closers := []io.Closer{
			sessionEventBusCloser{bus: sessionEventBus},
			modelSweepWorker,
			modelProbeRetryWorker,
			initialModelRecoveryWorker,
			webSocketHandler,
			routeMissRefresh,
			inference,
			usage,
			modelRefresh,
			terminalService,
			webUITerminalHandler,
		}
		if desktopTranslationService != nil {
			closers = append([]io.Closer{desktopTranslationService}, closers...)
		}
		if watchWSCloser != nil {
			closers = append([]io.Closer{watchWSCloser}, closers...)
		}
		if hooksRuntime != nil {
			closers = append(closers, hooksRuntime)
		}
		if backgroundDaemons != nil {
			closers = append(closers, backgroundDaemons)
		}
		if housekeepingDaemons != nil {
			closers = append(closers, housekeepingDaemons)
		}
		if distributionUpdates != nil {
			closers = append(closers, distributionUpdates)
		}
		if upgradeScheduler != nil {
			closers = append(closers, upgradeScheduler)
		}
		if windowScheduler != nil {
			closers = append(closers, windowScheduler)
		}
		if proxyServeManager != nil {
			// 先停外部入口子进程，再拆它依赖的出口/推理运行时。
			closers = append([]io.Closer{proxyServeManager}, closers...)
		}
		if pluginBundle != nil {
			closers = append(closers, pluginBundle)
		}
		if egressManager != nil {
			closers = append(closers, egressManager)
		}
		if activityDaemon != nil {
			closers = append(closers, activityDaemon)
		}
		if chatPrewarmCloser != nil {
			closers = append(closers, chatPrewarmCloser)
		}
		if clipboardRuntimeService != nil {
			closers = append(closers, clipboardRuntimeService)
		}
		if launcherRuntimeService != nil {
			closers = append(closers, launcherRuntimeService)
		}
		if requirementsRuntimeService != nil {
			closers = append(closers, requirementsRuntimeService)
		}
		if chatRuntimeService != nil {
			closers = append(closers, chatRuntimeService)
		}
		return closers
	}(), nil
}

// acquireAccountWriterLease 等待上一次 Server 退出时释放的单写者租约。
//
// 守护进程会在旧实例优雅关闭期间立即拉起新实例：旧实例仍持有租约时，
// 立即失败会造成 “backup_core_writer_busy” 启动风暴。这里做有界等待，
// 让重启自然交接；超过上限仍返回原始错误，避免掩盖真正的占用者。
func acquireAccountWriterLease(ctx context.Context, home string) (*accountwriterlease.Lease, error) {
	deadline := time.Now().Add(45 * time.Second)
	for {
		lease, err := accountwriterlease.Acquire(home)
		if err == nil {
			return lease, nil
		}
		if !errors.Is(err, accountwriterlease.ErrBusy) || time.Now().After(deadline) {
			return nil, err
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
}

// newWebUIChatHandler 把内部聊天入口装配在管理前缀上。
//
// 单独成函数是为了让「缺依赖必须装配期失败」有直接的测试落点：传入的端口少一个，
// 返回的 error 必须非空，而不是在第一次真实对话时才失败。

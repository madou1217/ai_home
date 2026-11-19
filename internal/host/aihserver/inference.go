package aihserver

import (
	"context"
	"errors"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"io"
	"log"
	"net/http"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	"github.com/madou1217/ai_home/application/accountrouting"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/effortalign"
	"github.com/madou1217/ai_home/application/inferencecatalog"
	"github.com/madou1217/ai_home/application/inferencegateway"
	"github.com/madou1217/ai_home/application/modelalias"
	"github.com/madou1217/ai_home/application/upstreamretry"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	agycodeassist "github.com/madou1217/ai_home/internal/adapters/agy/codeassist"
	"github.com/madou1217/ai_home/internal/adapters/claude/claudeidentity"
	claudemessages "github.com/madou1217/ai_home/internal/adapters/claude/messages"
	"github.com/madou1217/ai_home/internal/adapters/clientversion"
	"github.com/madou1217/ai_home/internal/adapters/codex/codexidentity"
	codexresponses "github.com/madou1217/ai_home/internal/adapters/codex/responses"
	"github.com/madou1217/ai_home/internal/adapters/upstreamfailure/configured"
	"github.com/madou1217/ai_home/internal/host/inferencehttp"
	"github.com/madou1217/ai_home/internal/host/inferenceruntime"
	"github.com/madou1217/ai_home/internal/transport/http/inferenceapi"
)

var errInvalidInferenceComposition = errors.New("生产推理组合依赖无效")

const (
	// defaultInferenceHTTPTimeout 是直接启动 aih-server 时的上游客户端超时。
	// aih server serve 会按 Node 的 upstreamTimeoutMs 默认值通过环境变量覆盖。
	defaultInferenceHTTPTimeout = inferenceapi.StreamTotalTimeout
	// agyFirstByteTimeout 只限制「等到响应头」的时间，不限制流式正文长度。
	// agy 池里偶发某个账号卡住不回首包；共享客户端没有首包超时，单次会吃满
	// 30s 的重试预算，剩下账号来不及接管。12s 内不回首包就换号。
	agyFirstByteTimeout     = 12 * time.Second
	modelRefreshTimeout     = 20 * time.Second
	modelRefreshBaseBackoff = time.Second
	modelRefreshMaxBackoff  = time.Minute
	modelRefreshConcurrency = 1
	// modelRefreshMaxAttempts 限制单账号刷新代次在协调器内的重试次数。退避按 1s 起步、
	// 封顶 1min（1s/2s/4s/8s/16s/32s/60s），8 次累计约 2 分钟；达到后放弃，交由周期
	// 重扫（6h）/路由未命中/按需触发重新入队，避免对确定性失败账号无限重试。
	modelRefreshMaxAttempts = 8
)

// inferenceHTTPTimeout 是上游推理客户端的超时；启动期由 ConfigureUpstreamTimeout 覆盖。
var inferenceHTTPTimeout = defaultInferenceHTTPTimeout

// inferenceComposition 保存推理 HTTP、原子模型目录及其内部生命周期。
type inferenceComposition struct {
	handler   http.Handler
	gemini    http.Handler
	models    *inferencecatalog.AtomicCatalog
	recruiter *accountrouting.Recruiter
	// runtime 是征召与推理终态共享的账号运行态；钉选回落判定复用它，避免另开读取路径。
	runtime        inferenceruntime.AccountRuntime
	codexUpstream  *codexresponses.Adapter
	claudeUpstream *claudemessages.Adapter
	agyUpstream    *agycodeassist.Adapter
	modelRefreshes inferencegateway.ModelRefreshScheduler
	// modelAliases 是 Node 推送的模型别名投影；随管理接口写入，随目录刷新编译。
	modelAliases *modelalias.Store
	// catalogRefresh 在别名投影变更后触发重建，让新别名立即生效。
	catalogRefresh *inferencecatalog.RefreshCoordinator
	closers        []io.Closer
}

// Runtime 返回与征召器共用的账号运行态边界。
func (composition *inferenceComposition) Runtime() inferenceruntime.AccountRuntime {
	if composition == nil {
		return nil
	}
	return composition.runtime
}

// inferenceCompositionDependencies 集中声明生产推理组合所需的窄端口。
type inferenceCompositionDependencies struct {
	catalog *providers.Catalog
	store   *sqliteaccount.Store
	runtime inferenceruntime.AccountRuntime
	weights accountrouting.AccountWeightSource
	// usageGate 是选号前的额度门禁；nil 表示不启用。
	usageGate         accountrouting.UsageGate
	strategy          accountrouting.SelectionStrategy
	models            accountapp.AccountModelRefresher
	modelRefreshes    inferencegateway.ModelRefreshScheduler
	credentialRefresh []accountcredentials.RefreshStrategy
	credentials       inferenceruntime.CredentialResolver
	// delegateCredentialRefresh 与账号管理侧解析器保持同一刷新所有权。
	delegateCredentialRefresh bool
	// ownsCredentialRefresh 与账号管理侧解析器共用同一判定：宿主台账里没有的账号
	// 由 Go 负责刷新（委托模式下也一样）。
	ownsCredentialRefresh func(accountcore.AccountRef) bool
	authorizer            inferencehttp.Authorizer
	httpClient            InferenceHTTPClient
	decodeErrors          func(error)
	responsesDecodeErrors func(error)
	upstreamDecodeErrors  func(error)
	// codexVersions 提供模拟 Codex 客户端时自报的版本；为空时使用编译期最低版本。
	codexVersions clientversion.Source
	// claudeVersions 提供模拟 Claude Code 客户端时自报的版本；为空时使用编译期最低版本。
	claudeVersions clientversion.Source
	// codexRejections 接收 Codex 上游拒绝请求的低敏诊断；可为空。
	codexRejections func(codexresponses.UpstreamRejection)
	clock           func() time.Time
	// requestRewriter 在派发前按 Provider 改写请求（vision guard）。
	requestRewriter inferencegateway.RequestRewriter
	// effortLadders 提供每个模型的推理强度档位，供上游适配器在编码前对齐。
	// nil 表示 Go 不承接该能力（请求原样透传，由上游适配器按原规则处理）。
	effortLadders effortalign.LadderReader
	agyModelWires agycodeassist.ModelWireReader
	// upstreamRules 是账号自定义上游错误规则求值端口；nil 表示 Go 未承接该能力。
	upstreamRules configured.Rules
	// upstream429Retries 是上游 HTTP 429 有界等待重试控制器（可选）。
	upstream429Retries *upstreamretry.Controller
	// componentLog 记录不影响启动的组件级失败（如初次目录刷新）；可为空。
	componentLog *log.Logger
}

// newInferenceComposition 装配模型快照、共享刷新调度器、Canonical Runtime 和 HTTP。
func newInferenceComposition(
	ctx context.Context,
	dependencies inferenceCompositionDependencies,
) (_ *inferenceComposition, resultErr error) {
	if !validInferenceDependencies(ctx, dependencies) {
		return nil, errInvalidInferenceComposition
	}
	composition := &inferenceComposition{}
	defer func() {
		if resultErr != nil {
			_ = composition.Close()
		}
	}()

	client := dependencies.httpClient
	if client == nil {
		transport := newUpstreamTransport()
		composition.closers = append(composition.closers, idleConnectionCloser{transport: transport})
		client = &http.Client{
			// 自建连接池同样要带「环境代理不可达改直连」语义（见 outbound_fallback.go）。
			Transport:     wrapOutboundTransport(transport),
			Timeout:       inferenceHTTPTimeout,
			CheckRedirect: rejectOAuthRedirect,
		}
	}
	var codexVersions clientversion.Source = clientversion.Static(codexidentity.Floor)
	if dependencies.codexVersions != nil {
		codexVersions = dependencies.codexVersions
	}
	codexAdapter, err := codexresponses.NewAdapterWithClientVersion(client, dependencies.clock, codexVersions)
	if err != nil {
		return nil, err
	}
	codexAdapter.ObserveRejections(dependencies.codexRejections)
	codexAdapter.ObserveUpstreamRules(dependencies.upstreamRules)
	codexAdapter.ObserveEffortLadders(dependencies.effortLadders)
	var claudeVersions clientversion.Source = clientversion.Static(claudeidentity.Floor)
	if dependencies.claudeVersions != nil {
		claudeVersions = dependencies.claudeVersions
	}
	claudeAdapter, err := claudemessages.NewAdapterWithClientVersion(
		client,
		dependencies.clock,
		claudeVersions,
		dependencies.upstreamDecodeErrors,
	)
	if err != nil {
		return nil, err
	}
	claudeAdapter.ObserveUpstreamRules(dependencies.upstreamRules)
	claudeAdapter.ObserveEffortLadders(dependencies.effortLadders)
	agyClient := client
	if dependencies.httpClient == nil {
		agyTransport := newUpstreamTransport()
		agyTransport.ResponseHeaderTimeout = agyFirstByteTimeout
		composition.closers = append(
			composition.closers,
			idleConnectionCloser{transport: agyTransport},
		)
		agyClient = &http.Client{
			Transport:     wrapOutboundTransport(agyTransport),
			Timeout:       inferenceHTTPTimeout,
			CheckRedirect: rejectOAuthRedirect,
		}
	}
	agyAdapter, err := agycodeassist.NewAdapterWithWireModels(agyClient, dependencies.clock, dependencies.agyModelWires)
	if err != nil {
		return nil, err
	}
	geminiAdapter, err := agycodeassist.NewGeminiAdapter(agyClient, dependencies.clock)
	if err != nil {
		return nil, err
	}
	activeCatalog, err := inferencecatalog.NewAtomicCatalog(dependencies.clock)
	if err != nil {
		return nil, err
	}
	// Go owns legacy first-read migration and canonical alias restoration.
	// A failed read must not become an empty catalog or wait for a Node seed.
	modelAliases := modelalias.NewStoreWithRepository(dependencies.store)
	if err := modelAliases.Restore(context.Background()); err != nil {
		return nil, err
	}
	builder, err := inferencecatalog.NewBuilder(
		dependencies.store,
		codexAdapter,
		claudeAdapter,
		agyAdapter,
		geminiAdapter,
	)
	if err != nil {
		return nil, err
	}
	builder.WithAliasStore(modelAliases)
	// 透传通道（家族四支 + cline/grok/kimi）由专用 HTTP 通道承载：模型进展示目录
	// 与账号路由索引（交还判定、/v1/models 依赖），但不编译 Canonical 规则。
	// 名单只从 relayProviderIDs 取，避免目录声明与模型刷新队列各写一份而漂移。
	builder.WithRelayProviders(relayProviderIDs()...)
	// 尚未接入 Go 推理上游的 Provider 的模型不进 Go 目录：一个 kiro 模型就能让
	// 整个快照构建失败，结果所有请求都被交还 Node。名单从 Catalog 派生。
	catalogRefresh, err := inferencecatalog.NewRefreshCoordinator(
		inferencecatalog.RefreshCoordinatorOptions{
			Builder: builder,
			Catalog: activeCatalog,
		},
	)
	if err != nil {
		return nil, err
	}
	composition.modelAliases = modelAliases
	composition.catalogRefresh = catalogRefresh
	composition.closers = append(composition.closers, catalogRefresh)
	if err := dependencies.store.SetRoutableModelObserver(
		catalogRefresh,
	); err != nil {
		return nil, err
	}
	// 初次失败只关闭推理目录；账号管理仍可通过后续成功写入触发恢复。
	if err := catalogRefresh.Refresh(ctx); err != nil && dependencies.componentLog != nil {
		dependencies.componentLog.Printf(
			"[aih] inference catalog initial refresh failed: %v",
			err,
		)
	}
	poolRetries, err := inferencegateway.NewDefaultRequestPoolRetryPolicy()
	if err != nil {
		return nil, err
	}

	runtimeComponents, err := inferenceruntime.NewComponents(inferenceruntime.Dependencies{
		Catalog:                   dependencies.catalog,
		Store:                     dependencies.store,
		Runtime:                   dependencies.runtime,
		Weights:                   dependencies.weights,
		UsageGate:                 dependencies.usageGate,
		Scheduling:                newSchedulingEvaluator(),
		Strategy:                  dependencies.strategy,
		Routes:                    activeCatalog,
		CredentialStrategies:      dependencies.credentialRefresh,
		Credentials:               dependencies.credentials,
		DelegateCredentialRefresh: dependencies.delegateCredentialRefresh,
		OwnsCredentialRefresh:     dependencies.ownsCredentialRefresh,
		Upstreams: []inferencegateway.UpstreamAdapter{
			codexAdapter,
			claudeAdapter,
			agyAdapter,
			geminiAdapter,
		},
		ModelRefreshes:     dependencies.modelRefreshes,
		Clock:              dependencies.clock,
		PoolRetries:        poolRetries,
		Upstream429Retries: dependencies.upstream429Retries,
		RequestRewriter:    dependencies.requestRewriter,
	})
	if err != nil {
		return nil, err
	}
	module, err := inferencehttp.New(inferencehttp.Dependencies{
		Executor:                     runtimeComponents.Executor(),
		Authorizer:                   dependencies.authorizer,
		Clock:                        dependencies.clock,
		MessagesDecodeErrorObserver:  dependencies.decodeErrors,
		ResponsesDecodeErrorObserver: dependencies.responsesDecodeErrors,
	})
	if err != nil {
		return nil, err
	}
	composition.handler = module.Router
	composition.gemini = module.Gemini
	composition.models = activeCatalog
	composition.recruiter = runtimeComponents.Recruiter()
	composition.runtime = runtimeComponents.Runtime()
	composition.codexUpstream = codexAdapter
	composition.claudeUpstream = claudeAdapter
	composition.agyUpstream = agyAdapter
	composition.modelRefreshes = dependencies.modelRefreshes
	return composition, nil
}

// Close 先停止账号模型 worker，再停止目录刷新 worker。
func (composition *inferenceComposition) Close() error {
	if composition == nil {
		return nil
	}
	var closeErrors []error
	for index := len(composition.closers) - 1; index >= 0; index-- {
		if err := composition.closers[index].Close(); err != nil {
			closeErrors = append(closeErrors, err)
		}
	}
	composition.closers = nil
	return errors.Join(closeErrors...)
}

// validInferenceDependencies 在启动任何后台 worker 前拒绝不完整依赖。
func validInferenceDependencies(
	ctx context.Context,
	dependencies inferenceCompositionDependencies,
) bool {
	return ctx != nil &&
		dependencies.catalog != nil &&
		dependencies.store != nil &&
		dependencies.runtime != nil &&
		dependencies.models != nil &&
		dependencies.modelRefreshes != nil &&
		(dependencies.credentials != nil || len(dependencies.credentialRefresh) > 0) &&
		dependencies.authorizer != nil &&
		dependencies.clock != nil
}

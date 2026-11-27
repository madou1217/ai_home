package aihserver

import (
	"fmt"
	"net/http"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	"github.com/madou1217/ai_home/application/accountrouting"
	inferencegateway "github.com/madou1217/ai_home/application/inferencegateway"
	"github.com/madou1217/ai_home/application/modelalias"
	"github.com/madou1217/ai_home/application/upstreamretry"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/transport/http/codebuddyfamilyrelay"
	"github.com/madou1217/ai_home/internal/transport/http/relaybridge"
	"github.com/madou1217/ai_home/internal/transport/http/relaycore"
)

// familyRelayInputs 是家族透传通道的稳定依赖。
type familyRelayInputs struct {
	catalog     *providers.Catalog
	recruiter   *accountrouting.Recruiter
	aiHomeDir   string
	aliases     *modelalias.Store
	store       *sqliteaccount.Store
	fallback    http.Handler
	credentials *accountcredentials.Resolver
	client      relaycore.HTTPClient
	egress      relaycore.AccountEgress
	attempts    inferencegateway.AttemptRecorder
	upstream429 *upstreamretry.Controller
	usage       relaycore.UsageRecorder
	gate        *usageSchedulingGate
	// routeChecker 判断模型是否已有 Canonical 执行路由；有路由的模型不进跨协议桥。
	routeChecker relaybridge.RouteChecker
	// messagesFallback / responsesFallback 承接桥不服务的请求（原生 relay / Canonical）。
	messagesFallback  http.Handler
	responsesFallback http.Handler
}

// familyRelayRuntime 是家族透传通道的装配结果。
//
// handler 承载 CodeBuddy/WorkBuddy 家族与插件 Provider 的 chat completions 透传；
// modules/accounts/providerRegistry 同时被内部聊天入口与插件描述符回调复用，
// 因此一并返回，避免调用方再重建一份。
type familyRelayRuntime struct {
	handler *relaycore.Handler
	// messagesHandler / responsesHandler 是同一套透传账号与 Provider 链在
	// Anthropic Messages / OpenAI Responses 入口上的跨协议桥。
	messagesHandler  http.Handler
	responsesHandler http.Handler
	geminiStable     http.Handler
	geminiBeta       http.Handler
	modules          []relayModule
	familyAccounts   *familyRelayAccountSource
	pluginProviders  *pluginProviderRegistry
}

func newFamilyRelayRuntime(inputs familyRelayInputs) (*familyRelayRuntime, error) {
	familyRelayAccounts, err := newFamilyRelayAccountSource(
		inputs.catalog,
		inputs.recruiter,
		familyRelayTransportPolicy{},
	)
	if err != nil {
		return nil, fmt.Errorf(
			"创建家族透传账号来源失败: %w",
			err,
		)
	}
	// 单 Provider 透传模块：账号来源与 Provider 变体由同一张注册表构造（见 relay_modules.go）。
	relayModules, err := buildRelayModules(relayBuildContext{
		Catalog:   inputs.catalog,
		Recruiter: inputs.recruiter,
		AIHomeDir: inputs.aiHomeDir,
	})
	if err != nil {
		return nil, err
	}
	// 同一入口上挂多个透传 Provider：**一个** relaycore.Handler + ProviderChain
	// + 合并的账号来源。
	//
	// 为什么不是两个 Handler 串接：每个 Handler 在「服务不了」时交回 Canonical，
	// 串接会让第一个 Handler 直接交还、第二个永远轮不到。分派必须发生在**账号所属
	// Provider** 这一层——链按账号解析 Provider，账号来源按模型汇总两个池。
	pluginProviders := newPluginProviderRegistry()
	pluginAccounts := &pluginRelayAccountSource{
		registry:  pluginProviders,
		catalog:   inputs.catalog,
		recruiter: inputs.recruiter,
		transport: pluginRelayTransportPolicy{},
	}
	familyMembers := append(
		[]relaycore.Provider{
			pluginRelayProviderChain{registry: pluginProviders},
			codebuddyfamilyrelay.NewProvider(codebuddyfamilyrelay.ProviderOptions{
				ProviderID: codebuddyfamilyrelay.FamilyProviders[0],
			}),
		},
		relayModuleProviders(relayModules)...,
	)
	// Path / Fallback 由每个入口各自声明：chat 入口交回 Canonical，跨协议入口
	// 交回该入口原有的原生 relay / Canonical 处理器。其余依赖完全共享。
	relayDependencies := relaycore.Dependencies{
		Provider: relaycore.NewProviderChain(familyMembers...),
		Aliases:  newChatAliasResolver(inputs.aliases, inputs.store),
		// 别名拥有最高解释权；未命中别名时才解析 Provider 显式声明的
		// `provider/model` 前缀，并把 Provider 钉死（与 Node 前门同一顺序）。
		ModelPrefixes: newRelayModelPrefixResolver(inputs.catalog, inputs.store),
		Accounts: relaycore.NewAccountSourceChain(
			append(append(relayModuleAccounts(relayModules), familyRelayAccounts), pluginAccounts)...,
		),
		Credentials:         inputs.credentials,
		Client:              inputs.client,
		AccountEgress:       inputs.egress,
		Attempts:            inputs.attempts,
		Upstream429Retries:  inputs.upstream429,
		Clock:               time.Now,
		MaxRequestBodyBytes: codebuddyfamilyrelay.MaxRequestBodyBytes,
		UnavailableMessage:  "家族透传当前不可用",
		// 用量由 relaycore 在流结束时结算（首个字节前无法得知 token 数）。
		Usage: inputs.usage,
		// 档位与选号/诊断同源：记账时按策略选出的档位归因。
		Buckets: relayQuotaBuckets{gate: inputs.gate, evaluator: newSchedulingEvaluator()},
	}
	chatDependencies := relayDependencies
	chatDependencies.Path = codebuddyfamilyrelay.Path
	chatDependencies.Fallback = inputs.fallback
	familyRelayHandler, err := relaycore.NewHandler(chatDependencies)
	if err != nil {
		return nil, fmt.Errorf(
			"创建家族透传 Handler 失败: %w",
			err,
		)
	}
	messagesHandler, err := relaybridge.New(
		relayDependencies,
		relaybridge.AnthropicSurface(),
		inputs.routeChecker,
		inputs.messagesFallback,
	)
	if err != nil {
		return nil, fmt.Errorf("创建 Anthropic 跨协议桥失败: %w", err)
	}
	responsesHandler, err := relaybridge.New(
		relayDependencies,
		relaybridge.ResponsesSurface(),
		inputs.routeChecker,
		inputs.responsesFallback,
	)
	if err != nil {
		return nil, fmt.Errorf("创建 Responses 跨协议桥失败: %w", err)
	}
	// Gemini 的模型在 URL 路径里，同一套透传依赖需要两个入口实例（稳定版与 beta
	// 前缀各自的下游 dispatcher 不同），由路由器在挂载前补齐 fallback。
	geminiStable, err := relaybridge.New(
		relayDependencies,
		relaybridge.GeminiSurface(),
		inputs.routeChecker,
		nil,
	)
	if err != nil {
		return nil, fmt.Errorf("创建 Gemini（稳定版）跨协议桥失败: %w", err)
	}
	geminiBeta, err := relaybridge.New(
		relayDependencies,
		relaybridge.GeminiSurface(),
		inputs.routeChecker,
		nil,
	)
	if err != nil {
		return nil, fmt.Errorf("创建 Gemini（beta）跨协议桥失败: %w", err)
	}

	return &familyRelayRuntime{
		handler:          familyRelayHandler,
		messagesHandler:  messagesHandler,
		responsesHandler: responsesHandler,
		geminiStable:     geminiStable,
		geminiBeta:       geminiBeta,
		modules:          relayModules,
		familyAccounts:   familyRelayAccounts,
		pluginProviders:  pluginProviders,
	}, nil
}

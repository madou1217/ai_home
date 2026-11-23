package aihserver

import (
	"net/http"
	"time"

	"github.com/madou1217/ai_home/application/accountauth"
	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	usageapp "github.com/madou1217/ai_home/application/accountusage"
	"github.com/madou1217/ai_home/application/modelalias"
	"github.com/madou1217/ai_home/application/modelmetadata"
	"github.com/madou1217/ai_home/application/upstreamretry"
	"github.com/madou1217/ai_home/contracts/modelpricing"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/upstreamfailure/configured"
	"github.com/madou1217/ai_home/internal/host/aihloginjob"
	"github.com/madou1217/ai_home/internal/runtime/chatruntime"
	runtimeegress "github.com/madou1217/ai_home/internal/runtime/egress"
	"github.com/madou1217/ai_home/internal/runtime/imageexecution"
	"github.com/madou1217/ai_home/internal/runtime/pricingcatalog"
	"github.com/madou1217/ai_home/internal/runtime/sessionevents"
	"github.com/madou1217/ai_home/internal/runtime/sshproxy"
	"github.com/madou1217/ai_home/internal/runtime/sshtunnel"
	"github.com/madou1217/ai_home/internal/runtime/subaggregator"
	"github.com/madou1217/ai_home/internal/runtime/tokenrefreshdaemon"
	runtimeupstreamretry "github.com/madou1217/ai_home/internal/runtime/upstreamretry"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountdeleteapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountimportapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountstatusapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountupdateapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuisessionhookapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiterminalapi"
)

// webuiDependenciesInputs 是 WebUI 路由依赖的装配输入。
//
// 宿主级依赖直接引用 handlerDependencies（只读），其余按能力分组；新增一个
// WebUI 依赖时只需要在对应分组里加一个字段并接到 newWebUIDependencies，不再
// 修改 newHandlers 的主流水线。
type webuiDependenciesInputs struct {
	host handlerDependencies

	// 鉴权、地址与监控
	authorizer      interface{ Authorized(*http.Request) bool }
	aiHomeDir       string
	catalog         *providers.Catalog
	nodeBaseURL     string
	selfBaseURL     string
	managementKey   func() string
	clientKey       func() string
	requestShutdown func()
	desktopChanged  *desktopSettingsNotifier
	metrics         *metricsRecorder

	// 模型与价格
	modelModalities    modelmetadata.Catalog
	modelAliasExpander modelmetadata.AliasExpander
	modelAliasDisplay  modelalias.DisplayReader
	metadataResolver   modelpricing.Resolver
	chatModels         chatruntime.GatewayModelReader

	// 出口与上游 429
	egressManager         *runtimeegress.Manager
	upstream429Store      *runtimeupstreamretry.Store
	sshProxies            *sshproxy.Supervisor
	reverseTunnels        *sshtunnel.Supervisor
	imageEgress           *imageAccountEgress
	upstream429Controller *upstreamretry.Controller
	accountRuntime        serverAccountRuntime
	credentials           *accountcredentials.Resolver
	upstreamRules         configured.Rules

	// 账号：登录、额度、删除与运行态
	nativeWork      chatruntime.NativeLaunchPreparer
	authJobs        *accountauth.Service
	accountsHandler interface {
		http.Handler
		webuiaccountimportapi.DocumentImporter
	}
	credentialEditor          webuiaccountupdateapi.CredentialEditor
	providerDefaults          *accountapp.ProviderDefaults
	modelRefresher            accountapp.AccountModelRefresher
	usageService              *usageapp.Service
	quotaStats                *usageapp.QuotaStatsService
	terminalProbe             func(string) string
	accountDeletion           webuiaccountdeleteapi.AccountDeletion
	accountHostGrant          webuiaccountstatusapi.HostGrantRevoker
	accountImporter           *accountapp.AccountImporter
	accountActivity           webuisessionhookapi.AccountActivityTracker
	credentialRefresher       tokenrefreshdaemon.CredentialRefresher
	delegateCredentialRefresh bool

	// 运行面：终端、总线、插件与聊天入口
	terminalHandler    *webuiterminalapi.Handler
	subAggregator      *subaggregator.Service
	sessionEventBus    *sessionevents.Bus
	codexHooks         *codexHooksRuntime
	familyRelayHandler http.Handler
	pluginBundle       *localPluginRuntimeBundle
	pricingService     *pricingcatalog.Service
}

// newWebUIDependencies 装配 WebUI 路由依赖。
//
// 从 newHandlers 拆出：这里只做字段归位与少量派生（登录作业、插槽包装、
// 启动时间），不产生新语义。主流水线因此只保留一行构造调用。
func newWebUIDependencies(inputs webuiDependenciesInputs) webuiRouteDependencies {
	return webuiRouteDependencies{
		Authorizer:         inputs.authorizer,
		AIHomeDir:          inputs.aiHomeDir,
		Catalog:            inputs.catalog,
		ModelModalities:    inputs.modelModalities,
		ModelAliasExpander: inputs.modelAliasExpander,
		ModelAliasDisplay:  inputs.modelAliasDisplay,
		MetadataResolver:   inputs.metadataResolver,
		webuiEgressDependencies: webuiEgressDependencies{
			EgressManager:         inputs.egressManager,
			Upstream429RetryStore: inputs.upstream429Store,
			ProxyPool:             inputs.host.ProxyPool,
			SSHProxies:            inputs.sshProxies,
			ReverseTunnels:        inputs.reverseTunnels,
		},
		ImageExecutionDependencies: imageexecution.Dependencies{
			AccountEgress:          inputs.imageEgress.HTTPForAccount,
			Upstream429Retries:     inputs.upstream429Controller,
			Attempts:               inputs.accountRuntime,
			CredentialObservations: inputs.credentials,
			Rules:                  inputs.upstreamRules,
		},
		HostHomeDir:        inputs.host.HostHomeDir,
		Store:              inputs.host.Store,
		TokenEvents:        inputs.host.TokenEvents,
		NativeWorkPreparer: inputs.nativeWork,
		AccountRuntime:     inputs.accountRuntime,
		AuthJobs:           inputs.authJobs,
		LoginJobs: aihloginjob.NewManager(aihloginjob.Options{
			AIHomeDir:   inputs.aiHomeDir,
			HostHomeDir: inputs.host.HostHomeDir,
		}),
		AccountsHandler:        inputs.accountsHandler,
		AccountRows:            inputs.host.WebUIAccountsSource,
		CredentialEditor:       inputs.credentialEditor,
		ProviderDefaults:       inputs.providerDefaults,
		ModelRefresher:         inputs.modelRefresher,
		UsageService:           inputs.usageService,
		QuotaStats:             inputs.quotaStats,
		TerminalProbe:          inputs.terminalProbe,
		AccountDeletion:        inputs.accountDeletion,
		AccountHostGrant:       inputs.accountHostGrant,
		NodeBaseURL:            inputs.nodeBaseURL,
		SelfBaseURL:            inputs.selfBaseURL,
		ManagementKey:          inputs.managementKey,
		RequestShutdown:        inputs.requestShutdown,
		TerminalHandler:        inputs.terminalHandler,
		SubAggregator:          inputs.subAggregator,
		SessionEventBus:        inputs.sessionEventBus,
		CodexHooks:             inputs.codexHooks,
		PluginHostService:      inputs.pluginBundle.HostService,
		PricingService:         inputs.pricingService,
		MetricsRecorder:        inputs.metrics,
		StartedAt:              time.Now(),
		OutcomeRecorder:        inputs.host.OutcomeRecorder,
		AccountActivity:        inputs.accountActivity,
		AccountImporter:        inputs.accountImporter,
		ClientKey:              inputs.clientKey,
		TranslationGateway:     inputs.host.TranslationGateway,
		ChatGateway:            inputs.pluginBundle.Handlers.wrap("openai_chat", inputs.familyRelayHandler),
		ChatModels:             inputs.chatModels,
		DesktopSettingsChanged: inputs.desktopChanged.changed,

		CredentialRefresher:       inputs.credentialRefresher,
		DelegateCredentialRefresh: inputs.delegateCredentialRefresh,
	}
}

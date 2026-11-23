package aihserver

import (
	"context"
	"log"
	"net/http"
	"strings"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	modelpricingcontract "github.com/madou1217/ai_home/contracts/modelpricing"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	pluginmodelcatalog "github.com/madou1217/ai_home/internal/adapters/pluginprovider/modelcatalog"
	"github.com/madou1217/ai_home/internal/runtime/pluginhost"
	"github.com/madou1217/ai_home/internal/runtime/pricingcatalog"
	"github.com/madou1217/ai_home/internal/runtime/pricingresolver"
	"github.com/madou1217/ai_home/internal/transport/http/pluginapi"
)

// pluginBundleInputs 是本地插件运行时的稳定依赖。
type pluginBundleInputs struct {
	ctx              context.Context
	aiHomeDir        string
	authorizer       pluginapi.Authorizer
	clientAuthorizer pluginapi.Authorizer
	store            *sqliteaccount.Store
	pluginProviders  *pluginProviderRegistry
	catalog          *providers.Catalog
	modelDiscovery   *accountapp.ModelDiscovery
	inference        *inferenceComposition
	errorLog         *log.Logger
}

// pluginBundleRuntime 是插件数据面/控制面与价格服务的装配结果。
type pluginBundleRuntime struct {
	bundle  *localPluginRuntimeBundle
	pricing *pricingcatalog.Service
}

// newPluginBundleRuntime 装配本地插件宿主、Provider 描述符回调与价格来源。
//
// 从 newHandlers 拆出：插件宿主生命周期、描述符刷新与实际价格接入是一组
// 相互独立于主推理流水线的关注点，集中在一个文件后扩展插件能力不再修改主装配。
func newPluginBundleRuntime(inputs pluginBundleInputs) *pluginBundleRuntime {
	pluginModelFallback := &pluginmodelcatalog.Discoverer{Client: &http.Client{Timeout: 15 * time.Second}}
	bundle := newLocalPluginHandlers(localPluginHandlerOptions{
		ManagementAuthorizer: inputs.authorizer,
		ClientAuthorizer:     inputs.clientAuthorizer,
		Describe:             accountProviderResolver(inputs.store),
		AIHomeDir:            inputs.aiHomeDir,
		OnProviderDescriptors: func(result pluginhost.DescriptorCollectResult) {
			inputs.pluginProviders.Update(result)
			inputs.catalog.ReplaceDynamic(inputs.pluginProviders.Definitions())
			inputs.modelDiscovery.SetPluginProviders(inputs.pluginProviders.ModelDescriptors(), pluginModelFallback)
			if inputs.inference != nil {
				inputs.inference.RefreshCatalog()
			}
		},
		OnLog: func(message string) {
			if inputs.errorLog != nil && strings.TrimSpace(message) != "" {
				inputs.errorLog.Println(message)
			}
		},
	})
	pluginBundle := &bundle
	var sharedPricingService *pricingcatalog.Service
	if pluginBundle.HostService != nil {
		sharedPricingService = pluginBundle.HostService.PricingService()
		if err := pluginBundle.HostService.Start(inputs.ctx); err != nil && inputs.errorLog != nil {
			inputs.errorLog.Printf("插件宿主初始激活降级: %v", err)
		}
		installPluginAliasSync(inputs.inference.modelAliases, pluginBundle.HostService, inputs.inference.RefreshCatalog)
	}
	// 插件价格来源接进定价 Resolver：已生效（通过复核）的插件快照参与报价裁决，
	// 按来源 authority 与宿主价格（账号/人工/官方）比较；未生效快照不参与计费。
	if sharedPricingService != nil {
		pricingresolver.ConfigurePluginSource(func() modelpricingcontract.QuoteSource {
			store := sharedPricingService.Store()
			if store == nil {
				return nil
			}
			return store.ContractQuoteSource()
		})
	}

	return &pluginBundleRuntime{bundle: pluginBundle, pricing: sharedPricingService}
}

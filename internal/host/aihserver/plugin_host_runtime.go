package aihserver

import (
	"context"
	"net/http"
	"strings"

	plugincontrol "github.com/madou1217/ai_home/application/plugincontrol"
	appplugins "github.com/madou1217/ai_home/application/pluginruntime"
	"github.com/madou1217/ai_home/internal/adapters/pluginartifact"
	pluginstatereader "github.com/madou1217/ai_home/internal/adapters/plugincontrol"
	"github.com/madou1217/ai_home/internal/adapters/pluginstatestore"
	"github.com/madou1217/ai_home/internal/runtime/pluginhost"
	"github.com/madou1217/ai_home/internal/runtime/pricingcatalog"
	"github.com/madou1217/ai_home/internal/transport/http/claudenativerelay"
	"github.com/madou1217/ai_home/internal/transport/http/pluginapi"
	"github.com/madou1217/ai_home/internal/transport/http/plugincontrolapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiplugintrustapi"
)

// localPluginHandlerOptions 描述 Go 自宿主插件运行时的装配选项（不依赖 Node 回调）。
type localPluginHandlerOptions struct {
	ManagementAuthorizer pluginapi.Authorizer
	ClientAuthorizer     pluginapi.Authorizer
	Describe             appplugins.AccountDescriber
	AIHomeDir            string
	RepoRoot             string
	HostVersion          string
	NodeVersion          string
	PricingService       *pricingcatalog.Service
	OnPricingApplied     func(context.Context)
	OnAudit              func(operation string, details map[string]any)
	OnLog                func(string)
}

// localPluginRuntimeBundle 打包供组合根持有的 HTTP 接入与本地 Go 插件宿主服务。
type localPluginRuntimeBundle struct {
	Handlers    pluginHandlers
	HostService *pluginhost.Service
}

// Close 按顺序停止本地宿主进程、价格同步、观察投递器与连接池。
func (b *localPluginRuntimeBundle) Close() error {
	if b == nil {
		return nil
	}
	if b.HostService != nil {
		return b.HostService.Close()
	}
	return b.Handlers.Close()
}

// newLocalPluginHandlers 使用 Go 本地 pluginhost.Service 装配完整插件数据面与控制面（零 Node 回调）。
func newLocalPluginHandlers(options localPluginHandlerOptions) localPluginRuntimeBundle {
	service, err := pluginhost.NewService(pluginhost.ServiceOptions{
		AIHomeDir:        options.AIHomeDir,
		RepoRoot:         options.RepoRoot,
		HostVersion:      options.HostVersion,
		NodeVersion:      options.NodeVersion,
		AccountDescriber: options.Describe,
		PricingService:   options.PricingService,
		OnPricingApplied: options.OnPricingApplied,
		OnAudit:          options.OnAudit,
		OnLog:            options.OnLog,
	})
	if err != nil {
		return localPluginRuntimeBundle{}
	}

	registry := service.Registry()
	invoker := service.Invoker()
	observer := service.Observer()

	gate, err := pluginapi.NewRequestGate(registry, invoker, options.ClientAuthorizer, claudenativerelay.MaxRequestBodyBytes, observer)
	if err != nil {
		_ = service.Close()
		return localPluginRuntimeBundle{}
	}
	projection, err := pluginapi.NewProjectionHandler(options.ManagementAuthorizer, registry, invoker, observer)
	if err != nil {
		_ = service.Close()
		return localPluginRuntimeBundle{}
	}

	handlers := pluginHandlers{
		gate:       gate,
		projection: projection,
		invoker:    invoker,
		observer:   observer,
	}
	if reader, err := pluginstatereader.NewReader(options.AIHomeDir); err == nil {
		if list, err := pluginapi.NewInventoryHandler(options.ManagementAuthorizer, reader, registry); err == nil {
			handlers.list = list
		}
	}
	if trust, err := webuiplugintrustapi.NewHandler(webuiplugintrustapi.Dependencies{
		Authorizer: options.ManagementAuthorizer,
		AIHomeDir:  options.AIHomeDir,
		OnAudit:    service.Audit,
	}); err == nil {
		handlers.trust = trust
	}
	handlers.control = newLocalPluginControlHandler(options.ManagementAuthorizer, options.AIHomeDir, service)

	return localPluginRuntimeBundle{
		Handlers:    handlers,
		HostService: service,
	}
}

func newLocalPluginControlHandler(
	authorizer pluginapi.Authorizer,
	aiHomeDir string,
	hostService *pluginhost.Service,
) http.Handler {
	if authorizer == nil || strings.TrimSpace(aiHomeDir) == "" || hostService == nil {
		return nil
	}
	acceptor, err := pluginartifact.NewAcceptor(aiHomeDir)
	if err != nil {
		return nil
	}
	store, err := pluginstatestore.NewStore(aiHomeDir)
	if err != nil {
		return nil
	}
	installer, err := plugincontrol.NewInstaller(aiHomeDir, acceptor, store)
	if err != nil {
		return nil
	}
	operator, err := hostService.Operator(store, store)
	if err != nil {
		return nil
	}
	handler, err := plugincontrolapi.NewHandler(plugincontrolapi.Dependencies{
		Authorizer: authorizer,
		Installer:  installer,
		Committer:  store,
		Operator:   operator,
		OnAudit:    hostService.Audit,
	})
	if err != nil {
		return nil
	}
	return handler
}

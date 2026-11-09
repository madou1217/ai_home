package aihserver

import (
	"context"
	"net/http"

	appplugins "github.com/madou1217/ai_home/application/pluginruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/adapters/plugincontrol"
	adapterplugins "github.com/madou1217/ai_home/internal/adapters/pluginruntime"
	"github.com/madou1217/ai_home/internal/transport/http/claudenativerelay"
	"github.com/madou1217/ai_home/internal/transport/http/pluginapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiplugintrustapi"
)

// pluginHandlers 是 Go 数据面的插件接入：Node 推送投影的管理接口与推理入口的 gateway.request 闸门。
//
// 没有任何投影时闸门对不带代次头的请求零开销直通；Node 只在 Go 确认了某代次后才带该代次转发。
type pluginHandlers struct {
	gate       *pluginapi.RequestGate
	projection http.Handler
	// list 是只读插件清单：控制面事实来自 Node 的 app-state.db，运行态来自 projection。
	list http.Handler
	// trust 是发布者信任根的读/写/撤销。信任根是文件型写面，写入口收敛到 Go；
	// Node 的 install 校验仍直接读同一个文件，所以这里只改文件的写入方。
	trust    http.Handler
	invoker  *adapterplugins.HostInvoker
	observer *appplugins.Observer
}

// newPluginHandlers 组装插件接入；依赖无效时返回禁用状态（路由不包闸门、不挂管理接口），
// 不让插件接入的问题拖垮整个 Go 数据面。Node 收不到投影确认时会把插件请求留在自己这边。
func newPluginHandlers(
	managementAuthorizer pluginapi.Authorizer,
	clientAuthorizer pluginapi.Authorizer,
	describe appplugins.AccountDescriber,
	aiHomeDir string,
) pluginHandlers {
	registry := appplugins.NewRegistry()
	invoker := adapterplugins.NewHostInvoker(registry)
	observer := appplugins.NewObserver(invoker, registry, describe, 0)
	gate, err := pluginapi.NewRequestGate(registry, invoker, clientAuthorizer, claudenativerelay.MaxRequestBodyBytes, observer)
	if err != nil {
		observer.Close()
		return pluginHandlers{}
	}
	projection, err := pluginapi.NewProjectionHandler(managementAuthorizer, registry, invoker, observer)
	if err != nil {
		observer.Close()
		return pluginHandlers{}
	}
	handlers := pluginHandlers{gate: gate, projection: projection, invoker: invoker, observer: observer}
	// 只读清单依赖 Node 的 app-state.db。数据目录不可解析时只少挂这条路由，
	// 投影推送与推理闸门照常工作——列表问题不能拖垮插件数据面。
	if reader, err := plugincontrol.NewReader(aiHomeDir); err == nil {
		if list, err := pluginapi.NewInventoryHandler(managementAuthorizer, reader, registry); err == nil {
			handlers.list = list
		}
	}
	// 信任根接口与清单一样只依赖管理密钥和数据目录；数据目录不可用时只少挂这三条路由。
	if trust, err := webuiplugintrustapi.NewHandler(webuiplugintrustapi.Dependencies{
		Authorizer: managementAuthorizer,
		AIHomeDir:  aiHomeDir,
	}); err == nil {
		handlers.trust = trust
	}
	return handlers
}

// accountProviderResolver 用无敏感的账号管理投影描述账号：Provider（观察事件）与认证形态（账号偏好候选）。
func accountProviderResolver(store *sqliteaccount.Store) appplugins.AccountDescriber {
	if store == nil {
		return nil
	}
	return func(ctx context.Context, accountRef string) appplugins.AccountDescription {
		ref, err := accountcore.ParseAccountRef(accountRef)
		if err != nil {
			return appplugins.AccountDescription{}
		}
		overview, err := store.GetAccountOverview(ctx, ref)
		if err != nil {
			return appplugins.AccountDescription{}
		}
		authType := "oauth"
		if kind := overview.AuthKind(); kind == "api_key" || kind == "api-key" {
			authType = "api-key"
		}
		return appplugins.AccountDescription{Provider: overview.Account().ProviderID(), AuthType: authType}
	}
}

// wrap 给推理入口包上闸门；禁用状态下原样返回。
func (plugins pluginHandlers) wrap(protocol string, next http.Handler) http.Handler {
	if plugins.gate == nil || next == nil {
		return next
	}
	return plugins.gate.Wrap(protocol, next)
}

// Close 停止观察投递并关闭与 Plugin Host 的连接。
func (plugins pluginHandlers) Close() error {
	plugins.observer.Close()
	if plugins.invoker == nil {
		return nil
	}
	return plugins.invoker.Close()
}

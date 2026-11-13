package aihserver

import (
	"context"
	"net/http"

	appplugins "github.com/madou1217/ai_home/application/pluginruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	adapterplugins "github.com/madou1217/ai_home/internal/adapters/pluginruntime"
	"github.com/madou1217/ai_home/internal/transport/http/pluginapi"
)

// pluginHandlers 是 Go 宿主持有的插件接入：本地宿主控制面、投影查询与推理入口的 gateway.request 闸门。
type pluginHandlers struct {
	gate       *pluginapi.RequestGate
	projection http.Handler
	// list 是只读插件清单：控制面事实来自 app-state.db，运行态来自 Go 本地宿主。
	list http.Handler
	// trust 是发布者信任根的读/写/撤销。
	trust http.Handler
	// control 是插件安装/卸载与实例启停（全部由 Go 本地 pluginhost.Service 驱动）。
	control  http.Handler
	invoker  *adapterplugins.HostInvoker
	observer *appplugins.Observer
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

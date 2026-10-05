package aihserver

import (
	"net/http"

	appplugins "github.com/madou1217/ai_home/application/pluginruntime"
	adapterplugins "github.com/madou1217/ai_home/internal/adapters/pluginruntime"
	"github.com/madou1217/ai_home/internal/transport/http/claudenativerelay"
	"github.com/madou1217/ai_home/internal/transport/http/pluginapi"
)

// pluginHandlers 是 Go 数据面的插件接入：Node 推送投影的管理接口与推理入口的 gateway.request 闸门。
//
// 没有任何投影时闸门对不带代次头的请求零开销直通；Node 只在 Go 确认了某代次后才带该代次转发。
type pluginHandlers struct {
	gate       *pluginapi.RequestGate
	projection http.Handler
	invoker    *adapterplugins.HostInvoker
}

// newPluginHandlers 组装插件接入；依赖无效时返回禁用状态（路由不包闸门、不挂管理接口），
// 不让插件接入的问题拖垮整个 Go 数据面。Node 收不到投影确认时会把插件请求留在自己这边。
func newPluginHandlers(managementAuthorizer pluginapi.Authorizer, clientAuthorizer pluginapi.Authorizer) pluginHandlers {
	registry := appplugins.NewRegistry()
	invoker := adapterplugins.NewHostInvoker(registry)
	gate, err := pluginapi.NewRequestGate(registry, invoker, clientAuthorizer, claudenativerelay.MaxRequestBodyBytes)
	if err != nil {
		return pluginHandlers{}
	}
	projection, err := pluginapi.NewProjectionHandler(managementAuthorizer, registry, invoker)
	if err != nil {
		return pluginHandlers{}
	}
	return pluginHandlers{gate: gate, projection: projection, invoker: invoker}
}

// wrap 给推理入口包上闸门；禁用状态下原样返回。
func (plugins pluginHandlers) wrap(protocol string, next http.Handler) http.Handler {
	if plugins.gate == nil || next == nil {
		return next
	}
	return plugins.gate.Wrap(protocol, next)
}

// Close 关闭与 Plugin Host 的连接。
func (plugins pluginHandlers) Close() error {
	if plugins.invoker == nil {
		return nil
	}
	return plugins.invoker.Close()
}

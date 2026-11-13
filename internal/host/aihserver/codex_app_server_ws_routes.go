package aihserver

import (
	"github.com/madou1217/ai_home/internal/transport/http/codexappserverapi"
)

const (
	// codexAppServerRootPattern 是 Go ServeMux 仅匹配根路径 "/" 的 GET 模式（不匹配任意子路径）。
	codexAppServerRootPattern = "GET /{$}"
	// codexAppServerLegacyPattern 是 Codex app-server WebSocket 历史入口模式。
	codexAppServerLegacyPattern = "GET " + codexappserverapi.AppServerProxyPath
)

// newCodexAppServerWSHandler 构造接入完整运行时与账号存储回落的 Codex app-server WebSocket 代理处理器。
func newCodexAppServerWSHandler(
	authorizer codexappserverapi.Authorizer,
	dependencies handlerDependencies,
) (*codexappserverapi.AppServerHandler, error) {
	var logError func(error)
	if dependencies.ErrorLog != nil {
		logError = func(err error) {
			if err != nil {
				dependencies.ErrorLog.Printf("[aih:codex-proxy] %v", err)
			}
		}
	}
	return codexappserverapi.NewAppServerHandler(codexappserverapi.AppServerDependencies{
		Authorizer:   authorizer,
		AIHomeDir:    dependencies.AIHomeDir,
		HostHomeDir:  dependencies.HostHomeDir,
		AccountStore: dependencies.Store,
		LogError:     logError,
	})
}

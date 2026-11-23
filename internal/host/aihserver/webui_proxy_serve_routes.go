package aihserver

import (
	"fmt"

	"github.com/madou1217/ai_home/internal/transport/http/webuiproxyserveapi"
)

// buildWebUIProxyServeRoutes 装配本机代理入口的状态与启停路由。
//
// 这是核心管理面，不是插件 UI：插件只贡献 egress.engine 能力，会话生命周期
// 必须由宿主唯一持有，否则无法保证同时只有一个入口去租约/占端口。
func buildWebUIProxyServeRoutes(dependencies webuiRouteDependencies) ([]webuiRoute, error) {
	if dependencies.Authorizer == nil || dependencies.ProxyServeManager == nil {
		return nil, nil
	}
	handler, err := webuiproxyserveapi.NewHandler(webuiproxyserveapi.Dependencies{
		Authorizer: dependencies.Authorizer,
		Manager:    dependencies.ProxyServeManager,
	})
	if err != nil {
		return nil, fmt.Errorf("创建本机代理入口接口失败: %w", err)
	}
	return []webuiRoute{
		{Pattern: "GET " + webuiproxyserveapi.Path, Handler: handler},
		{Pattern: "POST " + webuiproxyserveapi.StartPath, Handler: handler},
		{Pattern: "POST " + webuiproxyserveapi.StopPath, Handler: handler},
	}, nil
}

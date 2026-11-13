package aihserver

import (
	"fmt"

	upstreammappingapp "github.com/madou1217/ai_home/application/upstreammapping"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/transport/http/upstreammappingapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuimodelsyncapi"
)

// buildWebUIModelsRulesRoutes 装配 WebUI 模型目录管理与上游错误映射组路由。
//
// 模型别名写入口（/v1/management/webui/model-aliases 及 /{id}/toggle 等子路径）已由
// composition/router 挂载 handlers.modelAliasesWebUI（prefix "/" 匹配），此处不重复注册以免
// http.ServeMux 模式冲突。
// 同样，webuiopenaimodelsapi（GET /openai-models）与 webuiopenaimodelswriteapi
// （POST /openai-models/refresh、/delete）仍保留在 webuiroutes.go 中以维持既有契约；本切片
// 仅挂载无冲突的同步读写与 SSE 路由，让 Node 路由彻底切为 Go 纯代理。
func buildWebUIModelsRulesRoutes(dependencies webuiRouteDependencies) ([]webuiRoute, error) {
	if dependencies.Authorizer == nil || dependencies.Store == nil {
		return nil, nil
	}

	upstreamMappingService, err := upstreammappingapp.NewService(
		sqliteaccount.NewUpstreamErrorMappingRepository(dependencies.Store),
		providerIDs(dependencies.Catalog),
	)
	if err != nil {
		return nil, fmt.Errorf("创建 WebUI 上游错误映射组服务失败: %w", err)
	}
	upstreamMappingsHandler, err := upstreammappingapi.NewHandler(upstreammappingapi.Dependencies{
		Authorizer: dependencies.Authorizer,
		Service:    upstreamMappingService,
		BasePath:   upstreammappingapi.WebUIPath,
	})
	if err != nil {
		return nil, fmt.Errorf("创建 WebUI 上游错误映射组接口失败: %w", err)
	}

	modelsSyncHandler, err := webuimodelsyncapi.NewHandler(webuimodelsyncapi.Dependencies{
		Authorizer:     dependencies.Authorizer,
		Store:          dependencies.Store,
		AIHomeDir:      dependencies.AIHomeDir,
		Catalog:        dependencies.Catalog,
		Modalities:     dependencies.ModelModalities,
		AccountRows:    dependencies.AccountRows,
		ModelRefresher: dependencies.ModelRefresher,
	})
	if err != nil {
		return nil, fmt.Errorf("创建 WebUI 模型管理同步接口失败: %w", err)
	}

	return []webuiRoute{
		{Pattern: "GET " + upstreammappingapi.WebUIPath, Handler: upstreamMappingsHandler},
		{Pattern: "POST " + upstreammappingapi.WebUIPath, Handler: upstreamMappingsHandler},
		{Pattern: "GET " + upstreammappingapi.WebUIPath + "/{id}", Handler: upstreamMappingsHandler},
		{Pattern: "PUT " + upstreammappingapi.WebUIPath + "/{id}", Handler: upstreamMappingsHandler},
		{Pattern: "DELETE " + upstreammappingapi.WebUIPath + "/{id}", Handler: upstreamMappingsHandler},
		{Pattern: "POST " + upstreammappingapi.WebUIPath + "/{id}/toggle", Handler: upstreamMappingsHandler},
		{Pattern: "GET " + webuimodelsyncapi.CatalogPath, Handler: modelsSyncHandler},
		{Pattern: "POST " + webuimodelsyncapi.BasePath, Handler: modelsSyncHandler},
		{Pattern: "PATCH " + webuimodelsyncapi.BasePath, Handler: modelsSyncHandler},
		{Pattern: "POST " + webuimodelsyncapi.CatalogDeletePath, Handler: modelsSyncHandler},
		{Pattern: "POST " + webuimodelsyncapi.CatalogRefreshPath, Handler: modelsSyncHandler},
		{Pattern: "GET " + webuimodelsyncapi.WatchPath, Handler: modelsSyncHandler},
	}, nil
}

package aihserver

import (
	"fmt"

	upstreammappingapp "github.com/madou1217/ai_home/application/upstreammapping"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/transport/http/upstreammappingapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuimodelsyncapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuipublicalias"
)

// buildWebUIModelsRulesRoutes 装配 WebUI 模型目录管理与上游错误映射组路由。
//
// 模型别名写入口（/v1/management/webui/model-aliases 及 /{id}/toggle 等子路径）已由
// composition/router 挂载 handlers.modelAliasesWebUI（prefix "/" 匹配），此处不重复注册以免
// http.ServeMux 模式冲突。
// 同样，webuiopenaimodelsapi（GET /openai-models）与 webuiopenaimodelswriteapi
// （POST /openai-models/refresh、/delete）仍保留在 webuiroutes.go 中以维持管理面既有契约；
// 浏览器数据面的 /v0/webui/openai-models* 由本切片逐条改写到完整模型目录处理器，
// 不再复用只读处理器（旧 catch-all 会让 POST /refresh 落到只读处理器返回 405）。
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
		// 浏览器数据面：/v0/webui/upstream-error-mappings* → 管理前缀（同一处理器）。
		{Pattern: "GET /v0/webui/upstream-error-mappings", Handler: webuipublicalias.Rewrite("/v0/webui", "/v1/management/webui", upstreamMappingsHandler)},
		{Pattern: "POST /v0/webui/upstream-error-mappings", Handler: webuipublicalias.Rewrite("/v0/webui", "/v1/management/webui", upstreamMappingsHandler)},
		{Pattern: "GET /v0/webui/upstream-error-mappings/{id}", Handler: webuipublicalias.Rewrite("/v0/webui", "/v1/management/webui", upstreamMappingsHandler)},
		{Pattern: "PUT /v0/webui/upstream-error-mappings/{id}", Handler: webuipublicalias.Rewrite("/v0/webui", "/v1/management/webui", upstreamMappingsHandler)},
		{Pattern: "DELETE /v0/webui/upstream-error-mappings/{id}", Handler: webuipublicalias.Rewrite("/v0/webui", "/v1/management/webui", upstreamMappingsHandler)},
		{Pattern: "POST /v0/webui/upstream-error-mappings/{id}/toggle", Handler: webuipublicalias.Rewrite("/v0/webui", "/v1/management/webui", upstreamMappingsHandler)},
		{Pattern: "GET " + webuimodelsyncapi.CatalogPath, Handler: modelsSyncHandler},
		{Pattern: "POST " + webuimodelsyncapi.BasePath, Handler: modelsSyncHandler},
		{Pattern: "PATCH " + webuimodelsyncapi.BasePath, Handler: modelsSyncHandler},
		{Pattern: "POST " + webuimodelsyncapi.CatalogDeletePath, Handler: modelsSyncHandler},
		{Pattern: "POST " + webuimodelsyncapi.CatalogRefreshPath, Handler: modelsSyncHandler},
		{Pattern: "GET " + webuimodelsyncapi.WatchPath, Handler: modelsSyncHandler},
		// 浏览器数据面：公开路径与管理路径不同构，逐条改写到同一处理器。
		// 查询串（accountRef）与方法由处理器原样消费，refresh 返回 202 + 作业。
		{Pattern: "GET /v0/webui/openai-models", Handler: webuipublicalias.RewritePath(webuimodelsyncapi.CatalogPath, modelsSyncHandler)},
		{Pattern: "POST /v0/webui/openai-models", Handler: webuipublicalias.RewritePath(webuimodelsyncapi.BasePath, modelsSyncHandler)},
		{Pattern: "PATCH /v0/webui/openai-models", Handler: webuipublicalias.RewritePath(webuimodelsyncapi.BasePath, modelsSyncHandler)},
		{Pattern: "POST /v0/webui/openai-models/refresh", Handler: webuipublicalias.RewritePath(webuimodelsyncapi.CatalogRefreshPath, modelsSyncHandler)},
		{Pattern: "POST /v0/webui/openai-models/delete", Handler: webuipublicalias.RewritePath(webuimodelsyncapi.CatalogDeletePath, modelsSyncHandler)},
		{Pattern: "GET /v0/webui/openai-models/watch", Handler: webuipublicalias.RewritePath(webuimodelsyncapi.WatchPath, modelsSyncHandler)},
	}, nil
}

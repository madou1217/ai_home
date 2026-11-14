package aihserver

import (
	"net/http"
	"strings"

	"github.com/madou1217/ai_home/internal/transport/http/webuichatapi"
)

// BuildWebUIChatRunsRoutes 返回原生 chat run 控制、审批长轮询、CLI 安装确认与 legacy /chat 路由。
// 全部路由均挂在 /v1/management/webui/chat* 下，不与 /sessions/ 前缀挂载和集合路由冲突。
func BuildWebUIChatRunsRoutes(handler *webuichatapi.Handler) ([]webuiRoute, error) {
	if handler == nil {
		return nil, nil
	}
	runsCollectionPath := strings.TrimSuffix(webuichatapi.ManagementRunsCollectionPath, "/")
	legacyChatPath := strings.TrimSuffix(webuichatapi.ManagementLegacyChatPath, "/")
	return []webuiRoute{
		{
			Pattern: "GET " + runsCollectionPath,
			Handler: http.HandlerFunc(handler.ServeRunsCollection),
		},
		{
			Pattern: "POST " + webuichatapi.ManagementRunsPrefixPath + "{runId}/input",
			Handler: http.HandlerFunc(handler.ServeRunSubpath),
		},
		{
			Pattern: "POST " + webuichatapi.ManagementRunsPrefixPath + "{runId}/resize",
			Handler: http.HandlerFunc(handler.ServeRunSubpath),
		},
		{
			Pattern: "POST " + webuichatapi.ManagementRunsPrefixPath + "{runId}/abort",
			Handler: http.HandlerFunc(handler.ServeRunSubpath),
		},
		{
			Pattern: "POST " + webuichatapi.ManagementRunsPrefixPath + "{runId}/approvals/{approvalId}",
			Handler: http.HandlerFunc(handler.ServeRunSubpath),
		},
		{
			Pattern: "POST " + webuichatapi.ManagementInternalApprovalPath,
			Handler: http.HandlerFunc(handler.ServeApprovalRequest),
		},
		{
			Pattern: "POST " + webuichatapi.ManagementCLIInstallConfirmationsPrefixPath + "{confirmationId}",
			Handler: http.HandlerFunc(handler.ServeCliInstallConfirmation),
		},
		{
			Pattern: "POST " + legacyChatPath,
			Handler: http.HandlerFunc(handler.ServeLegacyChat),
		},
	}, nil
}

// buildWebUIChatRunsRoutes 遵循 webui_*_routes 统一装配签名；控制路由复用共享 *webuichatapi.Handler。
func buildWebUIChatRunsRoutes(dependencies webuiRouteDependencies) ([]webuiRoute, error) {
	return buildWebUIChatRunsRoutesWithHandler(dependencies, nil)
}

func buildWebUIChatRunsRoutesWithHandler(
	dependencies webuiRouteDependencies,
	handler *webuichatapi.Handler,
) ([]webuiRoute, error) {
	if dependencies.Authorizer == nil || handler == nil {
		return nil, nil
	}
	return BuildWebUIChatRunsRoutes(handler)
}

package aihserver

import (
	"fmt"
	"strings"

	"github.com/madou1217/ai_home/internal/transport/http/webuisessionmodelapi"
)

// buildWebUISessionReadsRoutes 装配会话读取扩展路由（如会话最近使用模型查询）。
//
// 会话列表、消息、预览与事件四条现有路由已直接装配在 webuiroutes.go 中；
// 本文件承接新增的只读模型查询端点，共用相同的 HostHomeDir 与 AIHomeDir 依赖。
func buildWebUISessionReadsRoutes(dependencies webuiRouteDependencies) ([]webuiRoute, error) {
	if dependencies.Authorizer == nil {
		return nil, nil
	}
	if strings.TrimSpace(dependencies.HostHomeDir) == "" && strings.TrimSpace(dependencies.AIHomeDir) == "" {
		return nil, nil
	}
	sessionModel, err := webuisessionmodelapi.NewHandler(webuisessionmodelapi.Dependencies{
		Authorizer:  dependencies.Authorizer,
		HostHomeDir: dependencies.HostHomeDir,
		AIHomeDir:   dependencies.AIHomeDir,
	})
	if err != nil {
		return nil, fmt.Errorf("创建会话模型查询接口失败: %w", err)
	}
	return []webuiRoute{
		{Pattern: "GET " + webuisessionmodelapi.Path, Handler: sessionModel},
	}, nil
}

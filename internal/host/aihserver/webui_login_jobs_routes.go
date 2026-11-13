package aihserver

import (
	"fmt"

	"github.com/madou1217/ai_home/internal/host/aihloginjob"
	"github.com/madou1217/ai_home/internal/transport/http/webuiloginjobsapi"
)

// buildWebUILoginJobsRoutes 装配家族 CLI 登录作业的管理路由。
//
// 作业引擎在 Go 进程内持有临时投影与 PTY；路由只做鉴权与快照序列化。Node 前端
// 契约切换前，这组路由可被 scripts/内部调用直接使用。
func buildWebUILoginJobsRoutes(dependencies webuiRouteDependencies) ([]webuiRoute, error) {
	if dependencies.Authorizer == nil || dependencies.AIHomeDir == "" {
		return nil, nil
	}
	manager := aihloginjob.NewManager(aihloginjob.Options{
		AIHomeDir:   dependencies.AIHomeDir,
		HostHomeDir: dependencies.HostHomeDir,
	})
	handler, err := webuiloginjobsapi.NewHandler(webuiloginjobsapi.Dependencies{
		Authorizer: dependencies.Authorizer,
		Jobs:       manager,
	})
	if err != nil {
		return nil, fmt.Errorf("创建登录作业接口失败: %w", err)
	}
	return []webuiRoute{
		{Pattern: "POST " + webuiloginjobsapi.Path, Handler: handler},
		{Pattern: "GET " + webuiloginjobsapi.Path + webuiloginjobsapi.ItemSuffix, Handler: handler},
		{Pattern: "POST " + webuiloginjobsapi.Path + webuiloginjobsapi.CancelSuffix, Handler: handler},
	}, nil
}

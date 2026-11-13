package aihserver

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/internal/transport/http/webuifstrustapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiprojectsapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiprojectswriteapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiworkspacefsapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiworkspacegitapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiworkspacemodelsapi"
	"github.com/madou1217/ai_home/internal/webuifile"
	"github.com/madou1217/ai_home/internal/webuiremoteworkspace"
)

// buildWebUIProjectsFSRoutes 装配项目写操作/浏览、工作区统一文件系统、工作区 Git
// 以及工作区模型目录管理路由。
//
// 写操作（browse/open/remove/pick）持久化在 app-state.db 并在变更后通知本机
// /projects/watch 订阅者；workspace/{fs,git} 在 Go 内统一承接本机项目（含手动打开
// 且位于宿主 HOME 之外的目录）与远程工作区影子目录，Node 侧只保留零回落透传代理。
func buildWebUIProjectsFSRoutes(dependencies webuiRouteDependencies) ([]webuiRoute, error) {
	aiHome := strings.TrimSpace(dependencies.AIHomeDir)
	hostHome := strings.TrimSpace(dependencies.HostHomeDir)
	if aiHome == "" && hostHome != "" {
		aiHome = filepath.Join(hostHome, ".ai_home")
	}

	projectsWrite, err := webuiprojectswriteapi.NewHandler(webuiprojectswriteapi.Dependencies{
		Authorizer:  dependencies.Authorizer,
		HostHomeDir: hostHome,
		AiHomeDir:   aiHome,
		OnChanged: func(ctx context.Context) {
			webuiprojectsapi.NotifyWatchers(ctx, aiHome)
		},
	})
	if err != nil {
		return nil, fmt.Errorf("创建项目写接口失败: %w", err)
	}

	projectPaths := func(ctx context.Context) []string {
		paths, _ := webuiprojectsapi.ListAuthorizedProjectPaths(ctx, hostHome, aiHome)
		return paths
	}
	trustSource, err := webuifstrustapi.OpenSource(aiHome)
	if err != nil {
		return nil, fmt.Errorf("创建工作区可信目录数据源失败: %w", err)
	}
	remoteSvc := webuiremoteworkspace.NewService(aiHome, hostHome, nil)

	workspaceFS, err := webuiworkspacefsapi.NewHandler(webuiworkspacefsapi.Dependencies{
		Authorizer:   dependencies.Authorizer,
		HostHomeDir:  hostHome,
		AiHomeDir:    aiHome,
		FS:           webuifile.OSFS{},
		ProjectPaths: projectPaths,
		TrustSource:  trustSource,
		Remote:       remoteSvc,
	})
	if err != nil {
		return nil, fmt.Errorf("创建工作区文件接口失败: %w", err)
	}

	workspaceGit, err := webuiworkspacegitapi.NewHandler(webuiworkspacegitapi.Dependencies{
		Authorizer:   dependencies.Authorizer,
		HostHomeDir:  hostHome,
		AiHomeDir:    aiHome,
		ProjectPaths: projectPaths,
		Remote:       remoteSvc,
	})
	if err != nil {
		return nil, fmt.Errorf("创建工作区 Git 接口失败: %w", err)
	}

	routes := []webuiRoute{
		{Pattern: "POST " + webuiprojectswriteapi.BrowsePath, Handler: projectsWrite},
		{Pattern: "POST " + webuiprojectswriteapi.OpenPath, Handler: projectsWrite},
		{Pattern: "POST " + webuiprojectswriteapi.RemovePath, Handler: projectsWrite},
		{Pattern: "POST " + webuiprojectswriteapi.PickPath, Handler: projectsWrite},
		{Pattern: "GET " + webuiworkspacefsapi.AccessPath, Handler: workspaceFS},
		{Pattern: "GET " + webuiworkspacefsapi.ReadPath, Handler: workspaceFS},
		{Pattern: "GET " + webuiworkspacefsapi.TreePath, Handler: workspaceFS},
		{Pattern: "GET " + webuiworkspacefsapi.MediaPath, Handler: workspaceFS},
		{Pattern: "POST " + webuiworkspacefsapi.TrustPath, Handler: workspaceFS},
		{Pattern: "GET " + webuiworkspacegitapi.SummaryPath, Handler: workspaceGit},
		{Pattern: "GET " + webuiworkspacegitapi.DiffPath, Handler: workspaceGit},
	}

	// 模型目录读取依赖 SQLite 账号库；跳过 nil 指针，避免传入类型化 nil 接口。
	if dependencies.Store != nil {
		workspaceModels, err := webuiworkspacemodelsapi.NewHandler(webuiworkspacemodelsapi.Dependencies{
			Authorizer:     dependencies.Authorizer,
			AiHomeDir:      aiHome,
			Store:          dependencies.Store,
			ModelRefresher: dependencies.ModelRefresher,
			MetadataIndex:  dependencies.ModelModalities,
		})
		if err != nil {
			return nil, fmt.Errorf("创建工作区模型目录接口失败: %w", err)
		}
		routes = append(routes, webuiRoute{
			Pattern: "GET " + webuiworkspacemodelsapi.Path,
			Handler: workspaceModels,
		})
	}

	return routes, nil
}

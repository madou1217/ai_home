package aihserver

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/sshhostbrowse"
	"github.com/madou1217/ai_home/internal/adapters/sshremote"
	"github.com/madou1217/ai_home/internal/transport/http/webuiprojectsapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuisshapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuisshhostbrowseapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuisshprobeapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuisshwriteapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiterminalapi"
)

// webUISSHPorts 允许组合根或测试注入共享终端服务等端口。
type webUISSHPorts struct {
	TerminalHandler  *webuiterminalapi.Handler
	TerminalLauncher webuisshapi.TerminalLauncher
}

// webuiTerminalLauncherAdapter 把 *webuiterminalapi.Handler 适配成 webuisshapi.TerminalLauncher。
type webuiTerminalLauncherAdapter struct {
	handler *webuiterminalapi.Handler
}

func (adapter webuiTerminalLauncherAdapter) LaunchTerminal(
	ctx context.Context,
	req webuisshapi.TerminalLaunchRequest,
) (webuisshapi.TerminalLaunchResult, *webuisshapi.TerminalLaunchError) {
	res, err := adapter.handler.LaunchSession(ctx, webuiterminalapi.LaunchRequest{
		SessionKey: req.SessionKey,
		Cwd:        req.Cwd,
		File:       req.File,
		Args:       req.Args,
		Env:        req.Env,
		Cols:       req.Cols,
		Rows:       req.Rows,
		Persistent: req.Persistent,
		Remote:     req.Remote,
	})
	if err != nil {
		return webuisshapi.TerminalLaunchResult{}, &webuisshapi.TerminalLaunchError{
			Status:  err.Status,
			Code:    err.Code,
			Message: err.Message,
		}
	}
	return webuisshapi.TerminalLaunchResult{
		TermID:     res.TermID,
		SessionKey: res.SessionKey,
		Durable:    res.Durable,
		Reused:     res.Reused,
	}, nil
}

// buildWebUISSHExtraRoutes 装配 SSH 开发机与远程工作区的完整 Go 路由（补齐 POST 探测 / 浏览 / 工作区 CRUD 与工作区终端）。
//
// 不重复注册 webuiroutes.go 已挂载的 GET/connections 写入模式，避免 ServeMux 启动期冲突。
func buildWebUISSHExtraRoutes(dependencies webuiRouteDependencies) ([]webuiRoute, error) {
	return buildWebUISSHExtraRoutesWithPorts(dependencies, webUISSHPorts{})
}

func buildWebUISSHExtraRoutesWithPorts(
	dependencies webuiRouteDependencies,
	ports webUISSHPorts,
) ([]webuiRoute, error) {
	aiHome := strings.TrimSpace(dependencies.AIHomeDir)
	hostHome := strings.TrimSpace(dependencies.HostHomeDir)
	if aiHome == "" && hostHome != "" {
		aiHome = filepath.Join(hostHome, ".ai_home")
	}

	sshSource, err := webuisshapi.OpenSource(aiHome)
	if err != nil {
		return nil, fmt.Errorf("打开 SSH 只读数据源失败: %w", err)
	}
	sshWriteSource, err := webuisshwriteapi.OpenSource(aiHome)
	if err != nil {
		return nil, fmt.Errorf("打开 SSH 写入数据源失败: %w", err)
	}

	sshProbe, err := webuisshprobeapi.NewHandler(webuisshprobeapi.Dependencies{
		Authorizer:  dependencies.Authorizer,
		Connections: sshSource,
		HostHomeDir: hostHome,
		Prober:      sshremote.Prober{HomeDir: hostHome},
	})
	if err != nil {
		return nil, fmt.Errorf("创建 SSH POST 探测接口失败: %w", err)
	}

	sshBrowse, err := webuisshhostbrowseapi.NewHandler(webuisshhostbrowseapi.Dependencies{
		Authorizer:  dependencies.Authorizer,
		Connections: sshSource,
		Runner:      sshhostbrowse.Runner{HomeDir: hostHome},
	})
	if err != nil {
		return nil, fmt.Errorf("创建 SSH POST 浏览接口失败: %w", err)
	}

	sshWorkspacesWrite, err := webuisshwriteapi.NewWorkspacesHandler(webuisshwriteapi.WorkspaceDependencies{
		Authorizer: dependencies.Authorizer,
		Store:      sshWriteSource,
		OnWorkspacesChanged: func(ctx context.Context) {
			webuiprojectsapi.NotifyWatchers(ctx, aiHome)
		},
	})
	if err != nil {
		return nil, fmt.Errorf("创建 SSH 工作区写入接口失败: %w", err)
	}

	launcher := ports.TerminalLauncher
	if launcher == nil && ports.TerminalHandler != nil {
		launcher = webuiTerminalLauncherAdapter{handler: ports.TerminalHandler}
	}
	sshWorkspaceTerminal, err := webuisshapi.NewWorkspaceTerminalHandler(webuisshapi.TerminalDependencies{
		Authorizer:  dependencies.Authorizer,
		Connections: sshSource,
		Workspaces:  sshSource,
		AIHomeDir:   aiHome,
		HostHomeDir: hostHome,
		Launcher:    launcher,
	})
	if err != nil {
		return nil, fmt.Errorf("创建 SSH 工作区终端接口失败: %w", err)
	}

	return []webuiRoute{
		{Pattern: "POST " + webuisshprobeapi.Path, Handler: sshProbe},
		{Pattern: "POST " + webuisshhostbrowseapi.Path, Handler: sshBrowse},
		{Pattern: "POST " + webuisshwriteapi.WorkspacesPath, Handler: sshWorkspacesWrite},
		{Pattern: "PUT " + webuisshwriteapi.WorkspaceItemPath, Handler: sshWorkspacesWrite},
		{Pattern: "DELETE " + webuisshwriteapi.WorkspaceItemPath, Handler: sshWorkspacesWrite},
		{Pattern: "POST " + webuisshapi.WorkspaceTerminalPath, Handler: sshWorkspaceTerminal},
	}, nil
}

package aihserver

import (
	"fmt"

	"github.com/madou1217/ai_home/internal/adapters/sshhostbrowse"
	"github.com/madou1217/ai_home/internal/adapters/sshremote"
	"github.com/madou1217/ai_home/internal/transport/http/webuipublicalias"
	"github.com/madou1217/ai_home/internal/transport/http/webuisshapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuisshhostbrowseapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuisshprobeapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuisshreverseapi"
)

// buildWebUISSHCoreRoutes 装配 SSH 连接、工作区状态、探测/浏览与反向隧道路由。
//
// 从 buildWebUIRoutes 拆出：SSH 能力独立演进，集中在一个文件后新增/修改
// SSH 路由不再触碰路由总装函数与其它功能的路由表。
func buildWebUISSHCoreRoutes(dependencies webuiRouteDependencies) (*webuisshapi.Source, []webuiRoute, error) {
	authorizer := dependencies.Authorizer

	sshSource, err := webuisshapi.OpenSource(dependencies.AIHomeDir)
	if err != nil {
		return nil, nil, fmt.Errorf("创建 SSH 连接数据源失败: %w", err)
	}
	sshHandler, err := webuisshapi.NewHandler(webuisshapi.Dependencies{Authorizer: authorizer, Store: sshSource})
	if err != nil {
		return nil, nil, fmt.Errorf("创建 SSH 连接接口失败: %w", err)
	}
	sshWorkspaces, err := webuisshapi.NewWorkspacesHandler(webuisshapi.Dependencies{Authorizer: authorizer}, sshSource, dependencies.AIHomeDir)
	if err != nil {
		return nil, nil, fmt.Errorf("创建 SSH 工作区接口失败: %w", err)
	}
	sshSessions, err := webuisshapi.NewSessionsHandler(webuisshapi.Dependencies{Authorizer: authorizer}, sshSource, dependencies.TerminalProbe)
	if err != nil {
		return nil, nil, fmt.Errorf("创建 SSH 工作区终端状态接口失败: %w", err)
	}
	// SSH 探测走 Go 进程内传输；第一切片只读，Node 仍承接终端与 Remote Workspace。
	sshProbe, err := webuisshprobeapi.NewHandler(webuisshprobeapi.Dependencies{
		Authorizer:  authorizer,
		Connections: sshSource,
		Prober:      sshremote.Prober{HomeDir: dependencies.HostHomeDir},
	})
	if err != nil {
		return nil, nil, fmt.Errorf("创建 SSH 探测接口失败: %w", err)
	}
	// 远端目录浏览：沿用 Node 的 argv 合同，Runner 用 Go 进程内 SSH 执行。
	// 出口/反向隧道连接暂不承接，由 Runner 明确失败关闭。
	sshBrowse, err := webuisshhostbrowseapi.NewHandler(webuisshhostbrowseapi.Dependencies{
		Authorizer:  authorizer,
		Connections: sshSource,
		Runner:      sshhostbrowse.Runner{HomeDir: dependencies.HostHomeDir},
	})
	if err != nil {
		return nil, nil, fmt.Errorf("创建 SSH 目录浏览接口失败: %w", err)
	}
	sshReverseTunnels, err := webuisshreverseapi.NewHandler(webuisshreverseapi.Dependencies{
		Authorizer:  authorizer,
		Connections: sshSource,
		Supervisor:  dependencies.ReverseTunnels,
	})
	if err != nil {
		return nil, nil, fmt.Errorf("创建 SSH 反向隧道接口失败: %w", err)
	}

	return sshSource, []webuiRoute{
		{Pattern: "GET " + webuisshapi.Path, Handler: sshHandler},
		{Pattern: "GET " + webuisshapi.WorkspacesPath, Handler: sshWorkspaces},
		{Pattern: "GET " + webuisshapi.WorkspaceSessionsPath, Handler: sshSessions},
		{Pattern: "GET " + webuisshprobeapi.Path, Handler: sshProbe},
		{Pattern: "GET " + webuisshhostbrowseapi.Path, Handler: sshBrowse},
		{Pattern: "GET " + webuisshreverseapi.Path, Handler: sshReverseTunnels},
		{Pattern: "GET " + webuisshreverseapi.WatchPath, Handler: sshReverseTunnels},
		{Pattern: "POST " + webuisshreverseapi.ReconcilePath, Handler: sshReverseTunnels},
		// 旧 Node 公开路径兼容：SSH 页仍在用 /v0/webui/ssh-connections/tunnels 与 .../watch。
		// 与 canonical ssh/reverse-tunnels 是同一份能力，只做前缀重写。
		{Pattern: "GET /v0/webui/ssh-connections/tunnels", Handler: webuipublicalias.Rewrite("/v0/webui/ssh-connections/tunnels", webuisshreverseapi.Path, sshReverseTunnels), SkipPublicAlias: true},
		{Pattern: "GET /v0/webui/ssh-connections/tunnels/watch", Handler: webuipublicalias.Rewrite("/v0/webui/ssh-connections/tunnels/watch", webuisshreverseapi.WatchPath, sshReverseTunnels), SkipPublicAlias: true},
		{Pattern: "POST " + webuisshreverseapi.Path + "/{connectionId}/reconnect", Handler: sshReverseTunnels},
	}, nil
}

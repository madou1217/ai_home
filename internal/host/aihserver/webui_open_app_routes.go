package aihserver

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/madou1217/ai_home/internal/transport/http/webuiopenappapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiterminalapi"
)

// newWebUIOpenAppLauncher 构建基于原生 Go 实现的宿主应用启动器，
// 供 accounts/{provider}/{accountRef}/open-app 与 toolkit app-open 共用，
// 不再回环调用 Node /v0/internal/accounts/launch-app。
func newWebUIOpenAppLauncher(dependencies webuiRouteDependencies) webuiopenappapi.Launcher {
	var webTerminalOpener webuiopenappapi.WebUITerminalOpener
	if dependencies.TerminalHandler != nil {
		terminalHandler := dependencies.TerminalHandler
		webTerminalOpener = func(
			ctx context.Context,
			req webuiopenappapi.WebUITerminalOpenRequest,
		) (webuiopenappapi.WebUITerminalOpenResult, error) {
			launchRes, launchErr := terminalHandler.LaunchSession(ctx, webuiterminalapi.LaunchRequest{
				SessionKey: req.SessionKey,
				Cwd:        req.Cwd,
				File:       req.File,
				Args:       req.Args,
				Env:        req.Env,
				Persistent: req.Persistent,
			})
			if launchErr != nil {
				msg := strings.TrimSpace(launchErr.Message)
				if msg == "" {
					msg = strings.TrimSpace(launchErr.Code)
				}
				if msg == "" {
					msg = "打开 Web 虚拟终端失败"
				}
				return webuiopenappapi.WebUITerminalOpenResult{}, errors.New(msg)
			}
			return webuiopenappapi.WebUITerminalOpenResult{
				TermID:     launchRes.TermID,
				SessionKey: launchRes.SessionKey,
				Reused:     launchRes.Reused,
			}, nil
		}
	}

	return webuiopenappapi.NewNativeLauncher(webuiopenappapi.NativeLauncherDependencies{
		AIHomeDir:           dependencies.AIHomeDir,
		HostHomeDir:         dependencies.HostHomeDir,
		Catalog:             dependencies.Catalog,
		Store:               dependencies.Store,
		EgressManager:       dependencies.EgressManager,
		CodexHooksService:   dependencies.CodexHooks.DesktopService(),
		WebUITerminalOpener: webTerminalOpener,
	})
}

// buildWebUIOpenAppRoutes 装配账号应用打开/关闭（open-app）路由。
//
// 原生执行器覆盖 Desktop/CLI 打开与关闭、账号资格与出口校验、Codex Desktop Hook、
// ZCode 原生代理设置与缺失安装（428）提示，Coordinator 只需在 webuiroutes.go 中接入本组路由。
func buildWebUIOpenAppRoutes(dependencies webuiRouteDependencies) ([]webuiRoute, error) {
	if dependencies.Authorizer == nil || dependencies.Store == nil {
		return nil, nil
	}
	handler, err := webuiopenappapi.NewHandler(webuiopenappapi.Dependencies{
		Authorizer:  dependencies.Authorizer,
		Accounts:    dependencies.Store,
		Providers:   dependencies.Catalog,
		AIHomeDir:   dependencies.AIHomeDir,
		HostHomeDir: dependencies.HostHomeDir,
		Launcher:    newWebUIOpenAppLauncher(dependencies),
	})
	if err != nil {
		return nil, fmt.Errorf("创建打开应用接口失败: %w", err)
	}
	return []webuiRoute{
		{
			Pattern: "POST " + webuiopenappapi.Path + webuiopenappapi.OpenAppSuffix,
			Handler: handler,
		},
	}, nil
}

package aihserver

import (
	"fmt"
	"net/http"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/adapters/modelmetadata/modelsdev"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountconfigapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountsexportapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuialiaspoolapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiarchivedsessionsapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuichatpasteapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuicontrolplaneapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuimobileaccountapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuimodelcontextapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuimodelsapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiopenaimodelsapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiprovidercliupgradeapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiquotaresetapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuirestoreschedulingapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiserverconfigapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuisshapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuitoolkittargetsapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuitoolsettingsapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiusageconfigapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiwindowactivationapi"
)

// webuiRoute 是 WebUI 管理面的单条路由；Pattern 含方法，直接交给 ServeMux。
type webuiRoute struct {
	Pattern string
	Handler http.Handler
}

// webuiRouteDependencies 是 WebUI 路由装配的全部输入。
//
// 这里刻意只收「跨切片共享」的依赖：新增一个 WebUI 能力时，在 buildWebUIRoutes
// 里加一个 constructor + 路由条目即可，composition/router 不再逐切片增长。
type webuiRouteDependencies struct {
	Authorizer      interface{ Authorized(*http.Request) bool }
	AIHomeDir       string
	Catalog         *providers.Catalog
	ModelModalities *modelsdev.Index
	HostHomeDir     string
	Store           *sqliteaccount.Store
	AccountRuntime  any
	// TerminalProbe 返回持久终端会话状态；SSH 工作区终端状态接口需要。
	TerminalProbe func(sessionKey string) string
}

func buildWebUIRoutes(dependencies webuiRouteDependencies) ([]webuiRoute, error) {
	authorizer := dependencies.Authorizer

	toolSettingsSource, err := webuitoolsettingsapi.OpenSettingsSource(dependencies.AIHomeDir)
	if err != nil {
		return nil, fmt.Errorf("创建工具启动权限设置数据源失败: %w", err)
	}
	toolSettings, err := webuitoolsettingsapi.NewHandler(webuitoolsettingsapi.Dependencies{
		Authorizer: authorizer, Providers: dependencies.Catalog,
		Settings: toolSettingsSource, HostHomeDir: dependencies.HostHomeDir,
	})
	if err != nil {
		return nil, fmt.Errorf("创建工具启动权限设置接口失败: %w", err)
	}

	quotaResetSource, err := webuiquotaresetapi.OpenSource(dependencies.AIHomeDir)
	if err != nil {
		return nil, fmt.Errorf("创建额度重置历史数据源失败: %w", err)
	}
	quotaReset, err := webuiquotaresetapi.NewHandler(webuiquotaresetapi.Dependencies{
		Authorizer: authorizer, Accounts: quotaResetSource, Events: quotaResetSource,
	})
	if err != nil {
		return nil, fmt.Errorf("创建额度重置历史接口失败: %w", err)
	}

	aliasSource, err := webuialiaspoolapi.OpenSource(dependencies.AIHomeDir)
	if err != nil {
		return nil, fmt.Errorf("创建别名池设置数据源失败: %w", err)
	}
	aliasPool, err := webuialiaspoolapi.NewHandler(webuialiaspoolapi.Dependencies{Authorizer: authorizer, Store: aliasSource})
	if err != nil {
		return nil, fmt.Errorf("创建别名池设置接口失败: %w", err)
	}

	chatPasteSource, err := webuichatpasteapi.OpenSource(dependencies.AIHomeDir)
	if err != nil {
		return nil, fmt.Errorf("创建粘贴设置数据源失败: %w", err)
	}
	chatPaste, err := webuichatpasteapi.NewHandler(webuichatpasteapi.Dependencies{Authorizer: authorizer, Store: chatPasteSource})
	if err != nil {
		return nil, fmt.Errorf("创建粘贴设置接口失败: %w", err)
	}

	usageConfigSource, err := webuiusageconfigapi.OpenSource(dependencies.AIHomeDir)
	if err != nil {
		return nil, fmt.Errorf("创建用量配置数据源失败: %w", err)
	}
	usageConfig, err := webuiusageconfigapi.NewHandler(webuiusageconfigapi.Dependencies{Authorizer: authorizer, Store: usageConfigSource})
	if err != nil {
		return nil, fmt.Errorf("创建用量配置接口失败: %w", err)
	}

	sshSource, err := webuisshapi.OpenSource(dependencies.AIHomeDir)
	if err != nil {
		return nil, fmt.Errorf("创建 SSH 连接数据源失败: %w", err)
	}
	sshHandler, err := webuisshapi.NewHandler(webuisshapi.Dependencies{Authorizer: authorizer, Store: sshSource})
	if err != nil {
		return nil, fmt.Errorf("创建 SSH 连接接口失败: %w", err)
	}
	sshWorkspaces, err := webuisshapi.NewWorkspacesHandler(webuisshapi.Dependencies{Authorizer: authorizer}, sshSource, dependencies.AIHomeDir)
	if err != nil {
		return nil, fmt.Errorf("创建 SSH 工作区接口失败: %w", err)
	}
	sshSessions, err := webuisshapi.NewSessionsHandler(webuisshapi.Dependencies{Authorizer: authorizer}, sshSource, dependencies.TerminalProbe)
	if err != nil {
		return nil, fmt.Errorf("创建 SSH 工作区终端状态接口失败: %w", err)
	}

	serverConfigSource, err := webuiserverconfigapi.OpenSource(dependencies.AIHomeDir)
	if err != nil {
		return nil, fmt.Errorf("创建 server 配置数据源失败: %w", err)
	}
	serverConfig, err := webuiserverconfigapi.NewHandler(webuiserverconfigapi.Dependencies{Authorizer: authorizer, Store: serverConfigSource})
	if err != nil {
		return nil, fmt.Errorf("创建 server 配置接口失败: %w", err)
	}

	toolkitTargets, err := webuitoolkittargetsapi.NewHandler(webuitoolkittargetsapi.Dependencies{Authorizer: authorizer, Store: sshSource})
	if err != nil {
		return nil, fmt.Errorf("创建 toolkit 执行目标接口失败: %w", err)
	}
	accountConfig, err := webuiaccountconfigapi.NewHandler(webuiaccountconfigapi.Dependencies{
		Authorizer: authorizer, AIHomeDir: dependencies.AIHomeDir, Catalog: dependencies.Catalog,
	})
	if err != nil {
		return nil, fmt.Errorf("创建账号配置查看接口失败: %w", err)
	}
	modelContext, err := webuimodelcontextapi.NewHandler(webuimodelcontextapi.Dependencies{
		Authorizer: authorizer, AIHomeDir: dependencies.AIHomeDir,
		Catalog: dependencies.Catalog, Metadata: dependencies.ModelModalities,
	})
	if err != nil {
		return nil, fmt.Errorf("创建模型上下文接口失败: %w", err)
	}
	windowActivation, err := webuiwindowactivationapi.NewHandler(webuiwindowactivationapi.Dependencies{
		Authorizer: authorizer, AIHomeDir: dependencies.AIHomeDir,
	})
	if err != nil {
		return nil, fmt.Errorf("创建窗口激活接口失败: %w", err)
	}
	controlPlane, err := webuicontrolplaneapi.NewHandler(webuicontrolplaneapi.Dependencies{
		Authorizer: authorizer, AIHomeDir: dependencies.AIHomeDir,
	})
	if err != nil {
		return nil, fmt.Errorf("创建控制面接口失败: %w", err)
	}
	providerUpgrade, err := webuiprovidercliupgradeapi.NewHandler(webuiprovidercliupgradeapi.Dependencies{
		Authorizer: authorizer, AIHomeDir: dependencies.AIHomeDir, Catalog: dependencies.Catalog,
	})
	if err != nil {
		return nil, fmt.Errorf("创建 provider CLI 升级接口失败: %w", err)
	}

	restoreRuntime, ok := dependencies.AccountRuntime.(webuirestoreschedulingapi.RuntimeRestorer)
	if !ok {
		return nil, fmt.Errorf("创建强制恢复调度接口失败: 运行态不支持 RestoreScheduling")
	}
	restoreScheduling, err := webuirestoreschedulingapi.NewHandler(webuirestoreschedulingapi.Dependencies{
		Authorizer: authorizer, AIHomeDir: dependencies.AIHomeDir, Runtime: restoreRuntime,
	})
	if err != nil {
		return nil, fmt.Errorf("创建强制恢复调度接口失败: %w", err)
	}
	accountExport, err := webuiaccountsexportapi.NewHandler(webuiaccountsexportapi.Dependencies{
		Authorizer: authorizer, Overviews: dependencies.Store, Credentials: dependencies.Store,
	})
	if err != nil {
		return nil, fmt.Errorf("创建账号导出接口失败: %w", err)
	}
	modelsRead, err := webuimodelsapi.NewHandler(webuimodelsapi.Dependencies{Authorizer: authorizer, Reader: dependencies.Store})
	if err != nil {
		return nil, fmt.Errorf("创建模型只读投影接口失败: %w", err)
	}
	openaiModelsRead, err := webuiopenaimodelsapi.NewHandler(webuiopenaimodelsapi.Dependencies{Authorizer: authorizer, Reader: dependencies.Store})
	if err != nil {
		return nil, fmt.Errorf("创建 OpenAI 模型读模型接口失败: %w", err)
	}
	archivedSessions, err := webuiarchivedsessionsapi.NewHandler(webuiarchivedsessionsapi.Dependencies{
		Authorizer: authorizer, HostHomeDir: dependencies.HostHomeDir,
	})
	if err != nil {
		return nil, fmt.Errorf("创建归档会话接口失败: %w", err)
	}
	setMobile, err := webuimobileaccountapi.NewSetMobileHandler(webuimobileaccountapi.Dependencies{
		Authorizer: authorizer, AIHomeDir: dependencies.AIHomeDir,
	})
	if err != nil {
		return nil, fmt.Errorf("创建 Codex App 绑定接口失败: %w", err)
	}
	clearMobile, err := webuimobileaccountapi.NewClearMobileHandler(webuimobileaccountapi.Dependencies{
		Authorizer: authorizer, AIHomeDir: dependencies.AIHomeDir,
	})
	if err != nil {
		return nil, fmt.Errorf("创建 Codex App 解绑接口失败: %w", err)
	}

	return []webuiRoute{
		{Pattern: "POST " + webuirestoreschedulingapi.Path + webuirestoreschedulingapi.RouteSuffix, Handler: restoreScheduling},
		{Pattern: "GET " + webuiaccountsexportapi.Path, Handler: accountExport},
		{Pattern: "GET " + webuimodelsapi.Path, Handler: modelsRead},
		{Pattern: "GET " + webuiopenaimodelsapi.Path, Handler: openaiModelsRead},
		{Pattern: "GET " + webuiarchivedsessionsapi.Path, Handler: archivedSessions},
		{Pattern: "POST " + webuimobileaccountapi.SetMobilePath, Handler: setMobile},
		{Pattern: "POST " + webuimobileaccountapi.ClearMobilePath, Handler: clearMobile},
		{Pattern: "GET " + webuitoolsettingsapi.Path + "/{appId}/settings", Handler: toolSettings},
		{Pattern: "GET " + webuiquotaresetapi.Path + "/{provider}/{accountRef}/quota-reset-events", Handler: quotaReset},
		{Pattern: "GET " + webuialiaspoolapi.Path + "/{provider}/{accountRef}/alias-pool", Handler: aliasPool},
		{Pattern: "POST " + webuialiaspoolapi.Path + "/{provider}/{accountRef}/alias-pool", Handler: aliasPool},
		{Pattern: "GET " + webuichatpasteapi.Path, Handler: chatPaste},
		{Pattern: "POST " + webuichatpasteapi.Path, Handler: chatPaste},
		{Pattern: "GET " + webuiusageconfigapi.Path, Handler: usageConfig},
		{Pattern: "POST " + webuiusageconfigapi.Path, Handler: usageConfig},
		{Pattern: "GET " + webuisshapi.Path, Handler: sshHandler},
		{Pattern: "GET " + webuisshapi.WorkspacesPath, Handler: sshWorkspaces},
		{Pattern: "GET " + webuisshapi.WorkspaceSessionsPath, Handler: sshSessions},
		{Pattern: "GET " + webuiserverconfigapi.Path, Handler: serverConfig},
		{Pattern: "POST " + webuiserverconfigapi.Path, Handler: serverConfig},
		{Pattern: "GET " + webuitoolkittargetsapi.Path, Handler: toolkitTargets},
		{Pattern: "GET " + webuiaccountconfigapi.Path + "/{provider}/{accountRef}/config-files", Handler: accountConfig},
		{Pattern: "GET " + webuimodelcontextapi.Path + "/{provider}/{accountRef}/model-context", Handler: modelContext},
		{Pattern: "POST " + webuimodelcontextapi.Path + "/{provider}/{accountRef}/model-context", Handler: modelContext},
		{Pattern: "DELETE " + webuimodelcontextapi.Path + "/{provider}/{accountRef}/model-context", Handler: modelContext},
		{Pattern: "POST " + webuimodelcontextapi.Path + "/{provider}/model-context/bulk", Handler: http.HandlerFunc(modelContext.ServeBulkHTTP)},
		{Pattern: "GET " + webuiwindowactivationapi.Path + "/{provider}/{accountRef}/window-activation", Handler: windowActivation},
		{Pattern: "POST " + webuiwindowactivationapi.Path + "/{provider}/{accountRef}/window-activation", Handler: windowActivation},
		{Pattern: "GET " + webuicontrolplaneapi.Path + "/profiles", Handler: controlPlane},
		{Pattern: "POST " + webuicontrolplaneapi.Path + "/profiles", Handler: controlPlane},
		{Pattern: "POST " + webuicontrolplaneapi.Path + "/profiles/active", Handler: controlPlane},
		{Pattern: "DELETE " + webuicontrolplaneapi.Path + "/profiles/{profileId}", Handler: controlPlane},
		{Pattern: "GET " + webuicontrolplaneapi.Path + "/endpoints", Handler: controlPlane},
		{Pattern: "GET " + webuiprovidercliupgradeapi.Path, Handler: providerUpgrade},
	}, nil
}

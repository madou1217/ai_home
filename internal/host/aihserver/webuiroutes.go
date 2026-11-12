package aihserver

import (
	"context"
	"fmt"
	"net/http"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	usageapp "github.com/madou1217/ai_home/application/accountusage"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accountrefmap"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/adapters/modelmetadata/modelsdev"
	"github.com/madou1217/ai_home/internal/adapters/sshhostbrowse"
	"github.com/madou1217/ai_home/internal/adapters/sshremote"
	"github.com/madou1217/ai_home/internal/runtime/sshtunnel"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountconfigapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountimportapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountreauthapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountsexportapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountstatusapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountupdateapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuialiaspoolapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiappentriesapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiarchivedsessionsapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuichatpasteapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuicontrolplaneapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuicontrolplanebootstrapapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuifsaccessapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuifsmediaapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuifsreadapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuifstreeapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuifstrustapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuigitapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuimanagementkeyapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuimobileaccountapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuimodelcontextapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuimodelsapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuimodelsettingsapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiopenaimodelsapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiopenaimodelswriteapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiprojectsapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiproviderauthsourcesapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiproviderclearbrokenapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiprovidercliupgradeapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiproviderhooksapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiquotaresetapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuirestoreschedulingapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiroutingrulesapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiserverconfigapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuisessioneventsapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuisessionmessagesapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuisessionpreviewsapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuisessionslifecycleapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuisessionslistapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuisetdefaultapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuislashcommandsapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuisshapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuisshhostbrowseapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuisshprobeapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuisshreverseapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuisshwriteapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuitoolappsettingswriteapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuitoolkitruntimeapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuitoolkittargetsapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuitoolsettingsapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiusageconfigapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiwindowactivationapi"
	"github.com/madou1217/ai_home/internal/webuifile"
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
	// AuthJobs 是 OAuth 作业服务：重新认证直接复用它起作业，不另建一套状态机。
	AuthJobs webuiaccountreauthapi.AccountAuthJobs
	// AccountsHandler 是 accountsapi 的账号导入端点（WebUI import 直接复用）。
	AccountsHandler http.Handler
	// CredentialEditor 是静态凭据编辑用例（update 路由复用）。
	CredentialEditor webuiaccountupdateapi.CredentialEditor
	// ProviderDefaults 是 Go 的 provider 默认账号关系。
	ProviderDefaults *accountapp.ProviderDefaults
	// ModelRefresher 是账号模型目录刷新端口（账号刷新作业的 models 段）。
	ModelRefresher accountapp.AccountModelRefresher
	// UsageService 是额度应用服务（账号刷新作业的 usage 段与 refresh-usage 入口）。
	UsageService *usageapp.Service
	// TerminalProbe 返回持久终端会话状态；SSH 工作区终端状态接口需要。
	TerminalProbe func(sessionKey string) string
	// ReverseTunnels 维护 ssh_connections.reverseTunnel。
	ReverseTunnels *sshtunnel.Supervisor
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
	// SSH 探测走 Go 进程内传输；第一切片只读，Node 仍承接终端与 Remote Workspace。
	sshProbe, err := webuisshprobeapi.NewHandler(webuisshprobeapi.Dependencies{
		Authorizer:  authorizer,
		Connections: sshSource,
		Prober:      sshremote.Prober{HomeDir: dependencies.HostHomeDir},
	})
	if err != nil {
		return nil, fmt.Errorf("创建 SSH 探测接口失败: %w", err)
	}
	// 远端目录浏览：沿用 Node 的 argv 合同，Runner 用 Go 进程内 SSH 执行。
	// 出口/反向隧道连接暂不承接，由 Runner 明确失败关闭。
	sshBrowse, err := webuisshhostbrowseapi.NewHandler(webuisshhostbrowseapi.Dependencies{
		Authorizer:  authorizer,
		Connections: sshSource,
		Runner:      sshhostbrowse.Runner{HomeDir: dependencies.HostHomeDir},
	})
	if err != nil {
		return nil, fmt.Errorf("创建 SSH 目录浏览接口失败: %w", err)
	}
	sshReverseTunnels, err := webuisshreverseapi.NewHandler(webuisshreverseapi.Dependencies{
		Authorizer:  authorizer,
		Connections: sshSource,
		Supervisor:  dependencies.ReverseTunnels,
	})
	if err != nil {
		return nil, fmt.Errorf("创建 SSH 反向隧道接口失败: %w", err)
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

	controlPlaneBootstrap, err := webuicontrolplanebootstrapapi.NewHandler(webuicontrolplanebootstrapapi.Dependencies{
		Authorizer: authorizer, AIHomeDir: dependencies.AIHomeDir,
	})
	if err != nil {
		return nil, fmt.Errorf("创建控制面引导接口失败: %w", err)
	}

	// 强制恢复调度是可选能力：运行态不提供时**跳过**这条路由，让 Node 继续兜底，
	// 而不是让一个 WebUI 写接口把整个 Go Core 拖到启动失败。
	var restoreScheduling http.Handler
	if restoreRuntime, ok := dependencies.AccountRuntime.(webuirestoreschedulingapi.RuntimeRestorer); ok {
		restoreScheduling, err = webuirestoreschedulingapi.NewHandler(webuirestoreschedulingapi.Dependencies{
			Authorizer: authorizer, AIHomeDir: dependencies.AIHomeDir, Runtime: restoreRuntime,
		})
		if err != nil {
			return nil, fmt.Errorf("创建强制恢复调度接口失败: %w", err)
		}
	}
	databasePath, err := appstate.DatabasePath(dependencies.AIHomeDir)
	if err != nil {
		return nil, fmt.Errorf("解析 app-state 路径失败: %w", err)
	}
	refTable, _ := accountrefmap.Load(context.Background(), dependencies.AIHomeDir)
	refResolver := accountrefmap.NewResolver(true, refTable)
	accountExport, err := webuiaccountsexportapi.NewHandler(webuiaccountsexportapi.Dependencies{
		Authorizer: authorizer, Overviews: dependencies.Store, Credentials: dependencies.Store, Resolver: refResolver,
	})
	if err != nil {
		return nil, fmt.Errorf("创建账号导出接口失败: %w", err)
	}
	modelsRead, err := webuimodelsapi.NewHandler(webuimodelsapi.Dependencies{
		Authorizer: authorizer, Reader: dependencies.Store,
		Settings: webuimodelsapi.SettingsFile{DatabasePath: databasePath},
		Snapshot: webuimodelsapi.SnapshotFile{DatabasePath: databasePath},
		Refs:     refResolver,
	})
	if err != nil {
		return nil, fmt.Errorf("创建模型只读投影接口失败: %w", err)
	}
	openaiModelsRead, err := webuiopenaimodelsapi.NewHandler(webuiopenaimodelsapi.Dependencies{
		Authorizer: authorizer, Reader: dependencies.Store,
		Settings:    webuiopenaimodelsapi.SettingsFile{DatabasePath: databasePath},
		Snapshot:    webuiopenaimodelsapi.SnapshotFile{DatabasePath: databasePath},
		AccountRefs: refResolver,
	})
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
	trustSource, err := webuifstrustapi.OpenSource(dependencies.AIHomeDir)
	if err != nil {
		return nil, fmt.Errorf("创建可信目录数据源失败: %w", err)
	}
	fsTrust, err := webuifstrustapi.NewHandler(webuifstrustapi.Dependencies{
		Authorizer: authorizer, Store: trustSource,
		AIHomeDir: dependencies.AIHomeDir, HostHomeDir: dependencies.HostHomeDir,
	})
	if err != nil {
		return nil, fmt.Errorf("创建可信目录接口失败: %w", err)
	}
	fsAccess, err := webuifsaccessapi.NewHandler(webuifsaccessapi.Dependencies{
		Authorizer: authorizer,
		Env:        webuifile.Env{AIHomeDir: dependencies.AIHomeDir, HostHomeDir: dependencies.HostHomeDir},
		TrustedRoots: func() []webuifile.TrustedRoot {
			roots, _ := trustSource.ReadTrustedRoots(context.Background())
			return roots
		},
	})
	if err != nil {
		return nil, fmt.Errorf("创建文件访问预检接口失败: %w", err)
	}
	hooks, err := webuiproviderhooksapi.NewHandler(webuiproviderhooksapi.Dependencies{
		Authorizer: authorizer, Catalog: dependencies.Catalog,
	})
	if err != nil {
		return nil, fmt.Errorf("创建 provider hooks 读模型失败: %w", err)
	}
	fsRead, err := webuifsreadapi.NewHandler(webuifsreadapi.Dependencies{
		Authorizer: authorizer,
		Env:        webuifile.Env{AIHomeDir: dependencies.AIHomeDir, HostHomeDir: dependencies.HostHomeDir},
		TrustedRoots: func() []webuifile.TrustedRoot {
			roots, _ := trustSource.ReadTrustedRoots(context.Background())
			return roots
		},
	})
	if err != nil {
		return nil, fmt.Errorf("创建文件读取接口失败: %w", err)
	}
	fsTree, err := webuifstreeapi.NewHandler(webuifstreeapi.Dependencies{
		Authorizer: authorizer,
		TrustedRoots: func() []webuifile.TrustedRoot {
			roots, _ := trustSource.ReadTrustedRoots(context.Background())
			return roots
		},
	})
	if err != nil {
		return nil, fmt.Errorf("创建文件树接口失败: %w", err)
	}
	fsMedia, err := webuifsmediaapi.NewHandler(webuifsmediaapi.Dependencies{
		Authorizer: authorizer,
		Env:        webuifile.Env{AIHomeDir: dependencies.AIHomeDir, HostHomeDir: dependencies.HostHomeDir},
		TrustedRoots: func() []webuifile.TrustedRoot {
			roots, _ := trustSource.ReadTrustedRoots(context.Background())
			return roots
		},
	})
	if err != nil {
		return nil, fmt.Errorf("创建媒体预览接口失败: %w", err)
	}
	sshWriteSource, err := webuisshwriteapi.OpenSource(dependencies.AIHomeDir)
	if err != nil {
		return nil, fmt.Errorf("创建 SSH 写入数据源失败: %w", err)
	}
	sshWrite, err := webuisshwriteapi.NewHandler(webuisshwriteapi.Dependencies{Authorizer: authorizer, Store: sshWriteSource})
	if err != nil {
		return nil, fmt.Errorf("创建 SSH 写入接口失败: %w", err)
	}
	accountImport, err := webuiaccountimportapi.NewHandler(webuiaccountimportapi.Dependencies{
		Authorizer: authorizer, Import: dependencies.AccountsHandler,
	})
	if err != nil {
		return nil, fmt.Errorf("创建账号导入接口失败: %w", err)
	}
	accountStatus, err := webuiaccountstatusapi.NewHandler(webuiaccountstatusapi.Dependencies{
		Authorizer: authorizer, Accounts: dependencies.Store,
	})
	if err != nil {
		return nil, fmt.Errorf("创建账号启停接口失败: %w", err)
	}
	accountUpdate, err := webuiaccountupdateapi.NewHandler(webuiaccountupdateapi.Dependencies{
		Authorizer: authorizer, Accounts: dependencies.Store, Editor: dependencies.CredentialEditor,
	})
	if err != nil {
		return nil, fmt.Errorf("创建账号编辑接口失败: %w", err)
	}
	modelsSettings, err := webuimodelsettingsapi.NewHandler(webuimodelsettingsapi.Dependencies{
		Authorizer: authorizer, Store: webuimodelsettingsapi.DatabaseStore{DatabasePath: databasePath},
	})
	if err != nil {
		return nil, fmt.Errorf("创建模型设置写入接口失败: %w", err)
	}
	routingAdapters, err := webuiroutingrulesapi.OpenAdapters(context.Background(), dependencies.AIHomeDir, dependencies.Store)
	if err != nil {
		return nil, fmt.Errorf("创建调度规则写入适配器失败: %w", err)
	}
	runtimeClearer, _ := dependencies.AccountRuntime.(webuiroutingrulesapi.RuntimeBlockClearer)
	routingRules, err := webuiroutingrulesapi.NewHandler(webuiroutingrulesapi.Dependencies{
		Authorizer: authorizer, Store: routingAdapters.Store, Accounts: routingAdapters.Accounts,
		Catalog: dependencies.Catalog, Runtime: runtimeClearer,
	})
	if err != nil {
		return nil, fmt.Errorf("创建调度规则接口失败: %w", err)
	}
	setDefault, err := webuisetdefaultapi.NewHandler(webuisetdefaultapi.BuildDependencies(
		authorizer, dependencies.AIHomeDir, dependencies.Catalog, dependencies.ProviderDefaults,
		webuisetdefaultapi.HostProjection{},
	))
	if err != nil {
		return nil, fmt.Errorf("创建默认账号接口失败: %w", err)
	}

	// 宿主面只读能力：git / 项目聚合 / slash 命令 / 应用入口 / 工具链环境。
	// 统一以 HostHomeDir 为边界，越界由各包自己拒绝。
	gitRead, err := webuigitapi.NewHandler(webuigitapi.Dependencies{
		Authorizer: authorizer, HostHomeDir: dependencies.HostHomeDir,
	})
	if err != nil {
		return nil, fmt.Errorf("创建 git 只读接口失败: %w", err)
	}
	projects, err := webuiprojectsapi.NewHandler(webuiprojectsapi.Dependencies{
		Authorizer: authorizer, HostHomeDir: dependencies.HostHomeDir, AiHomeDir: dependencies.AIHomeDir,
	})
	if err != nil {
		return nil, fmt.Errorf("创建项目聚合接口失败: %w", err)
	}
	slashCommands, err := webuislashcommandsapi.NewHandler(webuislashcommandsapi.Dependencies{
		Authorizer: authorizer, HostHomeDir: dependencies.HostHomeDir,
	})
	if err != nil {
		return nil, fmt.Errorf("创建 slash 命令接口失败: %w", err)
	}
	appEntries, err := webuiappentriesapi.NewHandler(webuiappentriesapi.Dependencies{
		Authorizer: authorizer, HostHomeDir: dependencies.HostHomeDir,
	})
	if err != nil {
		return nil, fmt.Errorf("创建应用入口探测接口失败: %w", err)
	}
	toolkitEnvironments, err := webuitoolkitruntimeapi.NewHandler(webuitoolkitruntimeapi.Dependencies{
		Authorizer: authorizer, HostHomeDir: dependencies.HostHomeDir,
	})
	if err != nil {
		return nil, fmt.Errorf("创建工具链环境接口失败: %w", err)
	}
	sessionMessages, err := webuisessionmessagesapi.NewHandler(webuisessionmessagesapi.Dependencies{
		Authorizer: authorizer, HostHomeDir: dependencies.HostHomeDir, AIHomeDir: dependencies.AIHomeDir,
	})
	if err != nil {
		return nil, fmt.Errorf("创建会话消息接口失败: %w", err)
	}
	sessionPreviews, err := webuisessionpreviewsapi.NewHandler(webuisessionpreviewsapi.Dependencies{
		Authorizer: authorizer, HostHomeDir: dependencies.HostHomeDir,
	})
	if err != nil {
		return nil, fmt.Errorf("创建会话预览接口失败: %w", err)
	}
	sessionEvents, err := webuisessioneventsapi.NewHandler(webuisessioneventsapi.Dependencies{
		Authorizer: authorizer, HostHomeDir: dependencies.HostHomeDir,
	})
	if err != nil {
		return nil, fmt.Errorf("创建会话事件接口失败: %w", err)
	}

	managementKeySource, err := webuimanagementkeyapi.OpenSource(dependencies.AIHomeDir)
	if err != nil {
		return nil, fmt.Errorf("创建管理密钥数据源失败: %w", err)
	}
	managementKey, err := webuimanagementkeyapi.NewHandler(webuimanagementkeyapi.Dependencies{
		Authorizer: authorizer, Store: managementKeySource,
	})
	if err != nil {
		return nil, fmt.Errorf("创建管理密钥轮换接口失败: %w", err)
	}
	clearBroken, err := webuiproviderclearbrokenapi.NewHandler(webuiproviderclearbrokenapi.Dependencies{
		Authorizer: authorizer, AIHomeDir: dependencies.AIHomeDir, Catalog: dependencies.Catalog,
	})
	if err != nil {
		return nil, fmt.Errorf("创建解除升级熔断接口失败: %w", err)
	}
	// 模型目录刷新：Go 侧按账号扇出，Provider 适配器由各自的模型发现模块注册。
	// 这里不按 Provider 写分支——「openai-models」只是 OpenAI 兼容的响应形状，
	// 不是 Provider 范围。依赖缺失时保持 nil，写接口继续返回 501，由 Node 回落到
	// 自己的探测路径，而不是假装刷新成功。
	modelCatalogRefresher := newWebUIModelCatalogRefresher(
		dependencies.Store,
		dependencies.ModelRefresher,
		time.Now,
	)
	openaiModelsWrite, err := webuiopenaimodelswriteapi.NewHandler(webuiopenaimodelswriteapi.Dependencies{
		Authorizer: authorizer, AIHomeDir: dependencies.AIHomeDir,
		Store:     webuiopenaimodelswriteapi.DatabaseStore{DatabasePath: databasePath},
		Catalog:   dependencies.Store,
		Refresher: modelCatalogRefresher,
	})
	if err != nil {
		return nil, fmt.Errorf("创建 OpenAI 模型写入接口失败: %w", err)
	}

	toolAppSettings, err := webuitoolappsettingswriteapi.NewHandler(webuitoolappsettingswriteapi.Dependencies{
		Authorizer: authorizer, Providers: dependencies.Catalog, AIHomeDir: dependencies.AIHomeDir,
	})
	if err != nil {
		return nil, fmt.Errorf("创建工具应用设置写入接口失败: %w", err)
	}
	sessionsList, err := webuisessionslistapi.NewHandler(webuisessionslistapi.Dependencies{
		Authorizer: authorizer, HostHomeDir: dependencies.HostHomeDir, AIHomeDir: dependencies.AIHomeDir,
	})
	if err != nil {
		return nil, fmt.Errorf("创建账号会话列表接口失败: %w", err)
	}
	sessionsLifecycle, err := webuisessionslifecycleapi.NewHandler(webuisessionslifecycleapi.Dependencies{
		Authorizer: authorizer, HostHomeDir: dependencies.HostHomeDir, AIHomeDir: dependencies.AIHomeDir,
	})
	if err != nil {
		return nil, fmt.Errorf("创建会话生命周期接口失败: %w", err)
	}
	reauthStarter, err := webuiaccountreauthapi.NewAccountAuthStarter(dependencies.AuthJobs)
	if err != nil {
		return nil, fmt.Errorf("创建重新认证作业启动器失败: %w", err)
	}
	reauth, err := webuiaccountreauthapi.NewHandler(webuiaccountreauthapi.Dependencies{
		Authorizer: authorizer, AIHomeDir: dependencies.AIHomeDir,
		Accounts: dependencies.Store, Jobs: reauthStarter,
	})
	if err != nil {
		return nil, fmt.Errorf("创建重新认证接口失败: %w", err)
	}

	authSources, err := webuiproviderauthsourcesapi.NewHandler(webuiproviderauthsourcesapi.Dependencies{
		Authorizer: authorizer, HostHomeDir: dependencies.HostHomeDir, AIHomeDir: dependencies.AIHomeDir,
	})
	if err != nil {
		return nil, fmt.Errorf("创建 Provider 授权来源接口失败: %w", err)
	}

	routes := []webuiRoute{
		{Pattern: "GET " + webuiaccountsexportapi.Path, Handler: accountExport},
		{Pattern: "GET " + webuimodelsapi.Path, Handler: modelsRead},
		{Pattern: "PUT " + webuimodelsettingsapi.Path, Handler: modelsSettings},
		{Pattern: "POST " + webuimodelsettingsapi.Path, Handler: modelsSettings},
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
		{Pattern: "GET " + webuisshprobeapi.Path, Handler: sshProbe},
		{Pattern: "GET " + webuisshhostbrowseapi.Path, Handler: sshBrowse},
		{Pattern: "GET " + webuisshreverseapi.Path, Handler: sshReverseTunnels},
		{Pattern: "GET " + webuisshreverseapi.WatchPath, Handler: sshReverseTunnels},
		{Pattern: "POST " + webuisshreverseapi.ReconcilePath, Handler: sshReverseTunnels},
		{Pattern: "POST " + webuisshreverseapi.Path + "/{connectionId}/reconnect", Handler: sshReverseTunnels},
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
		{Pattern: "POST " + webuifstrustapi.TrustPath, Handler: fsTrust},
		{Pattern: "GET " + webuifsaccessapi.Path, Handler: fsAccess},
		{Pattern: "GET " + webuiproviderhooksapi.Path, Handler: hooks},
		{Pattern: "GET " + webuifsreadapi.Path, Handler: fsRead},
		{Pattern: "GET " + webuifstreeapi.Path, Handler: fsTree},
		{Pattern: "GET " + webuifsmediaapi.Path, Handler: fsMedia},
		{Pattern: "POST " + webuisshwriteapi.CollectionPath, Handler: sshWrite},
		{Pattern: "PUT " + webuisshwriteapi.ItemPath, Handler: sshWrite},
		{Pattern: "DELETE " + webuisshwriteapi.ItemPath, Handler: sshWrite},
		{Pattern: "POST " + webuiaccountimportapi.Path, Handler: accountImport},
		{Pattern: "POST " + webuiaccountstatusapi.Path + webuiaccountstatusapi.RouteSuffix, Handler: accountStatus},
		{Pattern: "POST " + webuiaccountupdateapi.UpdatePath, Handler: accountUpdate},
		{Pattern: "POST " + webuiroutingrulesapi.Path, Handler: routingRules},
		{Pattern: "POST " + webuisetdefaultapi.Path + webuisetdefaultapi.SetDefaultRouteSuffix, Handler: setDefault},
		{Pattern: "POST " + webuisetdefaultapi.Path + webuisetdefaultapi.ClearDefaultRouteSuffix, Handler: setDefault},
		{Pattern: "GET " + webuigitapi.Path + webuigitapi.SummarySuffix, Handler: gitRead},
		{Pattern: "GET " + webuigitapi.Path + webuigitapi.DiffSuffix, Handler: gitRead},
		{Pattern: "GET " + webuiprojectsapi.Path, Handler: projects},
		{Pattern: "GET " + webuiprojectsapi.SessionsPath, Handler: projects},
		{Pattern: "GET " + webuisessionmessagesapi.Path, Handler: sessionMessages},
		{Pattern: "GET " + webuisessioneventsapi.Path, Handler: sessionEvents},
		{Pattern: "GET " + webuislashcommandsapi.Path, Handler: slashCommands},
		{Pattern: "GET " + webuiappentriesapi.Path, Handler: appEntries},
		{Pattern: "GET " + webuitoolkitruntimeapi.Path, Handler: toolkitEnvironments},
		{Pattern: "POST " + webuisessionpreviewsapi.Path, Handler: sessionPreviews},
		{Pattern: "POST " + webuimanagementkeyapi.Path, Handler: managementKey},
		{Pattern: "POST " + webuiproviderclearbrokenapi.Path + webuiproviderclearbrokenapi.ClearBrokenSuffix, Handler: clearBroken},
		{Pattern: "POST " + webuiopenaimodelswriteapi.RefreshPath, Handler: openaiModelsWrite},
		{Pattern: "POST " + webuiopenaimodelswriteapi.DeletePath, Handler: openaiModelsWrite},
		{Pattern: "PUT " + webuitoolappsettingswriteapi.Path + webuitoolappsettingswriteapi.SettingsSuffix, Handler: toolAppSettings},
		{Pattern: "GET " + webuisessionslistapi.Path + "/{provider}/{accountRef}", Handler: sessionsList},
		{Pattern: "GET " + webuisessionslifecycleapi.LifecycleCapabilitiesPath, Handler: sessionsLifecycle},
		{Pattern: "POST " + webuisessionslifecycleapi.ArchivePath, Handler: sessionsLifecycle},
		{Pattern: "POST " + webuiaccountreauthapi.Path + webuiaccountreauthapi.ReauthSuffix, Handler: reauth},
		{Pattern: "GET " + webuicontrolplanebootstrapapi.Path, Handler: controlPlaneBootstrap},
		{Pattern: "GET " + webuiproviderauthsourcesapi.Path, Handler: authSources},
	}
	if restoreScheduling != nil {
		routes = append(routes, webuiRoute{
			Pattern: "POST " + webuirestoreschedulingapi.Path + webuirestoreschedulingapi.RouteSuffix,
			Handler: restoreScheduling,
		})
	}
	// 账号刷新同样是可选能力：账号存储缺失时整组不挂载，让 Node 继续兜底，
	// 而不是让三条写接口把整个 Go Core 拖到启动失败。
	refreshRoutes, err := buildWebUIRefreshRoutes(dependencies)
	if err != nil {
		return nil, err
	}
	routes = append(routes, refreshRoutes...)
	return routes, nil
}

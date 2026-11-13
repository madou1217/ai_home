package aihserver

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"time"

	accountauth "github.com/madou1217/ai_home/application/accountauth"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	usageapp "github.com/madou1217/ai_home/application/accountusage"
	"github.com/madou1217/ai_home/core/providers"
	accountactivityadapter "github.com/madou1217/ai_home/internal/adapters/accountactivity"
	"github.com/madou1217/ai_home/internal/adapters/accountrefmap"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/adapters/accountstate"
	agyegress "github.com/madou1217/ai_home/internal/adapters/agy/egress"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/adapters/hostapps"
	"github.com/madou1217/ai_home/internal/adapters/hostdetect"
	"github.com/madou1217/ai_home/internal/adapters/hostexec"
	"github.com/madou1217/ai_home/internal/adapters/modelmetadata/modelsdev"
	"github.com/madou1217/ai_home/internal/adapters/sshhostbrowse"
	"github.com/madou1217/ai_home/internal/adapters/sshremote"
	"github.com/madou1217/ai_home/internal/runtime/sshtunnel"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountactivityapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountaddapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountconfigapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountdeleteapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountdetectapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountegressapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountimportapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountliveapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountreauthapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountsapi"
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
	"github.com/madou1217/ai_home/internal/transport/http/webuiopenappapi"
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
	"github.com/madou1217/ai_home/internal/transport/http/webuitoolkitenvapi"
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
	// AuthJobs 是 OAuth 作业服务：重新认证与新增账号都直接复用它的作业状态机。
	AuthJobs *accountauth.Service
	// AccountsHandler 是 accountsapi 的账号端点：HTTP 分发之外还提供导入作业需要的
	// 逐条导入用例（ImportAihAccounts），两条入口共用同一份导入语义。
	AccountsHandler interface {
		http.Handler
		webuiaccountimportapi.DocumentImporter
	}
	// AccountRows 是账号页读模型数据源（watch 快照与列表共用同一份行）。
	AccountRows webuiaccountsapi.Source
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
	// AccountDeletion 是账号删除用例（WebUI 的 DELETE 承接者）。
	AccountDeletion webuiaccountdeleteapi.AccountDeletion
	// AccountHostGrant 回收停用账号在宿主上的直连授权（当前只有 codex）。
	AccountHostGrant webuiaccountstatusapi.HostGrantRevoker
	// NodeBaseURL 是 Node 宿主回环地址：账号活动的 provider handler 仍由 Node 执行。
	NodeBaseURL string
	// ManagementKey 返回 Go Core 自己的引导密钥，Node 内部回调用它鉴权。
	ManagementKey func() string
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
	// 账号出口绑定：Go 是设置的唯一写者；运行态应用仍在 Node（薄壳写后执行）。
	accountEgress, err := webuiaccountegressapi.NewHandler(webuiaccountegressapi.Dependencies{
		Authorizer: authorizer, AIHomeDir: dependencies.AIHomeDir,
		Catalog: dependencies.Catalog, Store: agyegress.NewStore(dependencies.AIHomeDir),
	})
	if err != nil {
		return nil, fmt.Errorf("创建账号出口设置接口失败: %w", err)
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
	installHooks, err := webuiproviderhooksapi.NewInstallHandler(webuiproviderhooksapi.InstallDependencies{
		Authorizer: authorizer, Catalog: dependencies.Catalog, HostHomeDir: dependencies.HostHomeDir,
	})
	if err != nil {
		return nil, fmt.Errorf("创建 provider hooks 安装接口失败: %w", err)
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
	// account_state 是 Node WebUI 读取的展示投影。启停真值已经由 Go 承担，投影也
	// 必须由 Go 同步写回，否则 Node 侧不再写之后账号页会一直显示旧状态。
	// 打不开投影库时保持 nil：Go 真值仍可写，handler 不会伪造投影成功。
	var accountStatusProjection webuiaccountstatusapi.AccountStateProjection
	if projection, projectionErr := accountstate.Open(context.Background(), dependencies.AIHomeDir); projectionErr == nil {
		accountStatusProjection = projection
	} else {
		log.Printf("账号启停投影不可用: %v", projectionErr)
	}
	accountStatus, err := webuiaccountstatusapi.NewHandler(webuiaccountstatusapi.Dependencies{
		Authorizer: authorizer, Accounts: dependencies.Store,
		Projection: accountStatusProjection, HostGrant: dependencies.AccountHostGrant,
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
	accountDelete, err := webuiaccountdeleteapi.NewHandler(webuiaccountdeleteapi.Dependencies{
		Authorizer: authorizer, Deletion: dependencies.AccountDeletion,
	})
	if err != nil {
		return nil, fmt.Errorf("创建账号删除接口失败: %w", err)
	}
	setDefault, err := webuisetdefaultapi.NewHandler(webuisetdefaultapi.BuildDependencies(
		authorizer, dependencies.AIHomeDir, dependencies.Catalog, dependencies.ProviderDefaults,
		buildSetDefaultHostProjection(dependencies.AIHomeDir, dependencies.HostHomeDir),
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
		AIHomeDir: dependencies.AIHomeDir,
		Accounts:  hostapps.NewSource(dependencies.AIHomeDir),
	})
	if err != nil {
		return nil, fmt.Errorf("创建应用入口探测接口失败: %w", err)
	}
	// 打开应用：契约、启动计划与错误码在 Go；真正的宿主启动仍由 Node 执行器完成
	// （provider 桌面策略、账号出口、自动安装器都依赖宿主事实）。宿主缺失时保持
	// nil，Handler 回 501 与启动计划，而不是让整组路由启动失败。
	var openAppLauncher webuiopenappapi.Launcher
	if launcher := webuiopenappapi.NewHostLauncher(webuiopenappapi.HostLauncherOptions{
		BaseURL:       dependencies.NodeBaseURL,
		ManagementKey: dependencies.ManagementKey,
	}); launcher != nil {
		openAppLauncher = launcher
	}
	openApp, err := webuiopenappapi.NewHandler(webuiopenappapi.Dependencies{
		Authorizer: authorizer, Accounts: dependencies.Store,
		AIHomeDir: dependencies.AIHomeDir, HostHomeDir: dependencies.HostHomeDir,
		Launcher: openAppLauncher,
	})
	if err != nil {
		return nil, fmt.Errorf("创建打开应用接口失败: %w", err)
	}
	// 运行环境：探测、计划、执行与作业状态机都在 Go，Node 只做代理。
	toolkitEnvironmentActions, err := webuitoolkitenvapi.NewHandler(webuitoolkitenvapi.Dependencies{
		Authorizer: authorizer, HostHomeDir: dependencies.HostHomeDir, AIHomeDir: dependencies.AIHomeDir,
		Executor: hostexec.Executor{},
	})
	if err != nil {
		return nil, fmt.Errorf("创建运行环境操作接口失败: %w", err)
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
		// status 与只读接口同源，前端拿到清除结果后直接刷新面板。
		Status: func(context.Context) (any, error) {
			return webuiprovidercliupgradeapi.Snapshot(dependencies.AIHomeDir, dependencies.Catalog), nil
		},
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
		HostHomeDir: dependencies.HostHomeDir,
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
	// 新增账号作业：作业引擎与重新认证共用 application/accountauth，本切片只把
	// 开始/查询/回调/取消/安装确认/本机导入六条路径的权威入口搬到 Go。
	addJobs, err := webuiaccountaddapi.NewAccountAuthJobs(dependencies.AuthJobs)
	if err != nil {
		return nil, fmt.Errorf("创建新增账号作业适配器失败: %w", err)
	}
	accountAdd, err := webuiaccountaddapi.NewHandler(webuiaccountaddapi.Dependencies{
		Authorizer: authorizer, Jobs: addJobs,
	})
	if err != nil {
		return nil, fmt.Errorf("创建新增账号作业接口失败: %w", err)
	}

	// 认证来源链：installable 由 Go 按 Provider 合同的安装声明判定；alreadyImported 需要
	// 两侧身份指纹，端口在这里接到账号存储与官方 artifact 读取器上（见同目录
	// webuiproviderauthsources_ports.go）。插件来源仍归 Node 插件运行时，端口留空并由
	// 响应的 unfilledFields 显式声明。
	authSources, err := webuiproviderauthsourcesapi.NewHandler(webuiproviderauthsourcesapi.Dependencies{
		Authorizer: authorizer, HostHomeDir: dependencies.HostHomeDir, AIHomeDir: dependencies.AIHomeDir,
		ExistingIdentities:  providerAuthIdentities(dependencies.Store),
		LocalSourceIdentity: providerLocalAuthIdentity(dependencies.HostHomeDir),
		// 插件账号来源由 Node 插件运行时维护；Node 一旦检测到该 Provider 有插件来源
		// 就不会把请求交给 Go。因此 Go 侧无插件来源时返回空集，不把字段标成未填。
		PluginSources: func(context.Context, string) ([]webuiproviderauthsourcesapi.PluginSource, error) {
			return []webuiproviderauthsourcesapi.PluginSource{}, nil
		},
	})
	if err != nil {
		return nil, fmt.Errorf("创建 Provider 授权来源接口失败: %w", err)
	}

	// 账号活动：任务状态、守卫与速率限制在 Go；provider handler 经 Node 桥执行。
	// 目录是 Go 内的声明数据（与 Node 描述符同源），因此参数校验不再跨进程。
	activityLister, activityErr := accountactivityadapter.NewCredentialAccountLister(dependencies.AIHomeDir)
	if activityErr != nil {
		return nil, fmt.Errorf("创建账号活动账号来源失败: %w", activityErr)
	}
	activityService, activityErr := accountactivityadapter.NewService(accountactivityadapter.ServiceDependencies{
		Catalog:  accountactivityadapter.BuiltinCatalog(),
		Accounts: activityLister,
		Executor: accountactivityadapter.NewNodeBridge(accountactivityadapter.NodeBridgeOptions{
			BaseURL:       dependencies.NodeBaseURL,
			ManagementKey: dependencies.ManagementKey,
		}),
		Jobs: accountactivityadapter.NewJobManager(time.Now, nil),
		Now:  time.Now,
	})
	if activityErr != nil {
		return nil, fmt.Errorf("创建账号活动服务失败: %w", activityErr)
	}
	accountActivity, activityErr := webuiaccountactivityapi.NewHandler(webuiaccountactivityapi.Dependencies{
		Authorizer: authorizer,
		Service:    activityService,
	})
	if activityErr != nil {
		return nil, fmt.Errorf("创建账号活动接口失败: %w", activityErr)
	}

	// 账号实时视图：快照装配、revision 与增量 diff 都在 Go；Node 只做 SSE 外壳。
	accountLive, liveErr := webuiaccountliveapi.NewHandler(webuiaccountliveapi.Dependencies{
		Authorizer: authorizer,
		Rows:       dependencies.AccountRows,
		Runtime:    accountRuntimeSnapshotter(dependencies.AccountRuntime),
		States:     dependencies.Store,
		TokenUsage: dependencies.Store,
		Catalog:    dependencies.Catalog,
		AIHomeDir:  dependencies.AIHomeDir,
	})
	if liveErr != nil {
		return nil, fmt.Errorf("创建账号实时视图接口失败: %w", liveErr)
	}
	// 账号导入作业：状态机、上传解码、文档解析与逐条导入都在 Go。事件走同一条
	// 账号 watch 流（import-job 帧），Node 只保留 POST/GET 的协议外壳。
	accountImport, importErr := webuiaccountimportapi.NewHandler(webuiaccountimportapi.Dependencies{
		Authorizer: authorizer,
		Importer:   dependencies.AccountsHandler,
		Publisher:  accountLive,
	})
	if importErr != nil {
		return nil, fmt.Errorf("创建账号导入作业接口失败: %w", importErr)
	}

	// 账号发现：路由/鉴权/契约在 Go，扫描执行走 Node 宿主能力桥（详见 hostdetect）。
	accountDetect, detectErr := webuiaccountdetectapi.NewHandler(webuiaccountdetectapi.Dependencies{
		Authorizer: authorizer,
		Detector: hostdetect.NewNodeBridge(hostdetect.NodeBridgeOptions{
			BaseURL:       dependencies.NodeBaseURL,
			ManagementKey: dependencies.ManagementKey,
		}),
	})
	if detectErr != nil {
		return nil, fmt.Errorf("创建账号发现接口失败: %w", detectErr)
	}

	routes := []webuiRoute{
		{Pattern: "GET " + webuiaccountliveapi.Path, Handler: accountLive},
		{Pattern: "POST " + webuiaccountliveapi.SnapshotPath, Handler: accountLive},
		{Pattern: "POST " + webuiaccountdetectapi.Path, Handler: accountDetect},
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
		{Pattern: "GET " + webuiaccountegressapi.Path + "/{provider}/{accountRef}/egress", Handler: accountEgress},
		{Pattern: "POST " + webuiaccountegressapi.Path + "/{provider}/{accountRef}/egress", Handler: accountEgress},
		{Pattern: "GET " + webuicontrolplaneapi.Path + "/profiles", Handler: controlPlane},
		{Pattern: "POST " + webuicontrolplaneapi.Path + "/profiles", Handler: controlPlane},
		{Pattern: "POST " + webuicontrolplaneapi.Path + "/profiles/active", Handler: controlPlane},
		{Pattern: "DELETE " + webuicontrolplaneapi.Path + "/profiles/{profileId}", Handler: controlPlane},
		{Pattern: "GET " + webuicontrolplaneapi.Path + "/endpoints", Handler: controlPlane},
		{Pattern: "GET " + webuiprovidercliupgradeapi.Path, Handler: providerUpgrade},
		{Pattern: "POST " + webuifstrustapi.TrustPath, Handler: fsTrust},
		{Pattern: "GET " + webuifsaccessapi.Path, Handler: fsAccess},
		{Pattern: "GET " + webuiproviderhooksapi.Path, Handler: hooks},
		{Pattern: "POST " + webuiproviderhooksapi.InstallPath, Handler: installHooks},
		{Pattern: "GET " + webuifsreadapi.Path, Handler: fsRead},
		{Pattern: "GET " + webuifstreeapi.Path, Handler: fsTree},
		{Pattern: "GET " + webuifsmediaapi.Path, Handler: fsMedia},
		{Pattern: "POST " + webuisshwriteapi.CollectionPath, Handler: sshWrite},
		{Pattern: "PUT " + webuisshwriteapi.ItemPath, Handler: sshWrite},
		{Pattern: "DELETE " + webuisshwriteapi.ItemPath, Handler: sshWrite},
		{Pattern: "POST " + webuiaccountimportapi.Path, Handler: accountImport},
		{Pattern: "GET " + webuiaccountimportapi.Path + webuiaccountimportapi.JobsSuffix, Handler: accountImport},
		{Pattern: "POST " + webuiaccountstatusapi.Path + webuiaccountstatusapi.RouteSuffix, Handler: accountStatus},
		{Pattern: "DELETE " + webuiaccountdeleteapi.Path + webuiaccountdeleteapi.DeleteSuffix, Handler: accountDelete},
		{Pattern: "POST " + webuiaccountupdateapi.UpdatePath, Handler: accountUpdate},
		{Pattern: "POST " + webuiroutingrulesapi.Path, Handler: routingRules},
		{Pattern: "POST " + webuisetdefaultapi.Path + webuisetdefaultapi.SetDefaultRouteSuffix, Handler: setDefault},
		{Pattern: "POST " + webuisetdefaultapi.Path + webuisetdefaultapi.ClearDefaultRouteSuffix, Handler: setDefault},
		{Pattern: "GET " + webuigitapi.Path + webuigitapi.SummarySuffix, Handler: gitRead},
		{Pattern: "GET " + webuigitapi.Path + webuigitapi.DiffSuffix, Handler: gitRead},
		{Pattern: "GET " + webuiprojectsapi.Path, Handler: projects},
		{Pattern: "GET " + webuiprojectsapi.SessionsPath, Handler: projects},
		{Pattern: "GET " + webuiprojectsapi.WatchPath, Handler: projects},
		{Pattern: "POST " + webuiprojectsapi.SnapshotPath, Handler: projects},
		{Pattern: "GET " + webuisessionmessagesapi.Path, Handler: sessionMessages},
		{Pattern: "GET " + webuisessioneventsapi.Path, Handler: sessionEvents},
		{Pattern: "GET " + webuislashcommandsapi.Path, Handler: slashCommands},
		{Pattern: "GET " + webuiappentriesapi.Path, Handler: appEntries},
		{Pattern: "POST " + webuiopenappapi.Path + webuiopenappapi.OpenAppSuffix, Handler: openApp},
		{Pattern: "GET " + webuitoolkitenvapi.Path, Handler: toolkitEnvironmentActions},
		{Pattern: "GET " + webuitoolkitenvapi.GuidePath, Handler: toolkitEnvironmentActions},
		{Pattern: "POST " + webuitoolkitenvapi.PlanPath, Handler: toolkitEnvironmentActions},
		{Pattern: "POST " + webuitoolkitenvapi.ExecutePath, Handler: toolkitEnvironmentActions},
		{Pattern: "GET " + webuitoolkitenvapi.JobsPath, Handler: toolkitEnvironmentActions},
		{Pattern: "GET " + webuitoolkitenvapi.JobsWatchPath, Handler: toolkitEnvironmentActions},
		{Pattern: "GET " + webuitoolkitenvapi.JobPath, Handler: toolkitEnvironmentActions},
		{Pattern: "GET " + webuitoolkitenvapi.JobWatchPath, Handler: toolkitEnvironmentActions},
		{Pattern: "POST " + webuitoolkitenvapi.JobCancelPath, Handler: toolkitEnvironmentActions},
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
		{Pattern: "POST " + webuiaccountaddapi.Path, Handler: accountAdd},
		{Pattern: "GET " + webuiaccountaddapi.Path + webuiaccountaddapi.JobsSuffix, Handler: accountAdd},
		{Pattern: "POST " + webuiaccountaddapi.Path + webuiaccountaddapi.CallbackSuffix, Handler: accountAdd},
		{Pattern: "POST " + webuiaccountaddapi.Path + webuiaccountaddapi.CancelSuffix, Handler: accountAdd},
		{Pattern: "POST " + webuiaccountaddapi.Path + webuiaccountaddapi.LocalImportSuffix, Handler: accountAdd},
		{Pattern: "POST " + webuiaccountaddapi.Path + webuiaccountaddapi.InstallSuffix, Handler: accountAdd},
		{Pattern: "GET " + webuicontrolplanebootstrapapi.Path, Handler: controlPlaneBootstrap},
		{Pattern: "GET " + webuiproviderauthsourcesapi.Path, Handler: authSources},
		{Pattern: "POST " + webuiaccountactivityapi.RunPath, Handler: accountActivity},
		{Pattern: "POST " + webuiaccountactivityapi.ProbePath, Handler: accountActivity},
		{Pattern: "GET " + webuiaccountactivityapi.JobsPath, Handler: accountActivity},
		{Pattern: "GET " + webuiaccountactivityapi.ParamsPath, Handler: accountActivity},
		{Pattern: "POST " + webuiaccountactivityapi.AccountActionPath, Handler: accountActivity},
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
	// kimi 的套餐统计与桌面端托管登录：路由/上游协议都在 Go，Node 只做透传。
	kimiRoutes, err := buildWebUIKimiRoutes(dependencies)
	if err != nil {
		return nil, err
	}
	routes = append(routes, kimiRoutes...)
	return routes, nil
}

// accountRuntimeSnapshotter 把组合根传入的运行态对象收敛成 watch 需要的只读投影。
//
// dependencies.AccountRuntime 声明为 any 是为了让「恢复调度 / 清阻塞」等可选能力
// 按接口断言取用；watch 只关心 RuntimeSnapshot，因此在这里做一次防御性断言，
// 没实现时返回 nil（对应字段留空），而不是让整个路由构建失败。
func accountRuntimeSnapshotter(value any) webuiaccountliveapi.RuntimeSource {
	snapshotter, _ := value.(webuiaccountliveapi.RuntimeSource)
	return snapshotter
}

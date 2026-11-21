// Package aihcli 装配并执行 Codex、Claude 官方 CLI 的 Gateway 与 Native 双模式。
package aihcli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"golang.org/x/term"

	"github.com/madou1217/ai_home/application/accountcredentials"
	appprojection "github.com/madou1217/ai_home/application/accountprojection"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/providerlaunch"
	"github.com/madou1217/ai_home/application/providerruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/agyoauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/claudeoauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/clineoauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/codexoauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/geminioauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/grokoauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/kimioauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/staticcredential"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/tokenrefresh"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	claudecli "github.com/madou1217/ai_home/internal/adapters/claude/clilaunch"
	codebuddyfamilycli "github.com/madou1217/ai_home/internal/adapters/codebuddyfamily/clilaunch"
	codexcli "github.com/madou1217/ai_home/internal/adapters/codex/clilaunch"
	"github.com/madou1217/ai_home/internal/adapters/providerstorage"
	codebuddyfamilystorage "github.com/madou1217/ai_home/internal/adapters/providerstorage/codebuddyfamily"
	"github.com/madou1217/ai_home/internal/adapters/providerstorage/providerroot"
	"github.com/madou1217/ai_home/internal/runtime/accountadmission"
	runtimeprojection "github.com/madou1217/ai_home/internal/runtime/accountprojection"
	"github.com/madou1217/ai_home/internal/runtime/codebuddymodels"
	"github.com/madou1217/ai_home/internal/runtime/codexexecintent"
	"github.com/madou1217/ai_home/internal/runtime/codexhostauth"
	"github.com/madou1217/ai_home/internal/runtime/launchsettings"
	"github.com/madou1217/ai_home/internal/runtime/providercli"
	"github.com/madou1217/ai_home/internal/runtime/providersettings"
	"github.com/madou1217/ai_home/internal/runtime/pty"
	"github.com/madou1217/ai_home/internal/runtime/toolkit/permissionlaunch"
)

const oauthHTTPTimeout = 15 * time.Second

var (
	// ErrInvalidOptions 表示组合根缺少唯一数据目录或终端 I/O。
	ErrInvalidOptions = errors.New("AIH CLI 组合配置无效")
	// ErrInvalidRunRequest 表示 Context、Provider 或 Gateway 配置无效。
	ErrInvalidRunRequest = errors.New("AIH CLI 启动请求无效")
)

// Options 是生产组合根唯一允许的外部依赖。
type Options struct {
	// AIHomeDir 是 Native Direct 使用的本地业务数据库根；Gateway Relay 可以为空。
	AIHomeDir string
	// GatewayAccounts 是目标 Server 的固定账号解析端口；账号池模式不需要它。
	GatewayAccounts providerlaunch.GatewayAccountResolver
	// Stdin、Stdout、Stderr 原样连接当前前台官方 CLI。
	Stdin  io.Reader
	Stdout io.Writer
	Stderr io.Writer
	// OAuthHTTPClient 仅供测试替换 OAuth 刷新网络边界。
	OAuthHTTPClient *http.Client
	// ProviderHTTPClient 仅供本地 Claude 代理转发请求。
	ProviderHTTPClient *http.Client
	// HostHomeDir 覆盖账号投影的宿主家目录；为空时从进程环境解析。
	HostHomeDir string
	// CodexHomeDir 是 Gateway 启动共享的 Codex 配置根（宿主 ~/.codex）；
	// 为空时回退 <HostHomeDir>/.codex。投影 HOME 不保存用户偏好。
	CodexHomeDir string
	// AccountSettings 是账号级 Provider 设置覆盖存储；为空时按 AIHomeDir 自动装配。
	AccountSettings *providersettings.Store
	// ClaudePreflight 是 Claude 首屏检查决策；由命令入口按 app-state 解析。
	ClaudePreflight providercli.ClaudePreflight
}

// GatewayConfig 只在 Gateway Relay 模式使用；Native Direct 不读取它。
type GatewayConfig struct {
	BaseURL   string
	ClientKey string
}

// String 返回不包含 Server Client Key 的安全摘要。
func (config GatewayConfig) String() string {
	return fmt.Sprintf("aihcli.GatewayConfig{base_url=%s,client_key=<redacted>}", config.BaseURL)
}

// GoString 确保 %#v 不会反射 Client Key。
func (config GatewayConfig) GoString() string {
	return config.String()
}

// Format 覆盖所有 fmt verb，避免格式化绕过密钥脱敏。
func (config GatewayConfig) Format(state fmt.State, _ rune) {
	_, _ = state.Write([]byte(config.String()))
}

// launchPlanner 隔离应用层模式规划，便于 Host 只负责组合和生命周期。
type launchPlanner interface {
	Plan(
		ctx context.Context,
		intent providerlaunch.LaunchIntent,
		endpoint providerlaunch.GatewayEndpoint,
	) (providerlaunch.LaunchPlan, error)
}

// launchRunner 隔离官方进程、Socket 和本地代理运行边界。
type launchRunner interface {
	Run(
		ctx context.Context,
		plan providerlaunch.LaunchPlan,
		arguments []string,
	) error
	RunWithOptions(
		ctx context.Context,
		plan providerlaunch.LaunchPlan,
		arguments []string,
		options providercli.RunOptions,
	) error
}

// App 持有单库、双模式规划器和 Provider Runtime 的一次进程生命周期。
type App struct {
	catalog           *providers.Catalog
	aiHomeDir         string
	accountStore      *sqliteaccount.Store
	planner           launchPlanner
	runner            launchRunner
	permissionOptions permissionlaunch.Options
	// cliLifecycle 提供官方 CLI 的安装/更新事实；缺失时保留原失败语义。
	cliLifecycle providerCLILifecycle
	// stdin/stdout 只用于缺失 CLI 时的交互式安装确认。
	stdin       io.Reader
	interactive bool
	// hostHomeDir 与 lookupEnv 定位子进程实际读取的宿主 Codex 配置。
	hostHomeDir string
	// codexHomeDir 是 Gateway 启动共享的 Codex 配置根。
	codexHomeDir string
	// accountSettings 是账号级关键设置覆盖。
	accountSettings *providersettings.Store
	lookupEnv       func(string) (string, bool)
	stderr          io.Writer
	resources       []io.Closer
	closeOnce       sync.Once
	closeErr        error
}

// New 装配 Provider Catalog、aih.db、OAuth 刷新、双模式 Strategy 和官方 CLI Runtime。
func New(ctx context.Context, options Options) (*App, error) {
	if ctx == nil || options.Stdin == nil || options.Stdout == nil || options.Stderr == nil {
		return nil, ErrInvalidOptions
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		return nil, fmt.Errorf("创建 Provider Catalog 失败: %w", err)
	}
	var store *sqliteaccount.Store
	if strings.TrimSpace(options.AIHomeDir) != "" {
		store, err = sqliteaccount.Open(ctx, sqliteaccount.OpenOptions{
			AIHomeDir: options.AIHomeDir,
			Catalog:   catalog,
		})
		if err != nil {
			return nil, fmt.Errorf("打开账号数据库失败: %w", err)
		}
	}
	fail := func(message string, cause error) (*App, error) {
		if store != nil {
			_ = store.Close()
		}
		return nil, fmt.Errorf("%s: %w", message, cause)
	}

	var credentials *accountcredentials.Resolver
	var nativePlanner providerlaunch.NativePlanBuilder
	if store != nil {
		oauthClient := options.OAuthHTTPClient
		if oauthClient == nil {
			oauthClient = &http.Client{
				Timeout:       oauthHTTPTimeout,
				CheckRedirect: rejectOAuthRedirect,
			}
		}
		codexOAuth, err := codexoauth.New(oauthClient, time.Now)
		if err != nil {
			return fail("创建 Codex OAuth 刷新策略失败", err)
		}
		claudeOAuth, err := claudeoauth.New(oauthClient, time.Now)
		if err != nil {
			return fail("创建 Claude OAuth 刷新策略失败", err)
		}
		geminiOAuth, err := geminioauth.New(oauthClient, geminioauth.Options{})
		if err != nil {
			return fail("创建 Gemini OAuth 刷新策略失败", err)
		}
		geminiRefresh, err := tokenrefresh.NewStrategy(geminiOAuth)
		if err != nil {
			return fail("创建 Gemini 刷新适配策略失败", err)
		}
		agyOAuth, err := agyoauth.New(oauthClient)
		if err != nil {
			return fail("创建 Antigravity OAuth 刷新策略失败", err)
		}
		grokOAuth, err := grokoauth.New(oauthClient, grokoauth.Options{})
		if err != nil {
			return fail("创建 Grok OAuth 刷新策略失败", err)
		}
		grokRefresh, err := tokenrefresh.NewStrategy(grokOAuth)
		if err != nil {
			return fail("创建 Grok 刷新适配策略失败", err)
		}
		clineOAuth, err := clineoauth.New(oauthClient, clineoauth.Options{})
		if err != nil {
			return fail("创建 Cline OAuth 刷新策略失败", err)
		}
		clineRefresh, err := tokenrefresh.NewStrategy(clineOAuth)
		if err != nil {
			return fail("创建 Cline 刷新适配策略失败", err)
		}
		kimiOAuth, err := kimioauth.New(oauthClient, kimioauth.Options{})
		if err != nil {
			return fail("创建 Kimi OAuth 刷新策略失败", err)
		}
		// ZCode 的 token 刷新仍由 Node 宿主完成（go-account-sync 推送）；Go 侧
		// 声明静态凭据，避免解析器因「没有刷新策略」直接 500。
		zcodeRefresh, err := staticcredential.New("zcode")
		if err != nil {
			return fail("创建 ZCode 静态凭据策略失败", err)
		}
		opencodeRefresh, err := staticcredential.New("opencode")
		if err != nil {
			return fail("创建 OpenCode 静态凭据策略失败", err)
		}
		kiroRefresh, err := staticcredential.New("kiro")
		if err != nil {
			return fail("创建 Kiro 静态凭据策略失败", err)
		}
		qoderRefresh, err := staticcredential.New("qoder")
		if err != nil {
			return fail("创建 Qoder 静态凭据策略失败", err)
		}
		qodercnRefresh, err := staticcredential.New("qodercn")
		if err != nil {
			return fail("创建 Qoder CN 静态凭据策略失败", err)
		}
		refreshStrategies := []accountcredentials.RefreshStrategy{
			codexOAuth,
			claudeOAuth,
			geminiRefresh,
			agyOAuth,
			grokRefresh,
			clineRefresh,
			kimiOAuth,
			zcodeRefresh,
			opencodeRefresh,
			kiroRefresh,
			qoderRefresh,
			qodercnRefresh,
		}
		launchStrategies, err := newNativeLaunchStrategies()
		if err != nil {
			return fail("创建 Native Direct 策略失败", err)
		}
		// CodeBuddy 家族 Go 侧只消费 Node 已写入的凭据；Token 刷新仍由 Node 宿主完成。
		for _, providerID := range codebuddyfamilystorage.ProviderIDs() {
			refresh, err := staticcredential.New(providerID)
			if err != nil {
				return fail("创建 CodeBuddy 家族静态凭据策略失败", err)
			}
			refreshStrategies = append(refreshStrategies, refresh)
			strategy, err := codebuddyfamilycli.NewStrategy(
				providerID,
				codebuddyfamilystorage.SiteInternal(providerID),
			)
			if err != nil {
				return fail("创建 CodeBuddy 家族 CLI 策略失败", err)
			}
			launchStrategies = append(launchStrategies, strategy)
		}
		credentials, err = accountcredentials.NewResolver(accountcredentials.Dependencies{
			Store:      store,
			Strategies: refreshStrategies,
			Clock:      time.Now,
		})
		if err != nil {
			return fail("创建账号凭据解析器失败", err)
		}
		selector, err := accountapp.NewLaunchAccountSelector(catalog, store)
		if err != nil {
			return fail("创建 CLI 账号选择器失败", err)
		}
		nativePlanner, err = providerlaunch.NewPlanner(providerlaunch.Dependencies{
			Accounts:    selector,
			Credentials: credentials,
			Strategies:  launchStrategies,
		})
		if err != nil {
			return fail("创建 Native Direct 规划器失败", err)
		}
	}
	gatewayAccounts := options.GatewayAccounts
	if gatewayAccounts == nil {
		gatewayAccounts = store
	}
	hostHomeDir := strings.TrimSpace(options.HostHomeDir)
	if hostHomeDir == "" {
		hostHomeDir = resolveHostHomeDir()
	}
	codexHomeDir := strings.TrimSpace(options.CodexHomeDir)
	if codexHomeDir == "" {
		codexHomeDir = filepath.Join(hostHomeDir, providerroot.ConfigDir("codex"))
	}
	accountSettings := options.AccountSettings
	if accountSettings == nil && strings.TrimSpace(options.AIHomeDir) != "" {
		if databasePath, dbErr := appstate.DatabasePath(options.AIHomeDir); dbErr == nil {
			accountSettings = providersettings.NewStore(databasePath)
		}
	}
	// CodeBuddy 家族没有 OpenAI 兼容的 base URL 入口，网关档靠独立的 models.json
	// 投影：文件只放在 run/codebuddy-gateway，绝不写宿主共享的 ~/.codebuddy/models.json，
	// 否则家族账号投影会把网关模型链进每个账号沙箱，绕开 `aih codebuddy <id>` 的钉选。
	codebuddyRoot := ""
	if strings.TrimSpace(options.AIHomeDir) != "" {
		codebuddyRoot = filepath.Join(options.AIHomeDir, "run", "codebuddy-gateway")
	}
	codebuddyProjection := codebuddymodels.New(codebuddymodels.Options{
		RootDir: codebuddyRoot,
		Logf: func(format string, args ...any) {
			if options.Stderr != nil {
				_, _ = fmt.Fprintf(options.Stderr, "[aih:codebuddy-models] "+format+"\n", args...)
			}
		},
	})
	gatewayStrategies := []providerlaunch.GatewayStrategy{
		codexcli.NewGatewayStrategy(codexManagedProviderAuth{
			codexHomeDir: codexHomeDir,
			lookupEnv:    os.LookupEnv,
		}),
		claudecli.NewGatewayStrategy(),
	}
	if options.AIHomeDir != "" {
		for _, providerID := range codebuddyfamilystorage.ProviderIDs() {
			strategy, strategyErr := codebuddyfamilycli.NewGatewayStrategy(
				providerID,
				codebuddyfamilystorage.SiteInternal(providerID),
				codebuddyProjection.RootDir(),
				codebuddyProjection,
			)
			if strategyErr != nil {
				return fail("创建 CodeBuddy 家族网关策略失败", strategyErr)
			}
			gatewayStrategies = append(gatewayStrategies, strategy)
		}
	}
	gatewayPlanner, err := providerlaunch.NewGatewayPlanner(providerlaunch.GatewayDependencies{
		Accounts:   gatewayAccounts,
		Strategies: gatewayStrategies,
	})
	if err != nil {
		return fail("创建 Gateway Relay 规划器失败", err)
	}
	planner, err := providerlaunch.NewService(providerlaunch.ServiceDependencies{
		Native:  nativePlanner,
		Gateway: gatewayPlanner,
	})
	if err != nil {
		return fail("创建双模式启动服务失败", err)
	}
	var provisioner appprojection.Provisioner
	if store != nil {
		provisioner, err = newProjectionProvisioner(options.AIHomeDir, store)
		if err != nil {
			return fail("创建账号投影执行器失败", err)
		}
	}
	// 官方 CLI 的安装位置、安装计划与版本源统一由工具箱回答；Runner 用同一
	// 份事实解析可执行文件，安装成功即能被下一次启动发现（例如 ~/.local/bin）。
	cliLifecycle := newAppsCLILifecycle(options.AIHomeDir, hostHomeDir)
	runner, err := providercli.NewRunner(providercli.Options{
		Credentials:  credentials,
		Stdin:        options.Stdin,
		Stdout:       options.Stdout,
		Stderr:       options.Stderr,
		HTTPClient:   options.ProviderHTTPClient,
		Interactive:  isInteractiveTTY(options.Stdin, options.Stdout),
		PTYStarter:   pty.NewStarter(),
		Projection:   provisioner,
		HostHomeDir:  hostHomeDir,
		CodexHomeDir: codexHomeDir,
		PrepareNative: func(ctx context.Context, providerID, command string, args, env []string) ([]string, func(), error) {
			prepared, lease, err := codexexecintent.Prepare(ctx, providerID, command, args, env)
			return prepared, func() { lease.Release() }, err
		},
		DiscoverBinary:  cliLifecycle.Resolve,
		ClaudePreflight: options.ClaudePreflight,
	})
	if err != nil {
		return fail("创建 Provider CLI Runtime 失败", err)
	}
	interactive := isInteractiveTTY(options.Stdin, options.Stdout)
	if store == nil {
		app, err := newApp(catalog, planner, runner)
		if err != nil {
			return nil, err
		}
		app.hostHomeDir = hostHomeDir
		app.codexHomeDir = codexHomeDir
		app.accountSettings = accountSettings
		app.lookupEnv = os.LookupEnv
		app.stderr = options.Stderr
		app.cliLifecycle = cliLifecycle
		app.stdin = options.Stdin
		app.interactive = interactive
		app.permissionOptions = permissionlaunch.Options{Catalog: catalog, AIHomeDir: options.AIHomeDir, HostHomeDir: hostHomeDir, GOOS: runtime.GOOS}
		return app, nil
	}
	app, err := newApp(catalog, planner, runner, store)
	if err != nil {
		return nil, err
	}
	app.aiHomeDir = options.AIHomeDir
	app.accountStore = store
	app.hostHomeDir = hostHomeDir
	app.codexHomeDir = codexHomeDir
	app.accountSettings = accountSettings
	app.lookupEnv = os.LookupEnv
	app.stderr = options.Stderr
	app.cliLifecycle = cliLifecycle
	app.stdin = options.Stdin
	app.interactive = interactive
	app.permissionOptions = permissionlaunch.Options{Catalog: catalog, AIHomeDir: options.AIHomeDir, HostHomeDir: hostHomeDir, GOOS: runtime.GOOS}
	return app, nil
}

// newProjectionProvisioner 装配已迁移 Provider 的投影策略、materializer、
// 平台链接与凭据回写存储。未注册的 Provider 会在启动时失败关闭。
func newProjectionProvisioner(
	aiHomeDir string,
	store accountapp.CredentialVersionStore,
) (appprojection.Provisioner, error) {
	registry := providerstorage.New()
	return runtimeprojection.New(runtimeprojection.Options{
		AIHomeDir:     aiHomeDir,
		Policies:      registry,
		Materializers: registry.Materializers(),
		Linker:        runtimeprojection.NewLinker(),
		Credentials:   store,
	})
}

// resolveHostHomeDir 按 AIH_HOST_HOME / 平台家目录变量 / os 家目录解析宿主家。
func resolveHostHomeDir() string {
	environment := make(map[string]string)
	for _, entry := range os.Environ() {
		name, value, found := strings.Cut(entry, "=")
		if found && name != "" {
			environment[name] = value
		}
	}
	return providerruntime.ResolveHostHomeDir("", environment, runtime.GOOS)
}

func isInteractiveTTY(input io.Reader, output io.Writer) bool {
	stdin, inputOK := input.(*os.File)
	stdout, outputOK := output.(*os.File)
	return inputOK && outputOK && stdin == os.Stdin && stdout == os.Stdout &&
		term.IsTerminal(int(stdin.Fd())) && term.IsTerminal(int(stdout.Fd()))
}

// resolveDefaultAccountIntent 把"不带账号编号"的启动解析成默认账号的原生直连。
// 默认账号记录在 app_kv 的 account:default:<provider>，值是账号 ref 的 JSON。
func (app *App) resolveDefaultAccountIntent(
	ctx context.Context,
	providerID string,
	arguments []string,
) (providerlaunch.LaunchIntent, bool) {
	if app == nil || app.accountStore == nil || strings.TrimSpace(app.aiHomeDir) == "" {
		return providerlaunch.LaunchIntent{}, false
	}
	databasePath, err := appstate.DatabasePath(app.aiHomeDir)
	if err != nil {
		return providerlaunch.LaunchIntent{}, false
	}
	raw, found, err := appstate.ReadKV(ctx, databasePath, "account:default:"+providerID)
	if err != nil || !found {
		return providerlaunch.LaunchIntent{}, false
	}
	var accountRefText string
	if json.Unmarshal([]byte(raw), &accountRefText) != nil {
		return providerlaunch.LaunchIntent{}, false
	}
	accountRefText = strings.TrimSpace(accountRefText)
	if accountRefText == "" {
		return providerlaunch.LaunchIntent{}, false
	}
	account, err := app.accountStore.GetByRef(ctx, accountcore.AccountRef(accountRefText))
	if err != nil || !account.Enabled() {
		return providerlaunch.LaunchIntent{}, false
	}
	cliAccountID := account.CLIAccountID()
	if !cliAccountID.IsValid() {
		return providerlaunch.LaunchIntent{}, false
	}
	nativeArguments := append([]string{cliAccountID.String()}, arguments...)
	nativeIntent, err := providerlaunch.ParseLaunchIntent(app.catalog, providerID, nativeArguments)
	if err != nil || nativeIntent.Mode() != providerlaunch.LaunchModeNativeDirect {
		return providerlaunch.LaunchIntent{}, false
	}
	return nativeIntent, true
}

// newApp 统一生产和包内测试的不变量校验。
func newApp(
	catalog *providers.Catalog,
	planner launchPlanner,
	runner launchRunner,
	resources ...io.Closer,
) (*App, error) {
	if catalog == nil || planner == nil || runner == nil {
		return nil, ErrInvalidOptions
	}
	for _, resource := range resources {
		if resource == nil {
			return nil, ErrInvalidOptions
		}
	}
	return &App{
		catalog:   catalog,
		planner:   planner,
		runner:    runner,
		resources: append([]io.Closer(nil), resources...),
	}, nil
}

// Run 解析一次命令意图，按模式规划并执行；失败时绝不切换到另一认证路径。
func (app *App) Run(
	ctx context.Context,
	providerID string,
	arguments []string,
	gateway GatewayConfig,
) error {
	if app == nil || app.catalog == nil || app.planner == nil || app.runner == nil || ctx == nil {
		return ErrInvalidRunRequest
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if !supportedNativeCLIProvider(providerID) {
		return fmt.Errorf("%w: 当前只支持 codex / claude / gemini / CodeBuddy 家族", ErrInvalidRunRequest)
	}
	// 启动 Codex 前先确认宿主受管 Provider 的认证命令仍然可执行。升级或仓库
	// 搬家会删掉配置里的绝对路径，裸 codex 只会报内部模糊错误；这里在唯一的
	// 启动组合入口完成自愈（幂等、宿主锁内原子写，无密钥）。
	if providerID == "codex" {
		if err := app.ensureHostAuthCommand(); err != nil {
			return err
		}
	}
	intent, err := providerlaunch.ParseLaunchIntent(app.catalog, providerID, arguments)
	if err != nil {
		return fmt.Errorf("解析 Provider CLI 命令失败: %w", err)
	}
	// 不带账号编号的启动等价于"用宿主默认账号"（Node 入口一直是这个语义）。
	// Go 侧原先只认 Relay，于是 codebuddy / gemini 这类没有 Gateway Profile 的
	// 家族会被直接拒绝。这里先尝试落到默认账号，失败再走原有 Relay 校验。
	if intent.Mode() == providerlaunch.LaunchModeGatewayRelay && !supportedGatewayCLIProvider(intent.RelayProviderID()) {
		if nativeIntent, ok := app.resolveDefaultAccountIntent(ctx, providerID, arguments); ok {
			intent = nativeIntent
		}
	}
	var endpoint providerlaunch.GatewayEndpoint
	if intent.Mode() == providerlaunch.LaunchModeGatewayRelay {
		if !supportedGatewayCLIProvider(intent.RelayProviderID()) {
			return fmt.Errorf("%w: %s 没有可用账号（健康账号与默认账号均不可用）", ErrInvalidRunRequest, providerID)
		}
		endpoint, err = providerlaunch.NewGatewayEndpoint(gateway.BaseURL, gateway.ClientKey)
		if err != nil {
			return fmt.Errorf("Gateway 配置无效: %w", err)
		}
	}
	plan, err := app.planner.Plan(ctx, intent, endpoint)
	if err != nil {
		return fmt.Errorf("规划 Provider CLI 启动失败: %w", err)
	}
	accountOverrides, overrideWarning := app.resolveAccountLaunchOverrides(ctx, plan)
	if native, ok := plan.Native(); ok && app.accountStore != nil {
		lease, admitErr := accountadmission.Launch(app.aiHomeDir, native.ProviderID(), native.AccountRef().String())
		if admitErr != nil {
			return admitErr
		}
		defer lease.Close()
		current, lookupErr := app.accountStore.GetByRef(ctx, native.AccountRef())
		if lookupErr != nil || !current.Enabled() {
			return errors.New("native_account_unavailable")
		}
	}
	permission := permissionlaunch.Apply(ctx, app.permissionOptions, providerID, intent.Arguments(), false)
	launchArguments := intent.Arguments()
	if permission.Applied {
		launchArguments = permission.Args
	}
	if len(accountOverrides.Args) > 0 || len(accountOverrides.Env) > 0 {
		// 用户显式接远端 server 时，账号覆盖无法保证生效；直接跳过并提示。
		if containsLaunchArgument(launchArguments, "--server") {
			accountOverrides = launchsettings.Overrides{}
			overrideWarning = "[aih] 显式 --server 启动不注入账号级 Provider 设置；本次使用远端 server 配置。"
		} else if containsLaunchArgument(launchArguments, "--standalone") {
			accountOverrides.Args = removeLaunchArgument(accountOverrides.Args, "--standalone")
		}
	}
	for _, warning := range accountOverrides.Warnings {
		if app.stderr != nil && strings.TrimSpace(warning) != "" {
			_, _ = fmt.Fprintln(app.stderr, "[aih] "+warning)
		}
	}
	if overrideWarning != "" && app.stderr != nil {
		_, _ = fmt.Fprintln(app.stderr, overrideWarning)
	}
	planCLITarget, hasCLITarget := providerCLIPlanTargetFromPlan(plan)
	// 版本提示只读本地缓存（零延迟），并在 TUI 运行期间后台刷新缓存；
	// 不阻断启动，也绝不把版本检查变成启动前置条件。
	if hasCLITarget && app.providerCLIRemediationEligible(planCLITarget.ProviderID) {
		if notice := app.providerCLIUpdateNotice(ctx, planCLITarget.ProviderID); notice != "" {
			_, _ = fmt.Fprintln(app.stderr, notice)
		}
		app.refreshProviderCLIVersion(planCLITarget.ProviderID)
	}
	extraEnv := permission.Env
	if len(accountOverrides.Env) > 0 {
		merged := make(map[string]string, len(permission.Env)+len(accountOverrides.Env))
		for name, value := range permission.Env {
			merged[name] = value
		}
		for name, value := range accountOverrides.Env {
			merged[name] = value
		}
		extraEnv = merged
	}
	runProvider := func() error {
		return app.runner.RunWithOptions(ctx, plan, launchArguments, providercli.RunOptions{
			ExtraEnv:       extraEnv,
			ExtraArguments: accountOverrides.Args,
		})
	}
	runErr := runProvider()
	// 官方 CLI 缺失时不要只把 exec 错误抛给用户：说明原因、给出安装器，
	// 交互式终端直接询问 [Y/n]，安装成功后用同一份计划重试一次。
	if runErr != nil && hasCLITarget && errors.Is(runErr, providercli.ErrProviderBinaryNotFound) {
		installed, remediationErr := app.remediateProviderCLI(ctx, planCLITarget)
		if remediationErr != nil {
			return remediationErr
		}
		if installed {
			runErr = runProvider()
		}
	}
	if runErr != nil {
		return fmt.Errorf("执行 Provider CLI 失败: %w", runErr)
	}
	return nil
}

// resolveAccountLaunchOverrides 读取绑定账号的覆盖并翻译成 CLI 原生注入。
func (app *App) resolveAccountLaunchOverrides(
	ctx context.Context,
	plan providerlaunch.LaunchPlan,
) (launchsettings.Overrides, string) {
	if app == nil || app.accountSettings == nil {
		return launchsettings.Overrides{}, ""
	}
	provider, accountRef, ok := launchAccountIdentity(plan)
	if !ok {
		return launchsettings.Overrides{}, ""
	}
	document, err := app.accountSettings.Read(ctx, accountRef)
	if err != nil {
		return launchsettings.Overrides{}, fmt.Sprintf("[aih] 读取账号级 Provider 设置失败，本次使用公共配置: %v", err)
	}
	if document.Provider != provider || len(document.Values) == 0 {
		return launchsettings.Overrides{}, ""
	}
	overrides, err := launchsettings.Build(provider, accountRef, document.Values, app.aiHomeDir)
	if err != nil {
		return launchsettings.Overrides{}, fmt.Sprintf("[aih] 账号级 Provider 设置无法注入，本次使用公共配置: %v", err)
	}
	if overrides.Unsupported {
		return overrides, fmt.Sprintf("[aih] %s 的账号级设置已保存，但该 CLI 暂未接入启动注入；本次使用公共配置。", provider)
	}
	return overrides, ""
}

// containsLaunchArgument 判断 argv 是否包含精确参数。
func containsLaunchArgument(arguments []string, target string) bool {
	for _, argument := range arguments {
		if argument == target {
			return true
		}
	}
	return false
}

// removeLaunchArgument 删除所有精确匹配的参数。
func removeLaunchArgument(arguments []string, target string) []string {
	if len(arguments) == 0 {
		return arguments
	}
	filtered := make([]string, 0, len(arguments))
	for _, argument := range arguments {
		if argument != target {
			filtered = append(filtered, argument)
		}
	}
	return filtered
}

// launchAccountIdentity 返回本次启动绑定的 Provider 与账号；账号池模式返回 false。
func launchAccountIdentity(plan providerlaunch.LaunchPlan) (string, string, bool) {
	if gateway, ok := plan.Gateway(); ok {
		if accountRef, pinned := gateway.PinnedAccount(); pinned {
			return strings.ToLower(strings.TrimSpace(gateway.ClientProviderID())), accountRef.String(), true
		}
		return "", "", false
	}
	if native, ok := plan.Native(); ok {
		return strings.ToLower(strings.TrimSpace(native.ProviderID())), native.AccountRef().String(), true
	}
	return "", "", false
}

// ensureHostAuthCommand 是受管 Codex 认证命令自愈的唯一启动入口。
//
// 事实来源是子进程实际读取的 config.toml；失效时把 command 重指向当前 CLI，
// args 与其它内容保持不变。无法安全自愈时返回可操作的错误，避免 codex 的模糊报错。
func (app *App) ensureHostAuthCommand() error {
	executable, err := os.Executable()
	if err != nil {
		return fmt.Errorf("codex_host_auth_cli_unavailable: 无法解析当前 aih 可执行文件: %w", err)
	}
	result, err := codexhostauth.Ensure(codexConfigPath(app.codexHomeDir, app.lookupEnv), executable)
	if err != nil {
		return fmt.Errorf("受管 Codex Provider 配置不可用: %w", err)
	}
	if result.Changed && app.stderr != nil {
		_, _ = fmt.Fprintf(app.stderr, "[aih] 受管 Codex 认证命令已失效（%s），已更新为 %s。\n", result.PreviousCommand, result.Command)
	}
	return nil
}

// SupportsNativeCLI 报告一个 Provider 是否已由本组合根承接原生启动。
//
// 命令层（cmd/aih）用它决定统一动词（resume/fork）要不要按官方旗标改写；
// 与 supportedNativeCLIProvider 使用同一份名单，避免两处漂移。
func SupportsNativeCLI(providerID string) bool {
	return supportedNativeCLIProvider(providerID)
}

// supportedGatewayCLIProvider 与本组合根实际注册的 Gateway Strategy 保持一致。
//
// CodeBuddy 家族只支持显式 `aih codebuddy relay`：裸 `aih codebuddy` 仍由
// bare_launch 选一个健康账号走 Native Direct，不能因为这里放开就改变默认语义。
func supportedGatewayCLIProvider(providerID string) bool {
	if providerID == "codex" || providerID == "claude" {
		return true
	}
	return codebuddyfamilystorage.IsFamilyProvider(providerID)
}

// Close 逆序释放单库等组合资源；重复调用保持幂等。
func (app *App) Close() error {
	if app == nil {
		return nil
	}
	app.closeOnce.Do(func() {
		for index := len(app.resources) - 1; index >= 0; index-- {
			app.closeErr = errors.Join(app.closeErr, app.resources[index].Close())
		}
	})
	return app.closeErr
}

// rejectOAuthRedirect 防止 OAuth Token 请求把敏感 Header 重定向到未审计主机。
func rejectOAuthRedirect(_ *http.Request, _ []*http.Request) error {
	return http.ErrUseLastResponse
}

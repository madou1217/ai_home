// Package aihcli 装配并执行 Codex、Claude 官方 CLI 的 Gateway 与 Native 双模式。
package aihcli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	appprojection "github.com/madou1217/ai_home/application/accountprojection"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/providerlaunch"
	"github.com/madou1217/ai_home/application/providerruntime"
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
	agycli "github.com/madou1217/ai_home/internal/adapters/agy/clilaunch"
	claudecli "github.com/madou1217/ai_home/internal/adapters/claude/clilaunch"
	clinecli "github.com/madou1217/ai_home/internal/adapters/cline/clilaunch"
	codebuddyfamilycli "github.com/madou1217/ai_home/internal/adapters/codebuddyfamily/clilaunch"
	codexcli "github.com/madou1217/ai_home/internal/adapters/codex/clilaunch"
	geminicli "github.com/madou1217/ai_home/internal/adapters/gemini/clilaunch"
	grokcli "github.com/madou1217/ai_home/internal/adapters/grok/clilaunch"
	kimicli "github.com/madou1217/ai_home/internal/adapters/kimi/clilaunch"
	"github.com/madou1217/ai_home/internal/adapters/providerstorage"
	codebuddyfamilystorage "github.com/madou1217/ai_home/internal/adapters/providerstorage/codebuddyfamily"
	qodercli "github.com/madou1217/ai_home/internal/adapters/qoder/clilaunch"
	zcodecli "github.com/madou1217/ai_home/internal/adapters/zcode/clilaunch"
	runtimeprojection "github.com/madou1217/ai_home/internal/runtime/accountprojection"
	"github.com/madou1217/ai_home/internal/runtime/providercli"
	"github.com/madou1217/ai_home/internal/runtime/pty"
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
}

// App 持有单库、双模式规划器和 Provider Runtime 的一次进程生命周期。
type App struct {
	catalog   *providers.Catalog
	planner   launchPlanner
	runner    launchRunner
	resources []io.Closer
	closeOnce sync.Once
	closeErr  error
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
		qoderRefresh, err := staticcredential.New("qoder")
		if err != nil {
			return fail("创建 Qoder 静态凭据策略失败", err)
		}
		qodercnRefresh, err := staticcredential.New("qodercn")
		if err != nil {
			return fail("创建 Qoder CN 静态凭据策略失败", err)
		}
		qoderStrategy, err := qodercli.NewStrategy("qoder")
		if err != nil {
			return fail("创建 Qoder CLI 策略失败", err)
		}
		qodercnStrategy, err := qodercli.NewStrategy("qodercn")
		if err != nil {
			return fail("创建 Qoder CN CLI 策略失败", err)
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
			qoderRefresh,
			qodercnRefresh,
		}
		launchStrategies := []providerlaunch.Strategy{
			codexcli.NewStrategy(),
			claudecli.NewStrategy(),
			geminicli.NewStrategy(),
			agycli.NewStrategy(),
			grokcli.NewStrategy(),
			clinecli.NewStrategy(),
			kimicli.NewStrategy(),
			zcodecli.NewStrategy(),
			qoderStrategy,
			qodercnStrategy,
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
	gatewayPlanner, err := providerlaunch.NewGatewayPlanner(providerlaunch.GatewayDependencies{
		Accounts: gatewayAccounts,
		Strategies: []providerlaunch.GatewayStrategy{
			codexcli.NewGatewayStrategy(),
			claudecli.NewGatewayStrategy(),
		},
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
	hostHomeDir := strings.TrimSpace(options.HostHomeDir)
	if hostHomeDir == "" {
		hostHomeDir = resolveHostHomeDir()
	}
	runner, err := providercli.NewRunner(providercli.Options{
		Credentials: credentials,
		Stdin:       options.Stdin,
		Stdout:      options.Stdout,
		Stderr:      options.Stderr,
		HTTPClient:  options.ProviderHTTPClient,
		Interactive: isInteractiveTTY(options.Stdin, options.Stdout),
		PTYStarter:  pty.NewStarter(),
		Projection:  provisioner,
		HostHomeDir: hostHomeDir,
	})
	if err != nil {
		return fail("创建 Provider CLI Runtime 失败", err)
	}
	if store == nil {
		return newApp(catalog, planner, runner)
	}
	return newApp(catalog, planner, runner, store)
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
	return inputOK && outputOK && stdin == os.Stdin && stdout == os.Stdout
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
	intent, err := providerlaunch.ParseLaunchIntent(app.catalog, providerID, arguments)
	if err != nil {
		return fmt.Errorf("解析 Provider CLI 命令失败: %w", err)
	}
	var endpoint providerlaunch.GatewayEndpoint
	if intent.Mode() == providerlaunch.LaunchModeGatewayRelay {
		if !supportedGatewayCLIProvider(intent.RelayProviderID()) {
			return fmt.Errorf("%w: 当前 Relay 只支持 codex 和 claude", ErrInvalidRunRequest)
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
	if err := app.runner.Run(ctx, plan, intent.Arguments()); err != nil {
		return fmt.Errorf("执行 Provider CLI 失败: %w", err)
	}
	return nil
}

// supportedNativeCLIProvider 与本组合根实际注册的 Native Direct Strategy 保持一致。
func supportedNativeCLIProvider(providerID string) bool {
	switch providerID {
	case "codex", "claude", "gemini", "agy", "grok", "cline", "kimi", "zcode", "qoder", "qodercn", "codebuddy", "codebuddycn", "workbuddy", "workbuddycn":
		return true
	default:
		return false
	}
}

// SupportsNativeCLI 报告一个 Provider 是否已由本组合根承接原生启动。
//
// 命令层（cmd/aih）用它决定统一动词（resume/fork）要不要按官方旗标改写；
// 与 supportedNativeCLIProvider 使用同一份名单，避免两处漂移。
func SupportsNativeCLI(providerID string) bool {
	return supportedNativeCLIProvider(providerID)
}

// supportedGatewayCLIProvider 与本组合根实际注册的 Gateway Strategy 保持一致。
func supportedGatewayCLIProvider(providerID string) bool {
	return providerID == "codex" || providerID == "claude"
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

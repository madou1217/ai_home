// Package aihcli 装配并执行 Codex、Claude 官方 CLI 的 Gateway 与 Native 双模式。
package aihcli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/providerlaunch"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/claudeoauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/codexoauth"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	claudecli "github.com/madou1217/ai_home/internal/adapters/claude/clilaunch"
	codexcli "github.com/madou1217/ai_home/internal/adapters/codex/clilaunch"
	"github.com/madou1217/ai_home/internal/runtime/providercli"
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
		credentials, err = accountcredentials.NewResolver(accountcredentials.Dependencies{
			Store: store,
			Strategies: []accountcredentials.RefreshStrategy{
				codexOAuth,
				claudeOAuth,
			},
			Clock: time.Now,
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
			Strategies: []providerlaunch.Strategy{
				codexcli.NewStrategy(),
				claudecli.NewStrategy(),
			},
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
	runner, err := providercli.NewRunner(providercli.Options{
		Credentials: credentials,
		Stdin:       options.Stdin,
		Stdout:      options.Stdout,
		Stderr:      options.Stderr,
		HTTPClient:  options.ProviderHTTPClient,
	})
	if err != nil {
		return fail("创建 Provider CLI Runtime 失败", err)
	}
	if store == nil {
		return newApp(catalog, planner, runner)
	}
	return newApp(catalog, planner, runner, store)
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
	if !supportedCLIProvider(providerID) {
		return fmt.Errorf("%w: 当前只支持 codex 和 claude", ErrInvalidRunRequest)
	}
	intent, err := providerlaunch.ParseLaunchIntent(app.catalog, providerID, arguments)
	if err != nil {
		return fmt.Errorf("解析 Provider CLI 命令失败: %w", err)
	}
	if !supportedCLIProvider(intent.RelayProviderID()) {
		return fmt.Errorf("%w: 当前 Relay 只支持 codex 和 claude", ErrInvalidRunRequest)
	}
	var endpoint providerlaunch.GatewayEndpoint
	if intent.Mode() == providerlaunch.LaunchModeGatewayRelay {
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

// supportedCLIProvider 与本组合根实际注册的双模式 Strategy 保持一致。
func supportedCLIProvider(providerID string) bool {
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

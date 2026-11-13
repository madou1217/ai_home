// Package providercli 执行经过应用层校验的 Provider CLI 启动计划。
package providercli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"runtime"
	"time"

	appprojection "github.com/madou1217/ai_home/application/accountprojection"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/providerlaunch"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/runtime/pty"
	"github.com/madou1217/ai_home/internal/runtime/ptyhost"
)

var (
	// ErrInvalidRunnerOptions 表示 Runtime 缺少凭据刷新或终端 I/O。
	ErrInvalidRunnerOptions = errors.New("Provider CLI Runtime 配置无效")
	// ErrInvalidRunRequest 表示计划、参数或 Context 无效。
	ErrInvalidRunRequest = errors.New("Provider CLI Runtime 请求无效")
	// ErrUnsupportedRuntime 表示当前官方 CLI 不支持计划要求的安全运行形态。
	ErrUnsupportedRuntime = errors.New("Provider CLI Runtime 不受支持")
	// ErrProjectionUnavailable 表示计划要求账号投影，但 Runtime 没有装配投影执行器。
	ErrProjectionUnavailable = errors.New("Provider CLI 账号投影不可用")
	// ErrProjectionMismatch 表示实际策略形态与 Strategy 声明的隔离级别不一致。
	ErrProjectionMismatch = errors.New("Provider CLI 账号投影与策略不匹配")
)

// projectionCaptureTimeout 限制退出后的凭据回写；用户 Ctrl+C 取消了启动 Context
// 时仍要回写，否则客户端刚续期的 refresh_token 会丢。
const projectionCaptureTimeout = 20 * time.Second

// CredentialRefresher 是常驻 OAuth Runtime 收到上游 401 后的最小应用端口。
type CredentialRefresher interface {
	ForceRefreshCredentialBinding(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) (accountapp.CredentialBinding, error)
}

// Options 声明 Provider Runtime 的刷新端口和终端 I/O。
type Options struct {
	// Credentials 仅在 OAuth 上游明确 401 时执行强制刷新。
	Credentials CredentialRefresher
	// Stdin、Stdout、Stderr 原样连接官方 CLI。
	Stdin  io.Reader
	Stdout io.Writer
	Stderr io.Writer
	// HTTPClient 供 Claude OAuth/Gateway 本地代理转发流式请求。
	HTTPClient *http.Client
	// Interactive selects the PTY-backed direct process path for foreground TTY runs.
	Interactive bool
	PTYStarter  pty.Starter
	// Projection 执行账号级凭据文件投影；计划声明需要投影时必须提供。
	Projection appprojection.Provisioner
	// HostHomeDir 是投影共享链接指向的宿主家目录；为空时投影失败关闭。
	HostHomeDir string
	// Platform 覆盖链接/路径的平台语义；为空按 runtime.GOOS。
	Platform string
}

// Runner 是 LaunchPlan 到官方进程拓扑的唯一执行入口。
type Runner struct {
	credentials CredentialRefresher
	stdin       io.Reader
	stdout      io.Writer
	stderr      io.Writer
	httpClient  *http.Client
	interactive bool
	ptyStarter  pty.Starter
	projection  appprojection.Provisioner
	hostHomeDir string
	platform    string
	environ     func() []string
	binaries    binaryResolver
	processes   processFactory
}

// NewRunner 创建只依赖标准库操作系统边界的生产 Runtime。
func NewRunner(options Options) (*Runner, error) {
	// Gateway 与静态 API Key 不需要本地凭据刷新器；OAuth Runtime 在真正刷新时再失败关闭。
	if options.Stdin == nil || options.Stdout == nil || options.Stderr == nil {
		return nil, ErrInvalidRunnerOptions
	}
	client := options.HTTPClient
	if client == nil {
		client = &http.Client{}
	}
	platform := options.Platform
	if platform == "" {
		platform = runtime.GOOS
	}
	return &Runner{
		credentials: options.Credentials,
		stdin:       options.Stdin,
		stdout:      options.Stdout,
		stderr:      options.Stderr,
		httpClient:  client,
		interactive: options.Interactive,
		ptyStarter:  options.PTYStarter,
		projection:  options.Projection,
		hostHomeDir: options.HostHomeDir,
		platform:    platform,
		environ:     os.Environ,
		binaries:    defaultBinaryResolver(),
		processes:   execProcessFactory{},
	}, nil
}

// Run 按互斥计划执行一次官方 CLI；任何 Runtime 失败都不会切换认证模式。
func (runner *Runner) Run(
	ctx context.Context,
	plan providerlaunch.LaunchPlan,
	arguments []string,
) error {
	if runner == nil || ctx == nil || !plan.IsValid() {
		return ErrInvalidRunRequest
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	switch plan.Mode() {
	case providerlaunch.LaunchModeGatewayRelay:
		spec, ok := plan.Gateway()
		if !ok {
			return ErrInvalidRunRequest
		}
		if err := validateManagedArguments(spec.ClientProviderID(), arguments); err != nil {
			return err
		}
		resolved, err := spec.ResolveArguments(arguments)
		if err != nil {
			return err
		}
		if spec.ClientProviderID() == "claude" {
			return runner.runClaudeGateway(ctx, spec, resolved)
		}
		return runner.runDirect(
			ctx,
			spec.ClientProviderID(),
			spec.Binary(),
			resolved,
			spec.Environment(),
		)
	case providerlaunch.LaunchModeNativeDirect:
		spec, ok := plan.Native()
		if !ok {
			return ErrInvalidRunRequest
		}
		if err := validateManagedArguments(spec.ProviderID(), arguments); err != nil {
			return err
		}
		resolved, err := spec.ResolveArguments(arguments)
		if err != nil {
			return err
		}
		switch spec.Runtime().Kind() {
		case providerlaunch.RuntimeKindDirectProcess:
			return runner.runNativeDirect(ctx, spec, resolved)
		case providerlaunch.RuntimeKindCodexExternalAuth:
			return runner.runCodexExternalAuth(ctx, spec, resolved)
		case providerlaunch.RuntimeKindClaudeOAuthProxy:
			return runner.runClaudeOAuthProxy(ctx, spec, resolved)
		default:
			return ErrUnsupportedRuntime
		}
	default:
		return ErrInvalidRunRequest
	}
}

// runDirect 以当前终端和共享 Provider 状态启动一个官方 CLI 子进程。
func (runner *Runner) runDirect(
	ctx context.Context,
	providerID string,
	binary string,
	arguments []string,
	environment providerlaunch.EnvironmentPatch,
) error {
	path, err := runner.binaries.Resolve(providerID, binary)
	if err != nil {
		return err
	}
	return runner.runProviderProcess(
		ctx,
		path,
		arguments,
		applyEnvironment(runner.environ(), environment),
	)
}

// runNativeDirect 执行 Native Direct：需要凭据文件投影时先物化账号沙箱，
// 进程退出后（包括失败与取消）把客户端可能续期的凭据回写账号库。
func (runner *Runner) runNativeDirect(
	ctx context.Context,
	spec providerlaunch.LaunchSpec,
	arguments []string,
) error {
	path, err := runner.binaries.Resolve(spec.ProviderID(), spec.Binary())
	if err != nil {
		return err
	}
	environment := applyEnvironment(runner.environ(), spec.Environment())
	// 进程标记：WebUI 运行态与宿主进程扫描靠这个变量把 CLI 归到账号；
	// 必须先清掉宿主继承值，再写入本次账号。
	environment = applyAccountRefEnvironment(environment, spec.AccountRef())
	projection := spec.Projection()
	if !projection.Required() {
		return runner.runProviderProcess(ctx, path, arguments, environment)
	}
	if runner.projection == nil || runner.hostHomeDir == "" {
		return ErrProjectionUnavailable
	}
	request := appprojection.Request{
		ProviderID:         spec.ProviderID(),
		AccountRef:         spec.AccountRef(),
		Credential:         spec.RevealCredential(),
		HostHomeDir:        runner.hostHomeDir,
		Platform:           runner.platform,
		Purpose:            appprojection.PurposeLaunch,
		ProjectionRequired: true,
	}
	result, err := runner.projection.Prepare(ctx, request)
	if err != nil {
		return err
	}
	// 策略漂移必须失败关闭：Strategy 以为在隔离配置根、策略却退回共享状态（或反向）
	// 时，凭据可能落到宿主原生目录。
	if string(result.Mode) != string(projection.Mode()) ||
		result.PolicyID != projection.PolicyID() {
		return fmt.Errorf(
			"%w: got mode=%s policy=%s, want mode=%s policy=%s",
			ErrProjectionMismatch,
			result.Mode,
			result.PolicyID,
			projection.Mode(),
			projection.PolicyID(),
		)
	}
	environment, err = applyProjectionEnvironment(environment, result)
	if err != nil {
		return err
	}
	// qoder/qodercn 的账号边界在启动参数上（合同声明 --config-dir）：投影根
	// 就绪后把本次账号的配置根注入 argv，不能落到宿主 ~/.qoder。
	arguments = applyConfigDirArgument(spec.ProviderID(), arguments, result.Root)
	runErr := runner.runProviderProcess(ctx, path, arguments, environment)
	// 回写失败必须可见：它意味着账号库停留在旧一代，下一次启动可能拿到失效的
	// refresh_token。TUI 已经正常退出时把它当本次失败；TUI 自己失败时保留原
	// 退出码，只把回写错误打印出来。
	captureErr := runner.captureProjection(ctx, request, result)
	if captureErr == nil {
		return runErr
	}
	if runErr == nil {
		return captureErr
	}
	_, _ = fmt.Fprintf(runner.stderr, "aih: 回写账号凭据失败: %v\n", captureErr)
	return runErr
}

// captureProjection 用不受启动取消影响的 Context 回写凭据：TUI 被 Ctrl+C
// 打断时客户端常常已经刷新过 auth.json，丢掉这次回写会让下次启动用旧 token。
func (runner *Runner) captureProjection(
	ctx context.Context,
	request appprojection.Request,
	result appprojection.Result,
) error {
	captureCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), projectionCaptureTimeout)
	defer cancel()
	return runner.projection.Capture(captureCtx, request, result)
}

// runProviderProcess 是所有官方 CLI 前台进程的唯一入口：
//   - 真终端 + ptyStarter 可用 → 走 ptyhost（raw mode / resize / 退出码）；
//   - 脚本、管道、测试 → 普通 exec，保持 stdout/stderr 分离。
//
// 代理/OAuth 路径只负责旁路服务；TUI 进程必须同样走这里，不能各自 io.Copy。
func (runner *Runner) runProviderProcess(
	ctx context.Context,
	path string,
	arguments []string,
	environment []string,
) error {
	if runner.interactive && runner.ptyStarter != nil {
		return runner.runInteractiveDirect(ctx, path, arguments, environment)
	}
	process, err := runner.processes.Start(ctx, processSpec{
		path:   path,
		args:   append([]string(nil), arguments...),
		env:    append([]string(nil), environment...),
		stdin:  runner.stdin,
		stdout: runner.stdout,
		stderr: runner.stderr,
	})
	if err != nil {
		return err
	}
	return process.Wait()
}

func (runner *Runner) runInteractiveDirect(
	ctx context.Context,
	path string,
	arguments []string,
	environment []string,
) error {
	if runner == nil || runner.ptyStarter == nil || ctx == nil || path == "" {
		return ErrInvalidRunRequest
	}
	_, err := ptyhost.Run(ctx, ptyhost.Config{
		Path:    path,
		Args:    arguments,
		Env:     environment,
		Stdin:   runner.stdin,
		Stdout:  runner.stdout,
		Starter: runner.ptyStarter,
	})
	return err
}

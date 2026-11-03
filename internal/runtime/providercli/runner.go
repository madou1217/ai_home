// Package providercli 执行经过应用层校验的 Provider CLI 启动计划。
package providercli

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/providerlaunch"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/runtime/pty"
)

var (
	// ErrInvalidRunnerOptions 表示 Runtime 缺少凭据刷新或终端 I/O。
	ErrInvalidRunnerOptions = errors.New("Provider CLI Runtime 配置无效")
	// ErrInvalidRunRequest 表示计划、参数或 Context 无效。
	ErrInvalidRunRequest = errors.New("Provider CLI Runtime 请求无效")
	// ErrUnsupportedRuntime 表示当前官方 CLI 不支持计划要求的安全运行形态。
	ErrUnsupportedRuntime = errors.New("Provider CLI Runtime 不受支持")
)

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
	return &Runner{
		credentials: options.Credentials,
		stdin:       options.Stdin,
		stdout:      options.Stdout,
		stderr:      options.Stderr,
		httpClient:  client,
		interactive: options.Interactive,
		ptyStarter:  options.PTYStarter,
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
			return runner.runDirect(
				ctx,
				spec.ProviderID(),
				spec.Binary(),
				resolved,
				spec.Environment(),
			)
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
	env := applyEnvironment(runner.environ(), environment)
	if runner.interactive && runner.ptyStarter != nil {
		return runner.runInteractiveDirect(ctx, path, arguments, env)
	}
	process, err := runner.processes.Start(ctx, processSpec{
		path:   path,
		args:   append([]string(nil), arguments...),
		env:    env,
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
	session, err := runner.ptyStarter.Start(ctx, pty.Spec{
		Path: path,
		Args: append([]string(nil), arguments...),
		Env:  append([]string(nil), environment...),
		Size: pty.Size{Rows: 24, Cols: 80},
	})
	if err != nil {
		return err
	}
	defer session.Close()
	inputDone := make(chan error, 1)
	go func() {
		_, copyErr := io.Copy(session, runner.stdin)
		inputDone <- copyErr
	}()
	_, outputErr := io.Copy(runner.stdout, session)
	waitErr := session.Wait()
	if outputErr != nil && outputErr != io.EOF {
		return outputErr
	}
	if waitErr != nil {
		return waitErr
	}
	return <-inputDone
}

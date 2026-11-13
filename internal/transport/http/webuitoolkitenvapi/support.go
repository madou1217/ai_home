package webuitoolkitenvapi

import (
	"context"
	"errors"
	"os"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/sshremote"
	"github.com/madou1217/ai_home/internal/runtime/toolkit/environment"
)

var (
	// targetConnectionID 与 Node toolkit-execution-target.js 的 CONNECTION_ID 一致。
	targetConnectionID = regexp.MustCompile(`^conn_[a-f0-9]{16}$`)
	// environmentNamePattern 是远端 export 允许的变量名。
	environmentNamePattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

	errUnsupportedRemote          = errors.New("远端系统不在 toolkit 支持范围（Linux / macOS）")
	errRemoteDirectoryUnavailable = errors.New("远端目录不可读")
)

// targetError 是执行目标解析 / 连接失败的领域错误。
type targetError struct {
	code    string
	message string
	status  int
}

func (err *targetError) Error() string { return err.message }

func newTargetError(code string, message string, status int) *targetError {
	return &targetError{code: code, message: message, status: status}
}

// shellQuote 用 POSIX 单引号引用一个值。
func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

func currentPlatform() string {
	switch runtime.GOOS {
	case "darwin":
		return environment.PlatformMacOS
	case "windows":
		return environment.PlatformWindows
	default:
		return environment.PlatformLinux
	}
}

// executionTarget 是一次请求 / 一个作业的执行目标。
type executionTarget struct {
	Kind    string
	Key     string
	Label   string
	Host    func(ctx context.Context) (environment.Host, error)
	Run     func(ctx context.Context, plan environment.Plan, onOutput func(stream string, chunk string)) environment.RunResult
	Refresh func()
	Close   func()
}

func (target *executionTarget) hostOrLocal(ctx context.Context) (environment.Host, error) {
	if target.Host == nil {
		return environment.Host{}, errors.New("execution_target_unavailable")
	}
	return target.Host(ctx)
}

// localTarget 是本机目标：探测走真实文件系统，执行走注入的 Executor。
func (handler *Handler) localTarget() *executionTarget {
	home := handler.homeDir()
	host := environment.Host{
		Platform: currentPlatform(),
		HomeDir:  home,
		Exists: func(path string) bool {
			_, err := os.Stat(path)
			return err == nil
		},
		ReadDir: func(path string) ([]string, error) {
			entries, err := os.ReadDir(path)
			if err != nil {
				return nil, err
			}
			names := make([]string, 0, len(entries))
			for _, entry := range entries {
				if entry.IsDir() {
					names = append(names, entry.Name())
				}
			}
			return names, nil
		},
		Exec:      handler.executor,
		LookupEnv: os.Getenv,
	}
	return &executionTarget{
		Kind:  "local",
		Key:   "local",
		Label: "本机（AIH Server）",
		Host:  func(context.Context) (environment.Host, error) { return host, nil },
		Run: func(ctx context.Context, plan environment.Plan, onOutput func(string, string)) environment.RunResult {
			return handler.runPlan(ctx, host, plan, onOutput)
		},
		Refresh: func() {},
		Close:   func() {},
	}
}

// runPlan 在给定宿主上执行计划（本机）。
func (handler *Handler) runPlan(ctx context.Context, host environment.Host, plan environment.Plan, onOutput func(stream string, chunk string)) environment.RunResult {
	if host.Exec == nil {
		return environment.RunResult{SpawnFailed: true, Message: "executor_unavailable"}
	}
	timeout := time.Duration(plan.TimeoutMS) * time.Millisecond
	options := environment.ExecOptions{Env: plan.Env, Timeout: timeout, OnOutput: onOutput}
	if plan.Cwd != nil {
		options.Dir = *plan.Cwd
	}
	return host.Exec.Run(ctx, plan.Command, plan.Args, options)
}

// resolveTarget 解析请求里的目标：空 / local 是本机，ssh:<connectionId> 是 SSH 连接。
func (handler *Handler) resolveTarget(ctx context.Context, raw string) (*executionTarget, error) {
	value := strings.TrimSpace(raw)
	if value == "" || value == "local" {
		return handler.localTarget(), nil
	}
	if !strings.HasPrefix(value, "ssh:") {
		return nil, newTargetError("invalid_toolkit_target", "执行目标无效（local 或 ssh:<连接 ID>）", 400)
	}
	connectionID := strings.TrimPrefix(value, "ssh:")
	if !targetConnectionID.MatchString(connectionID) {
		return nil, newTargetError("invalid_toolkit_target", "执行目标无效（local 或 ssh:<连接 ID>）", 400)
	}
	rawConnections, found, err := handler.connections.ReadConnections(ctx)
	if err != nil {
		return nil, newTargetError("ssh_connections_read_failed", "SSH 连接读取失败", 500)
	}
	record, ok, err := findConnection(rawConnections, found, connectionID)
	if err != nil {
		return nil, newTargetError("ssh_connections_invalid", "ssh_connections 不是合法 JSON", 500)
	}
	if !ok {
		return nil, newTargetError("connection_not_found", "SSH 连接不存在", 404)
	}
	target := newSSHTarget(record, handler.homeDir())
	facts, err := target.describe(ctx)
	if err != nil {
		return nil, classifyRemoteError(err)
	}
	if facts.Platform == environment.PlatformWindows {
		return nil, newTargetError("unsupported_platform", "远端只能是 Linux 或 macOS（Windows 远端暂未迁移）", 400)
	}
	return &executionTarget{
		Kind:  "ssh",
		Key:   target.Key(),
		Label: target.Label(),
		Host: func(ctx context.Context) (environment.Host, error) {
			host, err := target.host(ctx)
			if err != nil {
				return environment.Host{}, err
			}
			return host, nil
		},
		Run:     target.run,
		Refresh: func() {},
		Close:   target.close,
	}, nil
}

// classifyRemoteError 把 SSH 传输错误映射成 Node toolkit-execution-target 的领域码。
func classifyRemoteError(err error) *targetError {
	if err == nil {
		return nil
	}
	if errors.Is(err, errUnsupportedRemote) {
		return newTargetError("unsupported_platform", "远端系统不在 toolkit 支持范围（Linux / macOS）", 400)
	}
	switch sshremote.ErrorCode(err) {
	case sshremote.CodeAuthFailed:
		return newTargetError("auth_failed", "SSH 认证失败", 502)
	case sshremote.CodeHostKeyMismatch, sshremote.CodeHostKeyRevoked:
		return newTargetError("host_key_mismatch", "SSH 主机密钥与记录不一致", 502)
	}
	return newTargetError("remote_unreachable", "远端不可达："+err.Error(), 502)
}

// homeDir 返回宿主家目录（与 Node resolveHostHome 一致：配置优先，其次进程 HOME）。
func (handler *Handler) homeDir() string {
	if strings.TrimSpace(handler.hostHomeDir) != "" {
		return strings.TrimSpace(handler.hostHomeDir)
	}
	if home, err := os.UserHomeDir(); err == nil {
		return strings.TrimSpace(home)
	}
	if profile := strings.TrimSpace(os.Getenv("USERPROFILE")); profile != "" {
		return profile
	}
	return strings.TrimSpace(os.Getenv("HOME"))
}

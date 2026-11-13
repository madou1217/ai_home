package environment

import (
	"context"
	"strings"
	"time"
)

// DefaultProbeTimeout 与 Node probe.js 的 probeTimeoutMs 一致：单条探测命令 3s。
const DefaultProbeTimeout = 3 * time.Second

// ExecOptions 是一次命令执行的可变部分。
//
// Env 只包含计划或探测额外声明的变量；实现负责把它叠加到宿主环境之上
// （Node 是 { ...process.env, ...plan.env }）。Dir 为空表示宿主默认工作目录。
type ExecOptions struct {
	Dir            string
	Env            map[string]string
	Timeout        time.Duration
	MaxOutputBytes int
	OnOutput       func(stream string, chunk string)
}

// RunResult 是一条命令的执行结果。
//
// ExitCode 为 nil 表示没有拿到退出码（启动失败、超时或传输中断）；Node 的
// probeStatus 用它区分 error 与 unavailable，因此这里必须保留这个区别。
type RunResult struct {
	OK          bool
	ExitCode    *int
	Signal      string
	Stdout      string
	Stderr      string
	Truncated   bool
	TimedOut    bool
	SpawnFailed bool
	Message     string
}

// Executor 是「在目标机器上执行一条命令」的唯一端口。
//
// 本机实现见 internal/adapters/hostexec；SSH 远端的实现把同一份 argv 交给
// 登录 shell。领域层只依赖这个端口，计划构建不感知执行位置。
type Executor interface {
	Run(ctx context.Context, command string, args []string, options ExecOptions) RunResult
}

// Host 是探测与计划构建需要的宿主事实。
//
// Exists / ReadDir 由目标机器的文件系统实现提供；远端目标用一次目录快照
// 构造同形视图，探测逻辑本身只有一份。
type Host struct {
	Platform  string
	HomeDir   string
	Exists    func(path string) bool
	ReadDir   func(path string) ([]string, error)
	Exec      Executor
	LookupEnv func(string) string
}

// probeTimeout 归一单条探测命令的超时；0 用默认 3s。
func probeTimeout(options ExecOptions) time.Duration {
	if options.Timeout > 0 {
		return options.Timeout
	}
	return DefaultProbeTimeout
}

// execProbe 以默认超时执行一条探测命令。
func execProbe(ctx context.Context, host Host, command string, args []string) RunResult {
	if host.Exec == nil {
		return RunResult{SpawnFailed: true, Message: "executor_unavailable"}
	}
	return host.Exec.Run(ctx, command, args, ExecOptions{Timeout: DefaultProbeTimeout})
}

// probeValue 对齐 Node execCommand 的 value 字段：成功时取 stdout，为空取 stderr。
// Node 的 execCommand 已经 trim 过输出，这里保持同一口径。
func probeValue(result RunResult) string {
	if !result.OK {
		return ""
	}
	if value := strings.TrimSpace(result.Stdout); value != "" {
		return value
	}
	return strings.TrimSpace(result.Stderr)
}

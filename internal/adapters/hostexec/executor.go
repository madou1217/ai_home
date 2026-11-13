// Package hostexec 是 environment.Executor 的本机实现：直接在本进程所在的机器上
// 启动子进程，捕获 stdout / stderr、超时与退出码。
//
// Node 的 executeLifecyclePlan 用 spawn + 60s~1h 超时 + 64KB 输出上限；这里保持
// 同一组语义：超时先 SIGTERM，输出只保留上限内的字节并标记 truncated。
package hostexec

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/toolkit/environment"
)

const (
	defaultTimeout        = 120 * time.Second
	defaultMaxOutput      = 64 * 1024
	minMaxOutput          = 1024
	maxMaxOutput          = 1024 * 1024
	waitDelayAfterSIGTERM = 5 * time.Second
)

// Executor 是本机命令执行器；零值可用。
type Executor struct{}

// Run 执行一条命令并返回结果。
func (Executor) Run(ctx context.Context, command string, args []string, options environment.ExecOptions) environment.RunResult {
	timeout := options.Timeout
	if timeout <= 0 {
		timeout = defaultTimeout
	}
	maxOutput := options.MaxOutputBytes
	if maxOutput <= 0 {
		maxOutput = defaultMaxOutput
	}
	if maxOutput < minMaxOutput {
		maxOutput = minMaxOutput
	}
	if maxOutput > maxMaxOutput {
		maxOutput = maxMaxOutput
	}
	collector := newOutputCollector(maxOutput, options.OnOutput)

	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	commandObj := exec.CommandContext(runCtx, command, args...)
	commandObj.Dir = options.Dir
	commandObj.Env = mergedEnv(options.Env)
	commandObj.Stdout = nil
	commandObj.Stderr = nil
	commandObj.Cancel = func() error {
		if commandObj.Process == nil {
			return nil
		}
		return commandObj.Process.Signal(syscall.SIGTERM)
	}
	commandObj.WaitDelay = waitDelayAfterSIGTERM

	stdout, err := commandObj.StdoutPipe()
	if err != nil {
		return environment.RunResult{SpawnFailed: true, Message: err.Error()}
	}
	stderr, err := commandObj.StderrPipe()
	if err != nil {
		return environment.RunResult{SpawnFailed: true, Message: err.Error()}
	}
	if err := commandObj.Start(); err != nil {
		return environment.RunResult{SpawnFailed: true, Message: err.Error()}
	}
	var group sync.WaitGroup
	group.Add(2)
	go func() {
		defer group.Done()
		_, _ = io.Copy(collector.writer("stdout"), stdout)
	}()
	go func() {
		defer group.Done()
		_, _ = io.Copy(collector.writer("stderr"), stderr)
	}()
	waitErr := commandObj.Wait()
	group.Wait()
	timedOut := errors.Is(runCtx.Err(), context.DeadlineExceeded)
	result := environment.RunResult{
		Truncated: collector.truncated(),
		TimedOut:  timedOut,
		Stdout:    collector.text("stdout"),
		Stderr:    collector.text("stderr"),
	}
	if timedOut {
		result.OK = false
		result.Message = "命令执行超时"
		return result
	}
	if waitErr != nil {
		var exitErr *exec.ExitError
		if errors.As(waitErr, &exitErr) {
			code := exitErr.ExitCode()
			result.ExitCode = &code
			if status, ok := exitErr.Sys().(syscall.WaitStatus); ok && status.Signaled() {
				result.Signal = status.Signal().String()
			}
			if code == 0 {
				result.OK = true
			}
			return result
		}
		result.SpawnFailed = true
		result.Message = waitErr.Error()
		return result
	}
	code := 0
	result.ExitCode = &code
	result.OK = true
	return result
}

// mergedEnv 在宿主环境之上叠加计划声明的变量（Node: {...process.env, ...plan.env}）。
func mergedEnv(extra map[string]string) []string {
	base := os.Environ()
	if len(extra) == 0 {
		return base
	}
	overridden := make(map[string]struct{}, len(extra))
	for key := range extra {
		overridden[key] = struct{}{}
	}
	merged := make([]string, 0, len(base)+len(extra))
	for _, entry := range base {
		index := strings.IndexByte(entry, '=')
		if index <= 0 {
			continue
		}
		if _, replaced := overridden[entry[:index]]; replaced {
			continue
		}
		merged = append(merged, entry)
	}
	for key, value := range extra {
		merged = append(merged, key+"="+value)
	}
	return merged
}

// outputCollector 复刻 Node createOutputCollector：所有流共享同一个字节预算。
type outputCollector struct {
	mu            sync.Mutex
	limit         int
	captured      int
	truncatedFlag bool
	stdout        strings.Builder
	stderr        strings.Builder
	onOutput      func(stream string, chunk string)
}

func newOutputCollector(limit int, onOutput func(stream string, chunk string)) *outputCollector {
	return &outputCollector{limit: limit, onOutput: onOutput}
}

func (collector *outputCollector) writer(stream string) io.Writer {
	return writerFunc(func(chunk []byte) (int, error) {
		collector.append(stream, chunk)
		return len(chunk), nil
	})
}

func (collector *outputCollector) append(stream string, chunk []byte) {
	collector.mu.Lock()
	remaining := collector.limit - collector.captured
	if remaining <= 0 {
		collector.truncatedFlag = true
		collector.mu.Unlock()
		return
	}
	captured := chunk
	if len(captured) > remaining {
		captured = captured[:remaining]
		collector.truncatedFlag = true
	}
	collector.captured += len(captured)
	value := string(captured)
	if stream == "stdout" {
		collector.stdout.WriteString(value)
	} else {
		collector.stderr.WriteString(value)
	}
	callback := collector.onOutput
	collector.mu.Unlock()
	if callback != nil && value != "" {
		callback(stream, value)
	}
}

func (collector *outputCollector) text(stream string) string {
	collector.mu.Lock()
	defer collector.mu.Unlock()
	if stream == "stdout" {
		return collector.stdout.String()
	}
	return collector.stderr.String()
}

func (collector *outputCollector) truncated() bool {
	collector.mu.Lock()
	defer collector.mu.Unlock()
	return collector.truncatedFlag
}

type writerFunc func([]byte) (int, error)

func (fn writerFunc) Write(chunk []byte) (int, error) { return fn(chunk) }

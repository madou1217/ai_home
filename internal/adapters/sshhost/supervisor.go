package sshhost

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"
)

// 退避序列与稳定阈值与 Node 的 B5 守护一致。
var (
	// Backoff 是断线重连的退避序列（秒级递增，封顶 30s）。
	Backoff = []time.Duration{
		1 * time.Second,
		2 * time.Second,
		5 * time.Second,
		10 * time.Second,
		20 * time.Second,
		30 * time.Second,
	}
	// StableAfter 表示连接稳定运行超过该时长后退避从头算。
	StableAfter = 60 * time.Second
	// CredentialWipeDelay 是建连后擦除临时凭据的延迟。
	CredentialWipeDelay = 10 * time.Second
)

// 工作区加载错误。
var (
	ErrWorkspaceNotFound  = errors.New("workspace_not_found")
	ErrConnectionNotFound = errors.New("connection_not_found")
)

// Workspace 是 app_kv: ssh_workspaces 的元素。
type Workspace struct {
	ID           string `json:"id"`
	ConnectionID string `json:"connectionId"`
	RemoteRoot   string `json:"remoteRoot"`
}

// WorkspaceReader 读取 app_kv 里的 JSON 值；Node 侧是 readJsonValue(fs, aiHomeDir, key)。
// 读失败按「未配置」处理，与 Node 的宽松读一致。
type WorkspaceReader interface {
	ReadJSON(key string, destination any) error
}

// LoadWorkspace 按工作区 ID 找到工作区及其 SSH 连接。
func LoadWorkspace(reader WorkspaceReader, workspaceID string) (Workspace, Connection, error) {
	var workspaces []Workspace
	if reader != nil {
		_ = reader.ReadJSON("ssh_workspaces", &workspaces)
	}
	var workspace Workspace
	found := false
	for _, item := range workspaces {
		if item.ID == workspaceID {
			workspace = item
			found = true
			break
		}
	}
	if !found {
		return Workspace{}, Connection{}, ErrWorkspaceNotFound
	}
	var connections []Connection
	if reader != nil {
		_ = reader.ReadJSON("ssh_connections", &connections)
	}
	for _, connection := range connections {
		if connection.ID == workspace.ConnectionID {
			return workspace, connection, nil
		}
	}
	return Workspace{}, Connection{}, ErrConnectionNotFound
}

// ExitStatus 是一次子进程退出结果；Signal 为空表示正常退出。
type ExitStatus struct {
	Code   int
	Signal string
}

// ProcessHandle 是守护对子进程的最小要求。
type ProcessHandle interface {
	Wait() ExitStatus
	Kill() error
}

// LaunchFunc 启动一条命令；生产实现见 ExecLauncher。
type LaunchFunc func(ctx context.Context, command Command) (ProcessHandle, error)

// Exit 是一次连接结束的事实，用于 Decide。
type Exit struct {
	Code         int
	Signal       string
	ConnectedFor time.Duration
	Stopping     bool
}

// Decision 是状态机的输出。
type Decision struct {
	Reconnect bool
	Delay     time.Duration
	Attempt   int
	ExitCode  int
}

// ShouldReconnect 判定 ssh 退出后是否重连：
// 255 = ssh 自身失败（连不上、断线、超时）；被信号打断也算断线（自身 SIGINT 除外）。
// 0 / 其他码 = 远端 shell 正常结束，不重连。
func ShouldReconnect(code int, signal string) bool {
	if signal != "" && signal != "SIGINT" {
		return true
	}
	return code == 255
}

// BackoffDelay 返回第 attempt 次重连前的等待时长（0 基，超出序列封顶）。
func BackoffDelay(attempt int) time.Duration {
	if attempt < 0 {
		attempt = 0
	}
	if attempt >= len(Backoff) {
		attempt = len(Backoff) - 1
	}
	return Backoff[attempt]
}

// Decide 是守护的核心状态机：给定一次退出与当前重试计数，给出下一步。
func Decide(exit Exit, attempt int) Decision {
	if exit.Stopping {
		return Decision{Reconnect: false, Attempt: attempt, ExitCode: 0}
	}
	if !ShouldReconnect(exit.Code, exit.Signal) {
		return Decision{Reconnect: false, Attempt: attempt, ExitCode: exit.Code}
	}
	if exit.ConnectedFor >= StableAfter {
		attempt = 0
	}
	return Decision{
		Reconnect: true,
		Delay:     BackoffDelay(attempt),
		Attempt:   attempt + 1,
		ExitCode:  exit.Code,
	}
}

// Supervisor 在 Server 的持久 PTY 里守护一条远程 shell：断线退避重连，
// 每次重连都重新读取连接配置，凭据只在建连时落临时文件并尽快擦除。
type Supervisor struct {
	State       WorkspaceReader
	AIHomeDir   string
	HomeDir     string
	WorkspaceID string
	SessionKey  string
	Output      io.Writer
	Launch      LaunchFunc
	Sleep       func(ctx context.Context, delay time.Duration) bool
	AfterFunc   func(delay time.Duration, callback func()) (stop func())
	Now         func() time.Time
	FS          CredentialFS
	Platform    string
}

// Run 运行守护直到远端 shell 正常结束、配置失效或 ctx 被取消；返回退出码。
func (supervisor *Supervisor) Run(ctx context.Context) int {
	if supervisor == nil || supervisor.State == nil || strings.TrimSpace(supervisor.WorkspaceID) == "" {
		return 1
	}
	attempt := 0
	for {
		if ctx.Err() != nil {
			return 0
		}
		workspace, connection, err := LoadWorkspace(supervisor.State, supervisor.WorkspaceID)
		if err != nil {
			if errors.Is(err, ErrWorkspaceNotFound) {
				supervisor.write("\r\n[aih] 远程工作区不可用：工作区已删除\r\n")
			} else {
				supervisor.write("\r\n[aih] 远程工作区不可用：SSH 连接已删除\r\n")
			}
			return 1
		}
		command, err := BuildRemoteShellCommand(RemoteShellOptions{
			Connection: connection,
			RemoteRoot: workspace.RemoteRoot,
			SessionKey: supervisor.sessionKey(),
			AIHomeDir:  supervisor.AIHomeDir,
			HomeDir:    supervisor.HomeDir,
			Platform:   supervisor.Platform,
			FS:         supervisor.credentialFS(),
		})
		if err != nil {
			supervisor.write("\r\n[aih] SSH 连接配置无效：" + errorCode(err) + "\r\n")
			return 1
		}
		startedAt := supervisor.now()
		handle, err := supervisor.launch(ctx, command)
		if err != nil {
			RemoveCredentialFiles(command.TempFiles, supervisor.credentialFS())
			supervisor.write("\r\n[aih] 无法启动 ssh：" + err.Error() + "\r\n")
			return 1
		}
		stopWipe := supervisor.afterFunc(CredentialWipeDelay, func() {
			RemoveCredentialFiles(command.TempFiles, supervisor.credentialFS())
		})
		stopWatch := watchCancellation(ctx, handle)
		status := handle.Wait()
		stopWatch()
		if stopWipe != nil {
			stopWipe()
		}
		RemoveCredentialFiles(command.TempFiles, supervisor.credentialFS())

		decision := Decide(Exit{
			Code:         status.Code,
			Signal:       status.Signal,
			ConnectedFor: supervisor.now().Sub(startedAt),
			Stopping:     ctx.Err() != nil,
		}, attempt)
		attempt = decision.Attempt
		if !decision.Reconnect {
			return decision.ExitCode
		}
		supervisor.write(fmt.Sprintf(
			"\r\n\x1b[33m[aih] 与 %s 的连接已断开，%d 秒后自动重连（第 %d 次）…\x1b[0m\r\n",
			connection.Host,
			int(decision.Delay/time.Second),
			attempt,
		))
		if !supervisor.sleep(ctx, decision.Delay) {
			return 0
		}
	}
}

func (supervisor *Supervisor) sessionKey() string {
	if strings.TrimSpace(supervisor.SessionKey) != "" {
		return supervisor.SessionKey
	}
	return RemoteSessionKey(supervisor.WorkspaceID, "")
}

func (supervisor *Supervisor) credentialFS() CredentialFS {
	if supervisor.FS != nil {
		return supervisor.FS
	}
	return osCredentialFS{}
}

func (supervisor *Supervisor) launch(ctx context.Context, command Command) (ProcessHandle, error) {
	if supervisor.Launch != nil {
		return supervisor.Launch(ctx, command)
	}
	return ExecLauncher(ctx, command)
}

func (supervisor *Supervisor) sleep(ctx context.Context, delay time.Duration) bool {
	if supervisor.Sleep != nil {
		return supervisor.Sleep(ctx, delay)
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func (supervisor *Supervisor) afterFunc(delay time.Duration, callback func()) func() {
	if supervisor.AfterFunc != nil {
		return supervisor.AfterFunc(delay, callback)
	}
	timer := time.AfterFunc(delay, callback)
	return func() { timer.Stop() }
}

func (supervisor *Supervisor) now() time.Time {
	if supervisor.Now != nil {
		return supervisor.Now()
	}
	return time.Now()
}

func (supervisor *Supervisor) write(text string) {
	output := supervisor.Output
	if output == nil {
		output = io.Discard
	}
	_, _ = io.WriteString(output, text)
}

func watchCancellation(ctx context.Context, handle ProcessHandle) func() {
	done := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			_ = handle.Kill()
		case <-done:
		}
	}()
	return func() { close(done) }
}

func errorCode(err error) string {
	if identityErr, ok := AsIdentityFileError(err); ok {
		return identityErr.Code
	}
	if configErr, ok := AsConfigError(err); ok {
		return configErr.Code
	}
	if err == nil {
		return ""
	}
	return err.Error()
}

// ExecLauncher 用 os/exec 启动 ssh，stdio 直连当前进程（终端由外层 PTY 托管）。
func ExecLauncher(ctx context.Context, command Command) (ProcessHandle, error) {
	process := exec.CommandContext(ctx, command.File, command.Args...)
	process.Stdin = os.Stdin
	process.Stdout = os.Stdout
	process.Stderr = os.Stderr
	process.Env = os.Environ()
	for key, value := range command.Env {
		process.Env = append(process.Env, key+"="+value)
	}
	if err := process.Start(); err != nil {
		return nil, err
	}
	return &execHandle{process: process}, nil
}

type execHandle struct {
	process *exec.Cmd
}

func (handle *execHandle) Wait() ExitStatus {
	err := handle.process.Wait()
	if err == nil {
		return ExitStatus{}
	}
	var exitError *exec.ExitError
	if errors.As(err, &exitError) {
		status := ExitStatus{Code: exitError.ExitCode()}
		if status.Code < 0 {
			// 被信号终止：退出码没有意义，交给 ShouldReconnect 按信号判断。
			status.Code = 0
			status.Signal = signalName(exitError)
		}
		return status
	}
	return ExitStatus{Code: 1}
}

func (handle *execHandle) Kill() error {
	if handle.process == nil || handle.process.Process == nil {
		return nil
	}
	return handle.process.Process.Kill()
}

// 说明：这里是尽力读取平台信号名，读不到时退回 ProcessState 的描述字符串。
func signalName(exitError *exec.ExitError) string {
	text := exitError.ProcessState.String()
	index := strings.LastIndex(text, "signal: ")
	if index < 0 {
		return text
	}
	return strings.TrimSpace(text[index+len("signal: "):])
}

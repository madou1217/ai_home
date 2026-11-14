package webuisshapi

// 远程工作区原生终端：在用户桌面的终端窗口里跑一个 Go supervisor。
//
// 拓扑：aih-server 由 WebUI 启动成终端命令（__remote-ws），它自己读工作区与
// SSH 连接、建连、断线重连，并接管 stdin/stdout。Node 不再参与这条链路，
// 远端机器也不需要 aih/node。
//
// 语义与 Node 的 ssh-remote-supervisor 对齐：
//   - 远端有 tmux 时进入/接回同名会话，断线重连后 shell 与进程原样接回；
//   - 正常结束（exit / 远端会话结束）不重连；ssh 断线（255/连接错误）由
//     sshremote.ReconnectingPTY 按退避重连；
//   - 每次重连都重新读取工作区连接配置。

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/sshhost"
	"github.com/madou1217/ai_home/internal/adapters/sshremote"
	"github.com/madou1217/ai_home/internal/runtime/pty"
)

// NativeRemoteOptions 是一次原生终端运行的输入。
type NativeRemoteOptions struct {
	AIHomeDir   string
	HostHomeDir string
	WorkspaceID string
	SessionKey  string
	Stdin       io.Reader
	Stdout      io.Writer
	Stderr      io.Writer
	// TerminalSize 返回当前本地终端尺寸；为 nil 时用 80x24。
	TerminalSize func() (pty.Size, bool)
	// WatchResize 注册本地终端尺寸变化回调；为 nil 时不做动态 resize。
	WatchResize func(ctx context.Context, onChange func(pty.Size))
}

// RunNativeRemoteWorkspace 运行远程工作区终端，直到远端会话结束或 ctx 取消。
func RunNativeRemoteWorkspace(ctx context.Context, options NativeRemoteOptions) error {
	workspaceID := strings.TrimSpace(options.WorkspaceID)
	if !isWorkspaceID(workspaceID) {
		return errors.New("invalid remote workspace invocation")
	}
	sessionKey := strings.TrimSpace(options.SessionKey)
	if sessionKey == "" {
		sessionKey = sshhost.RemoteSessionKey(workspaceID, "")
	}
	source, err := OpenSource(options.AIHomeDir)
	if err != nil {
		return err
	}
	rawWorkspaces, found, err := source.ReadWorkspaces(ctx)
	if err != nil {
		return fmt.Errorf("读取远程工作区失败: %w", err)
	}
	workspace, ok, err := findObjectByID(rawWorkspaces, found, workspaceID)
	if err != nil {
		return fmt.Errorf("ssh_workspaces 不是合法 JSON: %w", err)
	}
	if !ok {
		return errors.New("workspace_not_found")
	}
	rawConnections, connFound, err := source.ReadConnections(ctx)
	if err != nil {
		return fmt.Errorf("读取 SSH 连接失败: %w", err)
	}
	connectionsByID, err := parseConnectionsMap(rawConnections, connFound)
	if err != nil {
		return fmt.Errorf("ssh_connections 不是合法 JSON: %w", err)
	}
	connection, ok := connectionsByID[trimmedString(workspace["connectionId"])]
	if !ok {
		return errors.New("connection_not_found")
	}
	config, ok := buildSSHConfigChain(connection, connectionsByID, options.HostHomeDir)
	if !ok {
		return errors.New("egress_connection_invalid")
	}
	if reason, message := validateKeyFiles(config, options.HostHomeDir); reason != "" {
		return fmt.Errorf("%s: %s", reason, message)
	}
	if err := validateSSHConfigChain(config); err != nil {
		return err
	}
	remoteRoot := trimmedString(workspace["remoteRoot"])
	command := sshhost.BuildRemoteCommand(remoteRoot, sessionKey)

	size := pty.Size{Cols: 80, Rows: 24}
	if options.TerminalSize != nil {
		if current, ok := options.TerminalSize(); ok && current.Cols > 0 && current.Rows > 0 {
			size = current
		}
	}
	termName := strings.TrimSpace(os.Getenv("TERM"))
	if termName == "" {
		termName = "xterm-256color"
	}
	session, err := sshremote.OpenReconnectingPTY(ctx, config, command, sshremote.PTYOptions{
		Cols: size.Cols,
		Rows: size.Rows,
		Env:  []string{"TERM=" + termName},
	})
	if err != nil {
		return err
	}
	defer func() { _ = session.Close() }()

	if options.WatchResize != nil {
		options.WatchResize(ctx, func(next pty.Size) {
			if next.Cols > 0 && next.Rows > 0 {
				_ = session.Resize(next)
			}
		})
	}

	stdin := options.Stdin
	if stdin == nil {
		stdin = os.Stdin
	}
	stdout := options.Stdout
	if stdout == nil {
		stdout = os.Stdout
	}
	go func() {
		_, _ = io.Copy(session, stdin)
		// 本地终端关闭（EOF）时合上远端会话，避免后台残留。
		_ = session.Close()
	}()
	_, copyErr := io.Copy(stdout, session)
	waitErr := session.Wait()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if waitErr != nil {
		return waitErr
	}
	return copyErr
}

func isWorkspaceID(value string) bool {
	if !strings.HasPrefix(value, "ws_") || len(value) != 3+16 {
		return false
	}
	for _, char := range value[3:] {
		if (char < '0' || char > '9') && (char < 'a' || char > 'f') {
			return false
		}
	}
	return true
}

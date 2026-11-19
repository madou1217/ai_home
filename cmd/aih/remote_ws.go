package main

import (
	"context"
	"fmt"
	"os"
	"regexp"
	"strings"

	"golang.org/x/term"

	"github.com/madou1217/ai_home/internal/runtime/pty"
	"github.com/madou1217/ai_home/internal/runtime/shellsetup"
	"github.com/madou1217/ai_home/internal/transport/http/webuisshapi"
)

var remoteWorkspaceIDPattern = regexp.MustCompile(`^ws_[a-f0-9]{16}$`)

// `aih __remote_ws__ <workspace-id> [session-key]`：远程工作区 SSH 守护。
// 与 Node lib/server/ssh-remote-supervisor.js 同一职责，实际建连/重连由 Go 的
// webuisshapi.RunNativeRemoteWorkspace 完成。
func runRemoteWorkspace(arguments []string, runtime commandRuntime) error {
	if len(arguments) < 1 || !remoteWorkspaceIDPattern.MatchString(arguments[0]) {
		_, _ = fmt.Fprintln(runtime.stderr, "[aih] invalid remote workspace invocation.")
		return cliExitCode{code: 1}
	}
	workspaceID := arguments[0]
	sessionKey := ""
	if len(arguments) > 1 {
		sessionKey = arguments[1]
	}
	aiHomeDir, err := resolveAIHomeDir(runtime)
	if err != nil {
		return err
	}
	env := func(name string) string {
		value, _ := runtime.lookupEnv(name)
		return value
	}
	hostHomeDir := shellsetup.ResolveHostHomeDir(env, runtime.userHomeDir)
	stdin, _ := runtime.stdin.(*os.File)
	if stdin == nil {
		stdin = os.Stdin
	}
	options := webuisshapi.NativeRemoteOptions{
		AIHomeDir:   aiHomeDir,
		HostHomeDir: hostHomeDir,
		WorkspaceID: workspaceID,
		SessionKey:  sessionKey,
		Stdin:       stdin,
		Stdout:      runtime.stdout,
		Stderr:      runtime.stderr,
		TerminalSize: func() (pty.Size, bool) {
			width, height, sizeErr := term.GetSize(int(stdin.Fd()))
			if sizeErr != nil || width <= 0 || height <= 0 {
				return pty.Size{}, false
			}
			return pty.Size{Cols: uint16(width), Rows: uint16(height)}, true
		},
	}
	runErr := webuisshapi.RunNativeRemoteWorkspace(context.Background(), options)
	if runErr == nil {
		return nil
	}
	message := runErr.Error()
	switch message {
	case "workspace_not_found":
		message = "工作区已删除"
	case "connection_not_found":
		message = "SSH 连接已删除"
	default:
		if !strings.Contains(message, "工作区") && !strings.Contains(message, "连接") && !strings.Contains(message, "ssh") {
			message = "SSH 连接配置无效：" + message
		}
	}
	_, _ = fmt.Fprintf(runtime.stdout, "\r\n[aih] 远程工作区不可用：%s\r\n", message)
	return cliExitCode{code: 1}
}

package codexappserverws

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// SharedBackendOptions 描述一个可被多个终端复用的 app-server 后端。
type SharedBackendOptions struct {
	Command string
	Args    []string
	Dir     string
	Env     []string
	LogPath string
}

// SharedBackend 是已启动、监听 ws://127.0.0.1:<port> 的共享 app-server。
type SharedBackend struct {
	PID int
	URL string
}

// StartSharedBackend 以 ws 传输启动 app-server；端口由内核分配并通过日志回报。
// 进程与会话终端解耦：创建者退出后后端继续服务其它租约。
func StartSharedBackend(opts SharedBackendOptions) (SharedBackend, error) {
	if opts.Command == "" || opts.LogPath == "" {
		return SharedBackend{}, fmt.Errorf("codex_shared_backend_invalid_options")
	}
	if err := os.MkdirAll(filepath.Dir(opts.LogPath), 0o755); err != nil {
		return SharedBackend{}, err
	}
	logFile, err := os.OpenFile(filepath.Clean(opts.LogPath), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return SharedBackend{}, err
	}
	args := make([]string, 0, len(opts.Args)+2)
	args = append(args, stripListenArgs(opts.Args)...)
	args = append(args, "--listen", "ws://127.0.0.1:0")
	cmd := exec.Command(opts.Command, args...)
	cmd.Dir = opts.Dir
	cmd.Env = opts.Env
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	cmd.Stdin = nil
	configureSharedProcess(cmd)
	if err = cmd.Start(); err != nil {
		_ = logFile.Close()
		return SharedBackend{}, err
	}
	pid := cmd.Process.Pid
	// 后端与创建者解耦：不等 Wait，只释放自身句柄。
	go func() { _ = cmd.Wait() }()
	err = logFile.Close()
	if err != nil {
		return SharedBackend{}, err
	}
	port, ok := ReadBackendPort(opts.LogPath, 20*time.Second)
	if !ok {
		_ = cmd.Process.Kill()
		return SharedBackend{}, fmt.Errorf("codex_shared_backend_port_missing")
	}
	return SharedBackend{PID: pid, URL: fmt.Sprintf("ws://127.0.0.1:%d", port)}, nil
}

// stripListenArgs 去掉调用方给定的传输参数：共享后端统一由池决定 ws 端点。
func stripListenArgs(args []string) []string {
	out := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		trimmed := strings.TrimSpace(args[i])
		if trimmed == "--listen" || trimmed == "--stdio" {
			if trimmed == "--listen" && i+1 < len(args) {
				i++
			}
			continue
		}
		if strings.HasPrefix(trimmed, "--listen=") {
			continue
		}
		out = append(out, args[i])
	}
	return out
}

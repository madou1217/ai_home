// Package nodesupervisor 在 Go 进程内启动并监督仍由 Node 承担的 WebUI 数据面。
//
// 拓扑反转：launchd/服务管理器直接运行 aih-server；Go 持有公开端口并为推理面负责，
// 同时把尚未迁移的 /v0 路由交给一个 Node 子进程。Node 以“外部 Go Core”模式运行
// （AIH_GO_CORE_EXTERNAL_URL 指向本进程），不再自己拉起 Go。
//
// Node 只是可选子组件：启动失败或反复退出时 Go 继续服务自己的路由，并在日志里报错。
package nodesupervisor

import (
	"context"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	entryFileEnv = "AIH_SERVER_ENTRY_FILE"
	nodeExecEnv  = "AIH_SERVER_NODE_EXEC"

	restartDelay    = time.Second
	restartMaxDelay = 30 * time.Second
	stopTimeout     = 5 * time.Second
)

// Options 描述 Node 子进程的启动条件。
type Options struct {
	AIHomeDir     string
	NodeExec      string
	EntryFile     string
	ExternalURL   string
	ManagementKey string
	ClientKey     string
	Logf          func(format string, args ...any)
	// CommandFactory 与 PickPort 供测试注入；生产环境使用 exec.Command 与系统临时端口。
	CommandFactory func(name string, args ...string) *exec.Cmd
	PickPort       func() (int, error)
	Stdout         io.Writer
	Stderr         io.Writer
}

// Supervisor 持有一个 Node 子进程；Prepare 只选端口，Start 才拉起进程。
type Supervisor struct {
	options Options
	port    int

	mu         sync.Mutex
	command    *exec.Cmd
	started    bool
	stopping   bool
	done       chan struct{}
	halt       chan struct{}
	drained    chan struct{}
	doneOnce   sync.Once
	drainOnce  sync.Once
	generation uint64
	joined     uint64
	drainErr   error
}

var errUnavailable = fmt.Errorf("node supervisor unavailable")

// Prepare 选择 Node 的私有端口，返回监督器与 Node 的回环地址。
func Prepare(options Options) (*Supervisor, string, error) {
	if strings.TrimSpace(options.AIHomeDir) == "" || strings.TrimSpace(options.ExternalURL) == "" {
		return nil, "", errUnavailable
	}
	pickPort := options.PickPort
	if pickPort == nil {
		pickPort = pickFreePort
	}
	port, err := pickPort()
	if err != nil {
		return nil, "", err
	}
	return &Supervisor{options: options, port: port, done: make(chan struct{}), halt: make(chan struct{}), drained: make(chan struct{})},
		fmt.Sprintf("http://127.0.0.1:%d", port), nil
}

// Start is once-only. Starting and publishing the original command use the
// same mutex as Inhibit, so no unregistered child can cross that barrier.
func (supervisor *Supervisor) Start() {
	if supervisor == nil {
		return
	}
	supervisor.mu.Lock()
	if supervisor.started || supervisor.stopping {
		supervisor.mu.Unlock()
		return
	}
	supervisor.started = true
	err := supervisor.startLocked()
	supervisor.mu.Unlock()
	if err != nil {
		supervisor.logf("Node 子进程启动失败: %v", err)
		supervisor.finish()
		return
	}
	go supervisor.watch()
}

// Stop waits for the same original direct-child drain as every other caller.
// This does not prove independent Node processes or descendants have stopped.
func (supervisor *Supervisor) Stop() error {
	if supervisor == nil {
		return nil
	}
	_, err := supervisor.Drain(context.Background())
	return err
}

// startLocked is called only with mu held, including across command.Start and
// publication. The stop barrier cannot miss a child that is still starting.
func (supervisor *Supervisor) startLocked() error {
	if supervisor.stopping {
		return errUnavailable
	}
	nodeExec, entry, err := supervisor.resolveCommand()
	if err != nil {
		return err
	}
	args := []string{entry, "server", "serve", "--host", "127.0.0.1", "--port", strconv.Itoa(supervisor.port)}
	factory := supervisor.options.CommandFactory
	if factory == nil {
		factory = exec.Command
	}
	command := factory(nodeExec, args...)
	if command == nil {
		return errUnavailable
	}
	command.Env = supervisor.childEnv()
	command.Stdin = nil
	command.Stdout = supervisor.options.Stdout
	command.Stderr = supervisor.options.Stderr
	// Do not force-close inherited pipes and call that a completed pump join.
	// Drain(ctx) may time out, but that never authorizes a terminal receipt.
	command.WaitDelay = 0
	if err := command.Start(); err != nil {
		return err
	}
	supervisor.command = command
	supervisor.generation++
	return nil
}

// watch is the sole Cmd.Wait consumer for every original started generation.
// It joins exec's output pumps too; Process.Wait alone did not do that.
func (supervisor *Supervisor) watch() {
	defer supervisor.finish()
	for {
		supervisor.mu.Lock()
		command := supervisor.command
		supervisor.mu.Unlock()
		if command == nil || command.Process == nil {
			supervisor.recordDrainUnknown()
			return
		}
		err := command.Wait()
		supervisor.mu.Lock()
		if !directChildWaitJoined(command, err) {
			supervisor.drainErr = fmt.Errorf("node_supervisor_direct_child_wait_unknown")
			supervisor.inhibitLocked()
		} else {
			supervisor.joined++
		}
		supervisor.command = nil
		stopping := supervisor.stopping
		supervisor.mu.Unlock()
		if stopping {
			return
		}
		reason := "unknown"
		if err != nil {
			reason = err.Error()
		} else if command.ProcessState != nil {
			reason = fmt.Sprintf("exit=%d", command.ProcessState.ExitCode())
		}
		delay := restartDelay
		supervisor.logf("Node 子进程退出(%s)，%s 后重启", reason, delay)
		for {
			if !supervisor.waitRestart(delay) {
				return
			}
			supervisor.mu.Lock()
			if supervisor.stopping {
				supervisor.mu.Unlock()
				return
			}
			err = supervisor.startLocked()
			supervisor.mu.Unlock()
			if err == nil {
				break
			}
			supervisor.logf("Node 子进程重启失败: %v", err)
			delay *= 2
			if delay > restartMaxDelay {
				delay = restartMaxDelay
			}
		}
	}
}

func (supervisor *Supervisor) resolveCommand() (string, string, error) {
	nodeExec := strings.TrimSpace(supervisor.options.NodeExec)
	if nodeExec == "" {
		nodeExec = strings.TrimSpace(os.Getenv(nodeExecEnv))
	}
	if nodeExec == "" {
		found, err := exec.LookPath("node")
		if err != nil {
			return "", "", fmt.Errorf("找不到 node: %w", err)
		}
		nodeExec = found
	}
	entry := strings.TrimSpace(supervisor.options.EntryFile)
	if entry == "" {
		entry = strings.TrimSpace(os.Getenv(entryFileEnv))
	}
	if entry == "" {
		entry = discoverEntryFile()
	}
	if entry == "" {
		return "", "", fmt.Errorf("找不到 bin/ai-home.js")
	}
	return nodeExec, entry, nil
}

func (supervisor *Supervisor) childEnv() []string {
	overrides := map[string]string{
		"AIH_HOME_DIR":                  supervisor.options.AIHomeDir,
		"AIH_SERVER_HOST":               "127.0.0.1",
		"AIH_SERVER_PORT":               strconv.Itoa(supervisor.port),
		"AIH_SERVER_MANAGEMENT_KEY":     supervisor.options.ManagementKey,
		"AIH_SERVER_API_KEY":            supervisor.options.ClientKey,
		"AIH_GO_CORE_EXTERNAL_URL":      supervisor.options.ExternalURL,
		"AIH_DESKTOP_TRANSLATION_OWNER": "go",
		"AIH_GO_CORE_FRONT_DOOR":        "0",
		"AIH_SERVER_CREDENTIAL_REFRESH": "delegated",
	}
	env := make([]string, 0, len(os.Environ())+len(overrides))
	for _, item := range os.Environ() {
		name, _, found := strings.Cut(item, "=")
		if found {
			if _, override := overrides[name]; override {
				continue
			}
		}
		env = append(env, item)
	}
	for name, value := range overrides {
		env = append(env, name+"="+value)
	}
	return env
}

func (supervisor *Supervisor) logf(format string, args ...any) {
	logf := supervisor.options.Logf
	if logf == nil {
		logf = func(format string, args ...any) { fmt.Fprintf(os.Stderr, format+"\n", args...) }
	}
	logf("[aih:node-supervisor] "+format, args...)
}

func pickFreePort() (int, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer func() { _ = listener.Close() }()
	address, ok := listener.Addr().(*net.TCPAddr)
	if !ok || address.Port <= 0 {
		return 0, errUnavailable
	}
	return address.Port, nil
}

func discoverEntryFile() string {
	candidates := make([]string, 0, 2)
	if executable, err := os.Executable(); err == nil {
		candidates = append(candidates, filepath.Dir(executable))
	}
	if cwd, err := os.Getwd(); err == nil {
		candidates = append(candidates, cwd)
	}
	for _, start := range candidates {
		dir := start
		for depth := 0; depth < 6; depth++ {
			candidate := filepath.Join(dir, "bin", "ai-home.js")
			if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
				return candidate
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	return ""
}

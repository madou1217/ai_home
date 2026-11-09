package webuiterminalapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// DurableState 是 tmux 会话探测结果，与 Node persistentTerminal.probe 的 state 同名。
type DurableState string

const (
	DurableAlive       DurableState = "alive"
	DurableMissing     DurableState = "missing"
	DurableUnavailable DurableState = "unavailable"
)

// DurableProbe 是 probe 的完整结果。
type DurableProbe struct {
	State         DurableState
	MissingBinary bool
	Message       string
}

// DurableSpec 创建 tmux 外层会话所需的最小输入。
type DurableSpec struct {
	File string
	Args []string
	Dir  string
	Env  []string
	Cols int
	Rows int
}

// DurableCreate 是 create 的结果：Durable=false 表示宿主没有 tmux（或 Windows），
// 终端仍可打开，只是不具备跨 Server 重启的恢复能力。
type DurableCreate struct {
	Durable bool
}

// DurableStore 是 sessionKey 到 tmux 外层的管理端口。
type DurableStore interface {
	Probe(key string) DurableProbe
	Create(key string, spec DurableSpec) (DurableCreate, error)
	AttachCommand(key string) (string, []string)
	Close(key string) error
}

// missingDurable 是「宿主没有 tmux」的等价实现：探测报 unavailable，
// 创建退化为非持久会话（与 Node create 在 ENOENT 时的返回一致）。
type missingDurable struct{}

func (missingDurable) Probe(string) DurableProbe {
	return DurableProbe{State: DurableUnavailable, MissingBinary: true}
}

func (missingDurable) Create(string, DurableSpec) (DurableCreate, error) {
	return DurableCreate{Durable: false}, nil
}

func (missingDurable) AttachCommand(string) (string, []string) {
	return "tmux", nil
}

func (missingDurable) Close(string) error { return nil }

// commandResult 是一次外部命令的退出结果。
// err 只表达「命令本身无法执行」（如 tmux 不存在）；非零退出码放在 status。
type commandResult struct {
	output string
	status int
	err    error
}

// commandRunner 允许测试注入外部命令执行。
type commandRunner func(ctx context.Context, name string, args []string, env []string) commandResult

// tmuxStore 是 DurableStore 的生产实现。
//
// 每个 key 独立一个 tmux server（-L socket），继承的环境不会串到别的账号；
// socket 名只由 key 的 sha256 前 32 位决定，跨 Server 重启稳定。
type tmuxStore struct {
	platform string
	lookPath func(string) (string, error)
	run      commandRunner
	getenv   func(string) string
	getuid   func() int
	now      func() time.Time
}

// NewTmuxStore 创建生产 tmux 管理层。
func NewTmuxStore() DurableStore {
	return &tmuxStore{
		platform: runtime.GOOS,
		lookPath: exec.LookPath,
		run:      runCommand,
		getenv:   os.Getenv,
		getuid:   os.Getuid,
		now:      time.Now,
	}
}

func tmuxSocketForKey(key string) string {
	digest := sha256.Sum256([]byte(key))
	return "aih-web-" + hex.EncodeToString(digest[:])[:32]
}

func runCommand(ctx context.Context, name string, args []string, env []string) commandResult {
	commandContext, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	command := exec.CommandContext(commandContext, name, args...)
	command.Env = env
	output, err := command.CombinedOutput()
	result := commandResult{output: strings.TrimSpace(string(output)), err: err}
	var exitError *exec.ExitError
	if errors.As(err, &exitError) {
		result.status = exitError.ExitCode()
		result.err = nil
	}
	if err != nil && !errors.As(err, &exitError) {
		result.status = -1
	}
	return result
}

func (store *tmuxStore) runTmux(socket string, args []string, env []string) commandResult {
	command := append([]string{"-u", "-L", socket}, args...)
	return store.run(context.Background(), "tmux", command, env)
}

func (store *tmuxStore) Probe(key string) DurableProbe {
	if key == "" {
		return DurableProbe{State: DurableMissing}
	}
	if store.platform == "windows" {
		return DurableProbe{State: DurableMissing}
	}
	result := store.runTmux(tmuxSocketForKey(key), []string{"has-session", "-t", "=web"}, nil)
	if result.err != nil && errors.Is(result.err, exec.ErrNotFound) {
		return DurableProbe{State: DurableUnavailable, MissingBinary: true}
	}
	if result.err == nil && result.status == 0 {
		return DurableProbe{State: DurableAlive}
	}
	if result.err == nil && result.status == 1 && looksLikeMissingSession(result.output) {
		return DurableProbe{State: DurableMissing}
	}
	return DurableProbe{State: DurableUnavailable, Message: result.output}
}

func looksLikeMissingSession(output string) bool {
	lower := strings.ToLower(output)
	for _, marker := range []string{"no server running", "no such file or directory", "can't find session"} {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}

func (store *tmuxStore) Create(key string, spec DurableSpec) (DurableCreate, error) {
	if key == "" || store.platform == "windows" {
		return DurableCreate{Durable: false}, nil
	}
	if _, err := store.lookPath("tmux"); err != nil {
		return DurableCreate{Durable: false}, nil
	}
	socket := tmuxSocketForKey(key)
	tmuxArgs := []string{
		"-u", "-L", socket, "-f", "/dev/null", "new-session", "-d", "-s", "web",
		"-c", spec.Dir, "-x", strconv.Itoa(spec.Cols), "-y", strconv.Itoa(spec.Rows),
		// Web 终端的 tmux 是传输层，不是用户的 tmux 会话；清掉 pane 里的 TMUX 标记，
		// 让 aih CLI 能启动自己独立的交互式 tmux 而不被判成嵌套会话。
		"--", "env", "-u", "TMUX", spec.File,
	}
	tmuxArgs = append(tmuxArgs, spec.Args...)

	// systemd 托管的 Server 用独立 user scope 启动 tmux，重启 Server 只断开 attach 客户端。
	launcher := detachedLauncher(store.platform, store.getenv, store.getuid)
	attemptedLauncher := launcher != nil
	var result commandResult
	if launcher != nil {
		unit := "aih-web-" + socket[8:24] + "-" + strconv.FormatInt(store.now().UnixMilli(), 36)
		args := append([]string(nil), launcher.Prefix...)
		args = append(args, "--unit="+unit, "tmux")
		args = append(args, tmuxArgs...)
		environment := setEnv(append([]string(nil), spec.Env...), "XDG_RUNTIME_DIR", launcher.RuntimeDir)
		result = store.run(context.Background(), launcher.File, args, environment)
	}
	// systemd-run 不可用（容器里没有 user bus 等）时退回直接启动：
	// 仍可用，只是不跨 Server 重启。
	if !attemptedLauncher || result.err != nil || result.status != 0 {
		result = store.run(context.Background(), "tmux", tmuxArgs, spec.Env)
	}
	if result.err != nil && errors.Is(result.err, exec.ErrNotFound) {
		return DurableCreate{Durable: false}, nil
	}
	if result.err != nil || result.status != 0 {
		message := result.output
		if message == "" && result.err != nil {
			message = result.err.Error()
		}
		return DurableCreate{}, errors.New("persistent_terminal_unavailable: " + message)
	}
	store.runTmux(socket, []string{"set-option", "-g", "status", "off"}, nil)
	store.runTmux(socket, []string{"set-option", "-g", "escape-time", "0"}, nil)
	store.runTmux(socket, []string{"set-option", "-gq", "extended-keys", "on"}, nil)
	return DurableCreate{Durable: true}, nil
}

func (store *tmuxStore) AttachCommand(key string) (string, []string) {
	return "tmux", []string{"-u", "-L", tmuxSocketForKey(key), "attach-session", "-t", "=web"}
}

func (store *tmuxStore) Close(key string) error {
	if key == "" || store.platform == "windows" {
		return nil
	}
	result := store.runTmux(tmuxSocketForKey(key), []string{"kill-session", "-t", "=web"}, nil)
	if result.err == nil && result.status == 0 {
		return nil
	}
	if store.Probe(key).State == DurableMissing {
		return nil
	}
	return errors.New("persistent_terminal_unavailable")
}

// detachedLauncher 在 systemd 托管的 Server 上把 tmux server 放进独立的 user scope。
//
// 原因：KillMode=control-group 重启时会杀光自己 cgroup 里的所有进程，包括 tmux
// server；Server 一重启所有 Web 终端都没了。launchd / 前台进程没有这个问题，保持原样。
type detachedSpec struct {
	File       string
	Prefix     []string
	RuntimeDir string
}

func detachedLauncher(platform string, getenv func(string) string, getuid func() int) *detachedSpec {
	if platform != "linux" || getenv == nil || strings.TrimSpace(getenv("INVOCATION_ID")) == "" {
		return nil
	}
	runtimeDir := strings.TrimSpace(getenv("XDG_RUNTIME_DIR"))
	if runtimeDir == "" && getuid != nil {
		if uid := getuid(); uid >= 0 {
			runtimeDir = fmt.Sprintf("/run/user/%d", uid)
		}
	}
	if runtimeDir == "" {
		return nil
	}
	return &detachedSpec{
		File:       "systemd-run",
		Prefix:     []string{"--user", "--scope", "--quiet", "--collect"},
		RuntimeDir: runtimeDir,
	}
}

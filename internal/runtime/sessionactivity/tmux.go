package sessionactivity

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const (
	tmuxSocketPrefix       = "aih"
	tmuxListSeparator      = "\x1f"
	defaultTmuxCmdTimeout  = 1200 * time.Millisecond
)

var (
	nonSafeTmuxKeyPartPattern = regexp.MustCompile(`[^A-Za-z0-9._-]+`)
	leadingTrailingDashRe     = regexp.MustCompile(`^-+|-+$`)
	tmuxFormatString          = strings.Join([]string{
		"#{session_name}",
		"#{session_attached}",
		"#{session_created}",
		"#{session_path}",
		"#{pane_title}",
		"#{window_name}",
		"#{pane_current_command}",
		"#{pane_pid}",
		"#{E:AIH_RUNTIME_MARKER}",
		"#{pane_dead}",
		"#{pane_current_path}",
		"#{E:AIH_CODEX_FLAGS}",
		"#{window_activity}",
		"#{session_activity}",
	}, tmuxListSeparator)
)

// TmuxDetectResult 描述当前宿主环境中 tmux 的可用性。
type TmuxDetectResult struct {
	Available bool
	Command   string
}

// TmuxSession 表示从 tmux list-sessions 解析出的单个持久会话行。
type TmuxSession struct {
	Name             string
	Attached         bool
	CreatedAtMS      int64
	Path             string
	StartPath        string
	Title            string
	WindowName       string
	Command          string
	PanePID          int
	PaneDead         bool
	LastActivityAtMS int64
	LastActiveAtMS   int64
}

// TmuxRunner 抽象了 tmux 检测与按账号列出持久会话的外部进程调用，便于测试注入。
type TmuxRunner interface {
	Detect(ctx context.Context) TmuxDetectResult
	ListSessionsForAccount(ctx context.Context, tmuxCmd, provider, accountRef string, includeDetached bool) []TmuxSession
}

// OSTmuxRunner 使用宿主机实际 tmux 二进制执行持久会话查询。
type OSTmuxRunner struct {
	Platform  string
	LookPath  func(file string) (string, error)
	Getenv    func(key string) string
	UID       func() int
	Stat      func(path string) (os.FileInfo, error)
	ExecCmd   func(ctx context.Context, command string, args ...string) (string, error)
	CmdTimeout time.Duration
}

// NewOSTmuxRunner 创建基于系统 tmux 的探测运行器。
func NewOSTmuxRunner() *OSTmuxRunner {
	return &OSTmuxRunner{
		Platform:   runtime.GOOS,
		LookPath:   exec.LookPath,
		Getenv:     os.Getenv,
		UID:        os.Getuid,
		Stat:       os.Stat,
		CmdTimeout: defaultTmuxCmdTimeout,
		ExecCmd: func(ctx context.Context, command string, args ...string) (string, error) {
			cmd := exec.CommandContext(ctx, command, args...)
			var stdout bytes.Buffer
			cmd.Stdout = &stdout
			err := cmd.Run()
			return stdout.String(), err
		},
	}
}

func (runner *OSTmuxRunner) timeout() time.Duration {
	if runner != nil && runner.CmdTimeout > 0 {
		return runner.CmdTimeout
	}
	return defaultTmuxCmdTimeout
}

// Detect 检查宿主机是否已安装可执行 tmux。
func (runner *OSTmuxRunner) Detect(ctx context.Context) TmuxDetectResult {
	lookPath := exec.LookPath
	if runner != nil && runner.LookPath != nil {
		lookPath = runner.LookPath
	}
	cmdPath, err := lookPath("tmux")
	if err != nil || strings.TrimSpace(cmdPath) == "" {
		return TmuxDetectResult{}
	}
	execFn := runner.ExecCmd
	if execFn == nil {
		execFn = NewOSTmuxRunner().ExecCmd
	}
	runCtx, cancel := context.WithTimeout(ctx, runner.timeout())
	defer cancel()
	out, err := execFn(runCtx, cmdPath, "-V")
	if err != nil || strings.TrimSpace(out) == "" {
		return TmuxDetectResult{}
	}
	return TmuxDetectResult{
		Available: true,
		Command:   cmdPath,
	}
}

// ListSessionsForAccount 列出某 (provider, accountRef) 持久 tmux socket 下的存活会话。
func (runner *OSTmuxRunner) ListSessionsForAccount(
	ctx context.Context,
	tmuxCmd, provider, accountRef string,
	includeDetached bool,
) []TmuxSession {
	socket, ok := DeriveTmuxSocket(provider, accountRef)
	if !ok {
		return nil
	}
	if runner.socketMissing(socket) {
		return nil
	}
	command := strings.TrimSpace(tmuxCmd)
	if command == "" {
		command = "tmux"
	}
	execFn := runner.ExecCmd
	if execFn == nil {
		execFn = NewOSTmuxRunner().ExecCmd
	}
	runCtx, cancel := context.WithTimeout(ctx, runner.timeout())
	defer cancel()
	stdout, err := execFn(runCtx, command, "-u", "-L", socket, "list-sessions", "-F", tmuxFormatString)
	if err != nil && strings.TrimSpace(stdout) == "" {
		return nil
	}
	sessions := ParseTmuxSessionList(stdout)
	filtered := make([]TmuxSession, 0, len(sessions))
	for _, s := range sessions {
		if includeDetached {
			if !s.PaneDead {
				filtered = append(filtered, s)
			}
		} else if s.Attached {
			filtered = append(filtered, s)
		}
	}
	return filtered
}

func (runner *OSTmuxRunner) socketMissing(socket string) bool {
	platform := runtime.GOOS
	if runner != nil && strings.TrimSpace(runner.Platform) != "" {
		platform = runner.Platform
	}
	if platform == "windows" {
		return false
	}
	uidFn := os.Getuid
	if runner != nil && runner.UID != nil {
		uidFn = runner.UID
	}
	uid := uidFn()
	if uid < 0 {
		return false
	}
	getenv := os.Getenv
	if runner != nil && runner.Getenv != nil {
		getenv = runner.Getenv
	}
	base := strings.TrimSpace(getenv("TMUX_TMPDIR"))
	if base == "" {
		base = "/tmp"
	}
	statFn := os.Stat
	if runner != nil && runner.Stat != nil {
		statFn = runner.Stat
	}
	socketPath := filepath.Join(base, fmt.Sprintf("tmux-%d", uid), socket)
	_, err := statFn(socketPath)
	return err != nil
}

// DeriveTmuxSocket 依据 provider 与作用域生成 tmux -L socket 名。
func DeriveTmuxSocket(provider, runtimeScope string) (string, bool) {
	p := sanitizeTmuxKeyPart(provider)
	scope := sanitizeTmuxKeyPart(runtimeScope)
	if p == "" || scope == "" {
		return "", false
	}
	return tmuxSocketPrefix + "-" + p + "-" + scope, true
}

func sanitizeTmuxKeyPart(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return ""
	}
	cleaned := nonSafeTmuxKeyPartPattern.ReplaceAllString(trimmed, "-")
	return leadingTrailingDashRe.ReplaceAllString(cleaned, "")
}

// ParseTmuxSessionList 解析 tmux list-sessions 输出（兼容 14 字段与旧版 15+ 字段）。
func ParseTmuxSessionList(stdout string) []TmuxSession {
	lines := strings.Split(stdout, "\n")
	out := make([]TmuxSession, 0, len(lines))
	for _, rawLine := range lines {
		line := strings.TrimSuffix(rawLine, "\r")
		if strings.TrimSpace(line) == "" {
			continue
		}
		var parts []string
		if strings.Contains(line, tmuxListSeparator) {
			parts = strings.Split(line, tmuxListSeparator)
		} else {
			parts = strings.Split(line, "\t")
		}
		var (
			name            string
			attachedRaw     string
			createdRaw      string
			sessionPath     string
			title           string
			windowName      string
			command         string
			panePIDRaw      string
			paneDeadRaw     string
			paneCurrentPath string
			windowActRaw    string
			sessionActRaw   string
		)
		if len(parts) >= 15 {
			name = parts[0]
			attachedRaw = parts[1]
			createdRaw = parts[2]
			sessionPath = parts[3]
			title = parts[4]
			windowName = parts[5]
			command = parts[6]
			panePIDRaw = parts[7]
			paneDeadRaw = parts[10]
			paneCurrentPath = parts[12]
		} else {
			at := func(idx int) string {
				if idx >= 0 && idx < len(parts) {
					return parts[idx]
				}
				return ""
			}
			name = at(0)
			attachedRaw = at(1)
			createdRaw = at(2)
			sessionPath = at(3)
			title = at(4)
			windowName = at(5)
			command = at(6)
			panePIDRaw = at(7)
			paneDeadRaw = at(9)
			paneCurrentPath = at(10)
			windowActRaw = at(12)
			sessionActRaw = at(13)
		}
		trimmedName := strings.TrimSpace(name)
		if trimmedName == "" {
			continue
		}
		createdSec, _ := strconv.ParseInt(strings.TrimSpace(createdRaw), 10, 64)
		panePID, _ := strconv.Atoi(strings.TrimSpace(panePIDRaw))
		windowActSec, _ := strconv.ParseInt(strings.TrimSpace(windowActRaw), 10, 64)
		sessionActSec, _ := strconv.ParseInt(strings.TrimSpace(sessionActRaw), 10, 64)

		var lastActMS int64
		if windowActSec > 0 {
			lastActMS = windowActSec * 1000
		}
		maxActSec := max(windowActSec, sessionActSec)
		var lastActiveMS int64
		if maxActSec > 0 {
			lastActiveMS = maxActSec * 1000
		}
		displayPath := strings.TrimSpace(paneCurrentPath)
		if displayPath == "" {
			displayPath = strings.TrimSpace(sessionPath)
		}
		out = append(out, TmuxSession{
			Name:             trimmedName,
			Attached:         strings.TrimSpace(attachedRaw) != "0" && strings.TrimSpace(attachedRaw) != "",
			CreatedAtMS:      max(int64(0), createdSec) * 1000,
			Path:             displayPath,
			StartPath:        strings.TrimSpace(sessionPath),
			Title:            compactSingleLineText(title),
			WindowName:       compactSingleLineText(windowName),
			Command:          compactSingleLineText(command),
			PanePID:          panePID,
			PaneDead:         strings.TrimSpace(paneDeadRaw) == "1",
			LastActivityAtMS: lastActMS,
			LastActiveAtMS:   lastActiveMS,
		})
	}
	return out
}

func compactSingleLineText(value string) string {
	replaced := strings.NewReplacer("\r", " ", "\n", " ", "\t", " ").Replace(value)
	fields := strings.Fields(replaced)
	joined := strings.Join(fields, " ")
	if len(joined) > 120 {
		return joined[:120]
	}
	return joined
}

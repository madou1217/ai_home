package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/persistent"
	"github.com/madou1217/ai_home/internal/runtime/sessionproject"
)

// runGlobalSessionTarget 实现 aih ss <名字>：先按名字/前缀/描述匹配，命中且活着
// 就直接 attach 到该 tmux 会话；已结束的会话提示用 resume 续接（重启语义仍属 Node）。
func runGlobalSessionTarget(
	ctx context.Context,
	target string,
	runtime commandRuntime,
	allProjects ...bool,
) error {
	if projectPath, ok := resolveSessionProjectTarget(target, runtime); ok {
		return runSessionProjectPicker(ctx, projectPath, runtime)
	}
	rows, err := collectGlobalRows(ctx, runtime, allProjects...)
	if err != nil {
		return err
	}
	matched, ambiguous := matchGlobalSession(rows, target)
	if matched == nil {
		if len(ambiguous) == 0 {
			return fmt.Errorf("%w: 没有匹配的会话：%s", errInvalidCommand, target)
		}
		_, _ = fmt.Fprintf(runtime.stderr, "「%s」匹配到 %d 个会话，再具体一点：\n", target, len(ambiguous))
		for _, row := range ambiguous {
			_, _ = fmt.Fprintf(runtime.stderr, "  %s  %s\n", row.Name, globalSessionTitle(row))
		}
		return fmt.Errorf("%w: 会话名不唯一", errInvalidCommand)
	}
	if matched.NativeOnly {
		return launchNativeSession(ctx, *matched, runtime)
	}
	if !matched.Live {
		return fmt.Errorf(
			"%w: 会话 %s 已结束；用 aih %s resume %s 续接",
			errInvalidCommand,
			matched.Name,
			matched.Provider,
			matched.Name,
		)
	}
	if !terminalWriterIsTTY(runtime.stdout) {
		return fmt.Errorf("%w: 进入会话需要真实终端", errInvalidCommand)
	}
	return attachPersistentSession(ctx, *matched, runtime)
}

// resolveSessionProjectTarget 识别 aih ss <目录>：绝对路径、~/ 或 ./
// 开头的目录才算路径，避免把普通会话名误判成相对目录。
func resolveSessionProjectTarget(target string, runtime commandRuntime) (string, bool) {
	text := strings.TrimSpace(target)
	if text == "" {
		return "", false
	}
	home := ""
	if value, err := runtime.userHomeDir(); err == nil {
		home = strings.TrimSpace(value)
	}
	if strings.HasPrefix(text, "~/") && home != "" {
		text = filepath.Join(home, strings.TrimPrefix(text, "~/"))
	}
	if !filepath.IsAbs(text) {
		if !strings.HasPrefix(text, "./") && !strings.HasPrefix(text, "../") {
			return "", false
		}
		cwd, err := os.Getwd()
		if err != nil {
			return "", false
		}
		text = filepath.Join(cwd, text)
	}
	info, err := os.Stat(text)
	if err != nil || !info.IsDir() {
		return "", false
	}
	return filepath.Clean(text), true
}

// runSessionProjectPicker 只展示某个目录下的会话；从 $HOME 通过 Tab 补全
// 选中路径后，Enter 仍会按会话所属项目启动。
func runSessionProjectPicker(ctx context.Context, projectPath string, runtime commandRuntime) error {
	store, err := globalSessionStore(runtime)
	if err != nil {
		return err
	}
	base := pickerStore{store: store, runtime: runtime, allProjects: true}
	source := pathPickerStore{base: base, path: projectPath}
	rows, err := source.Rows(ctx)
	if err != nil {
		return err
	}
	if len(rows) == 0 {
		return fmt.Errorf("%w: 目录没有会话：%s", errInvalidCommand, projectPath)
	}
	labels := collectGlobalLabels(ctx, rows, runtime)
	if !terminalWriterIsTTY(runtime.stdin) || !terminalWriterIsTTY(runtime.stdout) {
		writeGlobalSessionGroups(runtime.stdout, rows, labels)
		return nil
	}
	return runSessionPicker(ctx, runtime, source, rows, labels)
}

type pathPickerStore struct {
	base pickerStore
	path string
}

func (source pathPickerStore) Rows(ctx context.Context) ([]persistent.SessionRow, error) {
	rows, err := source.base.Rows(ctx)
	if err != nil {
		return nil, err
	}
	selected := make([]persistent.SessionRow, 0, len(rows))
	for _, row := range rows {
		if sessionproject.MatchesCwd(sessionProjectPath(row), source.path) {
			selected = append(selected, row)
		}
	}
	return selected, nil
}

func (source pathPickerStore) Close(ctx context.Context, row persistent.SessionRow) error {
	return source.base.Close(ctx, row)
}

func (source pathPickerStore) Dismiss(ctx context.Context, row persistent.SessionRow) error {
	return source.base.Dismiss(ctx, row)
}

// launchNativeSession 进入没有 tmux pane 的原生 Provider 会话。
func launchNativeSession(ctx context.Context, row persistent.SessionRow, runtime commandRuntime) error {
	provider := strings.TrimSpace(row.Provider)
	threadID := strings.TrimSpace(row.NativeID)
	if provider == "" || threadID == "" {
		return fmt.Errorf("%w: 原生会话身份缺失", errInvalidCommand)
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	command := exec.CommandContext(ctx, executable, provider, "resume", threadID)
	command.Dir = sessionEnterDirectory(row)
	command.Stdin = runtime.stdin
	command.Stdout = runtime.stdout
	command.Stderr = runtime.stderr
	command.Env = os.Environ()
	if err := command.Run(); err != nil {
		return fmt.Errorf("进入原生会话 %s 失败: %w", threadID, err)
	}
	return nil
}

// attachPersistentSession 用 tmux attach-session 接回已存在的持久会话；父进程
// 不再包输入循环，终端语义完全交给 tmux。
func attachPersistentSession(
	ctx context.Context,
	row persistent.SessionRow,
	runtime commandRuntime,
) error {
	command := exec.CommandContext(ctx, "tmux", persistentAttachArgs(row)...)
	command.Dir = sessionEnterDirectory(row)
	command.Stdin = runtime.stdin
	command.Stdout = runtime.stdout
	command.Stderr = runtime.stderr
	command.Env = withoutTmuxClientEnv(os.Environ())
	if err := command.Run(); err != nil {
		return fmt.Errorf("进入会话 %s 失败: %w", row.Name, err)
	}
	return nil
}

// sessionEnterDirectory 让进入动作先落到会话所属项目：从 $HOME 选中会话
// 时，原生 resume 和 provider 的相对路径都必须在项目根下执行，不能沿用
// 选择器启动时的目录。目录不存在时返回空串，保留当前 cwd。
func sessionEnterDirectory(row persistent.SessionRow) string {
	project := sessionProjectPath(row)
	if project == "" || project == "-" {
		return ""
	}
	info, err := os.Stat(project)
	if err != nil || !info.IsDir() {
		return ""
	}
	return project
}

// persistentAttachArgs 与 Node buildTmuxBaseArgs + attach-session 逐字对齐。
func persistentAttachArgs(row persistent.SessionRow) []string {
	return []string{
		"-u", "-L", row.Socket,
		"attach-session", "-d",
		"-t", row.Name,
	}
}

// withoutTmuxClientEnv 去掉外层 tmux 变量，避免 attach 变成嵌套客户端。
func withoutTmuxClientEnv(environment []string) []string {
	result := make([]string, 0, len(environment))
	for _, entry := range environment {
		name, _, found := strings.Cut(entry, "=")
		if found && (name == "TMUX" || name == "TMUX_PANE") {
			continue
		}
		result = append(result, entry)
	}
	return result
}

// matchGlobalSession 复刻 Node matchGlobalSessionTarget：精确名 → 唯一前缀 →
// 唯一描述包含；多义时返回候选而不是随便挑一个。
func matchGlobalSession(
	rows []persistent.SessionRow,
	target string,
) (*persistent.SessionRow, []persistent.SessionRow) {
	wanted := strings.ToLower(strings.TrimSpace(target))
	if wanted == "" {
		return nil, nil
	}
	for index := range rows {
		if strings.ToLower(strings.TrimSpace(rows[index].Name)) == wanted {
			return &rows[index], nil
		}
		// 原生会话允许直接粘贴完整 session id（列表的「会话ID」列）。
		if rows[index].NativeOnly && strings.ToLower(strings.TrimSpace(rows[index].NativeID)) == wanted {
			return &rows[index], nil
		}
	}
	prefixMatches := make([]persistent.SessionRow, 0)
	for _, row := range rows {
		if strings.HasPrefix(strings.ToLower(strings.TrimSpace(row.Name)), wanted) {
			prefixMatches = append(prefixMatches, row)
		}
	}
	if len(prefixMatches) == 1 {
		return &prefixMatches[0], nil
	}
	if len(prefixMatches) > 1 {
		return nil, prefixMatches
	}
	descriptionMatches := make([]persistent.SessionRow, 0)
	for _, row := range rows {
		description := strings.ToLower(globalSessionTitle(row))
		if description != "-" && strings.Contains(description, wanted) {
			descriptionMatches = append(descriptionMatches, row)
		}
	}
	if len(descriptionMatches) == 1 {
		return &descriptionMatches[0], nil
	}
	if len(descriptionMatches) > 1 {
		return nil, descriptionMatches
	}
	return nil, nil
}

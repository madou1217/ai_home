package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/persistent"
)

// runGlobalSessionTarget 实现 aih ss <名字>：先按名字/前缀/描述匹配，命中且活着
// 就直接 attach 到该 tmux 会话；已结束的会话提示用 resume 续接（重启语义仍属 Node）。
func runGlobalSessionTarget(
	ctx context.Context,
	target string,
	runtime commandRuntime,
) error {
	rows, err := collectGlobalRows(ctx, runtime)
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

// attachPersistentSession 用 tmux attach-session 接回已存在的持久会话；父进程
// 不再包输入循环，终端语义完全交给 tmux。
func attachPersistentSession(
	ctx context.Context,
	row persistent.SessionRow,
	runtime commandRuntime,
) error {
	command := exec.CommandContext(ctx, "tmux", persistentAttachArgs(row)...)
	command.Stdin = runtime.stdin
	command.Stdout = runtime.stdout
	command.Stderr = runtime.stderr
	command.Env = withoutTmuxClientEnv(os.Environ())
	if err := command.Run(); err != nil {
		return fmt.Errorf("进入会话 %s 失败: %w", row.Name, err)
	}
	return nil
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

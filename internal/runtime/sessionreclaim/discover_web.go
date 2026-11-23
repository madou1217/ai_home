package sessionreclaim

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

// webTerminalSocketPrefix 是 Web 终端 tmux server 的 socket 前缀
// （webuiterminalapi/tmux.go 的 aih-web-<hash>）。
const webTerminalSocketPrefix = "aih-web-"

// discoverWebSessions 枚举 AIH 自己创建的 Web 终端 tmux 会话。
//
// 这些会话不写入 run/persistent-sessions 注册表，旧的回收器因此永远看不到它们：
// 2026-11-23 的 AWS 事故里，aih codex / agy 进程就是挂在这样的 tmux 会话下，
// 运行了十几小时也没人回收。这里把它们并入同一套四证据判定。
func discoverWebSessions(ctx context.Context) []Session {
	if runtime.GOOS == "windows" {
		return nil
	}
	dir := tmuxSocketDir()
	if dir == "" {
		return nil
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	sessions := make([]Session, 0, len(entries))
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return sessions
		}
		name := entry.Name()
		if !strings.HasPrefix(name, webTerminalSocketPrefix) {
			continue
		}
		fullPath := filepath.Join(dir, name)
		info, statErr := os.Lstat(fullPath)
		if statErr != nil || info.Mode()&os.ModeSocket == 0 {
			continue
		}
		output, runErr := runShort(ctx, "tmux", "-L", name, "list-sessions", "-F",
			"#{session_name}\t#{session_activity}\t#{session_created}")
		if runErr != nil {
			continue
		}
		for _, line := range strings.Split(strings.TrimSpace(output), "\n") {
			fields := strings.Split(line, "\t")
			if len(fields) < 3 {
				continue
			}
			sessionName := strings.TrimSpace(fields[0])
			if sessionName == "" {
				continue
			}
			activity := parseUnixSeconds(fields[1])
			if activity <= 0 {
				activity = parseUnixSeconds(fields[2])
			}
			cwd := ""
			if pathOutput, pathErr := runShort(ctx, "tmux", "-L", name, "display-message", "-p",
				"-t", sessionName, "#{pane_current_path}"); pathErr == nil {
				cwd = strings.TrimSpace(pathOutput)
			}
			updatedAt := int64(0)
			if activity > 0 {
				updatedAt = activity * 1000
			}
			sessions = append(sessions, Session{
				Provider:  "web-terminal",
				Socket:    name,
				Name:      sessionName,
				Cwd:       cwd,
				UpdatedAt: updatedAt,
			})
		}
	}
	return sessions
}

// tmuxSocketDir 与 tmux 自身的规则一致：TMUX_TMPDIR 覆盖 /tmp；
// 隔离验收因此可以用独立目录，不触碰真实终端会话。
func tmuxSocketDir() string {
	base := strings.TrimSpace(os.Getenv("TMUX_TMPDIR"))
	if base == "" {
		base = "/tmp"
	}
	return filepath.Join(base, fmt.Sprintf("tmux-%d", os.Getuid()))
}

func parseUnixSeconds(value string) int64 {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return 0
	}
	seconds, err := strconv.ParseInt(trimmed, 10, 64)
	if err != nil || seconds <= 0 {
		return 0
	}
	return seconds
}

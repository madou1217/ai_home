package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/persistent"
)

// attachCodexTmuxIfRunning 在 `aih codex resume <thread>` 时先找同一个
// NativeID 的 aih tmux 会话；命中就 attach，不再启动第二个 writer。
func attachCodexTmuxIfRunning(ctx context.Context, runtime commandRuntime, threadID string) (bool, error) {
	threadID = strings.TrimSpace(threadID)
	if threadID == "" {
		return false, nil
	}
	aiHomeDir, err := resolveAIHomeDir(runtime)
	if err != nil || strings.TrimSpace(aiHomeDir) == "" {
		return false, nil
	}
	socket, name, found := findCodexTmuxSession(aiHomeDir, threadID)
	if !found {
		return false, nil
	}
	tmuxPath, err := exec.LookPath("tmux")
	if err != nil {
		return false, nil
	}
	// 缓存/注册表可能过期；只有 tmux 里真的存在该 session 才 attach。
	if err := exec.CommandContext(ctx, tmuxPath, "-L", socket, "has-session", "-t", "="+name).Run(); err != nil {
		return false, nil
	}
	if output, err := exec.CommandContext(ctx, tmuxPath, "-L", socket, "display-message", "-p", "-t", "="+name, "#{pane_dead}").Output(); err == nil && strings.TrimSpace(string(output)) == "1" {
		return false, nil
	}
	_, _ = fmt.Fprintf(runtime.stderr, "[aih] thread %s 已在 tmux 会话 %s/%s 中运行，正在 attach\n", threadID, socket, name)
	command := exec.CommandContext(ctx, tmuxPath, "-L", socket, "attach-session", "-t", "="+name)
	command.Stdin = runtime.stdin
	command.Stdout = runtime.stdout
	command.Stderr = runtime.stderr
	command.Env = withoutTmuxClientEnv(os.Environ())
	return true, command.Run()
}

func findCodexTmuxSession(aiHomeDir, threadID string) (string, string, bool) {
	for _, entry := range persistent.ReadSessionCache(aiHomeDir, time.Now()) {
		if strings.TrimSpace(entry.AgentSessionID) != threadID || strings.TrimSpace(entry.Socket) == "" || !strings.EqualFold(entry.Provider, "codex") {
			continue
		}
		if strings.TrimSpace(entry.Name) != "" {
			return strings.TrimSpace(entry.Socket), strings.TrimSpace(entry.Name), true
		}
	}
	registry, err := persistent.NewRegistry(filepath.Join(filepath.Clean(aiHomeDir), "run"))
	if err != nil {
		return "", "", false
	}
	entries, err := registry.List(context.Background())
	if err != nil {
		return "", "", false
	}
	for _, entry := range entries {
		if !strings.EqualFold(entry.Provider, "codex") || strings.TrimSpace(entry.NativeID) != threadID {
			continue
		}
		if strings.TrimSpace(entry.Socket) != "" && strings.TrimSpace(entry.Session) != "" {
			return strings.TrimSpace(entry.Socket), strings.TrimSpace(entry.Session), true
		}
	}
	return "", "", false
}

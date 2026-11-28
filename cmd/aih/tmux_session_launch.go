package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/persistent"
)

// maybeRunInTmux 把交互式 provider/harness 启动包进一个 tmux 持久会话。
// 只包装真正的交互启动：models/sessions/help/exec/登录等管理或一次性命令
// 继续走原生路径；ss 只读，永远不会调用这里。
func maybeRunInTmux(
	ctx context.Context,
	runtime commandRuntime,
	category string,
	commandArgs []string,
) (bool, error) {
	if !shouldWrapInTmux(runtime, category, commandArgs) {
		return false, nil
	}
	if _, found := runtime.lookupEnv("AIH_TMUX_DRY_RUN"); found {
		_, _ = fmt.Fprintf(runtime.stderr, "[aih] tmux dry-run: %s %s\n", category, strings.Join(commandArgs, " "))
		return true, nil
	}
	tmuxPath, err := exec.LookPath("tmux")
	if err != nil {
		return false, nil
	}
	exe, err := os.Executable()
	if err != nil {
		return false, nil
	}
	cwd, err := os.Getwd()
	if err != nil {
		return false, nil
	}
	aiHomeDir, err := resolveAIHomeDir(runtime)
	if err != nil {
		return false, nil
	}
	category = sanitizeTMUXPart(category)
	if category == "" {
		return false, nil
	}
	socket := "aih-tmux-" + category
	name := "p-" + sanitizeTMUXPart(filepath.Base(cwd)) + "-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	if len(name) > 60 {
		name = name[:60]
	}

	registry, registryErr := persistent.NewRegistry(filepath.Join(filepath.Clean(aiHomeDir), "run"))
	if registryErr == nil {
		if writeErr := registry.Write(ctx, persistent.Entry{
			Provider:     category,
			RuntimeScope: "gateway",
			Gateway:      true,
			Socket:       socket,
			Session:      name,
			CWD:          cwd,
			Label:        category,
			CreatedAt:    time.Now(),
		}); writeErr != nil {
			return false, fmt.Errorf("登记 tmux 会话失败: %w", writeErr)
		}
	}

	inner := append([]string{exe}, commandArgs...)
	shellCommand := "env AIH_TMUX_WRAPPED=1 " + shellJoin(inner)
	start := exec.CommandContext(ctx, tmuxPath, "-L", socket, "new-session", "-d", "-s", name, "-c", cwd, shellCommand)
	start.Stdout = runtime.stdout
	start.Stderr = runtime.stderr
	if err := start.Run(); err != nil {
		if registry != nil {
			_ = registry.Remove(context.Background(), socket, name)
		}
		return true, fmt.Errorf("创建 tmux 会话失败: %w", err)
	}
	defer func() {
		if registry == nil {
			return
		}
		check := exec.Command(tmuxPath, "-L", socket, "has-session", "-t", "="+name)
		if check.Run() != nil {
			_ = registry.Remove(context.Background(), socket, name)
		}
	}()

	attach := exec.CommandContext(ctx, tmuxPath, "-L", socket, "attach-session", "-t", "="+name)
	attach.Stdin = runtime.stdin
	attach.Stdout = runtime.stdout
	attach.Stderr = runtime.stderr
	if err := attach.Run(); err != nil {
		return true, err
	}
	return true, nil
}

func shouldWrapInTmux(runtime commandRuntime, category string, commandArgs []string) bool {
	if strings.TrimSpace(category) == "" || len(commandArgs) == 0 {
		return false
	}
	if !terminalWriterIsTTY(runtime.stdin) || !terminalWriterIsTTY(runtime.stdout) {
		return false
	}
	if value, found := runtime.lookupEnv("TMUX"); found && strings.TrimSpace(value) != "" {
		return false
	}
	if value, found := runtime.lookupEnv("AIH_TMUX_WRAPPED"); found && strings.TrimSpace(value) != "" {
		return false
	}
	if value, found := runtime.lookupEnv("AIH_NO_TMUX"); found && strings.TrimSpace(value) != "" {
		return false
	}
	if value, found := runtime.lookupEnv("AIH_NO_PERSIST"); found && strings.TrimSpace(value) != "" {
		return false
	}
	for _, argument := range commandArgs {
		switch strings.ToLower(strings.TrimSpace(argument)) {
		case "--help", "-h", "help", "--version", "-v", "--json", "models", "sessions", "ss", "login", "logout", "account", "config", "update", "install", "--desktop", "--print", "-p", "exec", "app-server", "mcp", "mcp-server", "serve", "apply", "completion", "proto", "list", "adapters", "--plan", "--dry-run":
			return false
		}
	}
	return true
}

func shellJoin(values []string) string {
	quoted := make([]string, 0, len(values))
	for _, value := range values {
		quoted = append(quoted, "'"+strings.ReplaceAll(value, "'", `'\''`)+"'")
	}
	return strings.Join(quoted, " ")
}

func sanitizeTMUXPart(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	var builder strings.Builder
	for _, char := range value {
		if (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') || char == '-' || char == '_' || char == '.' {
			builder.WriteRune(char)
		}
	}
	return builder.String()
}

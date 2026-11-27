//go:build !windows

package providersessionhook

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

// invokingHarness 沿父进程链找出真正调用 hook 的 harness。
//
// Grok 会同时扫描 ~/.claude/settings.json 并执行 Claude 的托管 hook；只靠
// --provider 参数会把同一次 Grok 会话同时记成 claude 与 grok 两份身份。
// 这里按真实祖先进程判定，provider 与 harness 不一致时由 Run 跳过投递。
func invokingHarness() string {
	pid := os.Getppid()
	for depth := 0; depth < 5 && pid > 1; depth++ {
		output, err := exec.Command("ps", "-o", "ppid=,comm=", "-p", strconv.Itoa(pid)).Output()
		if err != nil {
			return ""
		}
		fields := strings.Fields(string(output))
		if len(fields) < 2 {
			return ""
		}
		if name := harnessName(filepath.Base(fields[1])); name != "" {
			return name
		}
		next, err := strconv.Atoi(fields[0])
		if err != nil || next <= 0 {
			return ""
		}
		pid = next
	}
	return ""
}

func harnessName(comm string) string {
	name := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(comm), ".exe"))
	switch {
	case strings.Contains(name, "codebuddycn"):
		return "codebuddycn"
	case strings.Contains(name, "codebuddy"):
		return "codebuddy"
	case strings.Contains(name, "opencode"):
		return "opencode"
	case strings.Contains(name, "gemini"):
		return "gemini"
	case strings.Contains(name, "grok"):
		return "grok"
	case strings.Contains(name, "codex"):
		return "codex"
	case strings.Contains(name, "claude"):
		return "claude"
	case strings.Contains(name, "agy"), strings.Contains(name, "antigravity"):
		return "agy"
	}
	return ""
}

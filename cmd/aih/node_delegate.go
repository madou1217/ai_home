package main

import (
	"os"
	"path/filepath"
	"strings"
)

// launchProviders 是 aih 直接拉起的 provider 家族。
var launchProviders = map[string]bool{
	"codex":       true,
	"claude":      true,
	"codebuddy":   true,
	"codebuddycn": true,
	"workbuddy":   true,
	"workbuddycn": true,
	"gemini":      true,
	"qoder":       true,
	"qodercn":     true,
	"zcode":       true,
	"cline":       true,
	"kiro":        true,
	"agy":         true,
	"opencode":    true,
	"grok":        true,
	"kimi":        true,
}

// isNativeLaunch 只覆盖"启动一个 provider 会话"这一种形态：
//
//	aih <provider>
//	aih <provider> <账号编号>
//
// 其余形态（ls/usage/server/resume、原生参数逃生门等）全部交回 Node 入口。
// 理由：启动是长驻进程，去掉 Node 外壳才真正省内存和约 1.3s 启动；
// 动作类命令继续走已验证的 Node 实现，避免兼容性回退。
func isNativeLaunch(args []string) bool {
	if len(args) == 0 || !launchProviders[args[0]] {
		return false
	}
	if len(args) == 1 {
		return true
	}
	if !isDigits(args[1]) {
		return false
	}
	for _, arg := range args[2:] {
		// "--" 是 Node 侧的原生参数逃生门，形态复杂，统一交回 Node。
		if strings.TrimSpace(arg) == "--" {
			return false
		}
	}
	return true
}

func isDigits(value string) bool {
	text := strings.TrimSpace(value)
	if text == "" {
		return false
	}
	for _, char := range text {
		if char < '0' || char > '9' {
			return false
		}
	}
	return true
}

// resolveNodeEntry 找到随仓库一起安装的 Node 入口脚本。
func resolveNodeEntry() (string, bool) {
	executable, err := os.Executable()
	if err != nil {
		return "", false
	}
	// 入口通常是符号链接（/opt/homebrew/bin/aih -> …/aih-go），
	// 必须按真实路径推算同仓库的 Node 入口。
	if resolved, linkErr := filepath.EvalSymlinks(executable); linkErr == nil {
		executable = resolved
	}
	candidate := filepath.Join(filepath.Dir(executable), "..", "..", "ai-home.js")
	resolved, err := filepath.Abs(candidate)
	if err != nil {
		return "", false
	}
	if info, err := os.Stat(resolved); err != nil || info.IsDir() {
		return "", false
	}
	return resolved, true
}

// delegateToNode 把非启动形态整体交给 Node 入口；成功时进程已被替换。
func delegateToNode(args []string) bool {
	if isNativeLaunch(args) {
		return false
	}
	// 只有以 aih 入口被调用时才回落 Node；直接调用 aih-go 的脚本保持原语义。
	if filepath.Base(os.Args[0]) != "aih" {
		return false
	}
	entry, ok := resolveNodeEntry()
	if !ok {
		return false
	}
	return execNode(entry, args)
}

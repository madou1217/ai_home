package main

import (
	"os"
	"path/filepath"
	"strings"
)

// delegationMarker 标记"本次进程是被 Go 转交给 Node 的"。
// Node 侧在维护动作里会反过来调用 aih-go（例如 server autostart install），
// 没有这个标记就会出现 Go→Node→Go 的无限重入。
const delegationMarker = "AIH_NODE_DELEGATED"

// envWithDelegationMarker 返回带标记的环境变量副本。
func envWithDelegationMarker() []string {
	env := os.Environ()
	for index, item := range env {
		if strings.HasPrefix(item, delegationMarker+"=") {
			env[index] = delegationMarker + "=1"
			return env
		}
	}
	return append(env, delegationMarker+"=1")
}

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
// Claude 已在 delegateToNode 中整体交给 Go；其它 Provider 的非启动形态仍可交回旧入口。
// 理由：启动是长驻进程，去掉 Node 外壳才真正省内存和约 1.3s 启动；
// 动作类命令继续走已验证的 Node 实现，避免兼容性回退。
func isNativeLaunch(args []string) bool {
	if len(args) == 0 || !launchProviders[args[0]] {
		return false
	}
	// 只有显式账号编号才走原生：不带编号时 Node 有一套"默认账号/自动选择"
	// 策略（含网关默认与优先级回退），Go 侧尚未完全对齐，先交回 Node。
	if len(args) == 1 || !isDigits(args[1]) {
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
	// Claude launches and actions belong to Go, including unpinned Gateway
	// sessions and --model-alias. Never silently re-enter the legacy host.
	if len(args) > 0 && (args[0] == "claude" || args[0] == "peer") {
		return false
	}
	if isNativeLaunch(args) {
		return false
	}
	// 内部子命令（__codex-cli-startup / __codex-local-app-server / __usage-facts …）
	// 是宿主与 Go 之间的私有协议，必须由 Go 自己处理，转给 Node 只会拿到帮助文本。
	if len(args) > 0 && strings.HasPrefix(args[0], "__") {
		return false
	}
	// 已经由 Go 转交过一次的进程不再回落，避免 Go→Node→Go 循环。
	if os.Getenv(delegationMarker) == "1" {
		return false
	}
	entry, ok := resolveNodeEntry()
	if !ok {
		return false
	}
	return execNode(entry, args)
}

package apps

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/toolkit/environment"
)

// withUsableJQPath 在 PATH 最前面插入一个「真的能跑」的 jq 目录。
//
// 为什么需要：官方安装脚本普遍用 jq 解析 JSON，而宿主 PATH 里排在最前的 jq 可能
// 是坏的（实测 /usr/local/bin/jq 缺 libonig.5，直接 dyld 退出）。安装计划的语义是
// 「把这个 CLI 装好」，不能因为一个坏 jq 就整条计划失败。这里逐个候选执行
// jq --version，第一个成功的目录前置；没有可用 jq 时原样返回，不做假设。
func withUsableJQPath(ctx context.Context, env map[string]string, opts Options) map[string]string {
	dir := usableJQDir(ctx, opts)
	if dir == "" {
		return env
	}
	merged := make(map[string]string, len(env)+1)
	for key, value := range env {
		merged[key] = value
	}
	base := strings.TrimSpace(merged["PATH"])
	if base == "" {
		base = os.Getenv("PATH")
	}
	if strings.TrimSpace(base) != "" {
		first := strings.Split(base, string(os.PathListSeparator))[0]
		if filepath.Clean(first) == filepath.Clean(dir) {
			return merged
		}
		merged["PATH"] = dir + string(os.PathListSeparator) + base
		return merged
	}
	merged["PATH"] = dir
	return merged
}

// usableJQDir 返回第一个 jq --version 成功的可执行文件所在目录。
func usableJQDir(ctx context.Context, opts Options) string {
	candidates := make([]string, 0, 4)
	if opts.LookPath != nil {
		if path, err := opts.LookPath("jq"); err == nil && strings.TrimSpace(path) != "" {
			candidates = append(candidates, path)
		}
	}
	candidates = append(candidates, "/opt/homebrew/bin/jq", "/usr/local/bin/jq")
	seen := make(map[string]bool, len(candidates))
	for _, candidate := range candidates {
		path := strings.TrimSpace(candidate)
		if path == "" || seen[path] {
			continue
		}
		seen[path] = true
		info, err := os.Stat(path)
		if err != nil || info.IsDir() {
			continue
		}
		result := (&opts).exec().Run(ctx, path, []string{"--version"}, environment.ExecOptions{
			Timeout: 2 * time.Second,
		})
		if result.OK {
			return filepath.Dir(path)
		}
	}
	return ""
}

// isSocksProxy 判断代理地址是不是 npm 不支持的 socks 形态。
func isSocksProxy(raw string) bool {
	value := strings.ToLower(strings.TrimSpace(raw))
	return strings.HasPrefix(value, "socks4://") || strings.HasPrefix(value, "socks4a://") ||
		strings.HasPrefix(value, "socks5://") || strings.HasPrefix(value, "socks://")
}

// npmPlanEnv 返回 npm 计划的额外环境变量。
//
// npm 的 fetch 层不支持 socks 代理：宿主把 HTTP(S)_PROXY 配成 socks5 时，npm 会把
// 它当普通 http 代理去连，TLS 阶段直接 "Socket closed"——镜像、registry 都配对了
// 也装不上。这里只在检测到 socks 时显式把 npm 的 proxy 配置置空；用户配的是
// http/https 代理时保持原样（那种代理 npm 能用）。
func npmPlanEnv(opts Options) map[string]string {
	proxyOf := func(key string) string {
		if opts.Env != nil {
			if value, ok := opts.Env[key]; ok && strings.TrimSpace(value) != "" {
				return value
			}
		}
		return os.Getenv(key)
	}
	keys := []string{"HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"}
	socks := false
	for _, key := range keys {
		if isSocksProxy(proxyOf(key)) {
			socks = true
			break
		}
	}
	if !socks {
		return nil
	}
	// 置空而不是只写 npm_config_*：npm 对 socks 形态的 https_proxy 会当普通 http
	// 代理去连，空串才是它认的「没有代理」。
	env := make(map[string]string, len(keys))
	for _, key := range keys {
		env[key] = ""
	}
	return env
}

// withUsableJQScript 在 POSIX shell 计划里把可用 jq 的目录注入脚本 PATH。
//
// 只改 plan.Env 不够：这些计划用 sh -lc 执行，login shell 会重新读取 /etc/profile，
// 把 PATH 重置成 /usr/local/bin 优先——宿主里坏掉的 jq 又会赢。所以在传进 -c 的脚本
// 前面显式 export PATH，保证脚本内部（含 curl | bash 的子 bash）都用得到好的 jq。
func withUsableJQScript(ctx context.Context, plan LifecyclePlan, opts Options) LifecyclePlan {
	if !isPosixShellCommand(plan.Command) {
		return plan
	}
	dir := usableJQDir(ctx, opts)
	if dir == "" {
		return plan
	}
	prefix := "export PATH=\"" + dir + ":$PATH\"; "
	args := append([]string(nil), plan.Args...)
	changed := false
	for index, arg := range args {
		if !strings.HasPrefix(arg, "-") {
			continue
		}
		if !strings.Contains(arg, "c") {
			continue
		}
		if index+1 >= len(args) {
			continue
		}
		script := strings.TrimSpace(args[index+1])
		if script == "" || strings.HasPrefix(script, "export PATH=") {
			continue
		}
		args[index+1] = prefix + args[index+1]
		changed = true
	}
	if !changed {
		return plan
	}
	plan.Args = args
	return plan
}

func isPosixShellCommand(command string) bool {
	base := strings.ToLower(filepath.Base(strings.TrimSpace(command)))
	switch base {
	case "sh", "bash", "zsh", "dash":
		return true
	default:
		return false
	}
}

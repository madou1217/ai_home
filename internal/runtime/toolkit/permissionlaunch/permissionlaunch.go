// Package permissionlaunch 把 WebUI 的「启动权限」设置应用到 CLI 启动参数。
//
// 事实来源与 Node 的 tool-permission-launch 一致：
//   - Provider 合同 nativeBoundary.permissions 决定默认最大权限参数与环境开关；
//   - app_kv 的 toolkit:tool-permission-settings 保存用户在 WebUI 的逐 Provider 开关；
//   - 用户显式传入权限旗标时不覆盖（尊重原生参数）。
//
// 这里不按 Provider 名判断权限语义；只有「旗标落点」是 CLI 形态差异：
// opencode 的 --auto 只认根命令或 run 子命令，kiro 的 --trust-all-tools 只认 chat。
package permissionlaunch

import (
	"context"
	"strings"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/runtime/toolkit/appsettings"
)

// Options 是应用启动权限所需的只读事实。
type Options struct {
	Catalog   *providers.Catalog
	AIHomeDir string
	// HostHomeDir 是读取宿主配置（去重）的显式依据；为空时不做去重。
	HostHomeDir string
	// GOOS 与 Env 解析宿主配置路径（XDG/APPDATA 等）；为空时用当前进程。
	GOOS      string
	Env       map[string]string
	LookupEnv func(string) string
}

// Result 是一次启动权限应用结果。
type Result struct {
	// Args 是应插入到 argv 的权限参数；Applied=false 时为空。
	Args []string
	// Env 是应叠加到子进程环境的开关；Applied=false 时为空。
	Env map[string]string
	// Applied 表示 Args/Env 是否生效。
	Applied bool
	// Reason 是未生效的稳定原因（诊断用）。
	Reason string
}

// Apply 计算一次启动要注入的权限参数与环境。
func Apply(ctx context.Context, options Options, providerID string, argv []string, isLogin bool) Result {
	if isLogin {
		return Result{Reason: "login"}
	}
	if isInformationalInvocation(argv) {
		return Result{Reason: "informational"}
	}
	definition, ok := lookupDefinition(options.Catalog, providerID)
	if !ok {
		return Result{Reason: "unsupported"}
	}
	maxArgs := providers.MaxPermissionArgs(definition)
	if len(maxArgs) == 0 {
		return Result{Reason: "unsupported"}
	}
	if providers.HasPermissionIntentFlag(definition, argv) {
		return Result{Reason: "explicit"}
	}
	if blockedSubcommand(definition, argv) != "" {
		// 恢复/分叉会话沿用会话已保存的权限；上游会拒绝权限覆盖。
		return Result{Reason: "session_continuation"}
	}
	settings := readSettings(ctx, options.AIHomeDir, providerID)
	if !settings.MaxPermission {
		return Result{Reason: "disabled"}
	}
	injected := maxArgs
	env := map[string]string{}
	if len(settings.PermissionArgs) > 0 {
		injected = settings.PermissionArgs
	} else {
		// 宿主配置已经表达的维度不再用命令行重复：同一件事说两遍会让 CLI 的权限
		// 状态与自己 /approvals 切出来的不一致（Node 2026-10-21 用户报障）。
		hostState := readHostPermissionState(options, providerID, maxArgs)
		injected = dropHostSatisfiedArgs(normalizeProvider(providerID), maxArgs, hostState)
		if len(injected) == 0 {
			return Result{Reason: "host_config_satisfied"}
		}
		env = providers.MaxPermissionEnv(definition)
	}
	placed, applied := place(normalizeProvider(providerID), argv, injected)
	if !applied {
		return Result{Reason: "unsupported_invocation"}
	}
	return Result{Args: placed, Env: env, Applied: true, Reason: "applied"}
}

// Place 仅执行旗标落点逻辑（导出给诊断/测试替身）。
func Place(providerID string, argv []string, extra []string) ([]string, bool) {
	return place(normalizeProvider(providerID), argv, extra)
}

func place(provider string, argv []string, extra []string) ([]string, bool) {
	if len(extra) == 0 {
		return argv, false
	}
	args := append([]string(nil), argv...)
	first := ""
	if len(args) > 0 {
		first = strings.TrimSpace(args[0])
	}
	switch provider {
	case "opencode":
		// --auto 只属于根命令（TUI）和 run 子命令；写在子命令前面会被拒。
		if first == "" || strings.HasPrefix(first, "-") {
			return append(append([]string(nil), extra...), args...), true
		}
		if first == "run" {
			return append(append([]string{args[0]}, extra...), args[1:]...), true
		}
		return argv, false
	case "kiro":
		// -a/--trust-all-tools 属于 chat 子命令；裸启动由启动策略补 chat。
		if first == "chat" {
			return append(append([]string{args[0]}, extra...), args[1:]...), true
		}
		return argv, false
	default:
		return append(append([]string(nil), extra...), args...), true
	}
}

func lookupDefinition(catalog *providers.Catalog, providerID string) (providers.Definition, bool) {
	if catalog == nil {
		return providers.Definition{}, false
	}
	return catalog.Get(normalizeProvider(providerID))
}

func normalizeProvider(providerID string) string {
	return strings.ToLower(strings.TrimSpace(providerID))
}

func readSettings(ctx context.Context, aiHomeDir string, providerID string) appsettings.Settings {
	source, err := appsettings.Open(aiHomeDir)
	if err != nil {
		return appsettings.Default()
	}
	return source.Read(ctx, providerID)
}

func isInformationalInvocation(argv []string) bool {
	for _, arg := range argv {
		switch strings.TrimSpace(arg) {
		case "--version", "-V", "--help", "-h":
			return true
		}
	}
	return false
}

// subcommandValueFlags 是找首个位置参数时必须整对跳过的「带值旗标」。
// 与 Node permission-flag-catalog 的 subcommandFlagsWithValue 同一份形态；
// 它只影响「resume 是否是子命令」的判断，漏一个最多多注入/少注入一次。
var subcommandValueFlags = map[string]bool{
	"-c": true, "--config": true, "--enable": true, "--disable": true,
	"--remote": true, "--remote-auth-token-env": true, "-i": true, "--image": true,
	"-m": true, "--model": true, "--local-provider": true, "-p": true, "--profile": true,
	"-s": true, "--sandbox": true, "-C": true, "--cd": true, "--add-dir": true,
	"-a": true, "--ask-for-approval": true,
}

// blockedSubcommand 返回 argv 的首个位置参数（若该参数在合同的
// blockingSubcommands 里）；否则返回空串。
func blockedSubcommand(definition providers.Definition, argv []string) string {
	if definition.NativeBoundary == nil {
		return ""
	}
	blocked := definition.NativeBoundary.Permissions.BlockingSubcommands
	if len(blocked) == 0 {
		return ""
	}
	for index := 0; index < len(argv); index++ {
		token := strings.TrimSpace(argv[index])
		if token == "" {
			continue
		}
		if token == "--" {
			return ""
		}
		if subcommandValueFlags[token] {
			index++
			continue
		}
		if strings.HasPrefix(token, "-") {
			continue
		}
		for _, item := range blocked {
			if token == item {
				return token
			}
		}
		return ""
	}
	return ""
}

package providers

import "strings"

// 权限参数的推导规则是 Provider 合同的一部分：WebUI 展示的「最大权限」与 CLI
// 启动时实际注入的参数必须来自同一份实现，不能在 transport 与启动层各写一遍。
//
// 顺序即优先级，与 Node deriveMaxPermissionArgs 完全一致：
// claude 同时声明 --permission-mode 与 --dangerously-skip-permissions，必须优先返回
// 模式（更窄且可被上游识别）；kimi 的 --auto 才是不再询问，--yolo 仍会询问高风险操作。
func MaxPermissionArgs(definition Definition) []string {
	flags, modes := permissionFlagsAndModes(definition)
	has := func(list []string, value string) bool {
		for _, item := range list {
			if item == value {
				return true
			}
		}
		return false
	}
	if has(modes, "danger-full-access") && has(flags, "--sandbox") {
		args := []string{"--sandbox", "danger-full-access"}
		if has(flags, "--ask-for-approval") {
			args = append(args, "--ask-for-approval", "never")
		}
		return args
	}
	if has(modes, "bypassPermissions") && has(flags, "--permission-mode") {
		return []string{"--permission-mode", "bypassPermissions"}
	}
	if has(modes, "bypass_permissions") && has(flags, "--permission-mode") {
		return []string{"--permission-mode", "bypass_permissions"}
	}
	if has(modes, "auto") && has(flags, "--auto") {
		return []string{"--auto"}
	}
	if has(modes, "yolo") && has(flags, "--yolo") {
		return []string{"--yolo"}
	}
	if has(modes, "yolo") && has(flags, "--approval-mode") {
		return []string{"--approval-mode", "yolo"}
	}
	if has(flags, "--dangerously-skip-permissions") {
		return []string{"--dangerously-skip-permissions"}
	}
	if has(flags, "--trust-all-tools") {
		return []string{"--trust-all-tools"}
	}
	return []string{}
}

// MaxPermissionEnv 返回合同声明的、与最大权限参数配套的进程环境开关。
//
// 例如 codebuddy 的 CODEBUDDY_IS_SANDBOX=1：bypassPermissions 仍会逐次询问
// HIGH/CRITICAL，只有这个环境变量能真正 full pass。没有最大权限参数时不返回环境：
// 那等于给一个没打算放开权限的 Provider 开后门。
func MaxPermissionEnv(definition Definition) map[string]string {
	args := MaxPermissionArgs(definition)
	if len(args) == 0 || definition.NativeBoundary == nil {
		return map[string]string{}
	}
	result := map[string]string{}
	for key, value := range definition.NativeBoundary.Permissions.Env {
		name := strings.TrimSpace(key)
		text := strings.TrimSpace(value)
		if name != "" && text != "" {
			result[name] = text
		}
	}
	return result
}

// PermissionIntentFlags 返回「用户已经表达权限意图」的全部旗标形式。
//
// 合同声明的长旗标之外，还包括等价旗标（--dangerously-bypass-approvals-and-sandbox）
// 与合同确实存在的短别名（codex 的 -s / -a）。漏判会把用户显式选择的权限与默认
// 最大权限叠加成冲突组合。
func PermissionIntentFlags(definition Definition) []string {
	flags, _ := permissionFlagsAndModes(definition)
	result := make([]string, 0, len(flags)+3)
	result = append(result, flags...)
	result = append(result, "--dangerously-bypass-approvals-and-sandbox")
	if hasString(flags, "--sandbox") {
		result = append(result, "-s")
	}
	if hasString(flags, "--ask-for-approval") {
		result = append(result, "-a")
	}
	return result
}

// HasPermissionIntentFlag 报告 argv 里是否已有权限旗标（含 --flag=value 形式）。
func HasPermissionIntentFlag(definition Definition, argv []string) bool {
	flags := PermissionIntentFlags(definition)
	for _, arg := range argv {
		token := strings.TrimSpace(arg)
		if token == "" {
			continue
		}
		if index := strings.IndexByte(token, '='); index >= 0 {
			token = token[:index]
		}
		if hasString(flags, token) {
			return true
		}
	}
	return false
}

func permissionFlagsAndModes(definition Definition) ([]string, []string) {
	if definition.NativeBoundary == nil {
		return nil, nil
	}
	return definition.NativeBoundary.Permissions.Flags, definition.NativeBoundary.Permissions.Modes
}

func hasString(list []string, value string) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}

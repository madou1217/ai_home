package codexappconfig

import "strings"

// permissionOverrideFlags 是 codex 在远程 resume 时拒绝的权限覆盖旗标。
// 与 Node lib/runtime/permission-flag-catalog.js 的 codex 条目一致（permissionIntent=false
// 的 --dangerously-bypass-hook-trust 不在其中）。
var permissionOverrideFlags = map[string]bool{
	"--sandbox":          true,
	"-s":                 true,
	"--ask-for-approval": true,
	"-a":                 true,
	"--approve-for-me":   true,
	"--dangerously-bypass-approvals-and-sandbox": true,
}

// permissionOverrideValueFlags 需要连带摘掉后一个取值的旗标。
var permissionOverrideValueFlags = map[string]bool{
	"--sandbox":          true,
	"-s":                 true,
	"--ask-for-approval": true,
	"-a":                 true,
}

// permissionOverrideConfigPrefixes 是 Codex TUI 在远程任务上检测的会话级权限配置路径
// （见上游 tui/src/resume_permissions.rs：approval_policy / approvals_reviewer /
// default_permissions / sandbox_mode / sandbox_workspace_write / permissions / network）。
var permissionOverrideConfigPrefixes = []string{
	"approval_policy",
	"approvals_reviewer",
	"default_permissions",
	"sandbox_mode",
	"sandbox_workspace_write",
	"permissions",
	"network",
}

// HasPermissionOverrides 判断 argv 是否携带远程 `/resume` 会整单拒绝的权限覆盖。
//
// 覆盖命令行旗标与会话级 `-c key=value` 配置；`--` 之后的参数属于提示词，不参与判断。
// 与上游检测保持一致是刻意的：宁可多用本地 app-server，也不要在远程模式里带着
// 必然被拒绝的组合启动。
func HasPermissionOverrides(argv []string) bool {
	for index := 0; index < len(argv); index++ {
		token := strings.TrimSpace(argv[index])
		if token == "--" {
			return false
		}
		flag, inlineValue := token, ""
		if cut := strings.IndexByte(token, '='); cut > 0 {
			flag, inlineValue = token[:cut], token[cut+1:]
		}
		switch flag {
		case "-s", "--sandbox", "-a", "--ask-for-approval", "--full-auto",
			"--approve-for-me", "--dangerously-bypass-approvals-and-sandbox",
			"-p", "--profile", "--add-dir":
			return true
		case "-c", "--config":
			value := inlineValue
			if value == "" && index+1 < len(argv) {
				value = strings.TrimSpace(argv[index+1])
				index++
			}
			if assignmentOverridesPermissions(value) {
				return true
			}
		}
	}
	return false
}

func assignmentOverridesPermissions(assignment string) bool {
	key, _, ok := strings.Cut(strings.TrimSpace(assignment), "=")
	if !ok {
		return false
	}
	key = strings.TrimSpace(key)
	for _, prefix := range permissionOverrideConfigPrefixes {
		if key == prefix || strings.HasPrefix(key, prefix+".") {
			return true
		}
	}
	return false
}

// StripPermissionOverrides 从 argv 中移除权限覆盖旗标及其取值，返回剩余参数与被移除的旗标。
// 用于远程 resume：codex 0.163 实测会整单拒绝这类组合，必须在注入 --remote 前摘除。
func StripPermissionOverrides(argv []string) ([]string, []string) {
	out := make([]string, 0, len(argv))
	removed := make([]string, 0, 2)
	for index := 0; index < len(argv); index++ {
		token := strings.TrimSpace(argv[index])
		flag := token
		inline := false
		if cut := strings.IndexByte(token, '='); cut > 0 {
			flag, inline = token[:cut], true
		}
		if !permissionOverrideFlags[flag] {
			out = append(out, argv[index])
			continue
		}
		removed = append(removed, flag)
		if !inline && permissionOverrideValueFlags[flag] && index+1 < len(argv) {
			next := strings.TrimSpace(argv[index+1])
			if next != "" && !strings.HasPrefix(next, "-") {
				index++
			}
		}
	}
	return out, removed
}

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

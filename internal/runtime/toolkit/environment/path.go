package environment

import "strings"

// 路径口径按「目标平台」而不是当前进程平台决定：从 WebUI 可以查看另一平台的
// 入门指南（例如在 macOS 上预览 Linux 的任务模板），这时计划里的家目录是占位符，
// 分隔符也必须按目标平台拼。
//
// 只实现本包用到的能力：join / isAbs / base / dir / normalize。
// 不引入 path/filepath 的当前平台语义，避免 Windows 计划被 host 平台改写。

// normalizePlatform 把 mac/darwin/win32 等别名归一成三个平台标识。
func normalizePlatform(value string) string {
	normalized := strings.ToLower(strings.TrimSpace(value))
	switch normalized {
	case "mac", "macos", "darwin":
		return PlatformMacOS
	case "win", "windows", "win32":
		return PlatformWindows
	case "linux", "linux2":
		return PlatformLinux
	}
	return normalized
}

// separator 返回目标平台的路径分隔符。
func separator(platform string) string {
	if normalizePlatform(platform) == PlatformWindows {
		return "\\"
	}
	return "/"
}

// JoinPath 按目标平台拼接路径；空片段被忽略。
func JoinPath(platform string, parts ...string) string {
	sep := separator(platform)
	cleaned := make([]string, 0, len(parts))
	for _, part := range parts {
		value := strings.TrimSpace(part)
		if value == "" {
			continue
		}
		if len(cleaned) == 0 {
			cleaned = append(cleaned, strings.TrimRight(value, "/\\"))
			continue
		}
		cleaned = append(cleaned, strings.Trim(value, "/\\"))
	}
	return strings.Join(cleaned, sep)
}

// IsAbsPath 判断路径在目标平台上是否绝对路径。
func IsAbsPath(platform string, value string) bool {
	target := strings.TrimSpace(value)
	if target == "" {
		return false
	}
	if normalizePlatform(platform) == PlatformWindows {
		if strings.HasPrefix(target, "\\\\") {
			return true
		}
		if len(target) >= 3 && isASCIILetter(target[0]) && target[1] == ':' && (target[2] == '\\' || target[2] == '/') {
			return true
		}
		return false
	}
	return strings.HasPrefix(target, "/")
}

// NormalizePath 做最小归一：统一分隔符、去重复分隔符、去尾部（根除外）。
func NormalizePath(platform string, value string) string {
	target := strings.TrimSpace(value)
	if target == "" {
		return ""
	}
	if normalizePlatform(platform) == PlatformWindows {
		target = strings.ReplaceAll(target, "/", "\\")
		for strings.Contains(target, "\\\\") && !strings.HasPrefix(target, "\\\\") {
			target = strings.ReplaceAll(target, "\\\\", "\\")
		}
		trimmed := strings.TrimRight(target, "\\")
		if len(trimmed) == 2 && trimmed[1] == ':' {
			return trimmed + "\\"
		}
		if trimmed == "" {
			return "\\"
		}
		return trimmed
	}
	for strings.Contains(target, "//") {
		target = strings.ReplaceAll(target, "//", "/")
	}
	if target == "/" {
		return target
	}
	return strings.TrimRight(target, "/")
}

func isASCIILetter(value byte) bool {
	return (value >= 'a' && value <= 'z') || (value >= 'A' && value <= 'Z')
}

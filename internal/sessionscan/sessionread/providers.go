package sessionread

import (
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/runtime/storagepolicy"
)

const unnamedTitle = "未命名会话"

// allKnownProviders 与 Node lib/provider-catalog.js 的 sessionHistory 能力表及 chat/kimi 对齐。
var allKnownProviders = map[string]bool{
	"codex":       true,
	"claude":      true,
	"gemini":      true,
	"agy":         true,
	"opencode":    true,
	"qoder":       true,
	"qodercn":     true,
	"grok":        true,
	"kiro":        true,
	"zcode":       true,
	"cline":       true,
	"codebuddy":   true,
	"codebuddycn": true,
	"workbuddy":   true,
	"workbuddycn": true,
	"kimi":        true,
	"chat":        true,
}

// NormalizeProvider 归一化 Provider 标识为小写去空白字符串。
func NormalizeProvider(provider string) string {
	return strings.ToLower(strings.TrimSpace(provider))
}

// IsKnownProvider 报告 Provider 是否在 Go 会话读取支持范围内。
func IsKnownProvider(provider string) bool {
	return allKnownProviders[NormalizeProvider(provider)]
}

// IsCodebuddyFamilyProvider 报告是否属于 CodeBuddy / WorkBuddy 四兄弟之一。
func IsCodebuddyFamilyProvider(provider string) bool {
	normalized := NormalizeProvider(provider)
	for _, member := range storagepolicy.FamilyProviders {
		if normalized == member {
			return true
		}
	}
	return false
}

// RequiresSingleSegmentProjectDirName 报告该 Provider 的 projectDirName 是否必须为单段目录名。
func RequiresSingleSegmentProjectDirName(provider string) bool {
	switch NormalizeProvider(provider) {
	case "claude", "gemini", "qoder", "qodercn", "grok":
		return true
	default:
		return IsCodebuddyFamilyProvider(provider)
	}
}

// IsSafePathSegment 拒绝空串、分隔符及 . / .. 片段。
func IsSafePathSegment(value string) bool {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" || trimmed == "." || trimmed == ".." {
		return false
	}
	if strings.ContainsAny(trimmed, `/\`) {
		return false
	}
	return filepath.Base(trimmed) == trimmed
}

// HasDotDotSegment 检测路径字符串中是否存在 .. 穿越片段。
func HasDotDotSegment(value string) bool {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return false
	}
	normalized := strings.ReplaceAll(trimmed, `\`, "/")
	for _, part := range strings.Split(normalized, "/") {
		if part == ".." {
			return true
		}
	}
	return false
}

// ResolveAIHomeDir 推导 AIH 状态根目录；未显式传入时退回 <hostHome>/.ai_home。
func ResolveAIHomeDir(opts Options) string {
	if trimmed := strings.TrimSpace(opts.AIHomeDir); trimmed != "" {
		return filepath.Clean(trimmed)
	}
	hostHome := strings.TrimSpace(opts.HostHomeDir)
	if hostHome == "" {
		return ""
	}
	return filepath.Join(filepath.Clean(hostHome), ".ai_home")
}

// ResolveAppStateDBPath 返回显式配置的或按 AIHomeDir 推导的 app-state.db 路径。
func ResolveAppStateDBPath(opts Options) string {
	if trimmed := strings.TrimSpace(opts.AppStateDBPath); trimmed != "" {
		return filepath.Clean(trimmed)
	}
	aiHome := ResolveAIHomeDir(opts)
	if aiHome == "" {
		return ""
	}
	dbPath, err := appstate.DatabasePath(aiHome)
	if err != nil {
		return ""
	}
	return dbPath
}

// ResolveAccountRuntimeDir 返回受管账号投影目录：<aiHome>/run/auth-projections/<provider>/<accountRef>。
func ResolveAccountRuntimeDir(aiHomeDir, provider, accountRef string) string {
	aiHome := strings.TrimSpace(aiHomeDir)
	normProvider := NormalizeProvider(provider)
	ref := strings.TrimSpace(accountRef)
	if aiHome == "" || normProvider == "" || ref == "" || !IsSafePathSegment(normProvider) || !IsSafePathSegment(ref) {
		return ""
	}
	return filepath.Join(filepath.Clean(aiHome), "run", "auth-projections", normProvider, ref)
}

// ListProviderAccountRefs 列出该 Provider 在 auth-projections 下的账号引用目录（排序且置顶给定 accountRef）。
func ListProviderAccountRefs(opts Options, provider string) []string {
	refs := make([]string, 0, 8)
	seen := make(map[string]bool)
	addRef := func(ref string) {
		trimmed := strings.TrimSpace(ref)
		if trimmed == "" || !IsSafePathSegment(trimmed) || seen[trimmed] {
			return
		}
		seen[trimmed] = true
		refs = append(refs, trimmed)
	}

	addRef(opts.AccountRef)

	aiHome := ResolveAIHomeDir(opts)
	if aiHome != "" {
		root := filepath.Join(aiHome, "run", "auth-projections", NormalizeProvider(provider))
		if entries, err := os.ReadDir(root); err == nil {
			names := make([]string, 0, len(entries))
			for _, entry := range entries {
				if entry.IsDir() {
					names = append(names, entry.Name())
				}
			}
			sort.Strings(names)
			for _, name := range names {
				addRef(name)
			}
		}
	}
	return refs
}

// NormalizeProjectPath 去空白并去掉尾部斜杠（保留根路径 "/" 本身）。
func NormalizeProjectPath(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return ""
	}
	if trimmed == "/" {
		return "/"
	}
	return strings.TrimRight(trimmed, "/")
}

// Package codebuddyfamilystorage 是 CodeBuddy / WorkBuddy 家族的账号投影策略与
// 凭据物化适配器。
//
// 对齐 Node lib/runtime/provider-storage-policy.js 的家族四支：
//   - 整个 HOME 是账号沙箱（fake_home），CLI 登录态读 HOME 下的共享 .info；
//   - 配置根按站点分开（.codebuddy / .codebuddy-cn / .workbuddy-ai / .workbuddy），
//     会话与 harness 配置通过链接回到宿主；
//   - 认证文件是 CodeBuddyExtension/Data/Public/auth/<hostId>.info，路径相对伪 HOME。
package codebuddyfamilystorage

import (
	"runtime"
	"strings"

	"github.com/madou1217/ai_home/application/accountprojection"
)

const (
	providerCodebuddy   = "codebuddy"
	providerCodebuddyCN = "codebuddycn"
	providerWorkbuddy   = "workbuddy"
	providerWorkbuddyCN = "workbuddycn"
)

type providerLayout struct {
	configDir       string
	defaultAuthFile string
	siteInternal    bool
	ideDataName     string
}

var layouts = map[string]providerLayout{
	providerCodebuddy: {
		configDir:       ".codebuddy",
		defaultAuthFile: "Tencent-Cloud.coding-copilot.info",
		ideDataName:     "CodeBuddy",
	},
	providerCodebuddyCN: {
		configDir:       ".codebuddy-cn",
		defaultAuthFile: "workbuddy-desktop.info",
		siteInternal:    true,
		ideDataName:     "CodeBuddy CN",
	},
	providerWorkbuddy: {
		configDir:       ".workbuddy-ai",
		defaultAuthFile: "workbuddy-desktop-ai.info",
		ideDataName:     "WorkBuddy AI",
	},
	providerWorkbuddyCN: {
		configDir:       ".workbuddy",
		defaultAuthFile: "workbuddy-desktop.info",
		siteInternal:    true,
		ideDataName:     "WorkBuddy",
	},
}

// ProviderIDs 返回家族四支的规范 Provider ID。
func ProviderIDs() []string {
	return []string{providerCodebuddy, providerCodebuddyCN, providerWorkbuddy, providerWorkbuddyCN}
}

// IsFamilyProvider 判断 Provider 是否属于 CodeBuddy 家族。
func IsFamilyProvider(providerID string) bool {
	_, ok := layouts[normalizeProviderID(providerID)]
	return ok
}

// ConfigDir 返回家族成员的 HOME 相对配置目录；未知 Provider 返回 false。
//
// 这是 .codebuddy / .codebuddy-cn / .workbuddy-ai / .workbuddy 的唯一映射源，
// 会话扫描、用量账本与桌面投影都从这里取，避免各自维护一份。
func ConfigDir(providerID string) (string, bool) {
	layout, ok := layouts[normalizeProviderID(providerID)]
	if !ok {
		return "", false
	}
	return layout.configDir, true
}

// ConfigDirs 返回家族配置目录的规范顺序（与 Node familyConfigDirs 一致）。
func ConfigDirs() []string {
	dirs := make([]string, 0, len(layouts))
	for _, providerID := range ProviderIDs() {
		if layout, ok := layouts[providerID]; ok {
			dirs = append(dirs, layout.configDir)
		}
	}
	return dirs
}

// ProviderForConfigDir 返回配置目录所属的 Provider；未知目录返回 false。
func ProviderForConfigDir(dirName string) (string, bool) {
	normalized := strings.TrimSpace(dirName)
	for providerID, layout := range layouts {
		if layout.configDir == normalized {
			return providerID, true
		}
	}
	return "", false
}

// SessionRoots 返回该 Provider 的会话根候选（HOME 相对，按优先级）。
func SessionRoots(providerID string) []string {
	roots := sessionRoots[normalizeProviderID(providerID)]
	return append([]string(nil), roots...)
}

// sessionRoots 是同一物理会话存储在家族内的候选根：先本 Provider，再跨产品。
var sessionRoots = map[string][]string{
	providerCodebuddy:   {".codebuddy", ".workbuddy-ai"},
	providerWorkbuddy:   {".workbuddy-ai", ".codebuddy"},
	providerCodebuddyCN: {".codebuddy-cn", ".workbuddy"},
	providerWorkbuddyCN: {".workbuddy", ".codebuddy-cn"},
}

func normalizeProviderID(providerID string) string {
	return strings.ToLower(strings.TrimSpace(providerID))
}

// Policy 返回指定家族 Provider 的投影策略；未知 Provider 返回 false。
func Policy(providerID string) (accountprojection.Policy, bool) {
	id := strings.ToLower(strings.TrimSpace(providerID))
	layout, ok := layouts[id]
	if !ok {
		return accountprojection.Policy{}, false
	}
	authPath := append(authDirSegments(runtime.GOOS), layout.defaultAuthFile)
	return accountprojection.Policy{
		Provider:        id,
		Mode:            accountprojection.ModeFakeHome,
		NativeRoot:      []string{layout.configDir},
		RuntimeHomeRoot: []string{layout.configDir, ".aih-runtime-home"},
		AuthArtifacts: []accountprojection.Artifact{{
			Field:     "credentials",
			Base:      accountprojection.ArtifactBaseHome,
			Path:      authPath,
			Format:    accountprojection.FormatJSON,
			LiveStore: true,
		}},
		PrivateArtifacts: []accountprojection.PathSpec{
			// 账号私有：桌面端加密/连接器状态、Keychain、诊断缓存与系统加密引用。
			// 与 Node CODEBUDDY_PRIVATE_DESKTOP_STATE 同口径。
			{Path: []string{"electron-user-data"}},
			{Path: []string{".codebuddy", "diagnostics"}},
			{Path: []string{"Library", "Preferences", "com.apple.security.plist"}},
			{Path: []string{".workbuddy-key-fallback"}},
			{Path: []string{"Library", "Application Support", "CodeBuddyExtension", "Cache"}},
			{Path: []string{"Library", "Application Support", "CodeBuddyExtension", "Logs"}},
			{Path: []string{layout.configDir, ".mcp.json"}},
			{Path: []string{layout.configDir, "sessions"}},
			{Path: []string{"Library", "Keychains"}},
		},
		ProjectionRoots: []accountprojection.Mapping{
			{From: []string{layout.configDir}, To: []string{layout.configDir}},
			{From: []string{layout.ideDataName, "Claw"}, To: []string{layout.ideDataName, "Claw"}},
		},
		SharedEntries:  familySharedEntries(id),
		SessionEntries: []string{"projects"},
		// 与 Node HOST_TOOLCHAIN_CACHES 逐项对齐：工具链缓存与账号无关，必须链接回
		// 宿主，否则每个账号各存一份（历史上 zcode 单账号堆到 4GB）。
		SharedHostCaches: []accountprojection.SharedLink{
			{Projection: []string{"go"}, Host: []string{"go"}},
			{Projection: []string{".npm"}, Host: []string{".npm"}},
			{Projection: []string{".bun"}, Host: []string{".bun"}},
			{Projection: []string{".volta"}, Host: []string{".volta"}},
			{Projection: []string{".local", "bin"}, Host: []string{".local", "bin"}},
			{
				Projection: []string{"Library", "Caches", "go-build"},
				Host:       []string{"Library", "Caches", "go-build"},
				Platforms:  []string{"darwin"},
			},
			{
				Projection: []string{"Library", "Caches", "Homebrew"},
				Host:       []string{"Library", "Caches", "Homebrew"},
				Platforms:  []string{"darwin"},
			},
			{
				Projection: []string{"Library", "Caches", "bun"},
				Host:       []string{"Library", "Caches", "bun"},
				Platforms:  []string{"darwin"},
			},
			{
				Projection: []string{"Library", "Caches", "pip"},
				Host:       []string{"Library", "Caches", "pip"},
				Platforms:  []string{"darwin"},
			},
			// 桌面端整目录缓存共享（Node DESKTOP_SHARED_CACHE_PROVIDERS）：只排除
			// 桌面应用自己的 Chromium 缓存（可能带凭据响应体）。
			{
				Projection: []string{"Library", "Caches"},
				Host:       []string{"Library", "Caches"},
				Platforms:  []string{"darwin"},
				Exclude: []string{
					"dev.zcode.app",
					"com.tencent.codebuddy",
					"com.workbuddy.workbuddy-ai",
					"com.tencent.workbuddy.mac",
				},
			},
		},
		SharedHostDataRoots: []accountprojection.SharedLink{
			{
				Projection: []string{"electron-user-data", "User", "globalStorage", "tencent-cloud.coding-copilot"},
				Host:       []string{"Library", "Application Support", layout.ideDataName, "User", "globalStorage", "tencent-cloud.coding-copilot"},
				Platforms:  []string{"darwin"},
			},
			{
				Projection: []string{"electron-user-data", "codebuddy-sessions.vscdb"},
				Host:       []string{"Library", "Application Support", layout.ideDataName, "codebuddy-sessions.vscdb"},
				Platforms:  []string{"darwin"},
			},
		},
		PrecreatedDirectories: []string{
			"logs",
			"plugins",
			"local_storage",
			"sessions",
			"shell-snapshots",
			"projects",
			"skills",
		},
		Env:              familyEnvironment(id, layout.configDir),
		AttachmentSubdir: []string{"tmp", "model", "images"},
	}, true
}

// familySharedEntries 返回需要链接到宿主的那批共享条目。
//
// CLI 专有条目（settings/statusline/argv/plugins）只属于 .codebuddy / .codebuddy-cn：
// WorkBuddy 桌面根的 settings.json 是 App 自己的 30KB 配置（sandbox/claw/office），
// 与 CLI settings 不是同一个 schema。混在一起会把桌面配置归一成几百字节的 CLI 小
// JSON，与 Node codebuddy-shared-config 的 sharedEntriesForConfigDir 同口径。
func familySharedEntries(providerID string) []string {
	entries := []string{
		"projects",
		"skills",
		"AGENTS.md",
		"mcp.json",
		"models.json",
		"history.jsonl",
		"file-history",
		"plans",
		"tasks",
		"shell-snapshots",
		"blobs",
	}
	if providerID == providerCodebuddy || providerID == providerCodebuddyCN {
		entries = append(entries, "settings.json", "statusline-command.sh", "argv.json", "plugins")
	}
	return entries
}

// familyEnvironment 生成伪 HOME 的环境绑定。WorkBuddy 两支额外需要
// WORKBUDDY_CONFIG_DIR（Node codebuddy-strategy 的同一口径）：只设 CODEBUDDY_CONFIG_DIR
// 会让桌面端和 CLI 读到不同配置根。
func familyEnvironment(providerID string, configDir string) []accountprojection.EnvBinding {
	bindings := []accountprojection.EnvBinding{
		{Key: "HOME", Base: accountprojection.EnvBaseProjectionRoot},
		{Key: "CODEBUDDY_CONFIG_DIR", Base: accountprojection.EnvBaseProjectionRoot, Path: []string{configDir}},
	}
	if strings.HasPrefix(providerID, "workbuddy") {
		bindings = append(bindings, accountprojection.EnvBinding{
			Key:  "WORKBUDDY_CONFIG_DIR",
			Base: accountprojection.EnvBaseProjectionRoot,
			Path: []string{configDir},
		})
	}
	return bindings
}

// SiteInternal 返回该 Provider 是否固定使用国内站。
func SiteInternal(providerID string) bool {
	return layouts[strings.ToLower(strings.TrimSpace(providerID))].siteInternal
}

// DefaultAuthFile 返回该 Provider 默认的 .info 文件名。
func DefaultAuthFile(providerID string) string {
	return layouts[strings.ToLower(strings.TrimSpace(providerID))].defaultAuthFile
}

// AuthDirSegments 返回伪 HOME 下共享 auth 目录的相对路径段。
func AuthDirSegments(goos string) []string {
	return authDirSegments(goos)
}

func authDirSegments(goos string) []string {
	switch strings.ToLower(strings.TrimSpace(goos)) {
	case "windows", "win32":
		return []string{"AppData", "Local", "CodeBuddyExtension", "Data", "Public", "auth"}
	case "linux":
		return []string{".local", "share", "CodeBuddyExtension", "Data", "Public", "auth"}
	default:
		return []string{"Library", "Application Support", "CodeBuddyExtension", "Data", "Public", "auth"}
	}
}

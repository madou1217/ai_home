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
	"sync"

	"github.com/madou1217/ai_home/application/accountprojection"
	"github.com/madou1217/ai_home/core/providers"
)

// builtinCatalog 只构造一次：家族存储事实由各 Provider 的 Definition 自己声明，
// 本适配器只负责把合同翻译成投影策略，不再维护 Provider→目录的中央表。
var builtinCatalog = sync.OnceValue(func() *providers.Catalog {
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		return nil
	}
	return catalog
})

func definitionFor(providerID string) (providers.Definition, bool) {
	catalog := builtinCatalog()
	if catalog == nil {
		return providers.Definition{}, false
	}
	definition, found := catalog.Get(normalizeProviderID(providerID))
	if !found || !providers.IsCodeBuddyFamilyProvider(definition.ID) {
		return providers.Definition{}, false
	}
	return definition, true
}

func storageFactsFor(providerID string) (providers.Definition, providers.StorageFacts, bool) {
	definition, ok := definitionFor(providerID)
	if !ok || definition.CLI == nil || definition.Storage == nil {
		return providers.Definition{}, providers.StorageFacts{}, false
	}
	if strings.TrimSpace(definition.CLI.GlobalDir) == "" {
		return providers.Definition{}, providers.StorageFacts{}, false
	}
	return definition, *definition.Storage, true
}

// ProviderIDs 返回家族四支的规范 Provider ID（成员事实在 core/providers）。
func ProviderIDs() []string {
	return providers.CodeBuddyFamilyProviders()
}

// IsFamilyProvider 判断 Provider 是否属于 CodeBuddy 家族。
func IsFamilyProvider(providerID string) bool {
	return providers.IsCodeBuddyFamilyProvider(providerID)
}

// ConfigDir 返回家族成员的 HOME 相对配置目录。
//
// 取值来自每个 Provider 自己的 CLI.GlobalDir；本包不再维护 Provider→目录表。
func ConfigDir(providerID string) (string, bool) {
	definition, ok := definitionFor(providerID)
	if !ok || definition.CLI == nil {
		return "", false
	}
	dirName := strings.TrimSpace(definition.CLI.GlobalDir)
	if dirName == "" {
		return "", false
	}
	return dirName, true
}

// ConfigDirs 返回家族配置目录的规范顺序（与 Node familyConfigDirs 一致）。
func ConfigDirs() []string {
	dirs := make([]string, 0, 4)
	for _, providerID := range ProviderIDs() {
		if dirName, ok := ConfigDir(providerID); ok {
			dirs = append(dirs, dirName)
		}
	}
	return dirs
}

// ProviderForConfigDir 返回配置目录所属的 Provider；未知目录返回 false。
func ProviderForConfigDir(dirName string) (string, bool) {
	normalized := strings.TrimSpace(dirName)
	for _, providerID := range ProviderIDs() {
		if current, ok := ConfigDir(providerID); ok && current == normalized {
			return providerID, true
		}
	}
	return "", false
}

// SessionRoots 返回该 Provider 的会话根候选（HOME 相对，按优先级）。
func SessionRoots(providerID string) []string {
	_, facts, ok := storageFactsFor(providerID)
	if !ok {
		return nil
	}
	return append([]string(nil), facts.SessionRoots...)
}

func normalizeProviderID(providerID string) string {
	return strings.ToLower(strings.TrimSpace(providerID))
}

// Policy 返回指定家族 Provider 的投影策略；未知 Provider 返回 false。
func Policy(providerID string) (accountprojection.Policy, bool) {
	definition, facts, ok := storageFactsFor(providerID)
	if !ok {
		return accountprojection.Policy{}, false
	}
	id := definition.ID
	configDir := strings.TrimSpace(definition.CLI.GlobalDir)
	authPath := append(authDirSegments(runtime.GOOS), facts.DefaultAuthFile)
	return accountprojection.Policy{
		Provider:        id,
		Mode:            accountprojection.ModeFakeHome,
		NativeRoot:      []string{configDir},
		RuntimeHomeRoot: []string{configDir, ".aih-runtime-home"},
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
			{Path: []string{configDir, ".mcp.json"}},
			{Path: []string{configDir, "sessions"}},
			{Path: []string{"Library", "Keychains"}},
		},
		ProjectionRoots: []accountprojection.Mapping{
			{From: []string{configDir}, To: []string{configDir}},
			{From: []string{facts.IDEDataName, "Claw"}, To: []string{facts.IDEDataName, "Claw"}},
		},
		SharedEntries:  familySharedEntries(definition),
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
				Host:       []string{"Library", "Application Support", facts.IDEDataName, "User", "globalStorage", "tencent-cloud.coding-copilot"},
				Platforms:  []string{"darwin"},
			},
			{
				Projection: []string{"electron-user-data", "codebuddy-sessions.vscdb"},
				Host:       []string{"Library", "Application Support", facts.IDEDataName, "codebuddy-sessions.vscdb"},
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
		Env:              familyEnvironment(definition, configDir),
		AttachmentSubdir: []string{"tmp", "model", "images"},
	}, true
}

// familySharedEntries 返回需要链接到宿主的那批共享条目。
//
// CLI 专有条目（settings/statusline/argv/plugins）只属于 .codebuddy / .codebuddy-cn：
// WorkBuddy 桌面根的 settings.json 是 App 自己的 30KB 配置（sandbox/claw/office），
// 与 CLI settings 不是同一个 schema。混在一起会把桌面配置归一成几百字节的 CLI 小
// JSON，与 Node codebuddy-shared-config 的 sharedEntriesForConfigDir 同口径。
func familySharedEntries(definition providers.Definition) []string {
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
	if definition.Family == "codebuddy" {
		entries = append(entries, "settings.json", "statusline-command.sh", "argv.json", "plugins")
	}
	return entries
}

// familyEnvironment 生成伪 HOME 的环境绑定。WorkBuddy 两支额外需要
// WORKBUDDY_CONFIG_DIR（Node codebuddy-strategy 的同一口径）：只设 CODEBUDDY_CONFIG_DIR
// 会让桌面端和 CLI 读到不同配置根。
func familyEnvironment(definition providers.Definition, configDir string) []accountprojection.EnvBinding {
	bindings := []accountprojection.EnvBinding{
		{Key: "HOME", Base: accountprojection.EnvBaseProjectionRoot},
		{Key: "CODEBUDDY_CONFIG_DIR", Base: accountprojection.EnvBaseProjectionRoot, Path: []string{configDir}},
	}
	if definition.Family == "workbuddy" {
		bindings = append(bindings, accountprojection.EnvBinding{
			Key:  "WORKBUDDY_CONFIG_DIR",
			Base: accountprojection.EnvBaseProjectionRoot,
			Path: []string{configDir},
		})
	}
	return bindings
}

// SiteInternal 返回该 Provider 是否固定使用国内站（站点事实在 Definition.Site）。
func SiteInternal(providerID string) bool {
	definition, ok := definitionFor(providerID)
	return ok && definition.Site == providers.SiteCN
}

// DefaultAuthFile 返回该 Provider 默认的 .info 文件名（由 Definition.Storage 声明）。
func DefaultAuthFile(providerID string) string {
	_, facts, ok := storageFactsFor(providerID)
	if !ok {
		return ""
	}
	return facts.DefaultAuthFile
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

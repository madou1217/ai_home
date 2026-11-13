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
	_, ok := layouts[strings.ToLower(strings.TrimSpace(providerID))]
	return ok
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
			{Path: []string{layout.configDir, ".mcp.json"}},
			{Path: []string{layout.configDir, "sessions"}},
			{Path: []string{"Library", "Keychains"}},
			{Path: []string{"electron-user-data"}},
			{Path: []string{".codebuddy", "diagnostics"}},
		},
		ProjectionRoots: []accountprojection.Mapping{
			{From: []string{layout.configDir}, To: []string{layout.configDir}},
			{From: []string{layout.ideDataName, "Claw"}, To: []string{layout.ideDataName, "Claw"}},
		},
		SharedEntries: []string{
			"projects",
			"AGENTS.md",
			"mcp.json",
			"models.json",
			"history.jsonl",
			"file-history",
			"plans",
			"tasks",
			"shell-snapshots",
			"blobs",
			"settings.json",
			"statusline-command.sh",
			"argv.json",
			"plugins",
		},
		SessionEntries: []string{"projects"},
		SharedHostCaches: []accountprojection.SharedLink{
			{Projection: []string{".npm"}, Host: []string{".npm"}},
			{Projection: []string{".local", "bin"}, Host: []string{".local", "bin"}},
			{Projection: []string{"go"}, Host: []string{"go"}},
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
		Env: []accountprojection.EnvBinding{
			{Key: "HOME", Base: accountprojection.EnvBaseProjectionRoot},
			{Key: "CODEBUDDY_CONFIG_DIR", Base: accountprojection.EnvBaseProjectionRoot, Path: []string{layout.configDir}},
		},
		AttachmentSubdir: []string{"tmp", "model", "images"},
	}, true
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

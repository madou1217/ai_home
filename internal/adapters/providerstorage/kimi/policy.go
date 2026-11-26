// Package kimistorage 是 Kimi Code 的账号投影策略与凭据物化适配器。
//
// 策略对齐 Node lib/runtime/provider-storage-policy.js 的 kimi 条目与
// launch-profile/kimi-strategy.js：KIMI_CODE_HOME 指向账号投影的 .kimi-code，
// 凭据/设备号/配置都在该目录内；会话目录与宿主共享，session_index 保持私有
// （CLI 用字符串前缀匹配自己的 KIMI_CODE_HOME，共享索引会显示别人的会话）。
package kimistorage

import (
	"github.com/madou1217/ai_home/application/accountprojection"
	"github.com/madou1217/ai_home/internal/adapters/providerstorage/providerroot"
)

// ProviderID 是 Kimi 的规范 Provider ID。
const ProviderID = "kimi"

// Policy 返回 Kimi 的投影策略。
func Policy() accountprojection.Policy {
	root := providerroot.NativeRoot(ProviderID)
	return accountprojection.Policy{
		Provider:        ProviderID,
		Mode:            accountprojection.ModeConfigDir,
		NativeRoot:      root,
		RuntimeHomeRoot: providerroot.RuntimeHome(ProviderID),
		AuthArtifacts: []accountprojection.Artifact{
			{
				Field:  "credentials",
				Path:   providerroot.NativePath(ProviderID, "credentials", "kimi-code.json"),
				Format: accountprojection.FormatJSON,
			},
			{
				Field:    "deviceId",
				Path:     providerroot.NativePath(ProviderID, "device_id"),
				Format:   accountprojection.FormatText,
				Optional: true,
			},
		},
		PrivateArtifacts: []accountprojection.PathSpec{
			{Path: []string{"electron-user-data"}},
			{Path: providerroot.NativePath(ProviderID, "config.toml")},
			{Path: providerroot.NativePath(ProviderID, "credentials")},
			{Path: providerroot.NativePath(ProviderID, "session_index.jsonl")},
		},
		ProjectionRoots: []accountprojection.Mapping{
			{From: append([]string{}, root...), To: append([]string{}, root...)},
		},
		SharedEntries: []string{
			"sessions", "cache", "logs", "user-history", "updates",
			"workspace-trust", "bin", "telemetry", "oauth", "tui.toml",
			"workspaces.json", "migrations-effort.json",
		},
		SessionEntries: []string{"sessions"},
		PrecreatedDirectories: []string{
			"sessions", "cache", "logs", "user-history", "updates",
			"workspace-trust", "bin", "telemetry",
		},
		// 桌面 daimon bundle 约 600MB/账号；版本戳一致时逐文件硬链接到宿主，
		// 不做整目录 symlink（应用升级会并发往同一目录解压）。
		SharedHostDedupe: []accountprojection.SharedLink{
			{
				Projection: []string{"electron-user-data", "daimon-bundle"},
				Host:       []string{"Library", "Application Support", "kimi-desktop", "daimon-bundle"},
				Platforms:  []string{"darwin"},
				StampFile:  ".daimon-bundle-stamp",
			},
			{
				Projection: []string{"electron-user-data", "daimon-bundle"},
				Host:       []string{"AppData", "Roaming", "kimi-desktop", "daimon-bundle"},
				Platforms:  []string{"windows"},
				StampFile:  ".daimon-bundle-stamp",
			},
		},
		Env: []accountprojection.EnvBinding{
			{Key: "KIMI_CODE_HOME", Base: accountprojection.EnvBaseProjectionRoot, Path: providerroot.NativeRoot(ProviderID)},
		},
		AttachmentSubdir: []string{"tmp", "model", "images"},
	}
}

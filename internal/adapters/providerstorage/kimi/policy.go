// Package kimistorage 是 Kimi Code 的账号投影策略与凭据物化适配器。
//
// 策略对齐 Node lib/runtime/provider-storage-policy.js 的 kimi 条目与
// launch-profile/kimi-strategy.js：KIMI_CODE_HOME 指向账号投影的 .kimi-code，
// 凭据/设备号/配置都在该目录内；会话目录与宿主共享，session_index 保持私有
// （CLI 用字符串前缀匹配自己的 KIMI_CODE_HOME，共享索引会显示别人的会话）。
package kimistorage

import "github.com/madou1217/ai_home/application/accountprojection"

// ProviderID 是 Kimi 的规范 Provider ID。
const ProviderID = "kimi"

// Policy 返回 Kimi 的投影策略。
func Policy() accountprojection.Policy {
	return accountprojection.Policy{
		Provider:        ProviderID,
		Mode:            accountprojection.ModeConfigDir,
		NativeRoot:      []string{".kimi-code"},
		RuntimeHomeRoot: []string{".kimi-code", ".aih-runtime-home"},
		AuthArtifacts: []accountprojection.Artifact{
			{
				Field:  "credentials",
				Path:   []string{".kimi-code", "credentials", "kimi-code.json"},
				Format: accountprojection.FormatJSON,
			},
			{
				Field:    "deviceId",
				Path:     []string{".kimi-code", "device_id"},
				Format:   accountprojection.FormatText,
				Optional: true,
			},
		},
		PrivateArtifacts: []accountprojection.PathSpec{
			{Path: []string{"electron-user-data"}},
			{Path: []string{".kimi-code", "config.toml"}},
			{Path: []string{".kimi-code", "credentials"}},
			{Path: []string{".kimi-code", "session_index.jsonl"}},
		},
		ProjectionRoots: []accountprojection.Mapping{
			{From: []string{".kimi-code"}, To: []string{".kimi-code"}},
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
		Env: []accountprojection.EnvBinding{
			{Key: "KIMI_CODE_HOME", Base: accountprojection.EnvBaseProjectionRoot, Path: []string{".kimi-code"}},
		},
		AttachmentSubdir: []string{"tmp", "model", "images"},
	}
}

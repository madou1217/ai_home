// Package geministorage 是 Gemini 的账号投影策略与凭据物化适配器。
//
// 策略对齐 Node lib/runtime/provider-storage-policy.js 的 gemini 条目与
// lib/cli/services/ai-cli/launch-profile/gemini-strategy.js：
//   - 只隔离 Provider 配置根（GEMINI_CLI_HOME=<投影>/.gemini），HOME 仍是宿主；
//   - oauth_creds.json / google_accounts.json 由账号凭据物化；
//   - history / projects.json / tmp 与会话只链接宿主，保持会话共享。
package geministorage

import "github.com/madou1217/ai_home/application/accountprojection"

// ProviderID 是 Gemini 的规范 Provider ID。
const ProviderID = "gemini"

// Policy 返回 Gemini 的投影策略。
func Policy() accountprojection.Policy {
	return accountprojection.Policy{
		Provider:        ProviderID,
		Mode:            accountprojection.ModeConfigDir,
		NativeRoot:      []string{".gemini"},
		RuntimeHomeRoot: []string{".gemini", ".aih-runtime-home"},
		AuthArtifacts: []accountprojection.Artifact{
			{
				Field:  "oauthCreds",
				Path:   []string{".gemini", "oauth_creds.json"},
				Format: accountprojection.FormatJSON,
			},
			{
				Field:    "googleAccounts",
				Path:     []string{".gemini", "google_accounts.json"},
				Format:   accountprojection.FormatJSON,
				Optional: true,
			},
		},
		PrivateArtifacts: []accountprojection.PathSpec{
			{Path: []string{"Library", "Keychains"}},
		},
		ProjectionRoots: []accountprojection.Mapping{
			{From: []string{".gemini"}, To: []string{".gemini"}},
		},
		SharedEntries:         []string{"history", "projects.json", "tmp"},
		SessionEntries:        []string{"history", "tmp"},
		PrecreatedDirectories: []string{"history", "tmp"},
		Env: []accountprojection.EnvBinding{
			{Key: "GEMINI_CLI_HOME", Base: accountprojection.EnvBaseProjectionRoot, Path: []string{".gemini"}},
			{Key: "GEMINI_CLI_SYSTEM_SETTINGS_PATH", Base: accountprojection.EnvBaseProjectionRoot, Path: []string{".gemini", "settings.json"}},
		},
		AttachmentSubdir: []string{"tmp", "model", "images"},
	}
}

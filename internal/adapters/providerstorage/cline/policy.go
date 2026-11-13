// Package clinestorage 是 Cline 的账号投影策略与凭据物化适配器。
//
// 策略对齐 Node lib/runtime/provider-storage-policy.js 的 cline 条目与
// launch-profile/cline-strategy.js：
//   - CLINE_DIR / CLINE_DATA_DIR 指向账号投影的 .cline；
//   - providers.json 是整库文档（含别的 Provider 密钥），只搬运 cline 槽位；
//   - 不共享宿主条目：凭据库与 secrets.json 都是账号私有。
package clinestorage

import "github.com/madou1217/ai_home/application/accountprojection"

// ProviderID 是 Cline 的规范 Provider ID。
const ProviderID = "cline"

// Policy 返回 Cline 的投影策略。
func Policy() accountprojection.Policy {
	return accountprojection.Policy{
		Provider:        ProviderID,
		Mode:            accountprojection.ModeConfigDir,
		NativeRoot:      []string{".cline"},
		RuntimeHomeRoot: []string{".cline", ".aih-runtime-home"},
		AuthArtifacts: []accountprojection.Artifact{
			{
				Field:  "auth",
				Path:   []string{".cline", "data", "settings", "providers.json"},
				Format: accountprojection.FormatJSON,
			},
		},
		PrivateArtifacts: []accountprojection.PathSpec{
			{Path: []string{"electron-user-data"}},
			{Path: []string{".cline", "data", "settings"}},
			{Path: []string{".cline", "data", "secrets.json"}},
			{Path: []string{"Library", "Keychains"}},
		},
		Env: []accountprojection.EnvBinding{
			{Key: "CLINE_DIR", Base: accountprojection.EnvBaseProjectionRoot, Path: []string{".cline"}},
			{Key: "CLINE_DATA_DIR", Base: accountprojection.EnvBaseProjectionRoot, Path: []string{".cline", "data"}},
		},
		AttachmentSubdir: []string{"tmp", "model", "images"},
	}
}

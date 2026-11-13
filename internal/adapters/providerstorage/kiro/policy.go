// Package kirostorage 是 Kiro CLI 的账号投影策略与凭据物化适配器。
//
// Kiro 跑在真实 HOME 下，会话/设置都用宿主原生 ~/.kiro；账号之间只换凭据库
// （KIRO_TEST_DB_PATH 指向账号目录里的 data.sqlite3）。投影根因此只承载一份数据库。
package kirostorage

import "github.com/madou1217/ai_home/application/accountprojection"

// ProviderID 是 Kiro 的规范 Provider ID。
const ProviderID = "kiro"

// Policy 返回 Kiro 的投影策略。
func Policy() accountprojection.Policy {
	return accountprojection.Policy{
		Provider:        ProviderID,
		Mode:            accountprojection.ModeConfigDir,
		NativeRoot:      []string{},
		RuntimeHomeRoot: []string{".aih-runtime-home"},
		AuthArtifacts: []accountprojection.Artifact{
			{
				Field:  "database",
				Path:   []string{"data.sqlite3"},
				Format: accountprojection.FormatBinaryBase64,
			},
		},
		PrivateArtifacts: []accountprojection.PathSpec{
			{Path: []string{"electron-user-data"}},
			{Path: []string{".aih-kiro-auth-binding"}},
		},
		Env: []accountprojection.EnvBinding{
			{Key: "KIRO_TEST_DB_PATH", Base: accountprojection.EnvBaseProjectionRoot, Path: []string{"data.sqlite3"}},
		},
		AttachmentSubdir: []string{"tmp", "model", "images"},
	}
}

// Package zcodestorage 是 ZCode 的账号投影策略与凭据物化适配器。
//
// 策略对齐 Node lib/runtime/provider-storage-policy.js 的 zcode 条目与
// launch-profile/zcode-strategy.js：
//   - HOME 与 ZCODE_DATA_BASE_DIR 都指向账号沙箱（CLI 在 base 下再拼 .zcode/v2）；
//   - credentials.json / config.json 由账号凭据物化，客户端原地续期时保留磁盘值；
//   - cli/ 与 workspace/ 会话状态与宿主共享。
package zcodestorage

import "github.com/madou1217/ai_home/application/accountprojection"

// ProviderID 是 ZCode 的规范 Provider ID。
const ProviderID = "zcode"

// Policy 返回 ZCode 的投影策略。
func Policy() accountprojection.Policy {
	return accountprojection.Policy{
		Provider:        ProviderID,
		Mode:            accountprojection.ModeFakeHome,
		NativeRoot:      []string{".zcode"},
		RuntimeHomeRoot: []string{".zcode", ".aih-runtime-home"},
		AuthArtifacts: []accountprojection.Artifact{
			{
				Field:     "credentials",
				Path:      []string{".zcode", "v2", "credentials.json"},
				Format:    accountprojection.FormatJSON,
				LiveStore: true,
			},
			{
				Field:    "config",
				Path:     []string{".zcode", "v2", "config.json"},
				Format:   accountprojection.FormatJSON,
				Optional: true,
			},
		},
		PrivateArtifacts: []accountprojection.PathSpec{
			{Path: []string{"electron-user-data"}},
			{Path: []string{"Library", "Keychains"}},
		},
		ProjectionRoots: []accountprojection.Mapping{
			{From: []string{".zcode"}, To: []string{".zcode"}},
		},
		SharedEntries:         []string{"cli", "workspace"},
		PrecreatedDirectories: []string{"cli", "workspace"},
		Env: []accountprojection.EnvBinding{
			{Key: "HOME", Base: accountprojection.EnvBaseProjectionRoot},
			{Key: "ZCODE_DATA_BASE_DIR", Base: accountprojection.EnvBaseProjectionRoot},
		},
		AttachmentSubdir: []string{"tmp", "model", "images"},
	}
}

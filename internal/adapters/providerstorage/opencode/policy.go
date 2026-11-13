// Package opencodestorage 是 OpenCode 的账号投影策略与凭据物化适配器。
//
// 对齐 Node lib/runtime/provider-storage-policy.js 的 opencode 条目与
// launch-profile/opencode-strategy.js：
//   - XDG_DATA_HOME 指向账号沙箱里的 bridge 目录，bridge/opencode 下的共享条目
//     逐项链回宿主 ~/.local/share/opencode（auth.json 除外，保持账号私有）；
//   - auth.json 由账号凭据物化，并通过符号链接暴露给 bridge。
package opencodestorage

import (
	"github.com/madou1217/ai_home/application/accountprojection"
	"github.com/madou1217/ai_home/internal/runtime/storagepolicy"
)

// ProviderID 是 OpenCode 的规范 Provider ID。
const ProviderID = "opencode"

// bridgeProjection 是 bridge 中 opencode 数据目录的投影路径。
var bridgeProjection = []string{".local", "share", "aih-opencode-runtime", "opencode"}

// Policy 返回 OpenCode 的投影策略。
func Policy() accountprojection.Policy {
	return accountprojection.Policy{
		Provider:        ProviderID,
		Mode:            accountprojection.ModeConfigDir,
		NativeRoot:      []string{".local", "share", "opencode"},
		RuntimeHomeRoot: []string{".local", "share", "opencode", ".aih-runtime-home"},
		AuthArtifacts: []accountprojection.Artifact{
			{
				Field:  "auth",
				Path:   []string{".local", "share", "opencode", "auth.json"},
				Format: accountprojection.FormatJSON,
			},
		},
		PrivateArtifacts: []accountprojection.PathSpec{
			{Path: []string{"electron-user-data"}},
			{Path: []string{".local", "share", "aih-opencode-runtime", "opencode", "auth.json"}},
			{Path: []string{".config", "opencode", "auth.json"}},
			{Path: []string{"Library", "Keychains"}},
		},
		SharedHostCaches: []accountprojection.SharedLink{
			{
				// 目录级共享：宿主每个子项链进 bridge，凭据文件排除在外。
				Projection: bridgeProjection,
				Host:       []string{".local", "share", "opencode"},
				Exclude:    storagepolicy.PrivateEntryNames(ProviderID),
			},
		},
		Env: []accountprojection.EnvBinding{
			{Key: "XDG_DATA_HOME", Base: accountprojection.EnvBaseProjectionRoot, Path: []string{".local", "share", "aih-opencode-runtime"}},
			{Key: "XDG_CONFIG_HOME", Base: accountprojection.EnvBaseHostHome, Path: []string{".config"}},
			{Key: "XDG_STATE_HOME", Base: accountprojection.EnvBaseHostHome, Path: []string{".local", "state"}},
		},
		AttachmentSubdir: []string{"tmp", "model", "images"},
	}
}

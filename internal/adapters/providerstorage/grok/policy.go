// Package grokstorage 是 Grok（build-cli）的账号投影策略与凭据物化适配器。
//
// 策略对齐 Node lib/runtime/provider-storage-policy.js 的 grok 条目与
// launch-profile/grok-strategy.js：
//   - GROK_HOME 指向账号投影的 .grok（ENV 隔离，HOME 仍是宿主）；
//   - auth.json 由账号凭据物化；sessions/cache/log 与宿主共享。
package grokstorage

import "github.com/madou1217/ai_home/application/accountprojection"

// ProviderID 是 Grok 的规范 Provider ID。
const ProviderID = "grok"

// Policy 返回 Grok 的投影策略。
func Policy() accountprojection.Policy {
	return accountprojection.Policy{
		Provider:        ProviderID,
		Mode:            accountprojection.ModeConfigDir,
		NativeRoot:      []string{".grok"},
		RuntimeHomeRoot: []string{".grok", ".aih-runtime-home"},
		AuthArtifacts: []accountprojection.Artifact{
			{
				Field:  "auth",
				Path:   []string{".grok", "auth.json"},
				Format: accountprojection.FormatJSON,
			},
		},
		PrivateArtifacts: []accountprojection.PathSpec{
			{Path: []string{"Library", "Keychains"}},
		},
		ProjectionRoots: []accountprojection.Mapping{
			{From: []string{".grok"}, To: []string{".grok"}},
		},
		SharedEntries:         []string{"sessions", "cache", "log"},
		SessionEntries:        []string{"sessions"},
		PrecreatedDirectories: []string{"sessions", "cache", "log"},
		Env: []accountprojection.EnvBinding{
			{Key: "GROK_HOME", Base: accountprojection.EnvBaseProjectionRoot, Path: []string{".grok"}},
		},
		AttachmentSubdir: []string{"tmp", "model", "images"},
	}
}

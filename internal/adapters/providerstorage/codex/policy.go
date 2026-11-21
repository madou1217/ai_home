// Package codexstorage 是 Codex 的账号投影策略与凭据物化适配器。
//
// 策略对齐 Node lib/runtime/provider-storage-policy.js 的 codex 条目：
//   - OAuth 账号隔离 CODEX_HOME（.codex/auth.json），会话/SQLite 仍指向宿主 .codex；
//   - API Key 账号同样隔离 CODEX_HOME，但投影里**没有 auth.json、也没有配置的
//     [.auth] 命令表**（config.toml 属私有 artifact，不从宿主复制）：启动参数用
//     env_key 传账号 key，而宿主配置的 auth 命令表与 env_key 互斥（codex ≥0.149）。
package codexstorage

import (
	"github.com/madou1217/ai_home/application/accountprojection"
	"github.com/madou1217/ai_home/internal/adapters/providerstorage/providerroot"
)

// Policy 返回 Codex 的投影策略。
func Policy() accountprojection.Policy {
	root := providerroot.NativeRoot("codex")
	return accountprojection.Policy{
		Provider:        "codex",
		Mode:            accountprojection.ModeConfigDir,
		NativeRoot:      root,
		RuntimeHomeRoot: providerroot.RuntimeHome("codex"),
		AuthArtifacts: []accountprojection.Artifact{
			{
				Field:  "auth",
				Path:   providerroot.NativePath("codex", "auth.json"),
				Format: accountprojection.FormatJSON,
			},
		},
		PrivateArtifacts: []accountprojection.PathSpec{
			{Path: providerroot.NativePath("codex", "config.toml")},
		},
		ProjectionRoots: []accountprojection.Mapping{
			{From: append([]string{}, root...), To: append([]string{}, root...)},
		},
		SharedEntries: []string{
			"sessions",
			"history.jsonl",
			"archived_sessions",
			"shell_snapshots",
			"version.json",
			"models_cache.json",
			".personality_migration",
			"log",
			"memories",
			"rules",
			"skills",
			"sqlite",
			"prompts",
			"worktrees",
			"automations",
			"backup",
			"vendor_imports",
			"internal_storage.json",
			"AGENTS.md",
			".tmp",
			"cache",
			"tmp",
			"session_index.jsonl",
		},
		SessionEntries: []string{"sessions", "archived_sessions", "session_index.jsonl"},
		PrecreatedDirectories: []string{
			"sessions",
			"archived_sessions",
			"shell_snapshots",
			"log",
			"memories",
			"rules",
			"skills",
			"sqlite",
			"prompts",
			"worktrees",
			"automations",
			"backup",
			"vendor_imports",
			".tmp",
			"cache",
			"tmp",
		},
		Env: []accountprojection.EnvBinding{
			{Key: "CODEX_HOME", Base: accountprojection.EnvBaseProjectionRoot, Path: providerroot.NativeRoot("codex")},
			{Key: "CODEX_SQLITE_HOME", Base: accountprojection.EnvBaseHostNativeRoot},
		},
		AttachmentSubdir: []string{".tmp", "model", "images"},
	}
}

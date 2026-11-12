// Package codexstorage 是 Codex 的账号投影策略与凭据物化适配器。
//
// 策略对齐 Node lib/runtime/provider-storage-policy.js 的 codex 条目：
//   - OAuth 账号隔离 CODEX_HOME（.codex/auth.json），会话/SQLite 仍指向宿主 .codex；
//   - API Key 账号不在这里投影（沿用 providerlaunch 的启动参数路径）。
package codexstorage

import "github.com/madou1217/ai_home/application/accountprojection"

// Policy 返回 Codex 的投影策略。
func Policy() accountprojection.Policy {
	return accountprojection.Policy{
		Provider:        "codex",
		Mode:            accountprojection.ModeConfigDir,
		NativeRoot:      []string{".codex"},
		RuntimeHomeRoot: []string{".codex", ".aih-runtime-home"},
		AuthArtifacts: []accountprojection.Artifact{
			{
				Field:  "auth",
				Path:   []string{".codex", "auth.json"},
				Format: accountprojection.FormatJSON,
			},
		},
		PrivateArtifacts: []accountprojection.PathSpec{
			{Path: []string{".codex", "config.toml"}},
		},
		ProjectionRoots: []accountprojection.Mapping{
			{From: []string{".codex"}, To: []string{".codex"}},
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
			{Key: "CODEX_HOME", Base: accountprojection.EnvBaseProjectionRoot, Path: []string{".codex"}},
			{Key: "CODEX_SQLITE_HOME", Base: accountprojection.EnvBaseHostNativeRoot},
		},
		AttachmentSubdir: []string{".tmp", "model", "images"},
	}
}

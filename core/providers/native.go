package providers

// nativeCodex 描述 Codex 原生配置、会话和权限边界。
func nativeCodex() *NativeCapability {
	return &NativeCapability{
		Config: NativeConfig{
			EnvHomeKeys:     []string{"CODEX_HOME"},
			UserSettings:    []string{"config.toml"},
			ProjectSettings: []string{".codex/config.toml"},
			CLIFlags:        []string{"--profile", "--config"},
		},
		Sessions: NativeSessions{
			Flags:       []string{"resume", "fork"},
			NativeStore: "state_*.sqlite",
		},
		MCP: NativeMCP{
			Commands:    []string{"mcp"},
			ConfigFiles: []string{"config.toml"},
		},
		Hooks: NativeHooks{
			Files:                  []string{"hooks.json"},
			StopRequiresJSONStdout: true,
		},
		Permissions: NativePermissions{
			Flags: []string{"--sandbox", "--ask-for-approval"},
			Modes: []string{"read-only", "workspace-write", "danger-full-access"},
		},
	}
}

// nativeClaude 描述 Claude Code 原生配置、会话和权限边界。
func nativeClaude() *NativeCapability {
	return &NativeCapability{
		Config: NativeConfig{
			EnvHomeKeys:     []string{"CLAUDE_CONFIG_DIR"},
			UserSettings:    []string{"settings.json"},
			ProjectSettings: []string{".claude/settings.json", ".claude/settings.local.json"},
			CLIFlags:        []string{"--settings", "--setting-sources"},
		},
		Sessions: NativeSessions{
			Flags:       []string{"--continue", "--resume", "--session-id", "--fork-session"},
			NativeStore: "projects/<project>/<session-id>.jsonl",
		},
		MCP: NativeMCP{
			Commands:    []string{"mcp"},
			ConfigFiles: []string{".mcp.json", ".claude.json"},
		},
		Hooks: NativeHooks{
			Files:                  []string{"settings.json", "plugins/hooks.json"},
			StopRequiresJSONStdout: true,
		},
		Permissions: NativePermissions{
			Flags: []string{"--permission-mode", "--allowedTools", "--disallowedTools"},
			Modes: []string{"default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"},
		},
	}
}

// nativeGemini 描述 Gemini CLI 原生配置、会话和权限边界。
func nativeGemini() *NativeCapability {
	return &NativeCapability{
		Config: NativeConfig{
			EnvHomeKeys:     []string{"GEMINI_CLI_SYSTEM_SETTINGS_PATH"},
			UserSettings:    []string{"settings.json"},
			ProjectSettings: []string{".gemini/settings.json"},
			CLIFlags:        []string{"--model", "--approval-mode", "--policy", "--admin-policy"},
		},
		Sessions: NativeSessions{
			// --session-file：按绝对路径加载某段会话（绕开 cwd → projectHash 的发现机制，
			// 持久会话重启恢复用这条；见 lib/runtime/provider-resume.js）。
			Flags:       []string{"--resume", "--session-id", "--list-sessions", "--session-file"},
			NativeStore: "sessions",
		},
		MCP: NativeMCP{
			Commands:    []string{"mcp"},
			ConfigFiles: []string{"settings.json"},
		},
		Hooks: NativeHooks{
			Files:                  []string{"settings.json"},
			StopRequiresJSONStdout: true,
		},
		Permissions: NativePermissions{
			Flags: []string{"--approval-mode", "--policy", "--admin-policy"},
			Modes: []string{"default", "auto_edit", "yolo", "plan"},
		},
	}
}

// nativeAntigravity 描述 Antigravity 原生配置、会话和权限边界。
func nativeAntigravity() *NativeCapability {
	return &NativeCapability{
		Config: NativeConfig{
			EnvHomeKeys:     []string{"HOME"},
			UserSettings:    []string{".gemini/antigravity-cli/settings.json"},
			ProjectSettings: []string{".agents/settings.json"},
			CLIFlags:        []string{"--sandbox", "--conversation", "--continue"},
		},
		Sessions: NativeSessions{
			Flags:       []string{"--continue", "--conversation"},
			NativeStore: "workspace-scoped conversations",
		},
		MCP: NativeMCP{
			Commands: []string{"/mcp"},
			ConfigFiles: []string{
				".gemini/antigravity-cli/mcp_config.json",
				".agents/mcp_config.json",
			},
		},
		Hooks: NativeHooks{
			Files: []string{
				".gemini/config/hooks.json",
				".agents/hooks.json",
				".gemini/config/plugins/*/hooks.json",
				".gemini/antigravity-cli/plugins/*/hooks.json",
			},
			StopRequiresJSONStdout: true,
		},
		Permissions: NativePermissions{
			Flags: []string{"--sandbox", "--dangerously-skip-permissions"},
			Modes: []string{"allow", "ask", "deny"},
		},
	}
}

// nativeGrok 描述 Grok CLI 原生配置、会话和权限边界。
func nativeGrok() *NativeCapability {
	return &NativeCapability{
		Config: NativeConfig{
			EnvHomeKeys:     []string{"GROK_HOME"},
			UserSettings:    []string{"config.toml"},
			ProjectSettings: []string{".grok/config.toml"},
			CLIFlags:        []string{"--model", "--permission-mode"},
		},
		Sessions: NativeSessions{
			Flags:       []string{"--continue", "--resume", "--session-id"},
			NativeStore: "sessions",
		},
		MCP: NativeMCP{
			Commands:    []string{"mcp"},
			ConfigFiles: []string{".grok/mcp.json"},
		},
		Hooks: NativeHooks{
			Files:                  []string{".grok/hooks.json"},
			StopRequiresJSONStdout: true,
		},
		Permissions: NativePermissions{
			Flags: []string{"--sandbox", "--permission-mode"},
			Modes: []string{"default", "acceptEdits", "auto", "dontAsk", "bypassPermissions", "plan"},
		},
	}
}

// nativeKimi 描述 Kimi Code 原生配置、会话和权限边界。
func nativeKimi() *NativeCapability {
	return &NativeCapability{
		Config: NativeConfig{
			EnvHomeKeys:     []string{"KIMI_CODE_HOME"},
			UserSettings:    []string{"config.toml"},
			ProjectSettings: []string{},
			CLIFlags:        []string{"--model", "--plan"},
		},
		Sessions: NativeSessions{
			Flags:       []string{"-c", "-C", "/sessions"},
			NativeStore: "sessions",
		},
		MCP: NativeMCP{
			Commands:    []string{},
			ConfigFiles: []string{},
		},
		Hooks: NativeHooks{
			Files:                  []string{},
			StopRequiresJSONStdout: false,
		},
		Permissions: NativePermissions{
			Flags: []string{"--yolo"},
			Modes: []string{"default", "yolo", "plan"},
		},
	}
}

// nativeKiro 描述 Kiro CLI 原生配置、会话和权限边界。
func nativeKiro() *NativeCapability {
	return &NativeCapability{
		Config: NativeConfig{
			EnvHomeKeys:     []string{"KIRO_HOME"},
			UserSettings:    []string{"settings/mcp.json"},
			ProjectSettings: []string{".kiro/settings/mcp.json"},
			CLIFlags:        []string{"--model", "--effort"},
		},
		Sessions: NativeSessions{
			Flags:       []string{"/rewind", "/chat new"},
			NativeStore: "data.sqlite3",
		},
		MCP: NativeMCP{
			Commands:    []string{"mcp"},
			ConfigFiles: []string{"settings/mcp.json"},
		},
		Hooks: NativeHooks{
			Files:                  []string{},
			StopRequiresJSONStdout: false,
		},
		Permissions: NativePermissions{
			Flags: []string{},
			Modes: []string{"default"},
		},
	}
}

// nativeCline 描述 Cline CLI 原生配置、会话和权限边界。
//
// 配置/状态两个根各有一个 env（CLINE_DIR / CLINE_DATA_DIR）与同名 CLI 参数
// （--config / --data-dir）。会话身份与历史都落在 <CLINE_DATA_DIR>/db/sessions.db
// （会话目录 <CLINE_DATA_DIR>/sessions/<session-id>/），恢复会话的入口是
// `--id <session-id>`（`cline --help` 实测；没有 `--resume` / `--continue`）。
// MCP 只有 `mcp` 子命令；hook 入口（`hook` + --hooks-dir）aih 尚未接入，
// 权限模型未验证，因此这几项留空而不是猜测。
func nativeCline() *NativeCapability {
	return &NativeCapability{
		Config: NativeConfig{
			EnvHomeKeys:     []string{"CLINE_DIR", "CLINE_DATA_DIR"},
			UserSettings:    []string{"data/settings/providers.json"},
			ProjectSettings: []string{},
			CLIFlags:        []string{"--config", "--data-dir"},
		},
		Sessions: NativeSessions{
			Flags:       []string{"--id"},
			NativeStore: "data/db/sessions.db",
		},
		MCP: NativeMCP{
			Commands:    []string{"mcp"},
			ConfigFiles: []string{},
		},
		Hooks: NativeHooks{
			Files:                  []string{},
			StopRequiresJSONStdout: false,
		},
		Permissions: NativePermissions{
			Flags: []string{},
			Modes: []string{},
		},
	}
}

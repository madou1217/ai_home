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
			Flags:       []string{"--resume", "--session-id", "--list-sessions"},
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

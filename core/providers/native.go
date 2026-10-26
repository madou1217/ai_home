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
			Projection:  &NativeMCPProjection{Path: "config.toml", Format: "toml-stdio"},
			Commands:    []string{"mcp"},
			ConfigFiles: []string{"config.toml"},
		},
		Plugins: NativePlugins{Adapter: "codex-marketplace", Commands: []string{"plugin"}, Mode: "native"},
		Skills:  NativeSkills{Paths: []string{"skills"}, Mode: "native"},
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
			Projection:  &NativeMCPProjection{Path: ".claude.json", Format: "json-stdio"},
			Commands:    []string{"mcp"},
			ConfigFiles: []string{".mcp.json", ".claude.json"},
		},
		Plugins: NativePlugins{Adapter: "claude-skills-dir", Paths: []string{"plugins"}, Mode: "native"},
		Skills:  NativeSkills{Paths: []string{"skills"}, Mode: "native"},
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
			Projection:  &NativeMCPProjection{Path: "settings.json", Format: "json-command"},
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
			Projection: &NativeMCPProjection{Path: "mcp_config.json", Format: "json-command"},
			Commands:   []string{"/mcp"},
			ConfigFiles: []string{
				".gemini/antigravity-cli/mcp_config.json",
				".agents/mcp_config.json",
			},
		},
		// Existing AIH instruction projection; no claim of native skill execution.
		Skills: NativeSkills{Paths: []string{".gemini/GEMINI.md"}, PathBase: "host-home", Mode: "projection-only"},
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
//
// 权限旗标（kimi 2.2.0 的 --help 原文，2026-10-21 实测）：
//   - 不带旗标 = Always Ask：执行命令/改文件前都问；
//   - `-y` / `--yolo` = Ask When Needed：常规编辑与命令自动执行，但有风险的操作、提问与计划仍会问；
//   - `--auto` = Never Ask：不再打断，一切自动决定。
//
// 所以「不再询问」对应 `--auto`，不是 `--yolo` —— 只声明 `--yolo` 会让最大权限注入成一个
// 官方说明里仍会询问的旗标。Modes 用 kimi 自己配置里的取值（PermissionModeSchema：
// yolo / manual / auto），不自造名称。
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
			Flags: []string{"--auto", "--yolo"},
			Modes: []string{"manual", "yolo", "auto"},
		},
	}
}

// nativeKiro 描述 Kiro CLI 原生配置、会话和权限边界。
// nativeKiro 描述 Kiro CLI 原生配置、会话和权限边界。
//
// 权限旗标（kiro-cli 2.32.0 的 `chat --help` 原文，2026-10-22 实测）：
//   - `-a, --trust-all-tools`：Allows the model to use any tool to run commands without
//     asking for confirmation（等价于「不再询问」）；
//   - `--trust-tools <TOOL_NAMES>`：只信任名单里的工具（`--trust-tools=` 表示一个都不信任）。
//
// 这两个旗标属于 **chat 子命令**，不是根命令：`kiro-cli -a` 退出码 2（被拒）、
// `kiro-cli chat -a` 退出码 0；agent / settings 也不接受。因此落点由
// lib/runtime/kiro-permission-args.js 声明（插在 `chat` 之后）。
// kiro 没有「模式枚举」这种形态（不像 claude 的 --permission-mode 收一个值），
// 所以 Modes 留空而不是编造：能力边界如实表达。
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
			Projection:  &NativeMCPProjection{Path: "settings/mcp.json", Format: "json-command"},
			Commands:    []string{"mcp"},
			ConfigFiles: []string{"settings/mcp.json"},
		},
		Hooks: NativeHooks{
			Files:                  []string{},
			StopRequiresJSONStdout: false,
		},
		Permissions: NativePermissions{
			Flags: []string{"--trust-all-tools", "--trust-tools"},
			Modes: []string{},
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
			Projection:  &NativeMCPProjection{Path: "data/settings/cline_mcp_settings.json", Format: "json-cline", AccountScoped: true},
			Commands:    []string{"mcp"},
			ConfigFiles: []string{"data/settings/cline_mcp_settings.json"},
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

// nativeOpenCode 描述 OpenCode CLI 原生配置、会话和权限边界。
//
// OpenCode 走 XDG 布局：config = $XDG_CONFIG_HOME/opencode/opencode.json、
// data = $XDG_DATA_HOME/opencode/（auth.json、opencode.db、log/、repos/、storage/）。
// 启动隔离只把 auth.json 留在账号投影里，其余数据与宿主共用同一份（见
// launch-profile/opencode-strategy.js）。会话身份在 opencode.db；恢复入口是
// `-c/--continue`（最近一段）与 `-s/--session <id>`（精确），另有 `--fork`（实测
// `opencode run --help`）。MCP 有 `mcp` 子命令（add/list/auth/logout/debug），配置写在
// opencode.json；hook 走插件文件 <configDir>/plugin/aih-session-hook.js（aih 已接入，
// 见 sessionSync 的 opencode_plugin）。权限决策有两套入口：serve 的 permission 应答
// （once/reject）与 CLI 的 `--auto`（“Auto-approve permissions that are not explicitly
// denied”，TUI 与 run 都接受，2.0.x 实测）。这里只声明后者；显式 deny 规则仍然优先。
func nativeOpenCode() *NativeCapability {
	return &NativeCapability{
		Config: NativeConfig{
			EnvHomeKeys:     []string{"OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT"},
			UserSettings:    []string{"opencode.json"},
			ProjectSettings: []string{},
			CLIFlags:        []string{"--model", "--agent"},
		},
		Sessions: NativeSessions{
			Flags:       []string{"--continue", "--session", "--fork"},
			NativeStore: "opencode.db",
		},
		MCP: NativeMCP{
			Projection:  &NativeMCPProjection{Path: ".config/opencode/opencode.json", PathBase: "host-home", Alternatives: []string{".config/opencode/opencode.jsonc"}, Format: "json-opencode"},
			Commands:    []string{"mcp"},
			ConfigFiles: []string{"opencode.json"},
		},
		Plugins: NativePlugins{Adapter: "opencode-local", Paths: []string{"plugin"}, PathBase: "host-home", Mode: "native"},
		Skills:  NativeSkills{Paths: []string{".config/opencode/AGENTS.md"}, PathBase: "host-home", Mode: "projection-only"},
		Hooks: NativeHooks{
			Files:                  []string{"plugin/aih-session-hook.js"},
			StopRequiresJSONStdout: false,
		},
		Permissions: NativePermissions{
			Flags: []string{"--auto"},
			Modes: []string{"auto"},
		},
	}
}

// nativeCodebuddy 描述 CodeBuddy 家族（codebuddy / codebuddycn / workbuddy /
// workbuddycn）原生配置、会话和权限边界。
//
// 四支共用同一内核（CodeBuddy Code，Claude Code 的衍生实现），磁盘布局同构、只有配置根名
// 与站点不同（见 runtime/codebuddy-family-layouts.js 与 launch-profile/codebuddy-strategy.js）：
// configDir 由 CODEBUDDY_CONFIG_DIR 选择（workbuddy* 另有 WORKBUDDY_CONFIG_DIR），CLI 自己
// 在其中 bootstrap settings.json / plugins / logs；会话落
// <configDir>/projects/<sanitized-cwd>/<session-id>.jsonl（与 Claude Code 同构）。
// 恢复入口：`-c/--continue`、`-r/--resume [sessionId]`、`--session-id <uuid>`（实测
// `codebuddy --help`）。MCP 有 `mcp` 子命令与 `--mcp-config`；权限用 `--permission-mode`
// 的六个模式 + 工具白/黑名单。hook：内核有 hooks（`--debug hooks` 可见），但 aih 未接入、
// 配置文件未验证，故留空而不是猜一个路径。
func nativeCodebuddy() *NativeCapability {
	return &NativeCapability{
		Config: NativeConfig{
			EnvHomeKeys:     []string{"CODEBUDDY_CONFIG_DIR", "WORKBUDDY_CONFIG_DIR"},
			UserSettings:    []string{"settings.json"},
			ProjectSettings: []string{},
			CLIFlags:        []string{"--model", "--permission-mode", "--mcp-config"},
		},
		Sessions: NativeSessions{
			Flags:       []string{"--continue", "--resume", "--session-id"},
			NativeStore: "projects/<project>/<session-id>.jsonl",
		},
		MCP: NativeMCP{
			Commands:    []string{"mcp"},
			ConfigFiles: []string{},
		},
		Plugins: NativePlugins{Adapter: "native-directory", Commands: []string{"plugin"}, Paths: []string{"plugins"}, Mode: "native"},
		Skills:  NativeSkills{Paths: []string{"skills"}, Mode: "native"},
		Hooks: NativeHooks{
			Files:                  []string{},
			StopRequiresJSONStdout: false,
		},
		Permissions: NativePermissions{
			Flags: []string{"--permission-mode", "--allowedTools", "--disallowedTools", "--dangerously-skip-permissions"},
			Modes: []string{"default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"},
		},
	}
}

// CodeBuddy 2.177.0 uses the native marketplace and user .mcp.json.
// The older WorkBuddy bundle has its own verified projection below.
func nativeCodebuddyCLI() *NativeCapability {
	native := nativeCodebuddy()
	native.Plugins.Adapter = "native-marketplace"
	native.MCP = NativeMCP{
		Projection:  &NativeMCPProjection{Path: ".mcp.json", Format: "json-stdio"},
		Commands:    []string{"mcp"},
		ConfigFiles: []string{".mcp.json"},
	}
	return native
}

func nativeCodebuddyCNCLI() *NativeCapability {
	native := nativeCodebuddyCLI()
	native.Runtime = &NativeResourceRuntime{Handler: "native-cli", Env: map[string]string{
		"CODEBUDDY_INTERNET_ENVIRONMENT":         "internal",
		"CODEBUDDY_COPILOT_INTERNET_ENVIRONMENT": "internal",
	}}
	return native
}

func nativeWorkbuddy() *NativeCapability {
	native := nativeCodebuddy()
	native.Plugins.Adapter = "native-marketplace"
	native.MCP = NativeMCP{
		Projection:  &NativeMCPProjection{Path: ".codebuddy.json", Format: "json-stdio"},
		Commands:    []string{"mcp"},
		ConfigFiles: []string{".codebuddy.json"},
	}
	native.Runtime = &NativeResourceRuntime{
		Handler: "desktop-node",
		Entry:   "Contents/Resources/app.asar.unpacked/cli/bin/codebuddy",
		Env:     map[string]string{"CODEBUDDY_FORCE_LITE_WB_BUNDLE": "1"},
	}
	return native
}

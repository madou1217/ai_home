package providers

//go:generate go run ../../cmd/provider-manifest --root ../..

// BuiltinManifest 返回 AI Home 当前内置 Provider 的唯一人工维护定义源。
//
// 修改 Provider 身份、认证方式或声明式能力后必须运行 `go generate ./core/providers`，
// 由生成器同步 Node 合同和 TypeScript Client 投影。
func BuiltinManifest() Manifest {
	return Manifest{
		SchemaVersion: SchemaVersion,
		GeneratedFrom: "core/providers/builtins.go",
		Providers: []Definition{
			builtinCodex(),
			builtinGemini(),
			builtinClaude(),
			builtinAntigravity(),
			builtinOpenCode(),
			builtinGrok(),
			builtinQoder(),
			builtinQoderCN(),
			builtinKimi(),
			builtinKiro(),
		},
		Fallback: Presentation{
			ID:                "codex",
			Label:             "AI",
			Short:             "AI",
			TerminalIcon:      "◌",
			TerminalIconAsset: "web/src/assets/brand/ai-home-mark.png",
			AccentVar:         "var(--color-brand)",
			SoftVar:           "var(--color-brand-soft)",
			TagColor:          "blue",
		},
	}
}

// builtinCodex 定义 Codex/ChatGPT 的稳定身份和声明式能力。
func builtinCodex() Definition {
	return Definition{
		ID:           "codex",
		Presentation: presentation("codex", "ChatGPT", "GPT", "◎", "green"),
		Gateway:      GatewayActive,
		Capabilities: []Capability{CapabilityAPIKeyAccount, CapabilityModelCatalog, CapabilityQuotaUsage},
		AuthOptions: []AuthOption{
			authOption(AuthModeOAuthBrowser, "ChatGPT / OpenAI 登录", "打开授权链接，授权后把回调地址提交给 WebUI。"),
			authOption(AuthModeOAuthDevice, "设备码登录", "仅在账号支持 device auth 时使用，适合远程环境。"),
			authOption(AuthModeAPIKey, "OpenAI 密钥", "绑定 OPENAI_API_KEY / OPENAI_BASE_URL。"),
		},
		SessionSync: SessionSync{
			Mode:       SessionSyncHook,
			Adapter:    "json_hooks",
			TargetKind: "hooks.json",
			Events:     []string{"SessionStart", "UserPromptSubmit", "Stop"},
		},
		CLI: &CLIConfig{
			Order:     4,
			GlobalDir: ".codex",
			LoginArgs: []string{"login"},
			Package:   "@openai/codex",
			EnvKeys:   []string{"OPENAI_API_KEY", "OPENAI_BASE_URL"},
			DesktopClient: &DesktopClient{
				MacOS: &DesktopPlatform{
					ClientName:   "Codex",
					ExecNames:    []string{"ChatGPT", "Codex"},
					PathIncludes: []string{"/ChatGPT.app/Contents/MacOS/", "/Codex.app/Contents/MacOS/"},
					BundleID:     "com.openai.codex",
					InstallPaths: []string{
						"/Applications/ChatGPT.app",
						"{hostHomeDir}/Applications/ChatGPT.app",
						"/Applications/Codex.app",
						"{hostHomeDir}/Applications/Codex.app",
					},
				},
				Windows: &DesktopPlatform{
					ClientName:   "Codex",
					ProcessNames: []string{"Codex.exe"},
					ExecNames:    []string{"Codex.exe"},
				},
				Linux: &DesktopPlatform{
					ClientName: "Codex",
					ExecNames:  []string{"Codex", "codex-desktop", "codex-app"},
				},
			},
		},
		NativeBoundary: nativeCodex(),
	}
}

// builtinGemini 定义仍可显式使用、但已退出自动网关路由的 Gemini CLI。
func builtinGemini() Definition {
	return Definition{
		ID:           "gemini",
		Presentation: presentation("gemini", "Gemini", "GM", "✦", "blue"),
		Gateway:      GatewayDeprecated,
		Capabilities: []Capability{CapabilityAPIKeyAccount, CapabilityModelCatalog, CapabilityQuotaUsage},
		AuthOptions: []AuthOption{
			authOption(AuthModeOAuthBrowser, "Google 登录", "使用 Gemini CLI 原生 Google 登录流程。"),
			authOption(AuthModeAPIKey, "Gemini 密钥", "绑定 GEMINI_API_KEY 或 GOOGLE_API_KEY。"),
		},
		SessionSync: SessionSync{
			Mode:       SessionSyncHook,
			Adapter:    "json_hooks",
			TargetKind: "settings.json",
			Events:     []string{"SessionStart", "BeforeAgent", "AfterAgent", "SessionEnd"},
		},
		CLI: &CLIConfig{
			Order:     2,
			GlobalDir: ".gemini",
			LoginArgs: []string{"auth"},
			Package:   "@google/gemini-cli",
			EnvKeys:   []string{"GEMINI_API_KEY", "GOOGLE_API_KEY"},
			DesktopClient: desktopClient(
				"Gemini",
				[]string{"Gemini"},
				[]string{"/Gemini.app/Contents/MacOS/"},
				[]string{"/Applications/Gemini.app", "{hostHomeDir}/Applications/Gemini.app"},
				[]string{"Gemini.exe"},
				[]string{"Gemini.exe"},
				[]string{"Gemini", "gemini-desktop"},
			),
		},
		NativeBoundary: nativeGemini(),
	}
}

// builtinClaude 定义 Claude Code 与独立 Claude Desktop 边界。
func builtinClaude() Definition {
	reloadsHostAuth := false
	return Definition{
		ID:           "claude",
		Presentation: presentation("claude", "Claude", "CL", "◇", "orange"),
		Gateway:      GatewayActive,
		Capabilities: []Capability{CapabilityAPIKeyAccount, CapabilityModelCatalog, CapabilityQuotaUsage},
		AuthOptions: []AuthOption{
			authOption(AuthModeOAuthBrowser, "Claude 登录", "使用 Claude Code 原生 login 流程（Claude.ai 凭据）。"),
			authOption(AuthModeAPIKey, "Anthropic 密钥", "绑定 ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL。"),
			authOption(AuthModeAuthToken, "Claude Code Token", "绑定 ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL。"),
		},
		SessionSync: SessionSync{
			Mode:       SessionSyncHook,
			Adapter:    "json_hooks",
			TargetKind: "settings.json",
			Events:     []string{"SessionStart", "UserPromptSubmit", "Stop", "StopFailure", "SessionEnd"},
		},
		CLI: &CLIConfig{
			Order:     3,
			GlobalDir: ".claude",
			LoginArgs: []string{"setup-token"},
			Package:   "@anthropic-ai/claude-code",
			EnvKeys:   []string{"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"},
			DesktopClient: &DesktopClient{
				ReloadsHostAuth: &reloadsHostAuth,
				UserDataEnvKey:  "CLAUDE_USER_DATA_DIR",
				MacOS: &DesktopPlatform{
					ClientName:   "Claude",
					ExecNames:    []string{"Claude"},
					PathIncludes: []string{"/Claude.app/Contents/MacOS/"},
					InstallPaths: []string{"/Applications/Claude.app", "{hostHomeDir}/Applications/Claude.app"},
				},
				Windows: &DesktopPlatform{
					ClientName:   "Claude",
					ProcessNames: []string{"Claude.exe"},
					ExecNames:    []string{"Claude.exe"},
				},
				Linux: &DesktopPlatform{
					ClientName: "Claude",
					ExecNames:  []string{"Claude", "claude-desktop"},
				},
			},
		},
		NativeBoundary: nativeClaude(),
	}
}

// builtinAntigravity 定义 Antigravity 的 Google 认证和 Code Assist 能力入口。
func builtinAntigravity() Definition {
	return Definition{
		ID:           "agy",
		Presentation: presentation("agy", "Antigravity", "AGY", "▲", "purple"),
		Gateway:      GatewayActive,
		Capabilities: []Capability{CapabilityModelCatalog, CapabilityQuotaUsage},
		AuthOptions: []AuthOption{
			authOption(AuthModeOAuthBrowser, "Antigravity 登录", "使用 Antigravity CLI 原生 Google 登录流程。"),
		},
		SessionSync: SessionSync{
			Mode:       SessionSyncHook,
			Adapter:    "agy_named_hooks",
			TargetKind: "hooks.json",
			Events:     []string{"PreInvocation", "PostInvocation", "Stop"},
		},
		CLI: &CLIConfig{
			Order:        1,
			GlobalDir:    ".gemini",
			ConfigSubDir: "antigravity-cli",
			LoginArgs:    []string{},
			Package:      "",
			EnvKeys:      []string{"AGY_ACCESS_TOKEN", "GOOGLE_OAUTH_ACCESS_TOKEN"},
			DesktopClient: desktopClient(
				"Antigravity",
				[]string{"Antigravity"},
				[]string{"/Antigravity.app/Contents/MacOS/"},
				[]string{"/Applications/Antigravity.app", "{hostHomeDir}/Applications/Antigravity.app"},
				[]string{"Antigravity.exe"},
				[]string{"Antigravity.exe"},
				[]string{"antigravity", "agy"},
			),
		},
		NativeBoundary: nativeAntigravity(),
	}
}

// builtinOpenCode 定义由 OpenCode 自身管理认证的 CLI 能力。
func builtinOpenCode() Definition {
	return Definition{
		ID:           "opencode",
		Presentation: presentation("opencode", "OpenCode", "OC", "⌘", "default"),
		Gateway:      GatewayActive,
		Capabilities: []Capability{CapabilityModelCatalog},
		AuthOptions: []AuthOption{
			authOption(AuthModeOAuthBrowser, "OpenCode 登录", "使用 OpenCode CLI 原生 auth login 流程。"),
		},
		SessionSync: SessionSync{
			Mode:       SessionSyncHook,
			Adapter:    "opencode_plugin",
			TargetKind: "plugin.js",
			Events:     []string{},
		},
		CLI: &CLIConfig{
			Order:     5,
			GlobalDir: ".config/opencode",
			LoginArgs: []string{"auth", "login"},
			Package:   "opencode-ai",
			EnvKeys:   []string{},
			DesktopClient: desktopClient(
				"OpenCode",
				[]string{"OpenCode"},
				[]string{"/OpenCode.app/Contents/MacOS/"},
				[]string{"/Applications/OpenCode.app", "{hostHomeDir}/Applications/OpenCode.app"},
				[]string{"OpenCode.exe"},
				[]string{"OpenCode.exe"},
				[]string{"OpenCode", "opencode-desktop"},
			),
		},
	}
}

// builtinGrok 定义 Grok OAuth 和 xAI API Key 两种账号模式。
func builtinGrok() Definition {
	return Definition{
		ID:           "grok",
		Presentation: presentation("grok", "Grok", "GK", "⚡", "cyan"),
		Gateway:      GatewayActive,
		Capabilities: []Capability{CapabilityAPIKeyAccount, CapabilityModelCatalog},
		AuthOptions: []AuthOption{
			authOption(AuthModeAPIKey, "xAI 密钥", "绑定 XAI_API_KEY / XAI_BASE_URL。"),
			authOption(AuthModeOAuthBrowser, "Grok 登录", "使用 Grok Build CLI 原生 auth login 流程（需 SuperGrok 订阅）。"),
		},
		SessionSync: SessionSync{
			Mode:       SessionSyncHook,
			Adapter:    "json_hooks",
			TargetKind: "hooks.json",
			Events:     []string{"SessionStart", "UserPromptSubmit", "Stop", "StopFailure", "SessionEnd"},
		},
		CLI: &CLIConfig{
			Order:      6,
			GlobalDir:  ".grok",
			LoginArgs:  []string{"login", "--oauth"},
			BinaryName: "grok",
			Package:    "",
			EnvKeys:    []string{"GROK_HOME", "XAI_API_KEY"},
			DesktopClient: desktopClient(
				"Grok",
				[]string{"Grok"},
				[]string{"/Grok.app/Contents/MacOS/"},
				[]string{"/Applications/Grok.app", "{hostHomeDir}/Applications/Grok.app"},
				[]string{"Grok.exe"},
				[]string{"Grok.exe"},
				[]string{"grok", "grok-build"},
			),
		},
		NativeBoundary: nativeGrok(),
	}
}

// builtinQoder 定义 Qoder 全球站 CLI 和 Personal Access Token。
func builtinQoder() Definition {
	return Definition{
		ID:           "qoder",
		Presentation: presentation("qoder", "Qoder", "QD", "◆", "blue"),
		Gateway:      GatewayActive,
		Capabilities: []Capability{CapabilityModelCatalog},
		AuthOptions: []AuthOption{
			authOption(AuthModeOAuthBrowser, "Qoder 登录", "使用 Qoder CLI 原生 browser login 流程（全球站 qodercli）。"),
			authOption(AuthModeAPIKey, "Qoder Personal Access Token", "绑定 QODER_PERSONAL_ACCESS_TOKEN（全球站）。"),
		},
		SessionSync: SessionSync{Mode: SessionSyncPolling, Events: []string{}},
		CLI: &CLIConfig{
			Order:                  7,
			GlobalDir:              ".qoder",
			ConfigAtProjectionRoot: true,
			LoginArgs:              []string{"login"},
			BinaryName:             "qodercli",
			Package:                "@qoder-ai/qodercli",
			ConfigDirFlag:          "--config-dir",
			InstallRegion:          "global",
			EnvKeys:                []string{"QODER_PERSONAL_ACCESS_TOKEN"},
			DesktopClient: desktopClient(
				"Qoder",
				[]string{"Qoder"},
				[]string{"/Qoder.app/Contents/MacOS/"},
				[]string{"/Applications/Qoder.app", "{hostHomeDir}/Applications/Qoder.app"},
				[]string{"Qoder.exe"},
				[]string{"Qoder.exe", "qodercli.exe"},
				[]string{"Qoder", "qodercli"},
			),
		},
	}
}

// builtinQoderCN 定义与全球站隔离的 Qoder 国内站 CLI。
func builtinQoderCN() Definition {
	return Definition{
		ID:           "qodercn",
		Presentation: presentation("qodercn", "Qoder CN", "QCN", "◇", "purple"),
		Gateway:      GatewayActive,
		Capabilities: []Capability{CapabilityModelCatalog},
		AuthOptions: []AuthOption{
			authOption(AuthModeOAuthBrowser, "Qoder CN 登录", "使用 Qoder CLI CN 原生 browser login 流程（qoderclicn）。"),
			authOption(AuthModeAPIKey, "Qoder CN Personal Access Token", "绑定 QODER_PERSONAL_ACCESS_TOKEN（国内站）。"),
		},
		SessionSync: SessionSync{Mode: SessionSyncPolling, Events: []string{}},
		CLI: &CLIConfig{
			Order:                  8,
			GlobalDir:              ".qoder-cn",
			ConfigAtProjectionRoot: true,
			LoginArgs:              []string{"login"},
			BinaryName:             "qoderclicn",
			Package:                "",
			ConfigDirFlag:          "--config-dir",
			InstallRegion:          "cn",
			EnvKeys:                []string{"QODER_PERSONAL_ACCESS_TOKEN"},
			DesktopClient: desktopClient(
				"Qoder CN",
				[]string{"Qoder", "QoderCN"},
				[]string{"/Qoder.app/Contents/MacOS/"},
				[]string{"/Applications/Qoder.app", "{hostHomeDir}/Applications/Qoder.app"},
				[]string{"Qoder.exe", "qoderclicn.exe"},
				[]string{"Qoder.exe", "qoderclicn.exe"},
				[]string{"Qoder", "qoderclicn"},
			),
		},
	}
}

// builtinKimi 定义 Kimi Code OAuth 和 Moonshot API Key 能力。
func builtinKimi() Definition {
	return Definition{
		ID:           "kimi",
		Presentation: presentation("kimi", "Kimi", "KM", "☾", "geekblue"),
		Gateway:      GatewayActive,
		Capabilities: []Capability{CapabilityAPIKeyAccount},
		AuthOptions: []AuthOption{
			authOption(AuthModeAPIKey, "Moonshot 密钥", "绑定 MOONSHOT_API_KEY / KIMI_BASE_URL（支持 api.moonshot.cn 和 api.moonshot.ai 双端点）。"),
			authOption(AuthModeOAuthBrowser, "Kimi Code 登录", "使用 Kimi Code CLI 原生 OAuth 设备码流程（需 Kimi 会员订阅）。"),
		},
		SessionSync: SessionSync{Mode: SessionSyncUnavailable, Events: []string{}},
		CLI: &CLIConfig{
			Order:     9,
			GlobalDir: ".kimi-code",
			LoginArgs: []string{"login"},
			Package:   "@moonshot-ai/kimi-code",
			EnvKeys:   []string{"MOONSHOT_API_KEY", "KIMI_CODE_HOME"},
		},
		NativeBoundary: nativeKimi(),
	}
}

// builtinKiro 定义 Kiro CLI 的 AWS Builder ID Device Flow。
func builtinKiro() Definition {
	return Definition{
		ID:           "kiro",
		Presentation: presentation("kiro", "Kiro", "KR", "⬡", "volcano"),
		Gateway:      GatewayActive,
		Capabilities: []Capability{CapabilityModelCatalog},
		AuthOptions: []AuthOption{
			authOption(AuthModeOAuthBrowser, "AWS Builder ID 登录", "使用 Kiro CLI Device Flow 认证（支持 Google/GitHub/AWS Builder ID）。"),
		},
		SessionSync: SessionSync{Mode: SessionSyncPolling, Events: []string{}},
		CLI: &CLIConfig{
			Order:      10,
			GlobalDir:  ".kiro",
			LoginArgs:  []string{"login", "--license", "free", "--use-device-flow"},
			BinaryName: "kiro-cli",
			Package:    "",
			EnvKeys:    []string{"KIRO_HOME", "KIRO_TEST_DB_PATH", "KIRO_API_KEY"},
		},
		NativeBoundary: nativeKiro(),
	}
}

// presentation 统一构造 Provider 的展示字段，避免十处重复资产命名规则。
func presentation(id, label, short, terminalIcon, tagColor string) Presentation {
	return Presentation{
		ID:                id,
		Label:             label,
		Short:             short,
		TerminalIcon:      terminalIcon,
		TerminalIconAsset: "assets/provider-icons/" + id + ".png",
		AccentVar:         "var(--provider-" + id + ")",
		SoftVar:           "var(--provider-" + id + "-soft)",
		TagColor:          tagColor,
	}
}

// authOption 统一构造 Client 认证选项。
func authOption(value AuthMode, label, description string) AuthOption {
	return AuthOption{Value: value, Label: label, Description: description}
}

// desktopClient 统一构造结构相同的跨平台桌面客户端定义。
func desktopClient(
	clientName string,
	macExecNames []string,
	macPathIncludes []string,
	macInstallPaths []string,
	windowsProcessNames []string,
	windowsExecNames []string,
	linuxExecNames []string,
) *DesktopClient {
	return &DesktopClient{
		MacOS: &DesktopPlatform{
			ClientName:   clientName,
			ExecNames:    macExecNames,
			PathIncludes: macPathIncludes,
			InstallPaths: macInstallPaths,
		},
		Windows: &DesktopPlatform{
			ClientName:   clientName,
			ProcessNames: windowsProcessNames,
			ExecNames:    windowsExecNames,
		},
		Linux: &DesktopPlatform{
			ClientName: clientName,
			ExecNames:  linuxExecNames,
		},
	}
}

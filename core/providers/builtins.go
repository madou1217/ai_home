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
			builtinZcode(),
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
		Clients:      clientSupport(true, true),
		Capabilities: []Capability{CapabilityAPIKeyAccount, CapabilityModelCatalog, CapabilityQuotaUsage, CapabilitySessionRuntime, CapabilityFabricRuntime, CapabilityGatewayProfile, CapabilitySessionHistory, CapabilityUsageScan},
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
			Order:      4,
			GlobalDir:  ".codex",
			ConfigFile: "config.toml",
			LoginArgs:  []string{"login"},
			Package:    "@openai/codex",
			EnvKeys:    []string{"OPENAI_API_KEY", "OPENAI_BASE_URL"},
			Headless:   &HeadlessConfig{TriggerSubcommands: []string{"exec"}},
			DesktopClient: &DesktopClient{
				UserDataEnvKey: "CODEX_ELECTRON_USER_DATA_PATH",
				MacOS: &DesktopPlatform{
					ClientName:   "ChatGPT",
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
					ClientName:   "ChatGPT",
					ProcessNames: []string{"ChatGPT.exe", "Codex.exe"},
					ExecNames:    []string{"ChatGPT.exe", "Codex.exe"},
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
		Clients:      clientSupport(true, false),
		Capabilities: []Capability{CapabilityAPIKeyAccount, CapabilityModelCatalog, CapabilityQuotaUsage, CapabilityFabricRuntime, CapabilitySessionHistory, CapabilityUsageScan},
		AuthOptions: []AuthOption{
			disabledAuthOption(
				AuthModeOAuthBrowser,
				"Google 登录 (已停用)",
				"Google 已关闭 Gemini CLI 个人版登录，请改用 Gemini API Key 或 Antigravity。",
				"Google 已关闭 Gemini CLI 个人版登录，请改用 Gemini API Key 或 Antigravity",
			),
			authOption(AuthModeAPIKey, "Gemini 密钥", "绑定 GEMINI_API_KEY 或 GOOGLE_API_KEY。"),
			authOption(AuthModeVertexAI, "Vertex AI", "Google Cloud Vertex AI 认证 (暂未接入，先占位)。"),
		},
		SessionSync: SessionSync{
			Mode:       SessionSyncHook,
			Adapter:    "json_hooks",
			TargetKind: "settings.json",
			Events:     []string{"SessionStart", "BeforeAgent", "AfterAgent", "SessionEnd"},
		},
		CLI: &CLIConfig{
			Order:      2,
			GlobalDir:  ".gemini",
			ConfigFile: "settings.json",
			LoginArgs:  []string{"auth"},
			Package:    "@google/gemini-cli",
			EnvKeys:    []string{"GEMINI_API_KEY", "GOOGLE_API_KEY"},
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
		Clients:      clientSupport(true, true),
		Capabilities: []Capability{CapabilityAPIKeyAccount, CapabilityModelCatalog, CapabilityQuotaUsage, CapabilitySessionRuntime, CapabilityFabricRuntime, CapabilityGatewayProfile, CapabilitySessionHistory, CapabilityUsageScan},
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
			Order:      3,
			GlobalDir:  ".claude",
			ConfigFile: "settings.json",
			LoginArgs:  []string{"setup-token"},
			Package:    "@anthropic-ai/claude-code",
			EnvKeys:    []string{"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"},
			Headless: &HeadlessConfig{
				TriggerFlags: []string{"-p", "--print"},
				StdinFlags:   []string{"--input-format=stream-json"},
			},
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
		Clients:      clientSupport(true, true),
		Capabilities: []Capability{CapabilityModelCatalog, CapabilityQuotaUsage, CapabilitySessionRuntime, CapabilityFabricRuntime, CapabilitySessionHistory, CapabilityUsageScan},
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
			ConfigFile:   "hooks.json",
			LoginArgs:    []string{},
			Package:      "",
			EnvKeys:      []string{"AGY_ACCESS_TOKEN", "GOOGLE_OAUTH_ACCESS_TOKEN"},
			Headless:     &HeadlessConfig{TriggerFlags: []string{"--print"}},
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

// builtinOpenCode 定义由 OpenCode API 密钥认证的 CLI 与网关能力。
// 官方规范说明：
// - 凭据获取：从 https://opencode.ai/auth 获取 API Key。
// - 官方端点：默认使用 OpenCode Go 端点 https://opencode.ai/zen/go/v1，亦支持 Zen 端点 https://opencode.ai/zen/v1。
// - 原生存储：CLI (opencode auth login) 在 ~/.local/share/opencode/auth.json 中管理 opencode / opencode-go 提供商键值。
// - 环境变量：OPENCODE_API_KEY 与 OPENCODE_BASE_URL。
func builtinOpenCode() Definition {
	return Definition{
		ID:           "opencode",
		Presentation: presentation("opencode", "OpenCode", "OC", "⌘", "default"),
		Gateway:      GatewayActive,
		Clients:      clientSupport(true, true),
		Capabilities: []Capability{CapabilityAPIKeyAccount, CapabilityModelCatalog, CapabilitySessionRuntime, CapabilityFabricRuntime, CapabilityGatewayProfile, CapabilitySessionHistory, CapabilityUsageScan},
		AuthOptions: []AuthOption{
			authOption(AuthModeAPIKey, "OpenCode 密钥", "绑定 OpenCode / OpenCode Go API Key（从 https://opencode.ai/auth 获取，默认端点 https://opencode.ai/zen/go/v1，支持全量 Zen / Go 模型）。"),
		},
		SessionSync: SessionSync{
			Mode:       SessionSyncHook,
			Adapter:    "opencode_plugin",
			TargetKind: "plugin.js",
			Events:     []string{},
		},
		CLI: &CLIConfig{
			Order:      5,
			GlobalDir:  ".config/opencode",
			ConfigFile: "opencode.json",
			LoginArgs:  []string{"auth", "login"},
			Package:    "opencode-ai",
			EnvKeys:    []string{"OPENCODE_API_KEY", "OPENCODE_BASE_URL"},
			Headless:   &HeadlessConfig{TriggerSubcommands: []string{"run"}},
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
		Clients:      clientSupport(true, false),
		Capabilities: []Capability{CapabilityAPIKeyAccount, CapabilityModelCatalog, CapabilitySessionHistory, CapabilityAccountSessionStore},
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
			ConfigFile: "settings.json",
			LoginArgs:  []string{"login", "--oauth"},
			BinaryName: "grok",
			Package:    "",
			EnvKeys:    []string{"GROK_HOME", "XAI_API_KEY", "XAI_BASE_URL"},
			Headless:   &HeadlessConfig{TriggerFlags: []string{"--single"}},
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
		Clients:      clientSupport(true, true),
		Capabilities: []Capability{CapabilityModelCatalog, CapabilitySessionHistory, CapabilityAccountSessionStore},
		AuthOptions: []AuthOption{
			authOption(AuthModeOAuthBrowser, "Qoder 登录", "使用 Qoder CLI 原生 browser login 流程（全球站 qodercli）。"),
			authOption(AuthModeAPIKey, "Qoder Personal Access Token", "绑定 QODER_PERSONAL_ACCESS_TOKEN（全球站）。"),
		},
		SessionSync: SessionSync{Mode: SessionSyncPolling, Events: []string{}},
		CLI: &CLIConfig{
			Order:                  7,
			GlobalDir:              ".qoder",
			ConfigFile:             "config.json",
			ConfigAtProjectionRoot: true,
			LoginArgs:              []string{"login"},
			BinaryName:             "qodercli",
			Package:                "@qoder-ai/qodercli",
			ConfigDirFlag:          "--config-dir",
			InstallRegion:          "global",
			EnvKeys:                []string{"QODER_PERSONAL_ACCESS_TOKEN"},
			Headless:               &HeadlessConfig{TriggerFlags: []string{"--print"}},
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
		Clients:      clientSupport(true, true),
		Capabilities: []Capability{CapabilityModelCatalog, CapabilitySessionHistory, CapabilityAccountSessionStore},
		AuthOptions: []AuthOption{
			authOption(AuthModeOAuthBrowser, "Qoder CN 登录", "使用 Qoder CLI CN 原生 browser login 流程（qoderclicn）。"),
			authOption(AuthModeAPIKey, "Qoder CN Personal Access Token", "绑定 QODER_PERSONAL_ACCESS_TOKEN（国内站）。"),
		},
		SessionSync: SessionSync{Mode: SessionSyncPolling, Events: []string{}},
		CLI: &CLIConfig{
			Order:                  8,
			GlobalDir:              ".qoder-cn",
			ConfigFile:             "config.json",
			ConfigAtProjectionRoot: true,
			LoginArgs:              []string{"login"},
			BinaryName:             "qoderclicn",
			Package:                "",
			ConfigDirFlag:          "--config-dir",
			InstallRegion:          "cn",
			EnvKeys:                []string{"QODER_PERSONAL_ACCESS_TOKEN"},
			Headless:               &HeadlessConfig{TriggerFlags: []string{"--print"}},
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
// quota_usage：kimi OAuth 账号由 Node 侧 kimi-quota-probe 走
// {KIMI_CODE_BASE_URL|api.kimi.com/coding/v1}/usages 拉取 5h/7days 配额窗口。
// 桌面端：Kimi Work / Kimi 桌面版（kimi.com/zh-cn/products/download）与
// Kimi 会员账号同体系；官方公开下载仅支持 macOS / Windows。Electron 应用
// 按账号用 --user-data-dir 隔离登录态（桌面版不读 ~/.kimi-code，登录态在
// 各自 user-data 目录内）。
func builtinKimi() Definition {
	return Definition{
		ID:           "kimi",
		Presentation: presentation("kimi", "Kimi", "KM", "☾", "geekblue"),
		Gateway:      GatewayActive,
		Clients:      clientSupport(true, true),
		Capabilities: []Capability{CapabilityAPIKeyAccount, CapabilityModelCatalog, CapabilityQuotaUsage, CapabilityUsageScan},
		AuthOptions: []AuthOption{
			authOption(AuthModeAPIKey, "Moonshot 密钥", "绑定 MOONSHOT_API_KEY / KIMI_BASE_URL（支持 api.moonshot.cn 和 api.moonshot.ai 双端点）。"),
			authOption(AuthModeOAuthBrowser, "Kimi Code 登录", "使用 Kimi Code CLI 原生 OAuth 设备码流程（需 Kimi 会员订阅）。"),
		},
		SessionSync: SessionSync{Mode: SessionSyncUnavailable, Events: []string{}},
		CLI: &CLIConfig{
			Order:      9,
			GlobalDir:  ".kimi-code",
			ConfigFile: "config.toml",
			LoginArgs:  []string{"login"},
			Package:    "@moonshot-ai/kimi-code",
			EnvKeys:    []string{"MOONSHOT_API_KEY", "KIMI_BASE_URL", "KIMI_CODE_HOME"},
			DesktopClient: desktopClient(
				"Kimi",
				[]string{"Kimi"},
				[]string{"/Kimi.app/Contents/MacOS/"},
				[]string{"/Applications/Kimi.app", "{hostHomeDir}/Applications/Kimi.app"},
				[]string{"Kimi.exe"},
				[]string{"Kimi.exe"},
				nil,
			),
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
		Clients:      clientSupport(true, true),
		Capabilities: []Capability{CapabilityModelCatalog, CapabilitySessionHistory, CapabilityAccountSessionStore},
		AuthOptions: []AuthOption{
			authOption(AuthModeOAuthBrowser, "AWS Builder ID 登录", "使用 Kiro CLI Device Flow 认证（支持 Google/GitHub/AWS Builder ID）。"),
		},
		SessionSync: SessionSync{Mode: SessionSyncPolling, Events: []string{}},
		CLI: &CLIConfig{
			Order:      10,
			GlobalDir:  ".kiro",
			ConfigFile: "config.json",
			LoginArgs:  []string{"login", "--license", "free", "--use-device-flow"},
			BinaryName: "kiro-cli",
			Package:    "",
			EnvKeys:    []string{"KIRO_HOME", "KIRO_TEST_DB_PATH", "KIRO_API_KEY"},
			DesktopClient: desktopClient(
				"Kiro",
				[]string{"Kiro"},
				[]string{"/Kiro.app/Contents/MacOS/"},
				[]string{"/Applications/Kiro.app", "{hostHomeDir}/Applications/Kiro.app"},
				[]string{"Kiro.exe"},
				[]string{"Kiro.exe"},
				[]string{"kiro", "Kiro"},
			),
		},
		NativeBoundary: nativeKiro(),
	}
}

// builtinZcode 定义 ZCode Desktop 的 Z.AI OAuth 与 API Key 双账号模式。
// ZCode 原生使用 Anthropic 协议（/v1/messages），凭据保存在
// ~/.zcode/v2/credentials.json（无 refresh token，过期需重新 login 导入）。
func builtinZcode() Definition {
	return Definition{
		ID:           "zcode",
		Presentation: presentation("zcode", "ZCode", "ZC", "◈", "geekblue"),
		Gateway:      GatewayActive,
		Clients:      clientSupport(false, true),
		Capabilities: []Capability{CapabilityAPIKeyAccount, CapabilityModelCatalog, CapabilitySessionHistory, CapabilityQuotaUsage, CapabilityUsageScan},
		AuthOptions: []AuthOption{
			authOption(AuthModeOAuthBrowser, "ZCode 登录", "使用 ZCode Desktop 的官方浏览器 OAuth 流程（Z.AI 账号，OAuth 凭据安全写入 AIH）。"),
			authOption(AuthModeAPIKey, "Z.ai 密钥", "绑定 ZCODE_API_KEY / ZCODE_BASE_URL（支持 open.bigmodel.cn 与 api.z.ai 双 Anthropic 端点）。"),
		},
		SessionSync: SessionSync{Mode: SessionSyncUnavailable, Events: []string{}},
		CLI: &CLIConfig{
			Order:      11,
			GlobalDir:  ".zcode",
			LoginArgs:  []string{"login"},
			BinaryName: "zcode",
			Package:    "",
			EnvKeys:    []string{"ZCODE_API_KEY", "ZCODE_BASE_URL", "ZCODE_DATA_BASE_DIR"},
			DesktopClient: desktopClient(
				"ZCode",
				[]string{"ZCode"},
				[]string{"/ZCode.app/Contents/MacOS/"},
				[]string{"/Applications/ZCode.app", "{hostHomeDir}/Applications/ZCode.app"},
				[]string{"ZCode.exe"},
				[]string{"ZCode.exe"},
				[]string{"zcode"},
			),
		},
	}
}

// clientSupport 是面向产品的客户端形态构造器；安装器和 Toolkit 只读取该合同。
func clientSupport(cli, desktop bool) ClientSupport {
	return ClientSupport{CLI: cli, Desktop: desktop}
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

// disabledAuthOption 构造已停用并带有停用原因的 Client 认证选项。
func disabledAuthOption(value AuthMode, label, description, disabledReason string) AuthOption {
	return AuthOption{
		Value:          value,
		Label:          label,
		Description:    description,
		Disabled:       true,
		DisabledReason: disabledReason,
	}
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
	client := &DesktopClient{
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
	}
	if len(linuxExecNames) > 0 {
		client.Linux = &DesktopPlatform{
			ClientName: clientName,
			ExecNames:  linuxExecNames,
		}
	}
	return client
}

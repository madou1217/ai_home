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
		Providers: withDefaultSite([]Definition{
			builtinCodex(),
			builtinGemini(),
			builtinClaude(),
			builtinAntigravity(),
			builtinOpenCode(),
			builtinGrok(),
			// 国内/国际双站点的产品线显式标注产品族；单站 Provider 由
			// withDefaultSite 补成 (Family=ID, Site=global)，不重复声明。
			family(builtinQoder(), "qoder", SiteGlobal),
			family(builtinQoderCN(), "qoder", SiteCN),
			builtinKimi(),
			builtinKiro(),
			builtinZcode(),
			family(builtinCodebuddy(), "codebuddy", SiteGlobal),
			family(builtinCodebuddyCN(), "codebuddy", SiteCN),
			family(builtinWorkbuddy(), "workbuddy", SiteGlobal),
			family(builtinWorkbuddyCN(), "workbuddy", SiteCN),
			builtinCline(),
		}),
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

// relayHostsCanonical 声明「两个宿主都能服务该 Provider 的推理，且 Go 走 canonical 通道」。
//
// canonical 表示 Go 有该 Provider 的完整上游适配器（core/inference 的 ProviderID +
// internal/adapters 下的协议适配器），因此覆盖全部推理入口，不限定 Entries。
func relayHostsCanonical() map[string]RelayHost {
	return map[string]RelayHost{
		RelayHostNode: {Supported: true, Channel: RelayChannelRelay},
		RelayHostGo:   {Supported: true, Channel: RelayChannelCanonical},
	}
}

// relayHostsGoRelay 声明「Go 以同协议透传承接，且只在这些入口上挂载」。
//
// 用于家族透传（codebuddy / workbuddy 四支）：Go 的 codebuddyfamilyrelay 只挂在
// chat completions 一个入口上，因此 entries 必须显式列出——只写布尔会让 /v1/messages
// 上的家族请求被误判为「Go 能服务」，而那条路径上根本没有透传 Handler。
func relayHostsGoRelay(entries ...string) map[string]RelayHost {
	return map[string]RelayHost{
		RelayHostNode: {Supported: true, Channel: RelayChannelRelay},
		RelayHostGo:   {Supported: true, Channel: RelayChannelRelay, Entries: entries},
	}
}

// relayHostsNodeOnly 声明「只有 Node 能服务该 Provider 的推理」，并写明 Go 不能的原因。
//
// reason 必填（validateRelayHosts 强制）：沉默缺失正是本能力位要消灭的形态——
// Provider 不在任何名单里、没人知道为什么，故障时只能靠翻代码猜。
func relayHostsNodeOnly(reason string) map[string]RelayHost {
	return map[string]RelayHost{
		RelayHostNode: {Supported: true, Channel: RelayChannelRelay},
		RelayHostGo:   {Supported: false, Reason: reason},
	}
}

// builtinCodex 定义 Codex/ChatGPT 的稳定身份和声明式能力。
func builtinCodex() Definition {
	return Definition{
		ID:           "codex",
		Presentation: withAPIHost(presentation("codex", "ChatGPT", "GPT", "◎", "green"), "api.openai.com"),
		Gateway:      GatewayActive,
		Clients:      clientSupport(true, true),
		Credentials:  &CredentialFacts{VendorID: "openai", APIKeyEnv: []string{"OPENAI_API_KEY"}, BaseURLEnv: []string{"OPENAI_BASE_URL"}},
		Capabilities: []Capability{CapabilityAPIKeyAccount, CapabilityModelCatalog, CapabilityQuotaUsage, CapabilitySessionRuntime, CapabilityFabricRuntime, CapabilityGatewayProfile, CapabilitySessionHistory, CapabilityUsageScan, CapabilityACPSession},
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
		RelayHosts:     relayHostsCanonical(),
	}
}

// builtinGemini 定义仍可显式使用、但已退出自动网关路由的 Gemini CLI。
func builtinGemini() Definition {
	return Definition{
		ID:           "gemini",
		Presentation: withAPIHost(presentation("gemini", "Gemini", "GM", "✦", "blue"), "generativelanguage.googleapis.com"),
		Gateway:      GatewayDeprecated,
		Clients:      clientSupport(true, false),
		Credentials:  &CredentialFacts{VendorID: "gemini", APIKeyEnv: []string{"GEMINI_API_KEY", "GOOGLE_API_KEY"}, BaseURLEnv: []string{"GEMINI_BASE_URL", "GOOGLE_BASE_URL"}},
		RelayHosts:   relayHostsNodeOnly("Go 无 gemini 直连上游（gemini-* 模型经 agy 的 Code Assist 服务，agy 已声明 canonical）"),
		Capabilities: []Capability{CapabilityAPIKeyAccount, CapabilityModelCatalog, CapabilityQuotaUsage, CapabilityFabricRuntime, CapabilitySessionHistory, CapabilityUsageScan, CapabilityACPSession},
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
		Presentation: withAPIHost(presentation("claude", "Claude", "CL", "◇", "orange"), "api.anthropic.com"),
		Gateway:      GatewayActive,
		Clients:      clientSupport(true, true),
		Credentials:  &CredentialFacts{VendorID: "anthropic", APIKeyEnv: []string{"ANTHROPIC_API_KEY"}, AuthTokenEnv: []string{"ANTHROPIC_AUTH_TOKEN"}, BaseURLEnv: []string{"ANTHROPIC_BASE_URL"}},
		Capabilities: []Capability{CapabilityAPIKeyAccount, CapabilityModelCatalog, CapabilityQuotaUsage, CapabilitySessionRuntime, CapabilityFabricRuntime, CapabilityGatewayProfile, CapabilitySessionHistory, CapabilityUsageScan, CapabilityACPSession},
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
					BundleID:     "com.anthropic.claudefordesktop",
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
		RelayHosts:     relayHostsCanonical(),
	}
}

// builtinAntigravity 定义 Antigravity 的 Google 认证和 Code Assist 能力入口。
func builtinAntigravity() Definition {
	return Definition{
		ID:           "agy",
		Presentation: withAPIHost(presentation("agy", "Antigravity", "AGY", "▲", "purple"), "daily-cloudcode-pa.googleapis.com"),
		Gateway:      GatewayActive,
		Clients:      clientSupport(true, true),
		Credentials:  &CredentialFacts{VendorID: "antigravity"},
		Capabilities: []Capability{CapabilityModelCatalog, CapabilityQuotaUsage, CapabilitySessionRuntime, CapabilityFabricRuntime, CapabilitySessionHistory, CapabilityUsageScan},
		AuthOptions: []AuthOption{
			authOptionWithStrategy(AuthModeOAuthBrowser, "aih-google-oauth", "Antigravity 直连 Google 登录", "由 AI Home 直接完成 Google OAuth，不需要安装 Antigravity CLI。"),
			authOptionWithStrategy(AuthModeOAuthBrowser, "native-cli", "Antigravity CLI 登录", "使用 Antigravity CLI 原生 Google 登录流程。"),
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
		RelayHosts:     relayHostsCanonical(),
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
		ID:             "opencode",
		Presentation:   withAPIHost(presentation("opencode", "OpenCode", "OC", "⌘", "default"), "opencode.ai"),
		Gateway:        GatewayActive,
		Clients:        clientSupport(true, true),
		Credentials:    &CredentialFacts{APIKeyEnv: []string{"OPENCODE_API_KEY"}, BaseURLEnv: []string{"OPENCODE_BASE_URL"}, CLIRequiresAuthFile: true},
		NativeBoundary: nativeOpenCode(),
		RelayHosts:     relayHostsNodeOnly("Go 无 opencode 推理上游适配器（规划见 2026-10-17-inference-capability-registry.md P2）"),
		Capabilities:   []Capability{CapabilityAPIKeyAccount, CapabilityModelCatalog, CapabilitySessionRuntime, CapabilityFabricRuntime, CapabilityGatewayProfile, CapabilitySessionHistory, CapabilityUsageScan, CapabilityACPSession},
		AuthOptions: []AuthOption{
			// Console 登录（设备码）：策略在 lib/server/oauth-strategies/opencode.js，
			// 跑的是官方 `opencode auth login opencode --method device`（方法枚举实测
			// `Available: device, key`），凭据落 opencode 的 credential 存储而不是 auth.json，
			// 登录成功后由宿主观察者登记成账号（lib/account/opencode-native-credential-sync.js）。
			authOptionWithStrategy(AuthModeOAuthBrowser, "opencode:device", "OpenCode Console 登录（设备码）", "官方 CLI 设备码流程：在任意设备打开验证地址完成授权（无需本机回调地址与协议处理器）。"),
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
			// OpenCode 2 的 npm 包是 `@opencode/cli`；旧的 `opencode-ai` 只发到 1.x
			// （上游安装器原文：OpenCode 2 ships as @opencode/cli），Node 侧用它做
			// 版本源（更新检查）与 npm 兜底安装计划，指错了就会拿 1.x 线去比 2.x 安装。
			Package:  "@opencode/cli",
			EnvKeys:  []string{"OPENCODE_API_KEY", "OPENCODE_BASE_URL"},
			Headless: &HeadlessConfig{TriggerSubcommands: []string{"run"}},
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
		Presentation: withAPIHost(presentation("grok", "Grok", "GK", "⚡", "cyan"), "api.x.ai"),
		Gateway:      GatewayActive,
		Clients:      clientSupport(true, false),
		Credentials:  &CredentialFacts{VendorID: "xai", APIKeyEnv: []string{"XAI_API_KEY"}, BaseURLEnv: []string{"XAI_BASE_URL"}, CLIRequiresAuthFile: true},
		RelayHosts:   relayHostsGoRelay("gateway.openai.chat_completions"),
		Capabilities: []Capability{CapabilityAPIKeyAccount, CapabilityModelCatalog, CapabilityQuotaUsage, CapabilitySessionHistory, CapabilityAccountSessionStore, CapabilityUsageScan},
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
		Presentation: withAPIHost(presentation("qoder", "Qoder", "QD", "◆", "blue"), "qoder.com"),
		Gateway:      GatewayActive,
		Clients:      clientSupport(true, true),
		Credentials:  &CredentialFacts{APIKeyEnv: []string{"QODER_PERSONAL_ACCESS_TOKEN"}},
		RelayHosts:   relayHostsNodeOnly("qoder 的推理只能经本机 CLI headless 执行，Go 服务端无此条件"),
		// usage_scan：扫描本地会话历史（projects/<project>/<session>.jsonl）建立会话/prompt
		// 索引，并在 assistant 记录带 usage 时统计 token。**2026-10-15 在 Windows 真机核实：
		// qoder CLI 1.1.2 的会话 JSONL 不写 usage**，因此 token 用量的实际来源是运行时——
		// 网关路径由 qoder-cli-transport 解析 stream-json 的 result.usage 记账
		// （sourceKind=server_qoder_cli_proxy）；CLI 直跑会话无 token 数据，不猜。
		// 账号会话落在账号 runtime 目录（account_session_store），归属精确、不需要注册表推断。
		Capabilities: []Capability{CapabilityModelCatalog, CapabilitySessionHistory, CapabilityAccountSessionStore, CapabilityUsageScan},
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
			// 官方 DMG 的实际包名是 Qoder IDE.app（可执行文件 Qoder，
			// bundle id com.qoder.ide）；Qoder.app 只作为旧版本回退。
			// Windows 的 UserSetup 安装到 %LOCALAPPDATA%\Programs\Qoder IDE，
			// 可执行文件是 Qoder IDE.exe；Qoder.exe 只属于旧版机器级安装
			// （C:\Program Files\Qoder），保留为回退而不是唯一事实。
			DesktopClient: describeDesktopClient(desktopClient(
				"Qoder",
				[]string{"Qoder"},
				[]string{"/Qoder IDE.app/Contents/MacOS/", "/Qoder.app/Contents/MacOS/"},
				[]string{"/Applications/Qoder IDE.app", "{hostHomeDir}/Applications/Qoder IDE.app", "/Applications/Qoder.app", "{hostHomeDir}/Applications/Qoder.app"},
				[]string{"Qoder.exe", "Qoder IDE.exe"},
				[]string{"Qoder.exe", "Qoder IDE.exe"},
				[]string{"qoder", "Qoder"},
			), "com.qoder.ide", []string{"Qoder IDE"}),
		},
		// 会话续接是 CLI 自己的事实（qodercli 1.1.72 --help 实测）：-c/--continue 续最近一段、
		// -r/--resume [id] 按 id 续、--fork-session 在续接时分叉成新会话。aih 的统一
		// `aih qoder resume` / `aih qoder fork` 直接翻译到这三个入口。
		// 不声明 NativeStore：aih 不读它的会话库（会话身份由用户/CLI 提供）。
		NativeBoundary: &NativeCapability{
			Sessions: NativeSessions{
				Flags: []string{"--continue", "--resume", "--fork-session"},
			},
			// 权限（qodercli 1.1.74 的 --help 与内置设置项，2026-10-22 实测）：
			//   --permission-mode <mode>  取值 default / accept_edits / auto / bypass_permissions / dont_ask
			//   --dangerously-skip-permissions  跳过全部权限检查
			// 设置项 `defaultPermissionMode` 收同样的取值，别名 yolo = bypass_permissions。
			// 取值用下划线形态（原生取值），不用界面上的驼峰别名。
			Permissions: NativePermissions{
				Flags: []string{"--permission-mode", "--dangerously-skip-permissions"},
				Modes: []string{"default", "accept_edits", "auto", "bypass_permissions", "dont_ask"},
			},
		},
	}
}

// builtinQoderCN 定义与全球站隔离的 Qoder 国内站 CLI。
func builtinQoderCN() Definition {
	return Definition{
		ID:           "qodercn",
		Presentation: withAPIHost(presentation("qodercn", "Qoder CN", "QCN", "◇", "purple"), "qoder.com.cn"),
		Gateway:      GatewayActive,
		Clients:      clientSupport(true, true),
		Credentials:  &CredentialFacts{APIKeyEnv: []string{"QODER_PERSONAL_ACCESS_TOKEN"}},
		RelayHosts:   relayHostsNodeOnly("qodercn 的推理只能经本机 CLI headless 执行，Go 服务端无此条件"),
		// 与 qoder 同源：会话 JSONL + usage 字段（账号 runtime 目录归属）。
		Capabilities: []Capability{CapabilityModelCatalog, CapabilitySessionHistory, CapabilityAccountSessionStore, CapabilityUsageScan},
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
			// 国内站 DMG 的实际包名是 Qoder CN IDE.app（可执行文件 Qoder CN，
			// bundle id com.aliyun.lingma.ide）；旧包名 Qoder.app 保留为回退。
			// Windows 的 UserSetup 安装到 %LOCALAPPDATA%\Programs\Qoder CN IDE，
			// 可执行文件是 Qoder CN IDE.exe；QoderCN.exe 属于旧版机器级安装。
			DesktopClient: describeDesktopClient(desktopClient(
				"Qoder CN",
				[]string{"Qoder CN", "QoderCN"},
				[]string{"/Qoder CN IDE.app/Contents/MacOS/", "/Qoder.app/Contents/MacOS/"},
				[]string{"/Applications/Qoder CN IDE.app", "{hostHomeDir}/Applications/Qoder CN IDE.app", "/Applications/Qoder.app", "{hostHomeDir}/Applications/Qoder.app"},
				[]string{"QoderCN.exe", "Qoder CN.exe", "Qoder CN IDE.exe"},
				[]string{"QoderCN.exe", "Qoder CN.exe", "Qoder CN IDE.exe"},
				[]string{"qoder-cn", "qodercn", "Qoder CN", "QoderCN"},
			), "com.aliyun.lingma.ide", []string{"Qoder CN IDE"}),
		},
		// 与 qoder 同源（qoderclicn 1.1.72 实测同样支持 -c/--continue、-r/--resume、--fork-session）。
		NativeBoundary: &NativeCapability{
			Sessions: NativeSessions{
				Flags: []string{"--continue", "--resume", "--fork-session"},
			},
			// 权限与 qoder 同源（qoderclicn 的 --help 实测同样的旗标与取值）。
			Permissions: NativePermissions{
				Flags: []string{"--permission-mode", "--dangerously-skip-permissions"},
				Modes: []string{"default", "accept_edits", "auto", "bypass_permissions", "dont_ask"},
			},
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
		Presentation: withAPIHost(presentation("kimi", "Kimi", "KM", "☾", "geekblue"), "api.moonshot.cn"),
		Gateway:      GatewayActive,
		Clients:      clientSupport(true, true),
		Credentials:  &CredentialFacts{VendorID: "moonshot", APIKeyEnv: []string{"MOONSHOT_API_KEY"}, BaseURLEnv: []string{"KIMI_BASE_URL"}},
		RelayHosts:   relayHostsGoRelay("gateway.openai.chat_completions"),
		Capabilities: []Capability{CapabilityAPIKeyAccount, CapabilityModelCatalog, CapabilityQuotaUsage, CapabilityUsageScan, CapabilityGatewayProfile, CapabilityACPSession},
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

// builtinKiro 定义 Kiro 的 AWS SSO OIDC 设备码授权（Builder ID / IAM Identity Center）。
// 授权由 aih 自己完成，**不需要本地 kiro CLI**；Kiro Desktop / social（Google/GitHub）账号
// 走 refresh_token 口径，见 lib/account/kiro-device-login.js。
func builtinKiro() Definition {
	return Definition{
		ID:           "kiro",
		Presentation: withAPIHost(presentation("kiro", "Kiro", "KR", "⬡", "volcano"), "kiro.dev"),
		Gateway:      GatewayActive,
		Clients:      clientSupport(true, true),
		Credentials:  &CredentialFacts{VendorID: "kiro"},
		RelayHosts:   relayHostsNodeOnly("Go 无 kiro 推理上游适配器（规划见 2026-10-17-inference-capability-registry.md P2）"),
		// usage_scan：kiro-cli 的会话写在宿主共享的 ~/.kiro/sessions/<sha256(cwd)[:16]>/sess_*/messages.jsonl，
		// 每次模型请求一条 contextUsage（上下文占用百分比）、每轮一条 usage_summary（credits + status），
		// 2026-10-19 实测 kiro-cli 2.32。token 没有原生字段，按「百分比 × 模型 maxInputTokens」估算；
		// 账号归属取自持久会话注册表的账号作用域（lib/usage/kiro-session-usage.js）。
		Capabilities: []Capability{CapabilityModelCatalog, CapabilitySessionHistory, CapabilityAccountSessionStore, CapabilityQuotaUsage, CapabilityUsageScan},
		AuthOptions: []AuthOption{
			authOption(AuthModeOAuthDevice, "AWS Builder ID 登录", "由 aih 直接完成 AWS SSO OIDC 设备码授权（Builder ID / IAM Identity Center），不需要本地 kiro CLI。"),
			authOption(AuthModeOAuthRefreshToken, "Kiro Desktop / refresh_token", "Kiro Desktop（Google / GitHub）账号：粘贴 Kiro IDE 的 refresh_token 完成导入。"),
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
			// Kiro CLI.app 内含 kiro_cli_desktop 原生 GUI，是现有桌面启动/实例
			// 隔离通道；Kiro.app（IDE）作为第二种落点保留。安装作业完成后的
			// 校验优先使用安装计划回报的实际落点，因此装了 IDE 时不会被
			// 先命中的 CLI 宿主掩盖。
			DesktopClient: describeDesktopClient(desktopClient(
				"Kiro",
				[]string{"kiro_cli_desktop", "Kiro"},
				[]string{"/Kiro CLI.app/Contents/MacOS/", "/Kiro.app/Contents/MacOS/"},
				[]string{"/Applications/Kiro CLI.app", "{hostHomeDir}/Applications/Kiro CLI.app", "/Applications/Kiro.app", "{hostHomeDir}/Applications/Kiro.app"},
				[]string{"Kiro.exe"},
				[]string{"Kiro.exe"},
				[]string{"kiro", "Kiro"},
			), "", []string{"Kiro"}),
		},
		NativeBoundary: nativeKiro(),
	}
}

// builtinZcode 定义 ZCode Desktop 的 Z.AI OAuth 与 API Key 双账号模式。
// ZCode 原生使用 Anthropic 协议（/v1/messages），凭据保存在
// ~/.zcode/v2/credentials.json（无 refresh token，过期需重新 login 导入）。
func builtinZcode() Definition {
	return Definition{
		ID:             "zcode",
		NativeBoundary: nativeZcode(),
		Presentation:   withAPIHost(presentation("zcode", "ZCode", "ZC", "◈", "geekblue"), "z.ai"),
		Gateway:        GatewayActive,
		// cli=true：ZCode CLI（0.17.0，随 Desktop 分发的 glm/zcode.cjs）已接入 aih 的
		// 启动/会话/非交互链路；此前声明为 false，于是 `aih zcode` 是「未识别的命令」，
		// 只能开 Desktop。
		Clients:      clientSupport(true, true),
		Credentials:  &CredentialFacts{APIKeyEnv: []string{"ZCODE_API_KEY"}, BaseURLEnv: []string{"ZCODE_BASE_URL"}},
		RelayHosts:   relayHostsNodeOnly("Go 无 zcode 推理上游适配器（规划见 2026-10-17-inference-capability-registry.md P2）"),
		Capabilities: []Capability{CapabilityAPIKeyAccount, CapabilityModelCatalog, CapabilitySessionHistory, CapabilityQuotaUsage, CapabilityUsageScan},
		AuthOptions: []AuthOption{
			// 两个**正交维度**，策略名是 `<区域>:<流程>`：
			//   区域：zai（国际站 chat.z.ai）/ bigmodel（国内站 bigmodel.cn）——
			//         决定授权入口、凭据键前缀（oauth:<region>:*）与套餐目录；
			//   流程：cli-flow（官方服务端中介，默认；无需本机回调地址/协议处理器/本机浏览器）
			//         / custom-scheme（zcode:// 自定义协议，授权后手填回调地址）。
			// loopback 不可用：该 client 的 redirect_uri 白名单已不再接受任何 http://localhost 地址。
			// 维度正交：新增区域或流程各加一条，不在派发代码里写 if。
			authOptionWithStrategy(AuthModeOAuthBrowser, "zai:cli-flow", "ZCode 登录（Z.AI 国际站 · 官方 CLI 流程）", "chat.z.ai 服务端中介授权：无需本机回调地址、不需协议处理器、也不需本机浏览器。"),
			authOptionWithStrategy(AuthModeOAuthBrowser, "bigmodel:cli-flow", "ZCode 登录（BigModel 国内站 · 官方 CLI 流程）", "bigmodel.cn 服务端中介授权：无需本机回调地址、不需协议处理器、也不需本机浏览器。"),
			authOptionWithStrategy(AuthModeOAuthBrowser, "zai:custom-scheme", "ZCode 登录（Z.AI 国际站 · zcode:// 回调）", "用官方注册的 zcode:// 回调，授权后需把回调地址粘贴回来；需本机注册该协议处理器。"),
			authOptionWithStrategy(AuthModeOAuthBrowser, "bigmodel:custom-scheme", "ZCode 登录（BigModel 国内站 · zcode:// 回调）", "用官方注册的 zcode:// 回调，授权后需把回调地址粘贴回来；需本机注册该协议处理器。"),
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
			// 非交互入口：`-p/--prompt`（ZCode 0.17.0 实测）。
			Headless: &HeadlessConfig{TriggerFlags: []string{"-p", "--prompt"}},
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

// builtinCodebuddy 定义 CodeBuddy Code CLI 与 CodeBuddy IDE 桌面端。
//
// 原生事实（2026-09-14 实测 @tencent-ai/codebuddy-code@2.150.0 + 官方 Homebrew cask）：
//   - CLI 包：npm `@tencent-ai/codebuddy-code`，bin 别名 codebuddy / cbc / codebuddy-code。
//   - 配置根目录：`~/.codebuddy`，只能由环境变量 `CODEBUDDY_CONFIG_DIR` 覆盖
//     （CLI 没有 --config-dir 参数，故本定义刻意不填 ConfigDirFlag）；账号隔离
//     因此在 launch-profile 里走环境变量注入，而不是命令行注入。
//   - configDir 不涵盖共享登录态；内嵌 CLI 读取 HOME 下的 CodeBuddyExtension
//     auth/*.info，启动隔离必须同时重定向 HOME，凭据导入链仍需单独适配。
//   - 登录入口：CLI 没有 `login` 子命令。首次交互式启动会打印
//     "Select login method:" 选择国内站 / 国际站 / 企业域名 / iOA，TUI 内另有
//     `/login`、`/logout` 斜杠命令。因此 LoginArgs 为空数组，登录形态即
//     "裸启动 + CLI 自己弹出登录方式选择"，与官方文档描述一致。
//   - 非交互入口：`-p/--print`（配合 `--output-format json|stream-json`）。
//   - 会话恢复：`-c/--continue`、`-r/--resume <sessionId>`、`--session-id <uuid>`。
//   - 桌面端：CodeBuddy IDE（VS Code 内核）。macOS 安装包名 `CodeBuddy.app`、
//     bundle id 前缀 `com.tencent.codebuddy`，官方 Homebrew cask 为 `codebuddy`。
//
// 本次刻意不声明的能力（能力 = 已落地适配器的声明，未实现就不声明，避免出现
// "声称支持但无实现"的链路）：
//   - account_session_store：见 session_history 的说明——会话读的是宿主地区目录，
//     不是账号隔离沙箱，所以不能声明这个能力。
//   - session_runtime / fabric_runtime / gateway_profile：Fabric runtime 与内置
//     网关 profile 路由未接入。
//     上述每一项都应作为独立的后续迭代，而不是在这里提前声明。
//
// session_history **已接入**（2026-09-15）：适配器在
// lib/sessions/session-reader-codebuddy.js，站点合并口径见该文件头部注释——
// 同一站点的 WorkBuddy 与 CodeBuddy 跑同一套 runtime、共用一份会话存储，
// 读取时把两个数据根合并成一份地区历史。
//
// 站点边界：本 Provider 代表**国际站**（codebuddy.ai）。国内站是独立 Provider
// `codebuddycn`，原因见 builtinCodebuddyCN 的说明。
//
// CLI/IDE 可能共享 HOME 下的 .info 登录态；本批不接管宿主凭据文件。
// reloadsHostAuth=false 表示尚未接通自动导入，并不表示上游凭据必然不通用。
// HOME 与 --user-data-dir 均按账号隔离，首次登录由原生程序完成。
func builtinCodebuddy() Definition {
	reloadsHostAuth := false
	return Definition{
		ID:             "codebuddy",
		NativeBoundary: nativeCodebuddyCLI(),
		RelayHosts:     relayHostsGoRelay("gateway.openai.chat_completions"),
		Presentation:   withAPIHost(presentation("codebuddy", "CodeBuddy", "CB", "❖", "blue"), "codebuddy.ai"),
		Gateway:        GatewayActive,
		Clients:        clientSupport(true, true),
		Credentials:    &CredentialFacts{APIKeyEnv: []string{"CODEBUDDY_API_KEY"}, BaseURLEnv: []string{"CODEBUDDY_BASE_URL"}},
		// session_history：会话读取适配器已落地
		// （lib/sessions/session-reader-codebuddy.js）。**刻意不声明 account_session_store**：
		// 会话读的是宿主地区目录而不是账号沙箱（见 SessionSync 的说明）。
		// quota_usage：家族四支共用同一个余额接口（POST {endpoint}/billing/meter/
		// get-user-resource-summary，无 /v2 前缀），同地区 work/code 是同一个账号、
		// 同一份积分，因此四支一起声明。适配器在 lib/cli/services/usage/
		// codebuddy-quota-probe.js，端点/鉴权头见 lib/account/codebuddy-billing.js。
		// model_catalog：从会话使用的 CLI `--help` 读取该账号支持的模型，家族四支共用
		// lib/server/workbuddy-model-discovery.js，运行时与账号环境保持一致。
		Capabilities: []Capability{CapabilityAPIKeyAccount, CapabilityModelCatalog, CapabilitySessionHistory, CapabilityQuotaUsage, CapabilityUsageScan, CapabilityACPSession},
		AuthOptions: []AuthOption{
			authOption(
				AuthModeOAuthBrowser,
				"CodeBuddy 登录",
				"使用 CodeBuddy Code 原生浏览器登录流程（首次启动选择国内站 / 国际站 / 企业域名）。",
			),
			authOption(
				AuthModeAPIKey,
				"CodeBuddy 密钥",
				"绑定 CODEBUDDY_API_KEY / CODEBUDDY_BASE_URL（非交互模式固定使用该密钥）。",
			),
		},
		// 会话同步：CLI 把会话落在 `<configDir>/projects/<project>/<sessionId>.jsonl`
		// （ACP/CodeBuddy 私有 JSONL 形态），AIH 已有读取适配器，因此声明 polling。
		// 无官方 hook，事件清单为空，不会产生空轮询。
		SessionSync: SessionSync{Mode: SessionSyncPolling, Events: []string{}},
		CLI: &CLIConfig{
			Order:      12,
			GlobalDir:  ".codebuddy",
			ConfigFile: "settings.json",
			// 空数组而非 nil：CLI 无 login 子命令，登录由裸启动的交互式选择完成。
			LoginArgs:  []string{},
			BinaryName: "codebuddy",
			Package:    "@tencent-ai/codebuddy-code",
			// CODEBUDDY_CONFIG_DIR：唯一的 configDir 覆盖手段（无 --config-dir 参数）。
			// CODEBUDDY_INTERNET_ENVIRONMENT：国内站（internal）/ 内网 iOA（ioa）与
			// API Key 搭配使用时必须显式指定，否则国内密钥会被路由到国际站而鉴权失败。
			// CODEBUDDY_COPILOT_INTERNET_ENVIRONMENT：IDE / Copilot 侧读取的同义开关
			// （2026-09-14 在 WorkBuddy.app 的 app.asar 内实测到 ENV_KEY_ 常量），
			// CLI 与 IDE 各自读自己的键，所以两个都要声明，避免只配一个时出现
			// "CLI 走国内站、IDE 仍打国际站"的静默分裂。
			// CODEBUDDY_AUTH_TOKEN：平台级 token（Token 刷新 / 计费查询），属账号私有。
			EnvKeys: []string{
				"CODEBUDDY_API_KEY",
				"CODEBUDDY_BASE_URL",
				"CODEBUDDY_AUTH_TOKEN",
				"CODEBUDDY_INTERNET_ENVIRONMENT",
				"CODEBUDDY_COPILOT_INTERNET_ENVIRONMENT",
				"CODEBUDDY_CONFIG_DIR",
			},
			// 命中 `-p` / `--print` 即判定为非交互调用（读取 stdin 后打印退出）。
			Headless: &HeadlessConfig{TriggerFlags: []string{"-p", "--print"}},
			// 只声明 macOS Desktop：`desktopClient[platform]` 存在 = Toolkit 会在该平台
			// 列出这个桌面应用，而列表里的每个应用都必须有安装/更新/卸载生命周期
			// （见 test/toolkit-app-lifecycle-matrix.test.js 的不变量）。CodeBuddy IDE
			// 目前只有 macOS 有可验证的免交互安装源（官方 Homebrew cask `codebuddy`），
			// Windows/Linux 官方只提供浏览器下载页（SPA，无法解析直链），因此这里
			// 刻意不声明，避免展示一个无法管理的应用。codex / claude / kimi 对 linux
			// 用的是同一取舍。
			//
			// 等 Windows/Linux 出现可验证的安装源时，在这里补 DesktopPlatform 并在
			// lib/server/app-installers/codebuddy.js 补对应 resolveDesktopInstallPlans
			// 即可（安装器里的 windows/linux hint 已经写好了人工指引）。
			//
			// ExecNames 必须是 bundle 内真实存在的可执行名。2026-09-14 实测
			// `CodeBuddy.app/Contents/MacOS/` 下只有 `Electron`（VS Code 内核的
			// Electron 主程序），没有以产品命名的可执行文件；`findDesktopClientRecord`
			// 会用 `execNames.find(存在者) || execNames[0]` 取值，若只写 "CodeBuddy"
			// 会解析出一个不存在的可执行路径，桌面端重启链路随之整体失效。
			// 同族的 CodeBuddy CN / WorkBuddy 也都是 `Electron`。
			DesktopClient: &DesktopClient{
				// 凭据不通用：桌面端只做账号隔离，不做 host auth 投影（独立登录）。
				ReloadsHostAuth: &reloadsHostAuth,
				MacOS: &DesktopPlatform{
					ClientName:   "CodeBuddy",
					ExecNames:    []string{"Electron"},
					BundleID:     "com.tencent.codebuddy",
					PathIncludes: []string{"/CodeBuddy.app/Contents/MacOS/"},
					InstallPaths: []string{
						"/Applications/CodeBuddy.app",
						"{hostHomeDir}/Applications/CodeBuddy.app",
					},
				},
			},
		},
	}
}

// builtinCodebuddyCN 定义 CodeBuddy **国内站**（copilot.tencent.com / codebuddy.cn）。
//
// 为什么国内站是独立 Provider，而不是同一个 Provider 的第二个站点：
//   - 账号体系不互通。国内站与国际站各自发凭据，同一个自然人两边是不同的账号；
//     AIH 的账号身份轴就是 Provider（accountRef 绑定 Provider、展示标签形如
//     `<provider>-<n>`、存储策略按 Provider 分派），把两套互不互认的身份塞进同一个
//     Provider 会出现"同 Provider 下两个无法互认的 OAuth 身份"，且 identitySeed
//     无法区分站点。
//   - 实机佐证（2026-09-14）：国内/国际是**两个独立 App、两个 bundle id**——
//     `CodeBuddy.app`（com.tencent.codebuddy，codebuddy.ai）与
//     `CodeBuddy CN.app`（com.tencent.codebuddycn，copilot.tencent.com），
//     官方 Homebrew cask 也分别维护 `codebuddy` 与 `codebuddy-cn`。
//   - 与既有先例一致：`qoder`（全球站）与 `qodercn`（国内站）就是两个 Provider。
//
// CLI 侧是**同一个 npm 包**（`@tencent-ai/codebuddy-code`，官方 install.sh 从
// myqcloud 拉同一份 releases），站点在首次登录时选择，并由
// CODEBUDDY_INTERNET_ENVIRONMENT=internal 显式固定。因此这里刻意声明
// `InstallRegion: "cn"`、复用同一个 Package/BinaryName，只用默认站点 env 与
// 独立的 GlobalDir 表达"国内站账号"——不伪造第二个二进制。
func builtinCodebuddyCN() Definition {
	reloadsHostAuth := false
	return Definition{
		ID:             "codebuddycn",
		NativeBoundary: nativeCodebuddyCNCLI(),
		RelayHosts:     relayHostsGoRelay("gateway.openai.chat_completions"),
		Presentation:   withAPIHost(presentation("codebuddycn", "CodeBuddy CN", "CBCN", "✦", "purple"), "copilot.tencent.com"),
		Gateway:        GatewayActive,
		Clients:        clientSupport(true, true),
		Credentials:    &CredentialFacts{APIKeyEnv: []string{"CODEBUDDY_API_KEY"}, BaseURLEnv: []string{"CODEBUDDY_BASE_URL"}},
		// 与 codebuddy 同口径：会话历史已接入，账号隔离存储不声明（读的是宿主地区目录）。
		// quota_usage：家族四支共用同一个余额接口（POST {endpoint}/billing/meter/
		// get-user-resource-summary，无 /v2 前缀），同地区 work/code 是同一个账号、
		// 同一份积分，因此四支一起声明。适配器在 lib/cli/services/usage/
		// codebuddy-quota-probe.js，端点/鉴权头见 lib/account/codebuddy-billing.js。
		// model_catalog：与 codebuddy 同一适配器，CLI 与凭据严格取本地区、本账号。
		Capabilities: []Capability{CapabilityAPIKeyAccount, CapabilityModelCatalog, CapabilitySessionHistory, CapabilityQuotaUsage, CapabilityUsageScan, CapabilityACPSession},
		AuthOptions: []AuthOption{
			authOption(
				AuthModeOAuthBrowser,
				"CodeBuddy CN 登录",
				"使用 CodeBuddy Code 原生登录流程并选择国内站（copilot.tencent.com）。",
			),
			authOption(
				AuthModeAPIKey,
				"CodeBuddy CN 密钥",
				"绑定 CODEBUDDY_API_KEY / CODEBUDDY_BASE_URL，并固定 CODEBUDDY_INTERNET_ENVIRONMENT=internal。",
			),
		},
		// 与 codebuddy 共用同一个二进制与同一套会话落盘形态，因此同为 polling。
		// 国内站的历史归属见 workbuddycn 的说明：codebuddycn 与 WorkBuddy.app 共用
		// 一份地区会话（~/.codebuddy-cn 与 ~/.workbuddy 合并读取）。
		SessionSync: SessionSync{Mode: SessionSyncPolling, Events: []string{}},
		CLI: &CLIConfig{
			Order:      13,
			GlobalDir:  ".codebuddy-cn",
			ConfigFile: "settings.json",
			// 与 codebuddy 同理：CLI 无 login 子命令，登录由裸启动的交互式选择完成。
			LoginArgs:  []string{},
			BinaryName: "codebuddy",
			Package:    "@tencent-ai/codebuddy-code",
			// 国内站安装计划只走官方国内入口（copilot.tencent.com）。
			InstallRegion: "cn",
			// EnvKeys 与 codebuddy 完全一致：同一个二进制读同一组键，区别只在
			// 账号为国内站时把 INTERNET_ENVIRONMENT 固定成 internal。
			EnvKeys: []string{
				"CODEBUDDY_API_KEY",
				"CODEBUDDY_BASE_URL",
				"CODEBUDDY_AUTH_TOKEN",
				"CODEBUDDY_INTERNET_ENVIRONMENT",
				"CODEBUDDY_COPILOT_INTERNET_ENVIRONMENT",
				"CODEBUDDY_CONFIG_DIR",
			},
			Headless: &HeadlessConfig{TriggerFlags: []string{"-p", "--print"}},
			// 桌面端只声明 macOS：国内官方 Homebrew cask `codebuddy-cn` 可免交互
			// 安装/更新/卸载 CodeBuddy CN.app；Windows/Linux 官方只给浏览器下载页
			// （安装器里留了 hint），声明了就会出现"无法管理的应用"，违反
			// test/toolkit-app-lifecycle-matrix.test.js 的不变量。
			DesktopClient: &DesktopClient{
				ReloadsHostAuth: &reloadsHostAuth,
				MacOS: &DesktopPlatform{
					ClientName:   "CodeBuddy CN",
					ExecNames:    []string{"Electron"},
					BundleID:     "com.tencent.codebuddycn",
					PathIncludes: []string{"/CodeBuddy CN.app/Contents/MacOS/"},
					InstallPaths: []string{
						"/Applications/CodeBuddy CN.app",
						"{hostHomeDir}/Applications/CodeBuddy CN.app",
					},
				},
			},
		},
	}
}

// builtinWorkbuddy 定义 WorkBuddy **国际站**（workbuddy.ai）桌面端。
//
// 与 CodeBuddy / Qoder 的关系（2026-09-15 实测纠正）：
//   - WorkBuddy 自己就是一条双站点产品线，与 CodeBuddy 的双站点是**平行的两条**，
//     不是 CodeBuddy 的第二个构建。官方 Homebrew cask 分别维护
//     `workbuddy-cn`（WorkBuddy.app，workbuddy.cn，com.tencent.workbuddy.mac）
//     与 `workbuddy-ai`（WorkBuddy AI.app，workbuddy.ai，com.workbuddy.workbuddy-ai）。
//   - 两个构建共用同一套 CodeBuddy Code 运行时，`CODEBUDDY_HOST` 字面量都是
//     `workbuddy-desktop`，但**登录态文件不同名**：国内站写
//     `workbuddy-desktop.info`，国际站写 `workbuddy-desktop-ai.info`
//     （实测两文件并存于 CodeBuddyExtension 的 auth 目录，realm 分别是
//     www.workbuddy.cn 与 www.workbuddy.ai，uid 也不同）。
//   - 因此国内/国际必须拆成两个 Provider：账号体系不互通，投影根也必须分开。
//     本 Provider 是国际站；国内站见 builtinWorkbuddyCN()。
//
// 只声明桌面端：WorkBuddy 不对外分发独立 CLI——它把 CodeBuddy Code runtime
// 内嵌在 App 内（app.asar 里读取 CODEBUDDY_CONFIG_DIR），所以不声明可安装 CLI。
func builtinWorkbuddy() Definition {
	reloadsHostAuth := false
	return Definition{
		ID:             "workbuddy",
		NativeBoundary: nativeWorkbuddy(),
		RelayHosts:     relayHostsGoRelay("gateway.openai.chat_completions"),
		Presentation:   withAPIHost(presentation("workbuddy", "WorkBuddy", "WB", "◉", "green"), "workbuddy.cn"),
		Gateway:        GatewayActive,
		Clients:        clientSupport(false, true),
		// BaseURLEnv：家族四支共用同一套 CodeBuddy Code runtime，Base URL 覆盖与
		// codebuddy 同源（认证方式的说明文案本来就写着「绑定 CODEBUDDY_API_KEY /
		// CODEBUDDY_BASE_URL」，缺了这条声明会让 WebUI 编辑账号时**写不进接口地址**
		// —— 2026-10-29 真机：applyCredentialPatch 只对契约声明过的键写入）。
		Credentials: &CredentialFacts{APIKeyEnv: []string{"CODEBUDDY_API_KEY"}, BaseURLEnv: []string{"CODEBUDDY_BASE_URL"}},
		// 会话历史已接入：WorkBuddy AI.app 与 codebuddy 跑同一套 CodeBuddy Code runtime，
		// 写的是同一份地区会话存储，读取时两个数据根合并成一个项目列表。
		// 客户端能力仍是 desktop-only（没有可安装的独立 CLI），因此可读历史、不可自行启动。
		// quota_usage：家族四支共用同一个余额接口（POST {endpoint}/billing/meter/
		// get-user-resource-summary，无 /v2 前缀），同地区 work/code 是同一个账号、
		// 同一份积分，因此四支一起声明。适配器在 lib/cli/services/usage/
		// codebuddy-quota-probe.js，端点/鉴权头见 lib/account/codebuddy-billing.js。
		// model_catalog：个人账号没有模型接口，模型列表取 App 内嵌 CLI `--help` 里按当前登录
		// 给出的「当前支持」列表（会话 --model 校验的也是它），适配器在
		// lib/server/workbuddy-model-discovery.js，家族四支共用。
		Capabilities: []Capability{CapabilityAPIKeyAccount, CapabilityModelCatalog, CapabilitySessionHistory, CapabilityQuotaUsage, CapabilityUsageScan, CapabilityACPSession},
		AuthOptions: []AuthOption{
			authOption(
				AuthModeOAuthBrowser,
				"WorkBuddy 登录",
				"使用 WorkBuddy 原生浏览器登录流程（国际站 workbuddy.ai 账号体系）。",
			),
			authOption(
				AuthModeAPIKey,
				"WorkBuddy 密钥",
				"绑定 CODEBUDDY_API_KEY / CODEBUDDY_BASE_URL（国际站不要固定 CODEBUDDY_INTERNET_ENVIRONMENT）。",
			),
		},
		// 会话同步：WorkBuddy AI.app 内嵌的就是 CodeBuddy Code runtime，会话落在
		// `~/.workbuddy-ai/projects`，与 codebuddy 的 `~/.codebuddy/projects` 合并成
		// 一份国际站历史。桌面端没有独立 CLI，所以这里只声明"可读"的 polling。
		SessionSync: SessionSync{Mode: SessionSyncPolling, Events: []string{}},
		// Clients.CLI=false 时仍然需要 CLIConfig：DesktopClient 挂在它下面，
		// 且 globalDir 是账号投影根。这里如实声明 WorkBuddy 自己的数据根。
		CLI: &CLIConfig{
			Order: 14,
			// 国际站的数据根是 `.workbuddy-ai`（官方 cask workbuddy-ai 的 zap 清单
			// 与 ~/.workbuddy-ai 实机目录一致），与国内站的 `.workbuddy` 不同名。
			GlobalDir:  ".workbuddy-ai",
			ConfigFile: "settings.json",
			LoginArgs:  []string{},
			// 没有独立 CLI 分发，因此不声明 BinaryName / Package：
			// provider-registry 只按 clients.cli 判定可安装 CLI，这里为 false，
			// 不会出现"声称可安装但装不了"的条目。
			EnvKeys: []string{
				"WORKBUDDY_CONFIG_DIR",
				"WORKBUDDY_USER_DATA_DIR",
				"CODEBUDDY_CONFIG_DIR",
				"CODEBUDDY_INTERNET_ENVIRONMENT",
				// 凭据键必须声明（2026-10-29 真机）：lib/profile/credential-config.js 的
				// deriveCliSpec 按命名约定**从 EnvKeys 派生** api-key 映射
				// （`*_API_KEY` / `*_BASE_URL`），漏了它们 WebUI 新增 api-key 账号会直接
				// `unknown_cli: Unsupported cli name`，而契约里本来就提供了「WorkBuddy 密钥」
				// 这个认证方式、Credentials.BaseURLEnv 也声明了 CODEBUDDY_BASE_URL。
				"CODEBUDDY_API_KEY",
				"CODEBUDDY_BASE_URL",
				"CODEBUDDY_AUTH_TOKEN",
			},
			DesktopClient: &DesktopClient{
				// 共享 .info 的宿主凭据导入尚未接通；连接器 credentials 不属于主站登录态。
				ReloadsHostAuth: &reloadsHostAuth,
				// 实测进程 env 中的真实键：WorkBuddy 用它解析 userData 根。
				// 把它指向账号隔离目录 = 每个账号一份独立登录态（独立扫码）。
				UserDataEnvKey: "WORKBUDDY_USER_DATA_DIR",
				MacOS: &DesktopPlatform{
					ClientName:   "WorkBuddy AI",
					ExecNames:    []string{"Electron"},
					BundleID:     "com.workbuddy.workbuddy-ai",
					PathIncludes: []string{"/WorkBuddy AI.app/Contents/MacOS/"},
					InstallPaths: []string{
						"/Applications/WorkBuddy AI.app",
						"{hostHomeDir}/Applications/WorkBuddy AI.app",
					},
				},
			},
		},
	}
}

// builtinWorkbuddyCN 定义 WorkBuddy **国内站**（workbuddy.cn）桌面端。
//
// 与 codebuddycn 的关系：两者是**不同产品、不同 App**，但共用同一账号体系与
// 同一份主站登录态文件（`workbuddy-desktop.info`）——WorkBuddy.app 与它内嵌的
// CodeBuddy Code CLI 读写的就是这一份。所以国内侧的"CLI 与 App 同一账号"不需要
// 任何开关：两个 Provider 声明同一个 auth artifact 即可。
//
// 与 builtinWorkbuddy() 的差别只在站点：国际站用 `workbuddy-desktop-ai.info`
// 与 `.workbuddy-ai`，国内站用 `workbuddy-desktop.info` 与 `.workbuddy`，
// 投影根分开，避免同一台机器上两个站点的账号看到同一个目录。
func builtinWorkbuddyCN() Definition {
	reloadsHostAuth := false
	return Definition{
		ID:             "workbuddycn",
		// WorkBuddy CN owns the same embedded CodeBuddy runtime as WorkBuddy AI,
		// but uses the domestic provider's HOME/config root and auth projection.
		// Keep the native boundary aligned with the actual WorkBuddy app bundle:
		// native marketplace resources, `.codebuddy.json` MCP projection and the
		// descriptor-declared lite bundle runtime. The provider-specific identity
		// and storage scope remain on this Definition/CLI descriptor.
		NativeBoundary: nativeWorkbuddy(),
		RelayHosts:     relayHostsGoRelay("gateway.openai.chat_completions"),
		Presentation:   withAPIHost(presentation("workbuddycn", "WorkBuddy CN", "WBCN", "◍", "gold"), "copilot.tencent.com"),
		Gateway:        GatewayActive,
		Clients:        clientSupport(false, true),
		// 与 workbuddy 同源：Base URL 覆盖与 codebuddy 家族一致（见上面那条说明）。
		Credentials: &CredentialFacts{APIKeyEnv: []string{"CODEBUDDY_API_KEY"}, BaseURLEnv: []string{"CODEBUDDY_BASE_URL"}},
		// 与 workbuddy 同口径：国内站 WorkBuddy.app 与 codebuddycn 共用同一份地区会话存储。
		// quota_usage：家族四支共用同一个余额接口（POST {endpoint}/billing/meter/
		// get-user-resource-summary，无 /v2 前缀），同地区 work/code 是同一个账号、
		// 同一份积分，因此四支一起声明。适配器在 lib/cli/services/usage/
		// codebuddy-quota-probe.js，端点/鉴权头见 lib/account/codebuddy-billing.js。
		// model_catalog：个人账号没有模型接口，模型列表取 App 内嵌 CLI `--help` 里按当前登录
		// 给出的「当前支持」列表（会话 --model 校验的也是它），适配器在
		// lib/server/workbuddy-model-discovery.js，家族四支共用。
		Capabilities: []Capability{CapabilityAPIKeyAccount, CapabilityModelCatalog, CapabilitySessionHistory, CapabilityQuotaUsage, CapabilityUsageScan, CapabilityACPSession},
		AuthOptions: []AuthOption{
			authOption(
				AuthModeOAuthBrowser,
				"WorkBuddy CN 登录",
				"使用 WorkBuddy 原生浏览器登录流程（国内站 workbuddy.cn 账号体系）。",
			),
			authOption(
				AuthModeAPIKey,
				"WorkBuddy CN 密钥",
				"绑定 CODEBUDDY_API_KEY / CODEBUDDY_BASE_URL，并固定 CODEBUDDY_INTERNET_ENVIRONMENT=internal。",
			),
		},
		// 会话同步：国内站 WorkBuddy.app 与 codebuddycn 共用同一份地区会话
		// （~/.workbuddy/projects 与 ~/.codebuddy-cn/projects 合并读取），因此也声明 polling。
		// 两个 Provider 都会读到同一批会话；展示层按会话 id 去重，只保留一份
		// （见 lib/server/webui-project-cache.js 的 buildProjectsSnapshot）。
		SessionSync: SessionSync{Mode: SessionSyncPolling, Events: []string{}},
		CLI: &CLIConfig{
			Order: 15,
			// 国内站的数据根是 `.workbuddy`（官方 cask workbuddy-cn 的 zap 清单
			// 与 ~/.workbuddy 实机目录一致）。
			GlobalDir:  ".workbuddy",
			ConfigFile: "settings.json",
			LoginArgs:  []string{},
			// EnvKeys 与 builtinWorkbuddy() 一致：同一套内嵌 runtime 读同一组键，
			// 区别只在国内站账号把 INTERNET_ENVIRONMENT 固定成 internal。
			// 凭据键同理必须声明（见 builtinWorkbuddy() 的说明）。
			EnvKeys: []string{
				"WORKBUDDY_CONFIG_DIR",
				"WORKBUDDY_USER_DATA_DIR",
				"CODEBUDDY_CONFIG_DIR",
				"CODEBUDDY_INTERNET_ENVIRONMENT",
				"CODEBUDDY_API_KEY",
				"CODEBUDDY_BASE_URL",
				"CODEBUDDY_AUTH_TOKEN",
			},
			DesktopClient: &DesktopClient{
				ReloadsHostAuth: &reloadsHostAuth,
				UserDataEnvKey:  "WORKBUDDY_USER_DATA_DIR",
				MacOS: &DesktopPlatform{
					ClientName:   "WorkBuddy",
					ExecNames:    []string{"Electron"},
					BundleID:     "com.tencent.workbuddy.mac",
					PathIncludes: []string{"/WorkBuddy.app/Contents/MacOS/"},
					InstallPaths: []string{
						"/Applications/WorkBuddy.app",
						"{hostHomeDir}/Applications/WorkBuddy.app",
					},
				},
			},
		},
	}
}

// builtinCline 定义 Cline 的 API Key 与 Cline Pass 订阅两种账号模式。
//
// 推理面是 api.cline.bot 的 OpenAI 兼容 REST（/api/v1/chat/completions），
// 成功路径就是标准 OpenAI SSE，因此网关侧按 openai_chat 直通。
// 账号凭据两种：API Key（providers.cline.apiKey）与 Cline Pass OAuth
// （providers["cline-pass"].auth 的 accessToken/refreshToken）。
// 原生 CLI 只有一个可执行文件（npm 包 cline），隔离根是 CLINE_DIR——
// CLINE_DATA_DIR 只是它下面 <CLINE_DIR>/data 的覆盖点，不是第二个根。
// 非交互入口是 `cline --json "<prompt>"`（Headless 声明见 CLI.Headless）：
// 一次性跑完即退，stdout 是 NDJSON agent 事件；`--id` 续聊仍必须 TTY。
// 会话恢复走原生 `--id <session-id>`（见 nativeCline）：会话身份与历史在
// <CLINE_DATA_DIR>/db/sessions.db，持久会话重启恢复因此能精确续接同一段对话。
func builtinCline() Definition {
	return Definition{
		ID:             "cline",
		Presentation:   withAPIHost(presentation("cline", "Cline", "CLN", "⟡", "magenta"), "cline.bot"),
		Gateway:        GatewayActive,
		Clients:        clientSupport(true, false),
		Credentials:    &CredentialFacts{VendorID: "cline", APIKeyEnv: []string{"CLINE_API_KEY"}, BaseURLEnv: []string{"CLINE_API_BASE_URL"}, CLIRequiresAuthFile: true},
		NativeBoundary: nativeCline(),
		// cline 走 relaycore 的同协议透传通道（internal/transport/http/clinerelay）：
		// 上游就是标准 OpenAI 兼容端点（POST {base}/chat/completions + Bearer workos:<JWT>），
		// 没有任何硬约束，因此它是「多数派零覆盖」的验证用例——Provider 只声明端点与
		// 凭据取法，改写/请求头/错误分类全部沿用 relaycore.BaseProvider 的默认实现。
		// 账号层由 nativeaccount 的 clineIdentity 解码，导入走原生信封。
		RelayHosts: relayHostsGoRelay("gateway.openai.chat_completions"),
		// session_history + account_session_store：会话读的是账号沙箱里的
		// <CLINE_DATA_DIR>/db/sessions.db 与 sessions/<id>/<id>.messages.json
		// （lib/sessions/session-reader-cline.js）。共享存储落地后同一条路径就是宿主
		// 那份会话（软链接），因此 aih 会话历史与宿主 `cline /history` 看到的是同一批。
		// session_runtime：WebUI 聊天可驱动 cline CLI —— 新会话走 `cline --json <prompt>`
		// 的 NDJSON 事件流，续聊只能 `cline --id <id>` 进 TUI（CLI 要求 TTY），
		// 两条路径的声明见 lib/server/native-session-chat-transport.js。
		// usage_scan：cline 自己把每轮 token 记账写在会话文件里
		// （sessions/<id>/<id>.messages.json 的 messages[].metrics = inputTokens /
		// outputTokens / cacheReadTokens / cacheWriteTokens，2026-10-15 实测 3.0.71），
		// 因此不需要网关流量也能统计该账号的 token 用量；账号归属取自持久会话注册表的
		// 账号作用域（lib/usage/cline-usage-ownership.js）。
		Capabilities: []Capability{CapabilityAPIKeyAccount, CapabilityModelCatalog, CapabilitySessionHistory, CapabilityAccountSessionStore, CapabilitySessionRuntime, CapabilityUsageScan, CapabilityACPSession},
		AuthOptions: []AuthOption{
			authOption(AuthModeAPIKey, "Cline API Key", "绑定 CLINE_API_KEY / CLINE_API_BASE_URL。"),
			authOption(AuthModeOAuthBrowser, "Cline Pass 登录", "使用 Cline 原生 auth 流程（需 Cline Pass 订阅）。"),
		},
		SessionSync: SessionSync{Mode: SessionSyncUnavailable, Events: []string{}},
		CLI: &CLIConfig{
			Order:      16,
			GlobalDir:  ".cline",
			LoginArgs:  []string{"auth"},
			BinaryName: "cline",
			Package:    "cline",
			EnvKeys:    []string{"CLINE_DIR", "CLINE_DATA_DIR", "CLINE_API_KEY", "CLINE_API_BASE_URL"},
			// `cline --json "<prompt>"` 是一次性非交互入口：stdout 是 NDJSON agent 事件、
			// 非 TTY 下跑完即退（2026-10-15 实测 3.0.71；README 也把 --json 列为 headless/CI 用法）。
			// 注意 `--id <session-id>` 续聊**要求 TTY**，因此只有新会话能走这条 headless 路径
			// （WebUI 聊天的分流见 lib/server/native-session-chat-transport.js）。
			Headless: &HeadlessConfig{TriggerFlags: []string{"--json"}},
		},
	}
}

// family 标注一个 Provider 所属的产品族与站点。
//
// 只有真正存在国内/国际双站点的产品线才需要显式调用（qoder / codebuddy /
// workbuddy）。站点不同 = 账号体系不互通 = 必须是两个 Provider，因此这里不改
// 身份，只补一层"它们属于同一个产品"的展示归属。
func family(definition Definition, family string, site Site) Definition {
	definition.Family = family
	definition.Site = site
	return definition
}

// withDefaultSite 为未显式标注的 Provider 补齐产品族与站点。
//
// 单站产品的 Family 就是它自己的 ID，Site 默认国际站——绝大多数 Provider 都是
// 单站，逐个写 family(x, x, SiteGlobal) 只会制造噪音和漂移风险。
func withDefaultSite(definitions []Definition) []Definition {
	for index := range definitions {
		if definitions[index].Family == "" {
			definitions[index].Family = definitions[index].ID
		}
		if definitions[index].Site == "" {
			definitions[index].Site = SiteGlobal
		}
	}
	return definitions
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

// withAPIHost 给描述符补上**默认 API 域名**（展示用，见 Presentation.APIHost）。
// 独立于 presentation() 是为了不改那 17 处既有调用签名。
func withAPIHost(p Presentation, host string) Presentation {
	p.APIHost = host
	return p
}

// authOption 统一构造 Client 认证选项。
func authOption(value AuthMode, label, description string) AuthOption {
	return AuthOption{Value: value, Label: label, Description: description}
}

func authOptionWithStrategy(value AuthMode, strategy, label, description string) AuthOption {
	return AuthOption{Value: value, Strategy: strategy, Label: label, Description: description}
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

// describeDesktopClient 为已构造的桌面客户端补充安装后探测所需的强身份：
// macOS bundle id 与 Windows 卸载注册表产品名。两者都存在时，探测不必依赖
// 固定的安装目录（实际包名/安装位置由厂商安装器决定）。
func describeDesktopClient(client *DesktopClient, macBundleID string, windowsDisplayNames []string) *DesktopClient {
	if client == nil {
		return nil
	}
	if client.MacOS != nil && macBundleID != "" {
		client.MacOS.BundleID = macBundleID
	}
	if client.Windows != nil && len(windowsDisplayNames) > 0 {
		client.Windows.DisplayNames = windowsDisplayNames
	}
	return client
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

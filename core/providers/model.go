// Package providers 定义 AI Home 的 Provider 领域合同。
//
// 该包只保存稳定身份、声明式能力和跨语言生成所需的数据，不能依赖 Server、Web 或具体 I/O 实现。
package providers

// SchemaVersion 是 Provider 跨语言合同的当前版本。
//
// 2: Definition 新增 family/site，Client 投影同步暴露，用于把国内站/国际站
// 聚合回同一个产品入口（此前菜单里只能并排显示两个条目）。
const SchemaVersion = 2

// Site 是 Provider 归属的产品站点。
//
// 同一产品族的国内站与国际站账号体系不互通（各自发凭据、同一自然人两边是
// 不同账号），所以它们必须是两个独立 Provider——身份轴、accountRef、存储策略
// 都按 Provider 分派。Site 只用于把两者聚合回同一个产品入口与同一份展示，
// 不参与任何账号身份判定。
type Site string

const (
	// SiteGlobal 是国际站（qoder 全球站 / codebuddy.ai / workbuddy.ai）。
	SiteGlobal Site = "global"
	// SiteCN 是国内站（qoder 国内站 / copilot.tencent.com / workbuddy.cn）。
	SiteCN Site = "cn"
)

// GatewayState 描述 Provider 在自动网关路由中的生命周期状态。
type GatewayState string

const (
	// GatewayActive 表示 Provider 可以进入自动网关候选集。
	GatewayActive GatewayState = "active"
	// GatewayDeprecated 表示 Provider 仅保留显式调用，不进入自动网关候选集。
	GatewayDeprecated GatewayState = "deprecated"
)

// Capability 是与具体实现解耦的 Provider 能力标识。
type Capability string

const (
	// CapabilityAPIKeyAccount 表示可以创建 API Key 或 Token 账号。
	CapabilityAPIKeyAccount Capability = "api_key_account"
	// CapabilityModelCatalog 表示可以进入统一模型目录探测链路。
	CapabilityModelCatalog Capability = "model_catalog"
	// CapabilityQuotaUsage 表示可以生成统一额度快照。
	CapabilityQuotaUsage Capability = "quota_usage"
	// CapabilitySessionRuntime 表示已接入 Fabric 的 Provider runtime/session 控制面。
	CapabilitySessionRuntime Capability = "session_runtime"
	// CapabilityFabricRuntime 表示可发布到 Fabric runtime registry 的 Provider。
	// 它比 session_runtime 更宽，允许保留仅支持显式/兼容 runtime 的 Provider。
	CapabilityFabricRuntime Capability = "fabric_runtime"
	// CapabilityGatewayProfile 表示可以通过 AIH 内置网关 profile 启动客户端。
	CapabilityGatewayProfile Capability = "gateway_profile"
	// CapabilitySessionHistory 表示 AIH 已实现该 Provider 的历史项目/会话读取适配器。
	CapabilitySessionHistory Capability = "session_history"
	// CapabilityAccountSessionStore 表示会话存储位于账号隔离的 runtime 目录中。
	CapabilityAccountSessionStore Capability = "account_session_store"
	// CapabilityUsageScan 表示已实现本地历史用量扫描适配器。
	CapabilityUsageScan Capability = "usage_scan"
	// CapabilityACPSession 表示该 Provider 已登记 ACP（Agent Client Protocol）会话入口，
	// 可由 aih 以 ACP 模式启动会话；入口参数与传输形态由 Node 侧布局表
	// （lib/runtime/acp-layouts.js）声明，Go 侧只登记能力（Node 描述符同源声明 `acp`）。
	CapabilityACPSession Capability = "acp_session"
)

// AuthMode 是账号创建时可选择的认证方式。
type AuthMode string

const (
	// AuthModeAPIKey 表示 API Key 或等价 Personal Access Token。
	AuthModeAPIKey AuthMode = "api-key"
	// AuthModeAuthToken 表示 Claude Code 独立认证 Token。
	AuthModeAuthToken AuthMode = "auth-token"
	// AuthModeOAuthBrowser 表示浏览器或原生 CLI OAuth 流程。
	AuthModeOAuthBrowser AuthMode = "oauth-browser"
	// AuthModeOAuthDevice 表示设备码 OAuth 流程。
	AuthModeOAuthDevice AuthMode = "oauth-device"
	// AuthModeOAuthRefreshToken 表示由用户提供 refresh_token 的 OAuth 导入
	// （没有浏览器/设备码环节，例如 Kiro Desktop / social 账号）。
	AuthModeOAuthRefreshToken AuthMode = "oauth-refresh-token"
	// AuthModeVertexAI 表示 Google Cloud Vertex AI 认证流程。
	AuthModeVertexAI AuthMode = "vertex-ai"
)

// SessionSyncMode 描述 Provider 会话变化如何同步到 AI Home。
type SessionSyncMode string

const (
	// SessionSyncHook 表示使用官方 Hook 或受控插件桥接事件。
	SessionSyncHook SessionSyncMode = "hook"
	// SessionSyncPolling 表示没有官方 Hook，但可以轮询原生会话存储。
	SessionSyncPolling SessionSyncMode = "polling"
	// SessionSyncUnavailable 表示当前没有可靠的会话同步能力。
	SessionSyncUnavailable SessionSyncMode = "unavailable"
)

// Manifest 是所有语言共同消费的 Provider 合同快照。
type Manifest struct {
	SchemaVersion int          `json:"schemaVersion"`
	GeneratedFrom string       `json:"generatedFrom"`
	Providers     []Definition `json:"providers"`
	Fallback      Presentation `json:"fallback"`
}

// Definition 是一个 Provider 的完整声明，不包含账号密钥和可变运行态。
type Definition struct {
	ID string `json:"id"`
	// Family 是产品族标识，同一产品族的国内站/国际站共享同一个值。
	// 单站产品的 Family 等于 ID，由 BuiltinManifest 统一补齐，无需逐个声明。
	Family string `json:"family"`
	// Site 是该 Provider 归属的站点；未显式声明时为 SiteGlobal。
	//
	// 消费方（Client 菜单 / 账号页）按 family 聚合、按 site 排序与标注，
	// 但账号始终挂在具体 Provider 上——聚合只影响展示，不影响身份。
	Site           Site              `json:"site"`
	Presentation   Presentation      `json:"presentation"`
	Gateway        GatewayState      `json:"gateway"`
	Capabilities   []Capability      `json:"capabilities"`
	AuthOptions    []AuthOption      `json:"authOptions"`
	SessionSync    SessionSync       `json:"sessionSync"`
	Clients        ClientSupport     `json:"clients"`
	CLI            *CLIConfig        `json:"cli,omitempty"`
	NativeBoundary *NativeCapability `json:"nativeBoundary,omitempty"`
	// Credentials 是凭据相关的静态事实（厂商标识与各类凭据的环境变量名），
	// 让调用方查表而不是按 provider 名写分支。未声明的字段表示该 Provider 没有这类凭据。
	Credentials *CredentialFacts `json:"credentials,omitempty"`
	// RelayHosts 声明**各宿主**能否承接该 Provider 的推理，key 为宿主名（"node" / "go"）。
	//
	// 为什么需要它：Provider 有没有 HTTP 推理通道（账号侧事实）与「哪个宿主能服务它」
	// 是两个问题。同一 Provider 可能 Node 能服务而 Go 不能（上游适配器尚未落地），
	// 而路由一旦划给 Go 就没有 Node 回落——请求只会失败。把「Go 能不能服务」显式声明出来，
	// 转发判定才能问能力而不是查一份容易漂移的中央名单。
	//
	// 未声明的宿主 = 该宿主不能服务（保守侧）；声明 supported=false 时 Reason 必填，
	// 让「为什么不能」可读，而不是留下一个没人知道原因的缺席。
	RelayHosts map[string]RelayHost `json:"relayHosts,omitempty"`
}

// RelayHost 描述某个宿主对该 Provider 推理的承接能力。
type RelayHost struct {
	// Supported 表示该宿主能否服务该 Provider 的推理。
	Supported bool `json:"supported"`
	// Channel 是承接通道：'canonical'（有完整上游适配器，全入口可用）或
	// 'relay'（同协议透传，受 Entries 限制）。Supported 为 false 时无意义。
	Channel string `json:"channel,omitempty"`
	// Entries 限定该通道挂载的入口；空表示全部推理入口。
	// 例：家族透传只挂在 gateway.openai.chat_completions，在 /v1/messages 上不可用。
	Entries []string `json:"entries,omitempty"`
	// Reason 在 Supported=false 时必填：为什么该宿主不能服务（如「Go 无 cline 上游适配器」）。
	Reason string `json:"reason,omitempty"`
}

// Relay 通道名。与 Node 侧 lib/providers/contract.js 的取值逐字一致。
const (
	// RelayChannelCanonical 表示宿主有该 Provider 的完整上游适配器。
	RelayChannelCanonical = "canonical"
	// RelayChannelRelay 表示宿主以同协议透传方式承接（不重建协议语义）。
	RelayChannelRelay = "relay"
)

// RelayHostNode / RelayHostGo 是 RelayHosts 的键。
const (
	RelayHostNode = "node"
	RelayHostGo   = "go"
)

// CredentialFacts 记录与凭据有关的静态事实。环境变量列表按优先级排列：
// 调用方取第一个非空值，因此顺序本身就是合同的一部分。
type CredentialFacts struct {
	// VendorID 是上游厂商在外部账号交换格式（如 sub2api 的 platform）中的标识。
	VendorID string `json:"vendorId,omitempty"`
	// APIKeyEnv 是 API 密钥的环境变量；任一非空即判定为 API 密钥账号。
	APIKeyEnv []string `json:"apiKeyEnv,omitempty"`
	// AuthTokenEnv 是 Bearer 鉴权令牌（第三方协议兼容端点）的环境变量。
	AuthTokenEnv []string `json:"authTokenEnv,omitempty"`
	// BaseURLEnv 是 API 基础地址的环境变量。
	BaseURLEnv []string `json:"baseUrlEnv,omitempty"`
	// CLIRequiresAuthFile 表示原生 CLI 只从凭据文件读凭据、不认环境变量里的密钥：
	// 即使账号的密钥在 env 里，启动沙箱也必须投影原生凭据文件（如 opencode 的 auth.json）。
	CLIRequiresAuthFile bool `json:"cliRequiresAuthFile,omitempty"`
}

// ClientSupport 是 Provider 面向用户的客户端形态合同。
//
// CLIConfig/DesktopClient 保存发现、隔离和运行时细节；Clients 只表达产品
// 是否应在 Toolkit 和账号入口中呈现对应客户端。两者刻意分离，允许保留
// 兼容性的内部运行时投影（例如历史桌面内置 CLI），而不把它误报成可安装客户端。
type ClientSupport struct {
	CLI     bool `json:"cli"`
	Desktop bool `json:"desktop"`
}

// Presentation 保存跨 Server 和 Client 共用的展示元数据。
type Presentation struct {
	ID                string `json:"id"`
	Label             string `json:"label"`
	Short             string `json:"short"`
	TerminalIcon      string `json:"terminalIcon"`
	TerminalIconAsset string `json:"terminalIconAsset"`
	AccentVar         string `json:"accentVar"`
	SoftVar           string `json:"softVar"`
	TagColor          string `json:"tagColor"`
}

// AuthOption 描述 Client 可以展示的账号认证选项。
type AuthOption struct {
	Value          AuthMode `json:"value"`
	Label          string   `json:"label"`
	Description    string   `json:"description"`
	Disabled       bool     `json:"disabled,omitempty"`
	DisabledReason string   `json:"disabledReason,omitempty"`
}

// SessionSync 保存会话同步的声明，具体写文件或读数据库仍由 Integration Adapter 实现。
type SessionSync struct {
	Mode       SessionSyncMode `json:"mode"`
	Adapter    string          `json:"adapter,omitempty"`
	TargetKind string          `json:"targetKind,omitempty"`
	Events     []string        `json:"events"`
}

// CLIConfig 描述原生 CLI 的发现、登录和账号隔离参数。
type CLIConfig struct {
	Order                  int             `json:"order"`
	GlobalDir              string          `json:"globalDir"`
	ConfigSubDir           string          `json:"configSubDir,omitempty"`
	ConfigFile             string          `json:"configFile,omitempty"`
	ConfigAtProjectionRoot bool            `json:"configAtProjectionRoot,omitempty"`
	LoginArgs              []string        `json:"loginArgs"`
	BinaryName             string          `json:"binaryName,omitempty"`
	Package                string          `json:"pkg"`
	ConfigDirFlag          string          `json:"configDirFlag,omitempty"`
	InstallRegion          string          `json:"installRegion,omitempty"`
	EnvKeys                []string        `json:"envKeys"`
	DesktopClient          *DesktopClient  `json:"desktopClient,omitempty"`
	Headless               *HeadlessConfig `json:"headless,omitempty"`
}

// HeadlessConfig 描述该原生 CLI 的非交互（一次性打印后退出）调用形态。
// 缺省（nil）表示该 CLI 没有非交互入口，只能走 PTY 交互路径。
type HeadlessConfig struct {
	// TriggerFlags 中任一 flag 出现在 argv 里即判定为非交互调用。
	TriggerFlags []string `json:"triggerFlags,omitempty"`
	// TriggerSubcommands 命中首个位置参数即判定为非交互调用（codex exec / opencode run）。
	TriggerSubcommands []string `json:"triggerSubcommands,omitempty"`
	// StdinFlags 以 "name=value" 声明「需要接通父进程 stdin」的形态，
	// 同时接受 `--name value` 与 `--name=value` 两种写法。
	StdinFlags []string `json:"stdinFlags,omitempty"`
}

// DesktopClient 描述可选桌面客户端的跨平台启动信息。
type DesktopClient struct {
	ReloadsHostAuth *bool            `json:"reloadsHostAuth,omitempty"`
	UserDataEnvKey  string           `json:"userDataEnvKey,omitempty"`
	MacOS           *DesktopPlatform `json:"macos,omitempty"`
	Windows         *DesktopPlatform `json:"windows,omitempty"`
	Linux           *DesktopPlatform `json:"linux,omitempty"`
}

// DesktopPlatform 描述单个平台上的桌面客户端候选路径和进程名。
type DesktopPlatform struct {
	ClientName   string   `json:"clientName"`
	ProcessNames []string `json:"processNames,omitempty"`
	ExecNames    []string `json:"execNames"`
	PathIncludes []string `json:"pathIncludes,omitempty"`
	BundleID     string   `json:"bundleId,omitempty"`
	InstallPaths []string `json:"installPaths,omitempty"`
	// DisplayNames 是 Windows 卸载注册表里的产品名（用于安装后探测，不猜安装目录）。
	DisplayNames []string `json:"displayNames,omitempty"`
}

// NativeCapability 描述原生 CLI 对配置、会话、MCP、Hook 和权限的边界。
type NativeCapability struct {
	Config      NativeConfig      `json:"config"`
	Sessions    NativeSessions    `json:"sessions"`
	MCP         NativeMCP         `json:"mcp"`
	Hooks       NativeHooks       `json:"hooks"`
	Permissions NativePermissions `json:"permissions"`
}

// NativeConfig 描述原生配置文件和 CLI 参数入口。
type NativeConfig struct {
	EnvHomeKeys     []string `json:"envHomeKeys"`
	UserSettings    []string `json:"userSettings"`
	ProjectSettings []string `json:"projectSettings"`
	CLIFlags        []string `json:"cliFlags"`
}

// NativeSessions 描述原生会话恢复参数和存储形态。
type NativeSessions struct {
	Flags       []string `json:"flags"`
	NativeStore string   `json:"nativeStore"`
}

// NativeMCP 描述原生 MCP 命令和配置文件。
type NativeMCP struct {
	Commands    []string `json:"commands"`
	ConfigFiles []string `json:"configFiles"`
}

// NativeHooks 描述原生 Hook 文件和 Stop 事件输出要求。
type NativeHooks struct {
	Files                  []string `json:"files"`
	StopRequiresJSONStdout bool     `json:"stopRequiresJsonStdout"`
}

// NativePermissions 描述原生权限参数和可选模式。
type NativePermissions struct {
	Flags []string `json:"flags"`
	Modes []string `json:"modes"`
}

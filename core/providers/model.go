// Package providers 定义 AI Home 的 Provider 领域合同。
//
// 该包只保存稳定身份、声明式能力和跨语言生成所需的数据，不能依赖 Server、Web 或具体 I/O 实现。
package providers

// SchemaVersion 是 Provider 跨语言合同的当前版本。
const SchemaVersion = 1

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
	ID             string            `json:"id"`
	Presentation   Presentation      `json:"presentation"`
	Gateway        GatewayState      `json:"gateway"`
	Capabilities   []Capability      `json:"capabilities"`
	AuthOptions    []AuthOption      `json:"authOptions"`
	SessionSync    SessionSync       `json:"sessionSync"`
	CLI            *CLIConfig        `json:"cli,omitempty"`
	NativeBoundary *NativeCapability `json:"nativeBoundary,omitempty"`
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
	Order                  int            `json:"order"`
	GlobalDir              string         `json:"globalDir"`
	ConfigSubDir           string         `json:"configSubDir,omitempty"`
	ConfigAtProjectionRoot bool           `json:"configAtProjectionRoot,omitempty"`
	LoginArgs              []string       `json:"loginArgs"`
	BinaryName             string         `json:"binaryName,omitempty"`
	Package                string         `json:"pkg"`
	ConfigDirFlag          string         `json:"configDirFlag,omitempty"`
	InstallRegion          string         `json:"installRegion,omitempty"`
	EnvKeys                []string       `json:"envKeys"`
	DesktopClient          *DesktopClient `json:"desktopClient,omitempty"`
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

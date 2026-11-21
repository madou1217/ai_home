// Package providers 定义 AI Home 的 Provider 领域合同。
//
// 该包只保存稳定身份、声明式能力和跨语言生成所需的数据，不能依赖 Server、Web 或具体 I/O 实现。
package providers

import "strings"

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
	// CapabilitySessionRuntime 表示已接入原生会话 runtime/session 控制面。
	CapabilitySessionRuntime Capability = "session_runtime"
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
	// Upstream 是该 Provider 的官方上游事实（主机清单与默认推理基址），
	// 供出口裁决、中继通道与额度探测查表，不再由调用方按 Provider 名分支。
	Upstream *Upstream `json:"upstream,omitempty"`
	// Storage 是该 Provider 自己的本地存储布局事实。
	//
	// 配置根不在这里重复声明：CLI.GlobalDir 是唯一来源。Storage 只承载无法从
	// 其他合同字段推导、且各 Provider 取值不同的布局事实（凭据文件名、IDE 数据
	// 目录名、家族会话根）。消费方必须查合同，不得再维护 Provider→目录的中央表。
	Storage *StorageFacts `json:"storage,omitempty"`
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
	// ModelPrefix 声明客户端用 `provider/model` 命名空间写法时是否解析该前缀。
	// 未声明 = 不解析，请求按原模型字面量路由（行为不变）。
	ModelPrefix *ModelPrefix `json:"modelPrefix,omitempty"`
}

// ModelPrefix 是 Provider 对 `provider/model` 命名空间前缀的声明。
//
// 只有显式声明 supported=true 的 Provider 才会在入口把前缀还原成裸模型并把
// Provider 钉死；未声明的 Provider 逐字节保持原行为。Aliases 是同一 Provider 的
// 历史/上游别名（例如 zcode 的 zai），Provider ID 本身总是隐含可用。
type ModelPrefix struct {
	Supported bool     `json:"supported"`
	Reason    string   `json:"reason,omitempty"`
	Aliases   []string `json:"aliases,omitempty"`
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

// PreferredOAuthAuthMode 返回该 Provider 声明的首个 OAuth 认证方式。
//
// AuthOptions 的顺序就是产品默认顺序：codex 同时支持浏览器授权与设备码，默认取
// 浏览器授权；opencode / kiro 只声明设备码。没有 OAuth 形态时返回空串，
// 调用方不得自行猜测。
func (definition Definition) PreferredOAuthAuthMode() AuthMode {
	for _, option := range definition.AuthOptions {
		switch option.Value {
		case AuthModeOAuthBrowser, AuthModeOAuthDevice, AuthModeOAuthRefreshToken:
			return option.Value
		}
	}
	return ""
}

// CredentialFacts 返回该 Provider 声明的凭据事实；未声明时返回零值。
//
// 消费方一律通过本方法读取，避免每处各自判空指针，或在缺少声明时把
// 「合同没有这类凭据」与「合同声明了但值为空」混为一谈。
func (definition Definition) CredentialFacts() CredentialFacts {
	if definition.Credentials == nil {
		return CredentialFacts{}
	}
	return *definition.Credentials
}

// StorageFacts 是 Provider 自己的本地存储布局事实。
type StorageFacts struct {
	// NativeRoot 是存储策略使用的主数据根（HOME 相对段）。
	// nil 表示使用 CLI.GlobalDir；显式空切片表示该 Provider 没有原生数据根
	// （qoder 只做账号投影）。需要与配置根区分时显式声明（opencode 的配置根是
	// .config/opencode，原生数据根是 .local/share/opencode）。
	NativeRoot *[]string `json:"nativeRoot,omitempty"`
	// DefaultAuthFile 是该 Provider 在共享 auth 目录下的默认凭据文件名。
	DefaultAuthFile string `json:"defaultAuthFile,omitempty"`
	// IDEDataName 是 electron userData / Application Support 下的产品目录名。
	IDEDataName string `json:"ideDataName,omitempty"`
	// AttachmentSubdir 是原生数据根下存放会话附件的子目录。
	AttachmentSubdir []string `json:"attachmentSubdir,omitempty"`
	// SessionRoots 是同一物理会话存储在家族内的候选根（HOME 相对，按优先级）。
	SessionRoots []string `json:"sessionRoots,omitempty"`
	// NoRuntimeHome 表示该 Provider 不使用 <nativeRoot>/.aih-runtime-home。
	// 默认 false；kiro / cline 显式声明 true。
	NoRuntimeHome bool `json:"noRuntimeHome,omitempty"`
	// AuthArtifacts 是本 Provider 的凭据文件声明。Path 相对 Base：
	// native = EffectiveNativeRoot，config = CLI.GlobalDir，hostAuth = HostAuthRoot，
	// home（默认）就是 HOME 本身。消费方按展开后的 HOME 相对路径读取。
	AuthArtifacts []AuthArtifactFacts `json:"authArtifacts,omitempty"`
	// PrivateArtifacts 是账号私有状态路径（凭据目录、会话、桌面缓存等）。
	// Base 语义与 AuthArtifacts 相同。
	PrivateArtifacts []PrivateArtifactFacts `json:"privateArtifacts,omitempty"`
	// HostAuthRoot 是宿主上共享认证/运行数据的根（HOME 相对段）。
	// nil 表示未声明；显式空切片表示根就是 HOME 本身。
	HostAuthRoot *[]string `json:"hostAuthRoot,omitempty"`
	// ConfigDenyPaths 是本 Provider 声明必须拒绝读取的配置位置（HOME 相对）。
	// 文件同时拒绝 "<name>.<suffix>" 备份变体；Recursive 表示整目录拒绝。
	ConfigDenyPaths []ConfigDenyFacts `json:"configDenyPaths,omitempty"`
}

// Artifact Base 取值：凭据路径相对于哪个已声明的根。
const (
	ArtifactBaseHome     = "home"
	ArtifactBaseNative   = "native"
	ArtifactBaseConfig   = "config"
	ArtifactBaseHostAuth = "hostAuth"
)

// AuthArtifactFacts 是一个 Provider 凭据文件的声明。
type AuthArtifactFacts struct {
	Field    string `json:"field"`
	Base     string `json:"base,omitempty"`
	Path     string `json:"path"`
	Format   string `json:"format,omitempty"`
	Optional bool   `json:"optional,omitempty"`
}

// PrivateArtifactFacts 是一个账号私有状态的声明（Base 语义同 AuthArtifactFacts）。
type PrivateArtifactFacts struct {
	Base string `json:"base,omitempty"`
	Path string `json:"path"`
}

// ConfigDenyFacts 是一条敏感的 Provider 配置位置。
//
// 目录（Recursive）拒绝其下所有文件；文件拒绝自身及同名备份变体。
// WebUI 文件 API 的 deny 名单只能从这里汇总，不再维护 Provider→路径的中央表。
type ConfigDenyFacts struct {
	Path      string `json:"path"`
	Recursive bool   `json:"recursive,omitempty"`
}

// EffectiveNativeRoot 返回存储策略使用的主数据根。
//
// 默认取 CLI.GlobalDir；Storage.NativeRoot 显式声明时优先（包括显式空切片）。
func (definition Definition) EffectiveNativeRoot() []string {
	if definition.Storage != nil && definition.Storage.NativeRoot != nil {
		// 显式空切片要保持非 nil：调用方用 len 判断，不看 nil 语义。
		return append([]string{}, (*definition.Storage.NativeRoot)...)
	}
	if definition.CLI == nil {
		return nil
	}
	dir := strings.TrimSpace(definition.CLI.GlobalDir)
	if dir == "" {
		return nil
	}
	return strings.Split(dir, "/")
}

// Upstream 是 Provider 的官方上游事实。
type Upstream struct {
	// OfficialHosts 是官方 API 主机（不含 scheme 与路径）。
	OfficialHosts []string `json:"officialHosts,omitempty"`
	// DefaultBaseURLs 是按凭据形态给出的官方默认推理基址，key 取值：
	//   "api_key" —— API Key / 静态凭据账号；
	//   "oauth"   —— OAuth 账号；
	//   "default" —— 不区分凭据形态。
	// 未声明表示该 Provider 没有静态默认值，必须由账号自身 baseUrl 或全局覆盖提供。
	DefaultBaseURLs map[string]string `json:"defaultBaseUrls,omitempty"`
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
	// APIHost 是该 Provider 的**默认 API 域名**（不含 scheme，例如 api.openai.com）。
	//
	// 为什么放在描述符里：前端展示 API Key 账号的身份时需要它（账号只有 baseUrl 时
	// 回落到厂商默认域名）。此前这份映射手写在 web/src/utils/account-labels.ts 的
	// `DEFAULT_API_KEY_DOMAINS: Record<Provider, string>` 里，于是**每加一个 Provider
	// 都要记得去改那张表**——漏了就在全量 TS 编译时报 TS2739（workbuddycn / cline
	// 就是这样漏的）。放进描述符后由 provider-manifest 生成，前端查表即可。
	APIHost string `json:"apiHost,omitempty"`
}

// AuthOption 描述 Client 可以展示的账号认证选项。
type AuthOption struct {
	Value AuthMode `json:"value"`
	// Strategy distinguishes multiple implementations of the same auth mode.
	// Empty keeps the historical single-strategy behavior.
	Strategy       string `json:"strategy,omitempty"`
	Label          string `json:"label"`
	Description    string `json:"description"`
	Disabled       bool   `json:"disabled,omitempty"`
	DisabledReason string `json:"disabledReason,omitempty"`
}

// SessionSync 保存会话同步的声明，具体写文件或读数据库仍由 Integration Adapter 实现。
type SessionSync struct {
	Mode       SessionSyncMode `json:"mode"`
	Adapter    string          `json:"adapter,omitempty"`
	TargetKind string          `json:"targetKind,omitempty"`
	Events     []string        `json:"events"`
	// Hook 是写文件所需的格式档案；nil 表示合同没有这项声明。
	// 只有 Mode=hook 时才能非 nil（见 validateSessionSync）。
	Hook *HookFormat `json:"hook,omitempty"`
}

// CLIConfig 描述原生 CLI 的发现、登录和账号隔离参数。
type CLIConfig struct {
	Order int `json:"order"`

	// DisplayName 是 Toolkit 应用列表里的 CLI 名称；空表示沿用 Provider 展示名
	// （例如 Codex CLI 的 Provider 展示名是 ChatGPT，但 CLI 本身叫 Codex）。
	DisplayName string `json:"displayName,omitempty"`

	GlobalDir              string   `json:"globalDir"`
	ConfigSubDir           string   `json:"configSubDir,omitempty"`
	ConfigFile             string   `json:"configFile,omitempty"`
	ConfigAtProjectionRoot bool     `json:"configAtProjectionRoot,omitempty"`
	LoginArgs              []string `json:"loginArgs"`
	BinaryName             string   `json:"binaryName,omitempty"`
	Package                string   `json:"pkg"`
	ConfigDirFlag          string   `json:"configDirFlag,omitempty"`
	InstallRegion          string   `json:"installRegion,omitempty"`
	// InstallRoot 是官方安装器放置二进制的 HOME 相对根（可多段）。
	// 未声明表示二进制由 PATH / 包管理器管理，没有独立安装根；
	// opencode 的安装器写到 ~/.opencode/bin，与配置根 .config/opencode 不同。
	InstallRoot   *[]string       `json:"installRoot,omitempty"`
	EnvKeys       []string        `json:"envKeys"`
	DesktopClient *DesktopClient  `json:"desktopClient,omitempty"`
	Headless      *HeadlessConfig `json:"headless,omitempty"`
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
	ReloadsHostAuth *bool  `json:"reloadsHostAuth,omitempty"`
	UserDataEnvKey  string `json:"userDataEnvKey,omitempty"`
	// Key 是 AIH 桌面应用目录里的稳定标识；为空表示该客户端不进入
	// `aih desktop` 的管理集合（仍可作为原生启动器的落点信息）。
	Key string `json:"key,omitempty"`
	// ShadowDirName 是需要影子副本时的目录名（位于 run/ 下）；空表示不做影子。
	ShadowDirName string           `json:"shadowDirName,omitempty"`
	MacOS         *DesktopPlatform `json:"macos,omitempty"`
	Windows       *DesktopPlatform `json:"windows,omitempty"`
	Linux         *DesktopPlatform `json:"linux,omitempty"`
}

// DesktopPlatform 描述单个平台上的桌面客户端候选路径和进程名。
type DesktopPlatform struct {
	ClientName   string   `json:"clientName"`
	ProcessNames []string `json:"processNames,omitempty"`
	ExecNames    []string `json:"execNames"`
	PathIncludes []string `json:"pathIncludes,omitempty"`
	BundleID     string   `json:"bundleId,omitempty"`
	// BundleNames 是 macOS 上的 .app 文件名（按查找优先级）。
	BundleNames []string `json:"bundleNames,omitempty"`
	// LegacyBundleIDs 是旧版本使用过的 bundle id；仅用于显示回落，
	// 实际 id 优先从 Info.plist 读取。
	LegacyBundleIDs []string `json:"legacyBundleIds,omitempty"`
	InstallPaths    []string `json:"installPaths,omitempty"`
	// DisplayNames 是 Windows 卸载注册表里的产品名（用于安装后探测，不猜安装目录）。
	DisplayNames []string `json:"displayNames,omitempty"`
}

// NativeCapability 描述原生 CLI 对配置、会话、MCP、Hook 和权限的边界。
type NativeCapability struct {
	Runtime  *NativeResourceRuntime `json:"runtime,omitempty"`
	Config   NativeConfig           `json:"config"`
	Sessions NativeSessions         `json:"sessions"`
	MCP      NativeMCP              `json:"mcp"`
	// Plugins/Skills describe native installation or projection boundaries. Empty
	// declarations are intentional: consumers must report unsupported instead of
	// guessing a provider's filesystem layout.
	Plugins     NativePlugins     `json:"plugins"`
	Skills      NativeSkills      `json:"skills"`
	Hooks       NativeHooks       `json:"hooks"`
	Permissions NativePermissions `json:"permissions"`
}

// NativeResourceRuntime declares a bundled execution lane for resource management.
// It does not imply that a standalone user CLI is distributed by this provider.
type NativeResourceRuntime struct {
	Handler string            `json:"handler"`
	Entry   string            `json:"entry"`
	Env     map[string]string `json:"env,omitempty"`
}

// NativePlugins describes the native plugin management boundary.
type NativePlugins struct {
	// Adapter selects a registered host projection strategy. Consumers must not
	// dispatch on provider identity when this field is present.
	Adapter  string   `json:"adapter,omitempty"`
	PathBase string   `json:"pathBase,omitempty"`
	Commands []string `json:"commands"`
	Paths    []string `json:"paths"`
	Mode     string   `json:"mode"`
}

// NativeSkills describes the native skill or instruction projection boundary.
type NativeSkills struct {
	// PathBase is native-root by default; host-home resolves home-relative projections.
	PathBase string   `json:"pathBase,omitempty"`
	Commands []string `json:"commands"`
	Paths    []string `json:"paths"`
	Mode     string   `json:"mode"`
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
	// Explicit argv templates for user-requested verbs. Nil means unsupported;
	// an empty WithoutID means a precise identity is required, not a new chat.
	Resume *NativeSessionCommand `json:"resume,omitempty"`
	Fork   *NativeSessionCommand `json:"fork,omitempty"`
}

// NativeSessionCommand is shared by Node and Go adapters, not a shell string.
// WithID contains exactly one {sessionId} slot; WithoutID is a native picker or
// documented last-session form. Neither form is evaluated by a shell.
type NativeSessionCommand struct {
	WithID    []string `json:"withId"`
	WithoutID []string `json:"withoutId"`
}

// NativeMCP 描述原生 MCP 命令和配置文件。
type NativeMCP struct {
	// Projection is an explicitly verified editable stdio configuration boundary.
	Projection  *NativeMCPProjection `json:"projection,omitempty"`
	Commands    []string             `json:"commands"`
	ConfigFiles []string             `json:"configFiles"`
}

// NativeMCPProjection declares the configuration adapter without provider dispatch.
type NativeMCPProjection struct {
	Path          string   `json:"path"`
	PathBase      string   `json:"pathBase,omitempty"`
	Format        string   `json:"format"`
	Alternatives  []string `json:"alternatives,omitempty"`
	AccountScoped bool     `json:"accountScoped,omitempty"`
}

// NativeHooks 描述原生 Hook 文件和 Stop 事件输出要求。
type NativeHooks struct {
	Files                  []string `json:"files"`
	StopRequiresJSONStdout bool     `json:"stopRequiresJsonStdout"`
}

// NativePermissions 描述原生权限参数和可选模式。
//
// Env 是「最大权限参数也无法完全免确认」时的补充开关：宿主把它写进子进程环境，
// 与 Flags 推导出的最大权限参数一起生效。没有这类开关的 Provider 不声明即可。
type NativePermissions struct {
	Flags []string          `json:"flags"`
	Modes []string          `json:"modes"`
	Env   map[string]string `json:"env,omitempty"`
	// BlockingSubcommands 声明「这些子命令不接受权限覆盖」：例如 codex 的
	// resume / fork（恢复远程任务时上游会拒绝 Permission overrides）。启动器据此
	// 跳过注入，而不是发出注定被拒的组合。
	BlockingSubcommands []string `json:"blockingSubcommands,omitempty"`
}

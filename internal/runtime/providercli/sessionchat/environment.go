package sessionchat

import (
	"regexp"
	"strings"

	"github.com/madou1217/ai_home/core/providers"
)

// ProviderAccountRefEnv 是按账号启动时注入的账号引用变量名。
const ProviderAccountRefEnv = "AIH_PROVIDER_ACCOUNT_REF"

// accountScopedEnvKeys 是必须按账号隔离的环境变量：宿主的值先剥掉，再由账号记录注入。
// 与 Node provider-runtime-env 的 ACCOUNT_SCOPED_ENV_KEYS 同集合同序。
var accountScopedEnvKeys = []string{
	"AIH_CODEX_GATEWAY_ACCOUNT_REF",
	"OPENAI_API_KEY",
	"OPENAI_BASE_URL",
	"OPENAI_ORGANIZATION",
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_CUSTOM_HEADERS",
	"AIH_CLAUDE_CREDENTIAL_TYPE",
	"ANTHROPIC_MODEL",
	"CLAUDE_MODEL",
	"GEMINI_API_KEY",
	"GOOGLE_API_KEY",
	"GEMINI_BASE_URL",
	"GOOGLE_GEMINI_BASE_URL",
	"GOOGLE_VERTEX_BASE_URL",
	"GOOGLE_GENAI_USE_VERTEXAI",
	"GOOGLE_CLOUD_PROJECT",
	"GOOGLE_CLOUD_LOCATION",
	"AGY_ACCESS_TOKEN",
	"GOOGLE_OAUTH_ACCESS_TOKEN",
	"OPENCODE_API_KEY",
	"OPENCODE_CONFIG",
	"OPENCODE_CONFIG_DIR",
	"OPENCODE_CONFIG_CONTENT",
	"OPENCODE_SERVER_PASSWORD",
	"OPENCODE_SERVER_USERNAME",
	"QODER_PERSONAL_ACCESS_TOKEN",
	"MOONSHOT_API_KEY",
	"KIMI_API_KEY",
	"KIMI_BASE_URL",
	"KIMI_CODE_CUSTOM_HEADERS",
	"KIMI_CODE_HOME",
	"ZCODE_API_KEY",
	"ZCODE_DATA_BASE_DIR",
	"CODEBUDDY_API_KEY",
	"CODEBUDDY_BASE_URL",
	"CODEBUDDY_AUTH_TOKEN",
	"CODEBUDDY_INTERNET_ENVIRONMENT",
	"CODEBUDDY_COPILOT_INTERNET_ENVIRONMENT",
	"CODEBUDDY_CONFIG_DIR",
	"WORKBUDDY_CONFIG_DIR",
	"WORKBUDDY_USER_DATA_DIR",
	"ACC_PRODUCT_CONFIG_V3",
	"ACC_PRODUCT_CONFIG_V2",
	"ACC_PRODUCT_CONFIG_PATH",
	"CODEBUDDY_SIDECAR_READY_SOCKET",
	"CODEBUDDY_SIDECAR_CREDENTIAL_BOOTSTRAP_SOCKET",
	"CODEBUDDY_SIDECAR_READY_TOKEN",
	"CODEBUDDY_SIDECAR_READY_SESSION_ID",
	"CODEBUDDY_RUNTIME_INSTANCE_ID",
	"CODEBUDDY_API_KEY_DISABLED",
	"WORKBUDDY_AT_REST_ENCRYPTION",
	"CLINE_API_KEY",
	"CLINE_API_BASE_URL",
	ProviderAccountRefEnv,
}

// providerHomeKeys 是必须从宿主环境剥掉的 Provider 配置根变量：
// 它们会把宿主自己的账号目录/配置漏进账号沙箱，随后由 Provider 策略重新指向。
var providerHomeKeys = []string{
	"CLAUDE_CONFIG_DIR",
	"CODEX_HOME",
	"CODEX_SQLITE_HOME",
	"CODEX_ELECTRON_USER_DATA_PATH",
	"GEMINI_CLI_HOME",
	"GEMINI_CLI_SYSTEM_SETTINGS_PATH",
	"OPENCODE_API_KEY",
	"OPENCODE_CONFIG",
	"OPENCODE_CONFIG_DIR",
	"OPENCODE_CONFIG_CONTENT",
	"OPENCODE_SERVER_PASSWORD",
	"OPENCODE_SERVER_USERNAME",
	"QODER_PERSONAL_ACCESS_TOKEN",
	"MOONSHOT_API_KEY",
	"ZCODE_API_KEY",
	"ZCODE_DATA_BASE_DIR",
	"KIMI_CODE_HOME",
	"CODEBUDDY_CONFIG_DIR",
	"CLINE_DIR",
	"CLINE_DATA_DIR",
}

// StripAccountScopedEnv 复制一份 base，并删除全部按账号隔离的键（含小写形态）。
func StripAccountScopedEnv(base map[string]string) map[string]string {
	env := make(map[string]string, len(base))
	for key, value := range base {
		env[key] = value
	}
	for _, key := range accountScopedEnvKeys {
		delete(env, key)
		delete(env, strings.ToLower(key))
	}
	return env
}

// BuildAccountScopedEnv 先剥掉宿主的账号键，再注入本账号的 env。
func BuildAccountScopedEnv(base map[string]string, accountEnv map[string]string) map[string]string {
	env := StripAccountScopedEnv(base)
	for key, value := range accountEnv {
		env[key] = value
	}
	return env
}

// HasNonEmptyEnvValue 判断 env 中该键是否有非空值（去空白后）。
func HasNonEmptyEnvValue(env map[string]string, key string) bool {
	return strings.TrimSpace(env[key]) != ""
}

// AuthProjectionOptions 是「是否必须投影原生凭据文件」的输入。
type AuthProjectionOptions struct {
	IsLogin     bool
	Gateway     bool
	AuthRelayed bool
}

// credentialFactsForProvider 返回 Provider 合同的凭据事实；未知 Provider 返回空事实。
func credentialFactsForProvider(provider string) providers.CredentialFacts {
	catalog := providerCatalog()
	if catalog == nil {
		return providers.CredentialFacts{}
	}
	definition, found := catalog.Get(provider)
	if !found || definition.Credentials == nil {
		return providers.CredentialFacts{}
	}
	return *definition.Credentials
}

// RequiresProviderAuthProjection 判断启动沙箱是否必须投影原生凭据文件。
//
// 登录、原生 OAuth/文件凭据、以及合同声明 cliRequiresAuthFile 的 Provider
// （如 opencode 的 auth.json）一律需要；纯 env 鉴权（密钥/令牌已在 env）不需要。
func RequiresProviderAuthProjection(provider string, accountEnv map[string]string, options AuthProjectionOptions) bool {
	if options.IsLogin {
		return true
	}
	if options.Gateway {
		return false
	}
	if options.AuthRelayed {
		return false
	}
	facts := credentialFactsForProvider(NormalizeProvider(provider))
	if facts.CLIRequiresAuthFile {
		return true
	}
	for _, key := range facts.APIKeyEnv {
		if HasNonEmptyEnvValue(accountEnv, key) {
			return false
		}
	}
	for _, key := range facts.AuthTokenEnv {
		if HasNonEmptyEnvValue(accountEnv, key) {
			return false
		}
	}
	return true
}

// RuntimeScope 是运行时目录与投影需求。
type RuntimeScope struct {
	HostHomeDir        string
	ProjectionRequired bool
	RuntimeDir         string
}

// RuntimeScopeOptions 是运行时作用域解析的输入。
type RuntimeScopeOptions struct {
	AuthProjectionOptions
	// AccountEnv 是本账号要注入的环境（用于判断是否已有 env 鉴权，从而免投影）。
	AccountEnv               map[string]string
	HostHomeDir              string
	Platform                 string
	RelayKeepsAccountSandbox bool
}

// ResolveProviderRuntimeScope 解析宿主家目录、是否投影、以及本次运行目录。
//
// projectionRequired 时运行目录是 Provider 的凭据投影目录；否则在 relay 需要保留沙箱时
// 用投影根，其余情况用宿主家目录（共享配置与会话）。
func ResolveProviderRuntimeScope(provider string, projectionDir string, baseEnv map[string]string, options RuntimeScopeOptions) RuntimeScope {
	candidateDir := normalizeString(projectionDir)
	hostHomeDir := ResolveHostHomeDir(options.HostHomeDir, baseEnv, options.Platform)
	projectionRequired := RequiresProviderAuthProjection(provider, options.AccountEnv, options.AuthProjectionOptions)
	relayKeepsSandbox := (options.AuthRelayed || options.Gateway) && options.RelayKeepsAccountSandbox
	runtimeDir := hostHomeDir
	if projectionRequired {
		runtimeDir = ResolveCLIAuthProjectionDir(candidateDir, provider)
	} else if relayKeepsSandbox {
		runtimeDir = candidateDir
	}
	return RuntimeScope{
		HostHomeDir:        hostHomeDir,
		ProjectionRequired: projectionRequired,
		RuntimeDir:         runtimeDir,
	}
}

// BuildHostScopedBaseEnv 复制 base，剥掉 Provider 配置根变量，并把 HOME/USERPROFILE
// 指向宿主家目录（沙箱内的 ~ 就是宿主家，但 Provider 自己的配置根已由策略重指）。
func BuildHostScopedBaseEnv(base map[string]string, hostHomeDir string) map[string]string {
	env := make(map[string]string, len(base))
	for key, value := range base {
		env[key] = value
	}
	for _, key := range providerHomeKeys {
		delete(env, key)
	}
	if hostHomeDir != "" {
		env["HOME"] = hostHomeDir
		env["USERPROFILE"] = hostHomeDir
	}
	return env
}

// GeminiCliEndpointEnv 把账号库字段映射成 gemini CLI 实际读取的 GOOGLE_* 接入点。
//
// 账号库存 GEMINI_BASE_URL / VERTEX_AI_*，CLI 只认 GOOGLE_GEMINI_BASE_URL /
// GOOGLE_VERTEX_BASE_URL / GOOGLE_GENAI_USE_VERTEXAI / GOOGLE_CLOUD_*；不映射时
// Vertex 账号只带 API Key 直打 Google，返回 401。
func GeminiCliEndpointEnv(accountEnv map[string]string) map[string]string {
	value := func(key string) string { return strings.TrimSpace(accountEnv[key]) }
	env := map[string]string{}
	baseURL := value("GEMINI_BASE_URL")
	vertex := value("VERTEX_AI_PROJECT_ID") != "" || value("VERTEX_AI_LOCATION") != "" ||
		strings.EqualFold(value("GOOGLE_GENAI_USE_VERTEXAI"), "true")
	if vertex {
		env["GOOGLE_GENAI_USE_VERTEXAI"] = "true"
		if baseURL != "" {
			env["GOOGLE_VERTEX_BASE_URL"] = baseURL
		}
		// express（placeholder）账号实际走 API-key 分支，只认 GOOGLE_GEMINI_BASE_URL。
		if baseURL != "" && value("VERTEX_AI_PLACEHOLDER") == "true" {
			env["GOOGLE_GEMINI_BASE_URL"] = baseURL
		}
		// express 模式不能带项目/地域，否则 SDK 改走 ADC 认证。
		if project := value("VERTEX_AI_PROJECT_ID"); project != "" && value("VERTEX_AI_PLACEHOLDER") != "true" {
			env["GOOGLE_CLOUD_PROJECT"] = project
			if location := value("VERTEX_AI_LOCATION"); location != "" {
				env["GOOGLE_CLOUD_LOCATION"] = location
			}
		}
	} else if baseURL != "" {
		env["GOOGLE_GEMINI_BASE_URL"] = baseURL
	}
	return env
}

// BuildProviderEnvExtra 返回服务端聊天轮为 Provider 追加的 env：
// gemini 强制信任工作区，并叠加账号接入点映射。
func BuildProviderEnvExtra(provider string, accountEnv map[string]string) map[string]string {
	env := map[string]string{}
	if NormalizeProvider(provider) == "gemini" {
		env["GEMINI_CLI_TRUST_WORKSPACE"] = "true"
		for key, value := range GeminiCliEndpointEnv(accountEnv) {
			env[key] = value
		}
	}
	return env
}

// accountRefPattern 是合法账号引用的形状（acct_ + 20 位十六进制）。
var accountRefPattern = regexp.MustCompile("^acct_[a-f0-9]{20}$")

// NormalizeProviderAccountRef 校验并返回账号引用；非法值返回空串。
func NormalizeProviderAccountRef(value string) string {
	accountRef := strings.TrimSpace(value)
	if !accountRefPattern.MatchString(accountRef) {
		return ""
	}
	return accountRef
}

// EnvironmentInput 是环境投影的完整输入。
type EnvironmentInput struct {
	Provider    string
	BaseEnv     map[string]string
	AccountEnv  map[string]string
	HostHomeDir string
	ExtraEnv    map[string]string
	AccountRef  string
}

// codebuddySiteEnvKeys 是 CodeBuddy 家族两个站点开关的写入顺序。
//
// CLI 读 `CODEBUDDY_INTERNET_ENVIRONMENT`，IDE / Copilot 侧读
// `CODEBUDDY_COPILOT_INTERNET_ENVIRONMENT`；只写一个会出现「CLI 打 A 站、
// IDE 打 B 站」的静默分裂，所以两个键必须同值。
var codebuddySiteEnvKeys = []string{
	"CODEBUDDY_INTERNET_ENVIRONMENT",
	"CODEBUDDY_COPILOT_INTERNET_ENVIRONMENT",
}

// codebuddyFamilySiteEnv 返回 CodeBuddy 家族两支的默认站点。
//
// 与 Node 启动策略（DEFAULT_INTERNET_ENVIRONMENT_BY_PROVIDER）同口径：
// codebuddy = 国际站 external，codebuddycn = 国内站 internal。WorkBuddy 桌面两支
// 不在这里——它们的配置根与站点由桌面 App 自己维护。
func codebuddyFamilySiteEnv(provider string) string {
	switch NormalizeProvider(provider) {
	case "codebuddy":
		return "external"
	case "codebuddycn":
		return "internal"
	default:
		return ""
	}
}

// BuildProjectedEnvironment 构造服务端聊天轮传给原生 CLI 的环境基座。
//
// 顺序与 Node buildProviderRuntimeEnv 的纯投影段一致：
// 剥宿主账号键 → 合并本账号 env → 剥 Provider 配置根 + 重指 HOME → 注入 extraEnv
// → 写入账号引用。
//
// 未包含（仍留在 Node）：Provider 启动策略的 buildEnvPatch（13 家各自配置模板）、
// 跨 Provider 协作变量、codex managed-launch 标记、模型别名改写、PATH 归并、
// UTF-8 locale / 代理归一与出口守卫。这些依赖读盘、配置或系统代理，不属于纯投影。
func BuildProjectedEnvironment(input EnvironmentInput) map[string]string {
	scoped := BuildAccountScopedEnv(input.BaseEnv, input.AccountEnv)
	env := BuildHostScopedBaseEnv(scoped, input.HostHomeDir)
	if NormalizeProvider(input.Provider) == "gemini" {
		for key, value := range GeminiCliEndpointEnv(scoped) {
			env[key] = value
		}
	}
	// CodeBuddy 家族：站点必须显式固定。CLI 缺省按 internal 解析，国际站账号
	// （codebuddy，token 由 www.codebuddy.ai 签发）会被发到 copilot.tencent.com，
	// 业务请求与 CLI 自己的 refreshSession 都是 401（2026-11-10 真机）。
	// 账号 env 已显式声明时保留账号值（例如企业 iOA），并让另一个键跟随同一站点；
	// ExtraEnv 仍可覆盖。
	if site := codebuddyFamilySiteEnv(input.Provider); site != "" {
		for _, key := range codebuddySiteEnvKeys {
			if value := strings.TrimSpace(env[key]); value != "" {
				site = value
				break
			}
		}
		for _, key := range codebuddySiteEnvKeys {
			if strings.TrimSpace(env[key]) == "" {
				env[key] = site
			}
		}
	}
	for key, value := range input.ExtraEnv {
		env[key] = value
	}
	if accountRef := NormalizeProviderAccountRef(input.AccountRef); accountRef != "" {
		env[ProviderAccountRefEnv] = accountRef
	} else {
		delete(env, ProviderAccountRefEnv)
	}
	return env
}

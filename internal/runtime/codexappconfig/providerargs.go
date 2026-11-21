package codexappconfig

import (
	"net/url"
	"regexp"
	"strings"
)

// CodexFlagsEnv 是 codex 启动/恢复开关的合并环境变量。
const CodexFlagsEnv = "AIH_CODEX_FLAGS"

var startupPolicyConfigs = []string{
	"suppress_unstable_features_warning=true",
	"check_for_update_on_startup=false",
}

var configScopedSubcommands = map[string]struct{}{"exec": {}, "resume": {}, "app-server": {}}

// ProviderArgsOptions 控制 buildCodexProviderArgs 的注入条件。
type ProviderArgsOptions struct {
	Force       bool
	ProviderKey string
}

// BuildStartupPolicyArgs 返回启动策略对应的 -c 参数。
func BuildStartupPolicyArgs() []string {
	args := make([]string, 0, len(startupPolicyConfigs)*2)
	for _, value := range startupPolicyConfigs {
		args = append(args, "-c", value)
	}
	return args
}

// BuildProviderArgs 生成 Codex 的 -c provider 参数；空 API key/BaseURL 且非 force 时返回 nil。
func BuildProviderArgs(env map[string]string, options ProviderArgsOptions) []string {
	apiKey := strings.TrimSpace(env["OPENAI_API_KEY"])
	baseURL := strings.TrimSpace(env["OPENAI_BASE_URL"])
	if apiKey == "" && baseURL == "" && !options.Force {
		return []string{}
	}
	providerKey := strings.TrimSpace(options.ProviderKey)
	if providerKey == "" {
		providerKey = AIHProviderKey
	}
	values := make([]string, 0, 10)
	values = append(values, startupPolicyConfigs...)
	values = append(values, "model_provider="+providerKey)
	if baseURL != "" {
		values = append(values, "model_providers."+providerKey+".base_url="+baseURL)
	}
	values = append(values, "model_providers."+providerKey+".wire_api=responses")

	if ref := strings.TrimSpace(env["AIH_CODEX_GATEWAY_ACCOUNT_REF"]); regexp.MustCompile("^acct_[a-zA-Z0-9]+$").MatchString(ref) {
		values = append(values, "model_providers."+providerKey+".http_headers.X-Account-Ref="+ref)
	}
	if session := strings.TrimSpace(env["AIH_CODEX_GATEWAY_SESSION_KEY"]); regexp.MustCompile("^[A-Za-z0-9._:-]+$").MatchString(session) {
		values = append(values, "model_providers."+providerKey+".http_headers.X-Session-Id="+session)
	}
	if alias := strings.TrimSpace(env["AIH_MODEL_ALIAS"]); regexp.MustCompile("^[A-Za-z0-9._:/*=-]+$").MatchString(alias) {
		values = append(values, "model_providers."+providerKey+".http_headers.X-Aih-Model-Alias="+alias)
	}
	if protocol := strings.TrimSpace(ReadCodexFlag(env, "upstreamProtocol", "")); regexp.MustCompile("^[a-z][a-z0-9_]{0,63}$").MatchString(protocol) {
		values = append(values, "model_providers."+providerKey+".http_headers.X-Aih-Upstream-Protocol="+protocol)
	}
	if owner := ReadCodexFlag(env, "routeOwner", ""); owner == "go" || owner == "node" {
		values = append(values, "model_providers."+providerKey+".http_headers.X-Aih-Route-Owner=go")
	}

	args := make([]string, 0, len(values)*2)
	for _, value := range values {
		args = append(args, "-c", value)
	}
	return args
}

// HasCodexModelProviderArg 判断参数里是否已显式指定 model_provider。
func HasCodexModelProviderArg(args []string) bool {
	for index, arg := range args {
		value := strings.TrimSpace(arg)
		if regexp.MustCompile("^--config=model_provider\\s*=").MatchString(value) {
			return true
		}
		if (value == "-c" || value == "--config") && index+1 < len(args) {
			if regexp.MustCompile("^model_provider\\s*=").MatchString(strings.TrimSpace(args[index+1])) {
				return true
			}
		}
	}
	return false
}

// InjectProviderArgs 把 provider 参数注入到全局参数之前；exec/resume/app-server 插在子命令后。
func InjectProviderArgs(args []string, providerArgs []string) []string {
	result := append([]string{}, args...)
	overrides := make([]string, 0, len(providerArgs))
	for _, arg := range providerArgs {
		if arg != "" {
			overrides = append(overrides, arg)
		}
	}
	if len(overrides) == 0 {
		return result
	}
	if _, scoped := configScopedSubcommands[strings.TrimSpace(firstArg(result))]; !scoped {
		return append(append([]string{}, overrides...), result...)
	}
	next := make([]string, 0, len(result)+len(overrides))
	next = append(next, result[0])
	next = append(next, overrides...)
	next = append(next, result[1:]...)
	return next
}

func firstArg(args []string) string {
	if len(args) == 0 {
		return ""
	}
	return args[0]
}

// ReadCodexFlag 从 AIH_CODEX_FLAGS 读取一个键；与 Node readCodexFlag 一致。
func ReadCodexFlag(env map[string]string, key, fallback string) string {
	fields := ParseCodexFlags(env[CodexFlagsEnv])
	if value, ok := fields[key]; ok {
		return value
	}
	return fallback
}

// ParseCodexFlags 解析逗号分隔的 key=urlencoded-value 串。
func ParseCodexFlags(raw string) map[string]string {
	fields := map[string]string{}
	for _, part := range strings.Split(raw, ",") {
		index := strings.Index(part, "=")
		if index <= 0 {
			continue
		}
		key := strings.TrimSpace(part[:index])
		value := strings.TrimSpace(part[index+1:])
		if key == "" || value == "" {
			continue
		}
		if decoded, err := url.PathUnescape(value); err == nil {
			fields[key] = decoded
		} else {
			fields[key] = value
		}
	}
	return fields
}

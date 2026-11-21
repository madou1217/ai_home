package codexappconfig

import (
	"strings"

	"github.com/madou1217/ai_home/application/serverconfig"
)

const (
	AIHProviderKey      = "aih_server"
	AIHProviderName     = "AIH Server"
	AIHProviderWireAPI  = "responses"
	AIHProviderEnvKey   = "OPENAI_API_KEY"
	StartupWarningKey   = "suppress_unstable_features_warning"
	StartupUpdateKey    = "check_for_update_on_startup"
	NativeAPIBaseMarker = "# AI Home managed API endpoint for native openai sessions"
)

// DefaultProviderBaseURL 与 Node buildServerBaseUrl() 一致。
var DefaultProviderBaseURL = serverconfig.BaseURL(serverconfig.DefaultHost, serverconfig.DefaultPort, "/v1")

// Header 保持 http_headers 的插入顺序（Node 用 Object.entries 的顺序）。
type Header struct {
	Key   string
	Value string
}

// AuthCommand 对应 model_providers.<key>.auth 表。
type AuthCommand struct {
	Command    string
	Args       []string
	ScriptPath string
}

// SyncOptions 是 Node normalizeCodexConfigSyncOptions 的强类型版本。
type SyncOptions struct {
	IsAPIKeyMode bool
	// HasIsAPIKeyMode 对应 JS hasOwnProperty(options, "isApiKeyMode")。
	HasIsAPIKeyMode     bool
	OpenAIAPIKey        string
	OpenAIBaseURL       string
	SQLiteHome          string
	CodexVersion        string
	ForceAIHProvider    bool
	HTTPHeaders         []Header
	ProviderKeyOverride string
	SupportsWebsockets  bool
	AuthCommand         *AuthCommand
}

// AccountOnlyConfig 对应 Node mergeConfigs 的 accountOnlyConfig。
type AccountOnlyConfig struct {
	PreferredAuthMethod string
	ModelProvider       string
	Providers           []string
	ModelProviders      []string
}

type normalizedOptions struct {
	SyncOptions
	providerKey string
}

// MergeConfigs 把宿主 config.toml 与账号级配置合并成沙箱 config.toml。
func MergeConfigs(hostConfig string, account AccountOnlyConfig, options SyncOptions) string {
	normalized := normalizeOptions(options)
	providerKey := normalized.providerKey
	merged := applyStartupPolicy(removeManagedCruft(trimEndSpace(hostConfig)))

	if line := buildPreferredAuthMethodLine(account, options); line != "" {
		merged = upsertRootKeyLine(merged, "preferred_auth_method", line)
	}
	if line := buildModelProviderLine(account, options); line != "" {
		merged = upsertRootKeyLine(merged, "model_provider", line)
	}
	if normalized.SQLiteHome != "" {
		sqliteHome := normalizeWindowsPathForConfig(normalized.SQLiteHome)
		merged = upsertRootKeyLine(merged, "sqlite_home", "sqlite_home = \""+escapeTomlBasicString(sqliteHome)+"\"")
	}

	if normalized.ForceAIHProvider || normalized.IsAPIKeyMode {
		// mergeConfigs 不读取 authCommand（Node 调用点也未传），保持 env_key/bearer 形态。
		blockOptions := normalized
		blockOptions.AuthCommand = nil
		block := managedProviderBlock(blockOptions)
		merged = syncBuiltinAPIBaseURL(merged, firstNonEmpty(normalized.OpenAIBaseURL, DefaultProviderBaseURL))
		merged = applyManagedProviderSection(merged, "[model_providers."+providerKey+"]", block)
	} else if normalized.HasIsAPIKeyMode && !normalized.IsAPIKeyMode {
		merged = removeManagedProviderSection(merged, providerKey)
		merged = syncBuiltinAPIBaseURL(merged, "")
	}

	return hoistModelProviderSections(NormalizeHooksFeatureFlag(trimEndSpace(merged)+"\n", normalized.CodexVersion))
}

func normalizeOptions(options SyncOptions) normalizedOptions {
	normalized := normalizedOptions{SyncOptions: options}
	normalized.OpenAIAPIKey = strings.TrimSpace(options.OpenAIAPIKey)
	normalized.OpenAIBaseURL = strings.TrimSpace(options.OpenAIBaseURL)
	normalized.SQLiteHome = strings.TrimSpace(options.SQLiteHome)
	normalized.CodexVersion = strings.TrimSpace(options.CodexVersion)
	headers := make([]Header, 0, len(options.HTTPHeaders))
	for _, header := range options.HTTPHeaders {
		key := strings.TrimSpace(header.Key)
		value := strings.TrimSpace(header.Value)
		if key != "" && value != "" {
			headers = append(headers, Header{Key: key, Value: value})
		}
	}
	normalized.HTTPHeaders = headers
	override := strings.TrimSpace(options.ProviderKeyOverride)
	if override != AIHProviderKey {
		override = ""
	}
	normalized.ProviderKeyOverride = override
	if normalized.ProviderKeyOverride != "" {
		normalized.providerKey = normalized.ProviderKeyOverride
	} else {
		normalized.providerKey = AIHProviderKey
	}
	return normalized
}

func escapeTomlBasicString(value string) string {
	return strings.ReplaceAll(strings.ReplaceAll(value, "\\", "\\\\"), "\"", "\\\"")
}

func tomlLiteral(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

func managedProviderBlock(options normalizedOptions) string {
	authLine := ""
	if options.AuthCommand != nil && options.AuthCommand.Command != "" {
		if options.OpenAIAPIKey == "" {
			authLine = "bearer_token = \"dummy\""
		}
	} else if options.OpenAIAPIKey != "" {
		authLine = "env_key = \"" + AIHProviderEnvKey + "\""
	} else {
		authLine = "bearer_token = \"dummy\""
	}
	httpHeadersLine := ""
	if len(options.HTTPHeaders) > 0 {
		pairs := make([]string, 0, len(options.HTTPHeaders))
		for _, header := range options.HTTPHeaders {
			pairs = append(pairs, "\""+escapeTomlBasicString(header.Key)+"\" = \""+escapeTomlBasicString(header.Value)+"\"")
		}
		httpHeadersLine = "http_headers = { " + strings.Join(pairs, ", ") + " }"
	}
	lines := []string{
		"[model_providers." + options.providerKey + "]",
		"name = \"" + AIHProviderName + "\"",
		"base_url = \"" + escapeTomlBasicString(firstNonEmpty(options.OpenAIBaseURL, DefaultProviderBaseURL)) + "\"",
		authLine,
		httpHeadersLine,
	}
	if options.SupportsWebsockets {
		lines = append(lines, "supports_websockets = true")
	}
	lines = append(lines, "wire_api = \""+AIHProviderWireAPI+"\"")
	main := filterEmpty(lines)
	if options.AuthCommand == nil || options.AuthCommand.Command == "" || options.OpenAIAPIKey == "" {
		return main
	}
	args := options.AuthCommand.Args
	if len(args) == 0 && options.AuthCommand.ScriptPath != "" {
		args = []string{options.AuthCommand.ScriptPath}
	}
	quotedArgs := make([]string, 0, len(args))
	for _, arg := range args {
		if arg != "" {
			quotedArgs = append(quotedArgs, tomlLiteral(arg))
		}
	}
	return strings.Join([]string{
		main,
		"",
		"[model_providers." + options.providerKey + ".auth]",
		"command = " + tomlLiteral(options.AuthCommand.Command),
		"args = [" + strings.Join(quotedArgs, ", ") + "]",
		"refresh_interval_ms = 300000",
		"timeout_ms = 10000",
	}, "\n")
}

func buildPreferredAuthMethodLine(account AccountOnlyConfig, options SyncOptions) string {
	normalized := normalizeOptions(options)
	if normalized.ForceAIHProvider || normalized.IsAPIKeyMode {
		return "preferred_auth_method = \"apikey\""
	}
	if normalized.HasIsAPIKeyMode && !normalized.IsAPIKeyMode {
		return "preferred_auth_method = \"oauth\""
	}
	return strings.TrimSpace(account.PreferredAuthMethod)
}

func buildModelProviderLine(account AccountOnlyConfig, options SyncOptions) string {
	normalized := normalizeOptions(options)
	if normalized.ForceAIHProvider || normalized.IsAPIKeyMode {
		return "model_provider = \"" + normalized.providerKey + "\""
	}
	if normalized.HasIsAPIKeyMode && !normalized.IsAPIKeyMode {
		return "model_provider = \"openai\""
	}
	return strings.TrimSpace(account.ModelProvider)
}

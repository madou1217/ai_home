package codexappconfig

import (
	"regexp"
	"strings"
)

// RuntimeConfigOptions 对应 Node buildCodexAppServerRuntimeConfig 的入参。
// Native 由调用方按 parseCodexTransportConfig/isNativeCodexConfig 判定后传入，
// 避免在配置包里再复制一份 transport 判定。
type RuntimeConfigOptions struct {
	ExecutionAccountRef string
	GatewayBaseURL      string
	GatewayAPIKey       string
	ChatGPTBaseURL      string
	SQLiteHome          string
	HostCodexHome       string
	SupportsWebsockets  bool
	Native              bool
}

// BuildCodexAppServerRuntimeConfig 生成隔离 runtime home 的 config.toml。
func BuildCodexAppServerRuntimeConfig(hostConfig string, options RuntimeConfigOptions) string {
	content := hostConfig
	if options.GatewayBaseURL != "" && !options.Native {
		headers := []Header{}
		if options.ExecutionAccountRef != "" {
			headers = append(headers, Header{Key: "X-Account-Ref", Value: options.ExecutionAccountRef})
		}
		content = MergeConfigs(content, AccountOnlyConfig{}, SyncOptions{
			IsAPIKeyMode: true, HasIsAPIKeyMode: true, ForceAIHProvider: true,
			OpenAIBaseURL: options.GatewayBaseURL, OpenAIAPIKey: options.GatewayAPIKey,
			SupportsWebsockets: true, SQLiteHome: options.HostCodexHome,
			HTTPHeaders: headers,
		})
		content = RetainOnlyManagedAIHProvider(content)
	} else {
		content = UpsertTomlStringValue(content, "sqlite_home", normalizeWindowsPathForConfig(options.HostCodexHome))
	}
	content = UpsertTomlStringValue(content, "cli_auth_credentials_store", "file")
	if options.ChatGPTBaseURL != "" && !options.Native {
		content = UpsertTomlStringValue(content, "chatgpt_base_url", options.ChatGPTBaseURL)
	}
	return content
}

// RetainOnlyManagedAIHProvider 只保留 [model_providers.aih_server]，删其它 provider 段。
func RetainOnlyManagedAIHProvider(content string) string {
	lines := strings.Split(content, "\n")
	output := make([]string, 0, len(lines))
	skipping := false
	headerPattern := regexp.MustCompile("^\\s*\\[model_providers\\.([^.\\]]+)")
	for _, line := range lines {
		if regexp.MustCompile("^\\s*\\[").MatchString(line) {
			match := headerPattern.FindStringSubmatch(line)
			skipping = match != nil && match[1] != AIHProviderKey
		}
		if !skipping {
			output = append(output, line)
		}
	}
	return strings.Join(output, "\n")
}

// UpsertTomlStringValue 在根区插入或替换 key = "value"。
func UpsertTomlStringValue(text, key, value string) string {
	normalizedKey := strings.TrimSpace(key)
	if !regexp.MustCompile("^[A-Za-z0-9_-]+$").MatchString(normalizedKey) {
		return text
	}
	line := normalizedKey + " = \"" + escapeTomlRuntimeString(value) + "\""
	tableIndex := -1
	for index, candidate := range strings.Split(text, "\n") {
		if strings.HasPrefix(strings.TrimSpace(candidate), "[") {
			tableIndex = index
			break
		}
	}
	lines := strings.Split(text, "\n")
	rootEnd := len(lines)
	if tableIndex >= 0 {
		rootEnd = tableIndex
		// Node 的根区正则会把段前空行留在 restSource；这里保持同样的空行归属。
		if rootEnd > 0 && strings.TrimSpace(lines[rootEnd-1]) == "" {
			rootEnd--
		}
	}
	rootSource := strings.Join(lines[:rootEnd], "\n")
	restSource := ""
	if rootEnd < len(lines) {
		restSource = strings.Join(lines[rootEnd:], "\n")
	}
	pattern := regexp.MustCompile("^" + regexp.QuoteMeta(normalizedKey) + "\\s*=\\s*\"[^\"\\n]*\"\\s*$")
	rootLines := strings.Split(rootSource, "\n")
	replaced := false
	for index, candidate := range rootLines {
		if pattern.MatchString(candidate) {
			rootLines[index] = line
			replaced = true
			break
		}
	}
	if !replaced {
		suffix := ""
		if rootSource != "" && !strings.HasSuffix(rootSource, "\n") {
			suffix = "\n"
		}
		rootSource = rootSource + suffix + line + "\n"
	} else {
		rootSource = strings.Join(rootLines, "\n")
	}
	return rootSource + restSource
}

func escapeTomlRuntimeString(value string) string {
	value = strings.ReplaceAll(value, "\\", "\\\\")
	value = strings.ReplaceAll(value, "\"", "\\\"")
	value = strings.ReplaceAll(value, "\r", "\\r")
	value = strings.ReplaceAll(value, "\n", "\\n")
	value = strings.ReplaceAll(value, "\t", "\\t")
	return value
}

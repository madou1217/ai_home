package webuiopenappapi

import "strings"

// Codex Desktop 的账号投影形态。前两种来自账号凭据，第三种是 OAuth 账号的显式选择：
//
//   - api-key：账号自带 API Key 与上游端点，投影出一个「账号专属」自定义 Provider；
//   - native：OAuth 账号用 ChatGPT 授权直连，模型请求走 Codex 内置 openai Provider；
//   - relay：OAuth 账号经本机 AIH Server 中转，模型请求走 aih_server Provider。
//
// 关键约束：openai 是 Codex 的内置保留 Provider，不能出现在 model_providers 里
// （Codex ≥0.171 会拒绝启动）。API-Key 账号因此永远不覆盖内置 openai，而是按账号
// 生成独立的 Provider ID，让配置里的身份与账号一一对应。
type codexDesktopConfigMode string

const (
	codexDesktopModeAPIKey codexDesktopConfigMode = "api-key"
	codexDesktopModeNative codexDesktopConfigMode = "native"
	codexDesktopModeRelay  codexDesktopConfigMode = "relay"
)

const (
	// codexRelayProviderKey 与 Codex app-server 中转链路共用同一个 Provider 名。
	codexRelayProviderKey  = "aih_server"
	codexRelayProviderName = "AIH Server"
	codexRelayEnvKey       = "OPENAI_API_KEY"
)

// codexDesktopAccountProviderKey 生成按账号稳定、且不会撞上 Codex 保留 ID 的 Provider ID。
func codexDesktopAccountProviderKey(accountRef string) string {
	var builder strings.Builder
	builder.WriteString("aih_")
	for _, r := range strings.TrimSpace(accountRef) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '_', r == '-':
			builder.WriteRune(r)
		case r >= 'A' && r <= 'Z':
			builder.WriteRune(r + ('a' - 'A'))
		default:
			builder.WriteByte('_')
		}
	}
	if builder.Len() == len("aih_") {
		builder.WriteString("account")
	}
	return builder.String()
}

// codexDesktopConfigInput 是三种形态共用的投影输入。
type codexDesktopConfigInput struct {
	HostConfig string
	Mode       codexDesktopConfigMode
	AccountRef string
	// Label 是账号展示名，仅用于 Provider 的 name 字段。
	Label string
	// AccountBaseURL 是 api-key 账号的上游端点。
	AccountBaseURL string
	// RelayBaseURL 是 relay 形态下本机 AIH Server 的 /v1 地址。
	RelayBaseURL string
	SQLiteHome   string
}

// buildCodexDesktopConfig 由宿主 config.toml 生成账号投影配置。
//
// 宿主里属于「直连/中转端点」的键一律由本函数重新决定：宿主的 model_provider、
// openai_base_url、preferred_auth_method 与受管 Provider 表都可能在别的账号下
// 写成不同形态，原样带入会让账号 A 的投影沿用账号 B 的走向。
func buildCodexDesktopConfig(input codexDesktopConfigInput) string {
	mode := input.Mode
	accountKey := codexDesktopAccountProviderKey(input.AccountRef)
	stripProviders := []string{codexRelayProviderKey, "openai"}
	if mode == codexDesktopModeAPIKey {
		stripProviders = append(stripProviders, accountKey)
	}
	filtered := filterCodexHostConfig(input.HostConfig, stripProviders)

	root := make([]string, 0, 4)
	switch mode {
	case codexDesktopModeAPIKey:
		root = append(root,
			`preferred_auth_method = "apikey"`,
			`model_provider = "`+accountKey+`"`,
		)
	case codexDesktopModeNative:
		// OAuth 直连：不写 model_provider，Codex 默认使用内置 openai + auth.json 的
		// ChatGPT 授权；preferred_auth_method 供旧版 Codex 选择 OAuth 登录态。
		root = append(root, `preferred_auth_method = "oauth"`)
	case codexDesktopModeRelay:
		// relay 的凭据来自进程环境（env_key），auth.json 仍保留 OAuth 登录态，
		// 让桌面端 UI 继续显示已登录。
		root = append(root, `model_provider = "`+codexRelayProviderKey+`"`)
	}
	if strings.TrimSpace(input.SQLiteHome) != "" {
		root = append(root, `sqlite_home = "`+escapeTomlBasicString(strings.TrimSpace(input.SQLiteHome))+`"`)
	}

	var builder strings.Builder
	for _, line := range root {
		builder.WriteString(line)
		builder.WriteByte('\n')
	}
	body := strings.TrimSpace(strings.Join(filtered, "\n"))
	if body != "" {
		builder.WriteString(body)
		builder.WriteByte('\n')
	}

	switch mode {
	case codexDesktopModeAPIKey:
		builder.WriteString("\n[model_providers." + accountKey + "]\n")
		builder.WriteString(`name = "` + escapeTomlBasicString(codexDesktopProviderLabel(input)) + `"` + "\n")
		builder.WriteString(`base_url = "` + escapeTomlBasicString(strings.TrimSpace(input.AccountBaseURL)) + `"` + "\n")
		builder.WriteString(`wire_api = "responses"` + "\n")
		// 让 Codex 用 auth.json 里的 API Key 作为 Bearer，与内置 openai 的认证路径一致。
		builder.WriteString(`requires_openai_auth = true` + "\n")
	case codexDesktopModeRelay:
		builder.WriteString("\n[model_providers." + codexRelayProviderKey + "]\n")
		builder.WriteString(`name = "` + codexRelayProviderName + `"` + "\n")
		builder.WriteString(`base_url = "` + escapeTomlBasicString(strings.TrimSpace(input.RelayBaseURL)) + `"` + "\n")
		builder.WriteString(`env_key = "` + codexRelayEnvKey + `"` + "\n")
		// 固定账号，避免中转把请求分到账号池里的其它账号。
		builder.WriteString(`http_headers = { "X-Account-Ref" = "` + escapeTomlBasicString(strings.TrimSpace(input.AccountRef)) + `" }` + "\n")
		builder.WriteString(`wire_api = "responses"` + "\n")
	}
	return builder.String()
}

// codexRelayBaseURL 把本机 Server 的根地址拼成 Codex 需要的 /v1 端点。
func codexRelayBaseURL(serverBaseURL string) string {
	base := strings.TrimSpace(serverBaseURL)
	if base == "" {
		return ""
	}
	return strings.TrimRight(base, "/") + "/v1"
}

func codexDesktopProviderLabel(input codexDesktopConfigInput) string {
	label := strings.TrimSpace(input.Label)
	if label == "" {
		label = strings.TrimSpace(input.AccountRef)
	}
	if label == "" {
		label = "account"
	}
	return "AIH " + label
}

// filterCodexHostConfig 去掉宿主里由投影接管的 Provider 表与根键，其余原样保留。
func filterCodexHostConfig(hostConfig string, stripProviders []string) []string {
	lines := strings.Split(strings.ReplaceAll(hostConfig, "\r\n", "\n"), "\n")
	sectionPrefixes := make([]string, 0, len(stripProviders))
	for _, key := range stripProviders {
		if key = strings.ToLower(strings.TrimSpace(key)); key != "" {
			sectionPrefixes = append(sectionPrefixes, "[model_providers."+key)
		}
	}
	filtered := make([]string, 0, len(lines))
	skipSection := false
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "[") {
			lowerSection := strings.ToLower(trimmed)
			skipSection = false
			for _, prefix := range sectionPrefixes {
				if strings.HasPrefix(lowerSection, prefix) {
					skipSection = true
					break
				}
			}
			if skipSection {
				continue
			}
		}
		if skipSection {
			continue
		}
		lower := strings.ToLower(trimmed)
		if strings.HasPrefix(lower, "preferred_auth_method") && strings.Contains(lower, "=") ||
			strings.HasPrefix(lower, "model_provider") && strings.Contains(lower, "=") ||
			strings.HasPrefix(lower, "openai_base_url") && strings.Contains(lower, "=") ||
			strings.HasPrefix(lower, "sqlite_home") && strings.Contains(lower, "=") {
			continue
		}
		filtered = append(filtered, line)
	}
	return filtered
}

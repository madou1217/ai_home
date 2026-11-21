package codexappconfig

import (
	"regexp"
	"strings"
)

// FilterOptions 对应 Node filterHostConfig 的 exclude 选项。
type FilterOptions struct {
	ExcludeAccountOnly bool
	ExcludeSensitive   bool
}

var projectHeaderPattern = regexp.MustCompile("^\\[projects\\.[^\\]]+\\]$")

func isProjectHeader(line string) bool {
	return projectHeaderPattern.MatchString(strings.TrimSpace(line))
}

func isManagedScaffoldComment(line string) bool {
	trimmed := strings.TrimSpace(line)
	switch trimmed {
	case "# This file is managed by ai-home (aih)",
		"# Synced from host config (excluding sensitive fields)",
		"# AI Home managed permissions: Full Access",
		"# API endpoint configuration (migrated from OPENAI_BASE_URL env var)":
		return true
	}
	return strings.HasPrefix(trimmed, "# Codex configuration for account")
}

// ExtractAccountOnlyConfig 提取账号级 root 键、[[providers]] 与 [model_providers.*] 段。
func ExtractAccountOnlyConfig(config string) AccountOnlyConfig {
	result := AccountOnlyConfig{Providers: []string{}, ModelProviders: []string{}}
	lines := strings.Split(config, "\n")
	activeType := ""
	activeLines := []string{}
	flush := func() {
		if activeType == "" || len(activeLines) == 0 {
			activeType = ""
			activeLines = nil
			return
		}
		section := strings.Join(activeLines, "\n")
		if activeType == "providers" {
			result.Providers = append(result.Providers, section)
		} else if activeType == "model_providers" {
			result.ModelProviders = append(result.ModelProviders, section)
		}
		activeType = ""
		activeLines = nil
	}
	for _, rawLine := range lines {
		trimmed := strings.TrimSpace(rawLine)
		if activeType != "" {
			startsProviders := trimmed == "[[providers]]"
			startsModelProvider := isModelProviderHeader(trimmed)
			startsOther := strings.HasPrefix(trimmed, "[") && !startsProviders && !startsModelProvider
			if startsProviders || startsModelProvider || startsOther {
				flush()
			}
		}
		if activeType == "" && strings.HasPrefix(trimmed, "preferred_auth_method") {
			result.PreferredAuthMethod = trimmed
			continue
		}
		if activeType == "" && strings.HasPrefix(trimmed, "model_provider") {
			result.ModelProvider = trimmed
			continue
		}
		if trimmed == "[[providers]]" {
			activeType = "providers"
			activeLines = []string{rawLine}
			continue
		}
		if isModelProviderHeader(trimmed) {
			activeType = "model_providers"
			activeLines = []string{rawLine}
			continue
		}
		if activeType != "" {
			activeLines = append(activeLines, rawLine)
		}
	}
	flush()
	return result
}

// FilterHostConfig 过滤账号级键、敏感凭据、sandbox_mode 与 aih 脚手架注释。
func FilterHostConfig(config string, options FilterOptions) string {
	lines := strings.Split(config, "\n")
	filtered := make([]string, 0, len(lines))
	skipUntilNextSection := false
	inModelProviders := false
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if skipUntilNextSection {
			if strings.HasPrefix(trimmed, "[") {
				skipUntilNextSection = false
			} else {
				continue
			}
		}
		if options.ExcludeAccountOnly {
			if strings.HasPrefix(trimmed, "preferred_auth_method") || strings.HasPrefix(trimmed, "model_provider") {
				continue
			}
			if trimmed == "[[providers]]" {
				skipUntilNextSection = true
				continue
			}
		}
		if options.ExcludeSensitive {
			if isModelProviderHeader(trimmed) {
				inModelProviders = true
				filtered = append(filtered, line)
				continue
			}
			if inModelProviders && strings.HasPrefix(trimmed, "[") && !isModelProviderHeader(trimmed) {
				inModelProviders = false
			}
			if inModelProviders {
				if strings.HasPrefix(trimmed, "bearer_token") || strings.HasPrefix(trimmed, "api_key") ||
					strings.Contains(trimmed, "_token =") || strings.Contains(trimmed, "_key =") {
					continue
				}
			}
		}
		if strings.HasPrefix(trimmed, "sandbox_mode") {
			continue
		}
		if isManagedScaffoldComment(trimmed) {
			continue
		}
		filtered = append(filtered, line)
	}
	return strings.Join(filtered, "\n")
}

// ScopeAccountOnlyConfig 选择账号级配置中与当前 provider 相关的片段。
func ScopeAccountOnlyConfig(account AccountOnlyConfig, options SyncOptions) AccountOnlyConfig {
	normalized := normalizeOptions(options)
	providerKey := normalized.providerKey
	accountModelProvider := extractModelProviderName(account.ModelProvider)
	shouldUseAIH := normalized.ForceAIHProvider || normalized.OpenAIBaseURL != "" || accountModelProvider == AIHProviderKey
	scoped := AccountOnlyConfig{
		PreferredAuthMethod: account.PreferredAuthMethod,
		ModelProvider:       account.ModelProvider,
		Providers:           append([]string{}, account.Providers...),
		ModelProviders:      []string{},
	}
	if shouldUseAIH {
		scoped.PreferredAuthMethod = "preferred_auth_method = \"apikey\""
		scoped.ModelProvider = "model_provider = \"" + providerKey + "\""
	}
	activeModelProvider := extractModelProviderName(scoped.ModelProvider)
	selected := map[string]string{}
	order := make([]string, 0)
	for _, block := range account.ModelProviders {
		key := extractModelProviderKeyFromHeader(sectionHeader(block))
		if key == "" {
			continue
		}
		selectBlock := key == providerKey || (key == activeModelProvider && key != AIHProviderKey)
		if !selectBlock {
			continue
		}
		if _, exists := selected[key]; !exists {
			order = append(order, key)
		}
		selected[key] = block
	}
	for _, key := range order {
		scoped.ModelProviders = append(scoped.ModelProviders, selected[key])
	}
	return scoped
}

// MergeSharedProjectSections 把共享配置里缺失的 [projects.*] 段追加到 base。
func MergeSharedProjectSections(baseConfig, sharedConfig string) string {
	baseHeaders := map[string]struct{}{}
	for _, section := range extractSections(baseConfig, isProjectHeader) {
		baseHeaders[sectionHeader(section)] = struct{}{}
	}
	missing := make([]string, 0)
	for _, section := range extractSections(sharedConfig, isProjectHeader) {
		if _, exists := baseHeaders[sectionHeader(section)]; !exists {
			missing = append(missing, section)
		}
	}
	if len(missing) == 0 {
		return baseConfig
	}
	blocks := []string{trimEndSpace(baseConfig)}
	blocks = append(blocks, missing...)
	filtered := make([]string, 0, len(blocks))
	for _, block := range blocks {
		if strings.TrimSpace(block) != "" {
			filtered = append(filtered, block)
		}
	}
	return strings.Join(filtered, "\n\n") + "\n"
}

func extractModelProviderName(line string) string {
	match := regexp.MustCompile("^model_provider\\s*=\\s*\"([^\"]+)\"\\s*$").FindStringSubmatch(strings.TrimSpace(line))
	if match == nil {
		return ""
	}
	return strings.TrimSpace(match[1])
}

func extractModelProviderKeyFromHeader(header string) string {
	match := regexp.MustCompile("^\\[model_providers\\.([^\\]]+)\\]\\s*$").FindStringSubmatch(strings.TrimSpace(header))
	if match == nil {
		return ""
	}
	return strings.TrimSpace(match[1])
}

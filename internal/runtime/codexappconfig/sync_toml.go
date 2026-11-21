package codexappconfig

import (
	"regexp"
	"strings"
)

func isModelProviderHeader(line string) bool {
	return regexp.MustCompile("^\\[model_providers\\.[^\\]]+\\]$").MatchString(strings.TrimSpace(line))
}

func applyManagedProviderSection(config, header, block string) string {
	authHeader := strings.TrimSuffix(header, "]") + ".auth]"
	return replaceTomlSection(stripNamedSections(config, []string{authHeader}), header, block)
}

func replaceTomlSection(content, header, block string) string {
	lines := strings.Split(content, "\n")
	start := -1
	for index, line := range lines {
		if strings.TrimSpace(line) == header {
			start = index
			break
		}
	}
	if start < 0 {
		base := trimEndSpace(content)
		if strings.TrimSpace(content) != "" {
			return base + "\n\n" + block + "\n"
		}
		return block + "\n"
	}
	end := len(lines)
	for index := start + 1; index < len(lines); index++ {
		if strings.HasPrefix(strings.TrimSpace(lines[index]), "[") {
			end = index
			break
		}
	}
	blockLines := strings.Split(block, "\n")
	next := make([]string, 0, len(lines)-end+start+len(blockLines))
	next = append(next, lines[:start]...)
	next = append(next, blockLines...)
	next = append(next, lines[end:]...)
	return strings.Join(next, "\n")
}

func upsertRootKeyLine(config, key, line string) string {
	lines := strings.Split(config, "\n")
	pattern := regexp.MustCompile("^" + regexp.QuoteMeta(key) + "\\s*=")
	firstSection := len(lines)
	for index, candidate := range lines {
		if strings.HasPrefix(strings.TrimSpace(candidate), "[") {
			firstSection = index
			break
		}
	}
	next := make([]string, 0, len(lines)+1)
	replaced := false
	for index, candidate := range lines {
		if index < firstSection && pattern.MatchString(strings.TrimSpace(candidate)) {
			if !replaced {
				next = append(next, strings.Split(line, "\n")...)
				replaced = true
			}
			continue
		}
		next = append(next, candidate)
	}
	if !replaced {
		tail := append([]string{}, next[firstSection:]...)
		next = append(next[:firstSection], strings.Split(line, "\n")...)
		next = append(next, tail...)
	}
	return strings.Join(next, "\n")
}

func syncBuiltinAPIBaseURL(config, baseURL string) string {
	lines := strings.Split(config, "\n")
	endpoint := strings.TrimSpace(baseURL)
	cleaned := make([]string, 0, len(lines))
	root := true
	for index := 0; index < len(lines); index++ {
		line := lines[index]
		if strings.HasPrefix(strings.TrimSpace(line), "[") {
			root = false
		}
		if root && strings.TrimSpace(line) == NativeAPIBaseMarker {
			if endpoint == "" && index+1 < len(lines) && regexp.MustCompile("^\\s*openai_base_url\\s*=").MatchString(lines[index+1]) {
				index++
			}
			continue
		}
		cleaned = append(cleaned, line)
	}
	content := strings.Join(cleaned, "\n")
	if endpoint == "" {
		return content
	}
	return upsertRootKeyLine(content, "openai_base_url", NativeAPIBaseMarker+"\n"+"openai_base_url = \""+escapeTomlBasicString(endpoint)+"\"")
}

func enableStartupWarningSuppression(config string) string {
	lines := strings.Split(config, "\n")
	pattern := regexp.MustCompile("^" + regexp.QuoteMeta(StartupWarningKey) + "\\s*=")
	inFeatures := false
	without := make([]string, 0, len(lines))
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "[") {
			inFeatures = trimmed == "[features]"
			without = append(without, line)
			continue
		}
		if inFeatures && pattern.MatchString(trimmed) {
			continue
		}
		without = append(without, line)
	}
	return upsertRootKeyLine(strings.Join(without, "\n"), StartupWarningKey, StartupWarningKey+" = true")
}

func disableStartupUpdateCheck(config string) string {
	return upsertRootKeyLine(config, StartupUpdateKey, StartupUpdateKey+" = false")
}

func applyStartupPolicy(config string) string {
	return disableStartupUpdateCheck(enableStartupWarningSuppression(config))
}

func stripNamedSections(config string, headers []string) string {
	if len(headers) == 0 {
		return config
	}
	set := make(map[string]struct{}, len(headers))
	for _, header := range headers {
		set[header] = struct{}{}
	}
	lines := strings.Split(config, "\n")
	next := make([]string, 0, len(lines))
	skipping := false
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "[") {
			_, skipping = set[trimmed]
			if skipping {
				continue
			}
		}
		if !skipping {
			next = append(next, line)
		}
	}
	return strings.Join(next, "\n")
}

func removeManagedProviderSection(config, providerKey string) string {
	return stripNamedSections(config, []string{
		"[model_providers." + providerKey + "]",
		"[model_providers." + providerKey + ".auth]",
	})
}

var legacyProviderKey = regexp.MustCompile("^aih(?:[-_]\\d+)?$")
var legacyHeaderPattern = regexp.MustCompile("^\\[model_providers\\.([^\\]\\s.]+)\\]$")

func removeLegacyProviderSections(config string) string {
	headers := make([]string, 0)
	for _, section := range extractSections(config, func(header string) bool {
		match := legacyHeaderPattern.FindStringSubmatch(header)
		return match != nil && legacyProviderKey.MatchString(match[1])
	}) {
		headers = append(headers, sectionHeader(section))
	}
	if len(headers) == 0 {
		return config
	}
	return stripNamedSections(config, headers)
}

const migratedBaseURLMarker = "# API endpoint configuration (migrated from OPENAI_BASE_URL env var)"

func removeMigratedBaseURLScaffold(config string) string {
	lines := strings.Split(config, "\n")
	output := make([]string, 0, len(lines))
	skipNext := false
	changed := false
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == migratedBaseURLMarker {
			skipNext = true
			changed = true
			continue
		}
		if skipNext && regexp.MustCompile("^openai_base_url\\s*=").MatchString(trimmed) {
			skipNext = false
			changed = true
			continue
		}
		skipNext = false
		output = append(output, line)
	}
	if !changed {
		return config
	}
	return strings.Join(output, "\n")
}

func removeManagedCruft(config string) string {
	return removeMigratedBaseURLScaffold(removeLegacyProviderSections(config))
}

func extractSections(config string, predicate func(header string) bool) []string {
	sections := make([]string, 0)
	lines := strings.Split(config, "\n")
	active := []string(nil)
	flush := func() {
		if active == nil {
			return
		}
		section := trimEndSpace(strings.Join(active, "\n"))
		if strings.TrimSpace(section) != "" {
			sections = append(sections, section)
		}
		active = nil
	}
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "[") {
			flush()
			if predicate(trimmed) {
				active = []string{line}
			}
			continue
		}
		if active != nil {
			active = append(active, line)
		}
	}
	flush()
	return sections
}

func sectionHeader(section string) string {
	for _, line := range strings.Split(section, "\n") {
		if strings.TrimSpace(line) != "" {
			return strings.TrimSpace(line)
		}
	}
	return ""
}

func hoistModelProviderSections(config string) string {
	lines := strings.Split(config, "\n")
	root := make([]string, 0)
	providers := make([]string, 0)
	others := make([]string, 0)
	var active []string
	var activeHeader string
	flush := func() {
		if active == nil {
			return
		}
		block := trimEndSpace(strings.Join(active, "\n"))
		if isModelProviderHeader(activeHeader) {
			providers = append(providers, block)
		} else {
			others = append(others, block)
		}
		active = nil
		activeHeader = ""
	}
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "[") {
			flush()
			active = []string{line}
			activeHeader = trimmed
			continue
		}
		if active != nil {
			active = append(active, line)
		} else {
			root = append(root, line)
		}
	}
	flush()
	blocks := make([]string, 0, 2+len(providers)+len(others))
	blocks = append(blocks, trimEndSpace(strings.Join(root, "\n")))
	blocks = append(blocks, providers...)
	blocks = append(blocks, others...)
	filtered := make([]string, 0, len(blocks))
	for _, block := range blocks {
		if strings.TrimSpace(block) != "" {
			filtered = append(filtered, block)
		}
	}
	return strings.Join(filtered, "\n\n") + "\n"
}

func normalizeWindowsPathForConfig(value string) string {
	decoded := strings.TrimSpace(value)
	if regexp.MustCompile("^[A-Za-z]:[\\\\/]").MatchString(decoded) || strings.HasPrefix(decoded, "\\\\") {
		return strings.ReplaceAll(decoded, "\\", "/")
	}
	return decoded
}

func filterEmpty(lines []string) string {
	kept := make([]string, 0, len(lines))
	for _, line := range lines {
		if line != "" {
			kept = append(kept, line)
		}
	}
	return strings.Join(kept, "\n")
}

func trimEndSpace(value string) string {
	return strings.TrimRight(value, " \t\n\r\v\f")
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

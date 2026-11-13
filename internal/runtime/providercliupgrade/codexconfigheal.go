package providercliupgrade

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const (
	aihCodexProviderKey     = "aih_server"
	aihCodexProviderName    = "AIH Server"
	aihCodexProviderWireAPI = "responses"
	aihCodexProviderEnvKey  = "OPENAI_API_KEY"
)

var (
	tomlHeaderRe       = regexp.MustCompile(`^\[([^\[\]]+)\]$`)
	tomlKeyValueRe     = regexp.MustCompile(`^([A-Za-z0-9_.-]+)\s*=\s*(.+)$`)
	multilineDoubleRe  = regexp.MustCompile(`"""`)
	multilineSingleRe  = regexp.MustCompile(`'''`)
)

// HealCodexSandboxConfig 在沙箱 CODEX_HOME/config.toml 中写入或修复受管 model_providers.aih_server 段。
func HealCodexSandboxConfig(codexHome string, baseURL string) error {
	trimmedHome := strings.TrimSpace(codexHome)
	if trimmedHome == "" {
		return fmt.Errorf("codexHome 为空")
	}
	configPath := filepath.Join(trimmedHome, "config.toml")
	rawBytes, err := os.ReadFile(configPath)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	lines := strings.Split(strings.ReplaceAll(string(rawBytes), "\r\n", "\n"), "\n")

	targetHeader := "[model_providers." + aihCodexProviderKey + "]"
	headerIdx := -1
	endIdx := len(lines)
	inMultiline := ""

	for i, line := range lines {
		nextMultiline, skip := advanceTOMLMultilineState(line, inMultiline)
		if skip {
			inMultiline = nextMultiline
			continue
		}
		inMultiline = nextMultiline

		trimmed := strings.TrimSpace(line)
		if headerIdx < 0 {
			if m := tomlHeaderRe.FindStringSubmatch(trimmed); len(m) == 2 && "["+strings.TrimSpace(m[1])+"]" == targetHeader {
				headerIdx = i
			}
			continue
		}
		if tomlHeaderRe.MatchString(trimmed) {
			endIdx = i
			break
		}
	}

	effectiveBaseURL := strings.TrimSpace(baseURL)
	if effectiveBaseURL == "" {
		effectiveBaseURL = "http://127.0.0.1:1/v1"
	}
	desiredOrder := []string{"name", "base_url", "env_key", "wire_api"}
	desiredValues := map[string]string{
		"name":     fmt.Sprintf("%q", aihCodexProviderName),
		"base_url": fmt.Sprintf("%q", effectiveBaseURL),
		"env_key":  fmt.Sprintf("%q", aihCodexProviderEnvKey),
		"wire_api": fmt.Sprintf("%q", aihCodexProviderWireAPI),
	}

	var updated []string
	if headerIdx < 0 {
		trimmedRight := strings.TrimRight(string(rawBytes), "\r\n \t")
		if trimmedRight != "" {
			updated = append(updated, strings.Split(strings.ReplaceAll(trimmedRight, "\r\n", "\n"), "\n")...)
			updated = append(updated, "")
		}
		updated = append(updated, targetHeader)
		for _, k := range desiredOrder {
			updated = append(updated, k+" = "+desiredValues[k])
		}
	} else {
		updated = append(updated, lines[:headerIdx+1]...)
		seenKeys := map[string]bool{}
		for i := headerIdx + 1; i < endIdx; i++ {
			line := lines[i]
			trimmed := strings.TrimSpace(line)
			if m := tomlKeyValueRe.FindStringSubmatch(trimmed); len(m) == 3 {
				key := m[1]
				if replacement, managed := desiredValues[key]; managed {
					if !seenKeys[key] {
						updated = append(updated, key+" = "+replacement)
						seenKeys[key] = true
					}
					continue
				}
			}
			updated = append(updated, line)
		}
		var missing []string
		for _, k := range desiredOrder {
			if !seenKeys[k] {
				missing = append(missing, k+" = "+desiredValues[k])
			}
		}
		if len(missing) > 0 {
			updated = append(updated, missing...)
		}
		if endIdx < len(lines) {
			updated = append(updated, lines[endIdx:]...)
		}
	}

	nextContent := strings.TrimRight(strings.Join(updated, "\n"), "\n") + "\n"
	if err := os.MkdirAll(filepath.Dir(configPath), 0o755); err != nil {
		return err
	}
	return os.WriteFile(configPath, []byte(nextContent), 0o600)
}

func advanceTOMLMultilineState(line string, current string) (string, bool) {
	if current != "" {
		delimiter := `"""`
		if current == "single" {
			delimiter = `'''`
		}
		if strings.Contains(line, delimiter) {
			return "", true
		}
		return current, true
	}
	if len(multilineDoubleRe.FindAllStringIndex(line, -1))%2 == 1 {
		return "double", false
	}
	if len(multilineSingleRe.FindAllStringIndex(line, -1))%2 == 1 {
		return "single", false
	}
	return "", false
}

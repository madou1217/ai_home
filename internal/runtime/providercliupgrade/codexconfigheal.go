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
	// aihCodexSandboxBaseURL 只是占位网关地址：沙箱里的 provider 段必须先存在，
	// 否则 codex 会秒退；真实地址由启动参数或宿主配置决定。
	aihCodexSandboxBaseURL = "http://127.0.0.1:1/v1"
)

var (
	tomlHeaderRe      = regexp.MustCompile(`^\[([^\[\]]+)\]$`)
	tomlKeyValueRe    = regexp.MustCompile(`^([A-Za-z0-9_.-]+)\s*=\s*(.+)$`)
	multilineDoubleRe = regexp.MustCompile(`"""`)
	multilineSingleRe = regexp.MustCompile(`'''`)
)

// HealCodexSandboxConfig 在沙箱 CODEX_HOME/config.toml 中写入或修复受管 model_providers.aih_server 段。
//
// 修复只补缺失字段，并把段内**已经声明的凭据机制当成权威**：Codex ≥0.149 拒绝
// 同时出现 [.auth] 命令表与 env_key（provider auth cannot be combined with
// env_key，整份配置拒绝加载）。因此声明了 auth 或 bearer_token 的段不会补
// env_key，残留的 env_key 会被移除；宿主配置（由 codexdefault 写 auth 命令）即
// 使被误传进来也不会再被写坏。
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
	declaresAuth := false
	authHeaderIdx := -1
	inMultiline := ""

	for i, line := range lines {
		nextMultiline, skip := advanceTOMLMultilineState(line, inMultiline)
		if skip {
			inMultiline = nextMultiline
			continue
		}
		inMultiline = nextMultiline

		m := tomlHeaderRe.FindStringSubmatch(strings.TrimSpace(line))
		if len(m) != 2 {
			continue
		}
		header := "[" + strings.TrimSpace(m[1]) + "]"
		if isManagedProviderAuthHeader(header) {
			declaresAuth = true
			if authHeaderIdx < 0 {
				authHeaderIdx = i
			}
		}
		if headerIdx < 0 {
			if header == targetHeader {
				headerIdx = i
			}
			continue
		}
		if endIdx == len(lines) && i > headerIdx {
			endIdx = i
		}
	}

	hasBearerToken, hasBaseURL, inlineAuth := providerSectionFacts(lines, headerIdx, endIdx)
	if inlineAuth || hasBearerToken {
		declaresAuth = true
	}
	writeEnvKey := !declaresAuth

	explicitBaseURL := strings.TrimSpace(baseURL)
	desiredOrder := []string{"name", "base_url", "env_key", "wire_api"}
	desiredValues := map[string]string{
		"name":     fmt.Sprintf("%q", aihCodexProviderName),
		"wire_api": fmt.Sprintf("%q", aihCodexProviderWireAPI),
	}
	switch {
	case explicitBaseURL != "":
		desiredValues["base_url"] = fmt.Sprintf("%q", explicitBaseURL)
	case !declaresAuth && !hasBaseURL:
		// 只有我们自己的沙箱段才允许写占位地址；声明了 auth 的宿主段宁可不动，
		// 也不要把真实网关地址换成连不通的占位值。
		desiredValues["base_url"] = fmt.Sprintf("%q", aihCodexSandboxBaseURL)
	}
	if writeEnvKey {
		desiredValues["env_key"] = fmt.Sprintf("%q", aihCodexProviderEnvKey)
	}

	var updated []string
	if headerIdx < 0 && declaresAuth && authHeaderIdx >= 0 {
		// 只有 [model_providers.aih_server.auth] 子表、没有父表头：父表必须写在
		// 子表之前，否则是 TOML 表重复定义。凭据仍由 auth 命令提供。
		block := []string{targetHeader, "name = " + desiredValues["name"]}
		if value, managed := desiredValues["base_url"]; managed {
			block = append(block, "base_url = "+value)
		}
		block = append(block, "wire_api = "+desiredValues["wire_api"])
		updated = append(updated, lines[:authHeaderIdx]...)
		updated = append(updated, block...)
		updated = append(updated, lines[authHeaderIdx:]...)
	} else if headerIdx < 0 {
		trimmedRight := strings.TrimRight(string(rawBytes), "\r\n \t")
		if trimmedRight != "" {
			updated = append(updated, strings.Split(strings.ReplaceAll(trimmedRight, "\r\n", "\n"), "\n")...)
			updated = append(updated, "")
		}
		updated = append(updated, targetHeader)
		for _, k := range desiredOrder {
			if value, managed := desiredValues[k]; managed {
				updated = append(updated, k+" = "+value)
			}
		}
	} else {
		updated = append(updated, lines[:headerIdx+1]...)
		seenKeys := map[string]bool{}
		inMultiline = ""
		for i := headerIdx + 1; i < endIdx; i++ {
			line := lines[i]
			nextMultiline, skip := advanceTOMLMultilineState(line, inMultiline)
			if skip {
				inMultiline = nextMultiline
				updated = append(updated, line)
				continue
			}
			inMultiline = nextMultiline
			if m := tomlKeyValueRe.FindStringSubmatch(strings.TrimSpace(line)); len(m) == 3 {
				key := m[1]
				if key == "env_key" && !writeEnvKey {
					continue
				}
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
			if _, managed := desiredValues[k]; !managed {
				continue
			}
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

// isManagedProviderAuthHeader 识别 [model_providers.aih_server.auth] 及其子表。
func isManagedProviderAuthHeader(header string) bool {
	prefix := "[model_providers." + aihCodexProviderKey + ".auth"
	return header == prefix+"]" || strings.HasPrefix(header, prefix+".")
}

// providerSectionFacts 读取受管段里已声明的凭据机制与端点。bearer_token 与
// 内联/点号 auth 都是配置自带的凭据来源，都不能再叠加 env_key。
func providerSectionFacts(lines []string, headerIdx, endIdx int) (hasBearerToken, hasBaseURL, inlineAuth bool) {
	if headerIdx < 0 {
		return false, false, false
	}
	inMultiline := ""
	for i := headerIdx + 1; i < endIdx; i++ {
		nextMultiline, skip := advanceTOMLMultilineState(lines[i], inMultiline)
		if skip {
			inMultiline = nextMultiline
			continue
		}
		inMultiline = nextMultiline
		m := tomlKeyValueRe.FindStringSubmatch(strings.TrimSpace(lines[i]))
		if len(m) != 3 {
			continue
		}
		switch {
		case m[1] == "auth" || strings.HasPrefix(m[1], "auth."):
			inlineAuth = true
		case m[1] == "bearer_token":
			if !tomlValueEmpty(m[2]) {
				hasBearerToken = true
			}
		case m[1] == "base_url":
			if !tomlValueEmpty(m[2]) {
				hasBaseURL = true
			}
		}
	}
	return hasBearerToken, hasBaseURL, inlineAuth
}

// tomlValueEmpty 判断一行 key = value 的值是否为空字符串/空值。
func tomlValueEmpty(value string) bool {
	trimmed := strings.TrimSpace(value)
	if len(trimmed) >= 2 {
		if (trimmed[0] == '"' && trimmed[len(trimmed)-1] == '"') ||
			(trimmed[0] == '\'' && trimmed[len(trimmed)-1] == '\'') {
			return strings.TrimSpace(trimmed[1:len(trimmed)-1]) == ""
		}
	}
	return trimmed == ""
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

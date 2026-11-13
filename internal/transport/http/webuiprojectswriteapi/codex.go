package webuiprojectswriteapi

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

func ensureCodexHooksEnabled(ctx context.Context, hostHomeDir string) {
	if strings.TrimSpace(hostHomeDir) == "" {
		return
	}
	configPath := filepath.Join(hostHomeDir, ".codex", "config.toml")
	rawBytes, err := os.ReadFile(configPath)
	if err != nil {
		return
	}
	text := string(rawBytes)
	flagName := detectCodexHooksFlagName(ctx)
	updated, changed := rewriteCodexFeaturesFlag(text, flagName)
	if !changed {
		return
	}
	_ = writeCodexConfigAtomic(configPath, updated)
}

func ensureCodexProjectRegistered(hostHomeDir, projectPath string) {
	if strings.TrimSpace(hostHomeDir) == "" || strings.TrimSpace(projectPath) == "" {
		return
	}
	configPath := filepath.Join(hostHomeDir, ".codex", "config.toml")
	var text string
	if rawBytes, err := os.ReadFile(configPath); err == nil {
		text = string(rawBytes)
	}
	updated, changed := upsertTrustedCodexProject(text, projectPath)
	if !changed {
		return
	}
	_ = writeCodexConfigAtomic(configPath, updated)
}

func removeCodexProjectRegistration(hostHomeDir, projectPath string) {
	if strings.TrimSpace(hostHomeDir) == "" || strings.TrimSpace(projectPath) == "" {
		return
	}
	configPath := filepath.Join(hostHomeDir, ".codex", "config.toml")
	rawBytes, err := os.ReadFile(configPath)
	if err != nil {
		return
	}
	updated, changed := removeCodexProjectSection(string(rawBytes), projectPath)
	if !changed {
		return
	}
	_ = writeCodexConfigAtomic(configPath, updated)
}

func writeCodexConfigAtomic(configPath, content string) error {
	if err := os.MkdirAll(filepath.Dir(configPath), 0o755); err != nil {
		return err
	}
	tmp := configPath + ".aih-tmp-" + strconv.FormatInt(time.Now().UnixNano(), 10)
	if err := os.WriteFile(tmp, []byte(content), 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, configPath); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

func detectCodexHooksFlagName(ctx context.Context) string {
	probeCtx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	out, err := exec.CommandContext(probeCtx, "codex", "--version").Output()
	if err != nil {
		return "hooks"
	}
	fields := strings.Fields(string(out))
	for _, field := range fields {
		parts := strings.Split(strings.TrimPrefix(field, "v"), ".")
		if len(parts) < 2 {
			continue
		}
		major, errMaj := strconv.Atoi(parts[0])
		minor, errMin := strconv.Atoi(parts[1])
		if errMaj == nil && errMin == nil {
			if major == 0 && minor < 114 {
				return "codex_hooks"
			}
			return "hooks"
		}
	}
	return "hooks"
}

func rewriteCodexFeaturesFlag(text, flagName string) (string, bool) {
	lines := strings.Split(text, "\n")
	start := -1
	end := len(lines)
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "[") || !strings.HasSuffix(trimmed, "]") {
			continue
		}
		if trimmed == "[features]" {
			start = i
			continue
		}
		if start >= 0 {
			end = i
			break
		}
	}
	if start < 0 {
		return text, false
	}
	changed := false
	hasFlag := false
	outSection := make([]string, 0, end-start)
	for _, line := range lines[start+1 : end] {
		key, val, ok := splitTomlKeyValue(line)
		if ok && (key == "hooks" || key == "codex_hooks") {
			if key == flagName && strings.EqualFold(val, "true") && !hasFlag {
				outSection = append(outSection, line)
				hasFlag = true
				continue
			}
			changed = true
			if !hasFlag {
				outSection = append(outSection, flagName+" = true")
				hasFlag = true
			}
			continue
		}
		outSection = append(outSection, line)
	}
	if !changed {
		return text, false
	}
	rebuilt := append([]string{}, lines[:start+1]...)
	rebuilt = append(rebuilt, outSection...)
	rebuilt = append(rebuilt, lines[end:]...)
	return strings.Join(rebuilt, "\n"), true
}

func upsertTrustedCodexProject(text, projectPath string) (string, bool) {
	sectionHeader := "[projects." + strconv.Quote(projectPath) + "]"
	lines := strings.Split(text, "\n")
	start, end := findExactSection(lines, sectionHeader)
	if start < 0 {
		trimmed := strings.TrimRight(text, "\n")
		prefix := ""
		if trimmed != "" {
			prefix = trimmed + "\n\n"
		}
		return prefix + sectionHeader + "\ntrust_level = \"trusted\"\n", true
	}
	hasTrust := false
	changed := false
	for i := start + 1; i < end; i++ {
		key, val, ok := splitTomlKeyValue(lines[i])
		if ok && key == "trust_level" {
			hasTrust = true
			if strings.Trim(val, `"'`) != "trusted" {
				lines[i] = `trust_level = "trusted"`
				changed = true
			}
			break
		}
	}
	if !hasTrust {
		rebuilt := append([]string{}, lines[:start+1]...)
		rebuilt = append(rebuilt, `trust_level = "trusted"`)
		rebuilt = append(rebuilt, lines[start+1:]...)
		return strings.Join(rebuilt, "\n"), true
	}
	if !changed {
		return text, false
	}
	return strings.Join(lines, "\n"), true
}

func removeCodexProjectSection(text, projectPath string) (string, bool) {
	sectionHeader := "[projects." + strconv.Quote(projectPath) + "]"
	lines := strings.Split(text, "\n")
	start, end := findExactSection(lines, sectionHeader)
	if start < 0 {
		return text, false
	}
	rebuilt := append([]string{}, lines[:start]...)
	rebuilt = append(rebuilt, lines[end:]...)
	joined := strings.TrimRight(strings.Join(rebuilt, "\n"), "\n")
	if joined != "" {
		joined += "\n"
	}
	return joined, true
}

func findExactSection(lines []string, header string) (int, int) {
	start := -1
	end := len(lines)
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "[") || !strings.HasSuffix(trimmed, "]") {
			continue
		}
		if trimmed == header && start < 0 {
			start = i
			continue
		}
		if start >= 0 {
			end = i
			break
		}
	}
	return start, end
}

func splitTomlKeyValue(line string) (string, string, bool) {
	stripped := strings.TrimSpace(line)
	if stripped == "" || strings.HasPrefix(stripped, "#") {
		return "", "", false
	}
	if commentIdx := strings.IndexByte(stripped, '#'); commentIdx >= 0 {
		stripped = strings.TrimSpace(stripped[:commentIdx])
	}
	eqIdx := strings.IndexByte(stripped, '=')
	if eqIdx <= 0 {
		return "", "", false
	}
	key := strings.TrimSpace(stripped[:eqIdx])
	val := strings.TrimSpace(stripped[eqIdx+1:])
	return key, val, key != ""
}

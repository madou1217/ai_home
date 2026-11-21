// Package launchsettings 把账号级 Provider 关键设置注入到官方 CLI 启动参数/环境。
//
// 公共值已经在 Provider 配置文件里；这里只处理账号显式覆盖的键，并且只在
// 绑定到具体账号的启动中使用（账号池模式没有单一账号，保持公共值）。
package launchsettings

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/providerconfigs"
)

// Overrides 是本次启动需要叠加的额外参数与环境。
type Overrides struct {
	Args []string
	Env  map[string]string
	// Unsupported 表示该 Provider 暂未接入账号级启动注入（值仍已保存）。
	Unsupported bool
	// Warnings 是本次注入的可见提示（如个别键无法注入）。
	Warnings []string
}

// Build 按 Provider 的 CLI 能力生成账号覆盖注入。
//
// 目前接入：codex（-c）、claude（--settings）、opencode（OPENCODE_CONFIG + --standalone）、
// agy（--settings 内联 JSON，已用 agy 校验确认）、grok（--model/--effort）、
// gemini（--model；compressionThreshold 因系统设置文件要求 root 所有而仅保存）。
func Build(providerID, accountRef string, values map[string]string, aiHomeDir string) (Overrides, error) {
	normalizedProvider := strings.ToLower(strings.TrimSpace(providerID))
	definitions, found := providerconfigs.KeySettingsForProvider(normalizedProvider)
	if !found || len(values) == 0 {
		return Overrides{}, nil
	}
	declared := make(map[string]providerconfigs.KeySetting, len(definitions))
	for _, definition := range definitions {
		declared[definition.Path] = definition
	}
	filtered := make(map[string]string, len(values))
	for path, value := range values {
		if _, ok := declared[path]; ok {
			// 历史覆盖可能停留在内部 id；注入前统一翻译成 CLI 接受的值
			// （agy 只认显示名）。空值仍视为未覆盖。
			normalized := providerconfigs.NormalizeKeySettingValue(normalizedProvider, path, value)
			if normalized != "" {
				filtered[path] = normalized
			}
		}
	}
	if len(filtered) == 0 {
		return Overrides{}, nil
	}
	if !providerconfigs.AccountLaunchInjectionSupported(normalizedProvider) {
		return Overrides{Unsupported: true}, nil
	}
	switch normalizedProvider {
	case "codex":
		return buildCodex(filtered, declared)
	case "claude":
		return buildClaude(filtered, declared, accountRef, aiHomeDir)
	case "opencode":
		return buildOpencode(filtered, declared, accountRef, aiHomeDir)
	case "agy":
		return buildAgy(filtered, declared)
	case "grok":
		return buildGrok(filtered)
	case "gemini":
		return buildGemini(filtered)
	default:
		return Overrides{Unsupported: true}, nil
	}
}

// buildCodex 用 `-c key=value` 覆盖 config.toml 的任意键（含嵌套点号键）。
func buildCodex(values map[string]string, declared map[string]providerconfigs.KeySetting) (Overrides, error) {
	paths := sortedPaths(values)
	args := make([]string, 0, len(paths)*2)
	for _, path := range paths {
		literal, err := tomlLiteral(declared[path], values[path])
		if err != nil {
			return Overrides{}, err
		}
		args = append(args, "-c", path+"="+literal)
	}
	return Overrides{Args: args}, nil
}

// buildClaude 用 `--settings <file>` 叠加账号覆盖；Claude 会与用户设置合并。
func buildClaude(
	values map[string]string,
	declared map[string]providerconfigs.KeySetting,
	accountRef, aiHomeDir string,
) (Overrides, error) {
	settings := map[string]any{}
	for path, value := range values {
		setting := declared[path]
		typed, err := typedValue(setting, value)
		if err != nil {
			return Overrides{}, err
		}
		if err := setNested(settings, path, typed); err != nil {
			return Overrides{}, err
		}
	}
	home := strings.TrimSpace(aiHomeDir)
	ref := strings.TrimSpace(accountRef)
	if home == "" || ref == "" {
		return Overrides{Unsupported: true}, nil
	}
	directory := filepath.Join(home, "run", "account-settings", "claude", ref)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return Overrides{}, fmt.Errorf("账号级 Claude 设置目录不可用: %w", err)
	}
	raw, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return Overrides{}, err
	}
	target := filepath.Join(directory, "settings.json")
	temporary, err := os.CreateTemp(directory, ".settings-*.tmp")
	if err != nil {
		return Overrides{}, err
	}
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(temporary.Name())
		}
	}()
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return Overrides{}, err
	}
	if _, err := temporary.Write(append(raw, '\n')); err != nil {
		_ = temporary.Close()
		return Overrides{}, err
	}
	if err := temporary.Close(); err != nil {
		return Overrides{}, err
	}
	if err := os.Rename(temporary.Name(), target); err != nil {
		return Overrides{}, err
	}
	cleanup = false
	return Overrides{Args: []string{"--settings", target}}, nil
}

// buildAgy 用 --settings 内联 JSON 覆盖本次会话（agy 帮助明确该值只用于当前会话）。
func buildAgy(values map[string]string, declared map[string]providerconfigs.KeySetting) (Overrides, error) {
	settings := map[string]any{}
	for path, value := range values {
		typed, err := typedValue(declared[path], value)
		if err != nil {
			return Overrides{}, err
		}
		if err := setNested(settings, path, typed); err != nil {
			return Overrides{}, err
		}
	}
	raw, err := json.Marshal(settings)
	if err != nil {
		return Overrides{}, err
	}
	return Overrides{Args: []string{"--settings", string(raw)}}, nil
}

// buildGrok 把声明路径映射到官方 -m/--effort 参数。
func buildGrok(values map[string]string) (Overrides, error) {
	args := make([]string, 0, len(values)*2)
	for _, path := range sortedPaths(values) {
		value := values[path]
		switch path {
		case "models.default":
			args = append(args, "--model", value)
		case "models.default_reasoning_effort":
			args = append(args, "--effort", value)
		default:
			continue
		}
	}
	return Overrides{Args: args}, nil
}

// buildGemini 只用官方 --model；compressionThreshold 只能保存在公共/账号配置里，
// 因为 Gemini 要求系统设置文件由 root 所有，用户目录的覆盖文件会被跳过。
func buildGemini(values map[string]string) (Overrides, error) {
	args := make([]string, 0, 2)
	warnings := make([]string, 0)
	if model, ok := values["model.name"]; ok && strings.TrimSpace(model) != "" {
		args = append(args, "--model", strings.TrimSpace(model))
	}
	if _, ok := values["model.compressionThreshold"]; ok {
		warnings = append(warnings, "Gemini 的 model.compressionThreshold 无法在账号级启动注入（系统设置文件要求 root 所有），本次仅使用账号目录中的公共值。")
	}
	return Overrides{Args: args, Warnings: warnings}, nil
}

// buildOpencode 用 OPENCODE_CONFIG 指向账号覆盖文件；OpenCode 会把它作为
// 一个配置源叠加在全局配置之上（`opencode debug config` 已验证）。
func buildOpencode(
	values map[string]string,
	declared map[string]providerconfigs.KeySetting,
	accountRef, aiHomeDir string,
) (Overrides, error) {
	settings := map[string]any{}
	for path, value := range values {
		setting := declared[path]
		typed, err := typedValue(setting, value)
		if err != nil {
			return Overrides{}, err
		}
		if err := setNested(settings, path, typed); err != nil {
			return Overrides{}, err
		}
	}
	home := strings.TrimSpace(aiHomeDir)
	ref := strings.TrimSpace(accountRef)
	if home == "" || ref == "" {
		return Overrides{Unsupported: true}, nil
	}
	target, err := writeJsonOverlay(home, "opencode", ref, "opencode.json", settings)
	if err != nil {
		return Overrides{}, err
	}
	// 共享后台 server 不会重新读取客户端 env；账号覆盖必须让本次进程使用
	// 私有 server（已用 `opencode --standalone debug config` 验证配置源生效）。
	return Overrides{
		Args: []string{"--standalone"},
		Env:  map[string]string{"OPENCODE_CONFIG": target},
	}, nil
}

// writeJsonOverlay 原子写入账号级覆盖文件（0600）。
func writeJsonOverlay(home, provider, accountRef, filename string, settings map[string]any) (string, error) {
	directory := filepath.Join(home, "run", "account-settings", provider, accountRef)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return "", fmt.Errorf("账号级设置目录不可用: %w", err)
	}
	raw, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return "", err
	}
	target := filepath.Join(directory, filename)
	temporary, err := os.CreateTemp(directory, ".settings-*.tmp")
	if err != nil {
		return "", err
	}
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(temporary.Name())
		}
	}()
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return "", err
	}
	if _, err := temporary.Write(append(raw, '\n')); err != nil {
		_ = temporary.Close()
		return "", err
	}
	if err := temporary.Close(); err != nil {
		return "", err
	}
	if err := os.Rename(temporary.Name(), target); err != nil {
		return "", err
	}
	cleanup = false
	return target, nil
}

func sortedPaths(values map[string]string) []string {
	paths := make([]string, 0, len(values))
	for path := range values {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	return paths
}

// tomlLiteral 按声明类型生成 Codex -c 接受的字面量。
func tomlLiteral(setting providerconfigs.KeySetting, value string) (string, error) {
	switch setting.Kind {
	case providerconfigs.KeySettingBoolean:
		lower := strings.ToLower(value)
		if lower != "true" && lower != "false" {
			return "", fmt.Errorf("关键设置 %s 必须是 true/false", setting.Path)
		}
		return lower, nil
	case providerconfigs.KeySettingNumber:
		number, err := strconv.ParseFloat(value, 64)
		if err != nil {
			return "", fmt.Errorf("关键设置 %s 必须是数字", setting.Path)
		}
		return strconv.FormatFloat(number, 'f', -1, 64), nil
	default:
		return strconv.Quote(value), nil
	}
}

// typedValue 生成 Claude settings JSON 的原生类型。
func typedValue(setting providerconfigs.KeySetting, value string) (any, error) {
	switch setting.Kind {
	case providerconfigs.KeySettingBoolean:
		lower := strings.ToLower(value)
		if lower != "true" && lower != "false" {
			return nil, fmt.Errorf("关键设置 %s 必须是 true/false", setting.Path)
		}
		return lower == "true", nil
	case providerconfigs.KeySettingNumber:
		number, err := strconv.ParseFloat(value, 64)
		if err != nil {
			return nil, fmt.Errorf("关键设置 %s 必须是数字", setting.Path)
		}
		return number, nil
	default:
		return value, nil
	}
}

// setNested 写入点号路径；Claude 当前关键项都是根级，保留嵌套兼容。
func setNested(target map[string]any, path string, value any) error {
	segments := strings.Split(path, ".")
	current := target
	for index, segment := range segments {
		if segment == "" {
			return fmt.Errorf("关键设置路径无效: %s", path)
		}
		if index == len(segments)-1 {
			current[segment] = value
			return nil
		}
		next, ok := current[segment].(map[string]any)
		if !ok {
			next = map[string]any{}
			current[segment] = next
		}
		current = next
	}
	return nil
}

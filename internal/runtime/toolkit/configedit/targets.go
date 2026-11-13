// Package configedit 实现 Toolkit 受管应用与运维工具配置文件的原子读取、乐观并发保存、
// 权限提权读写以及保存前语法/二进制校验。
//
// 对应 Node 侧 config-editor.js 与各 tool-plugin 的 config 校验逻辑。
package configedit

import (
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/core/providers"
)

type ideTargetDef struct {
	ID              string
	ConfigDirectory string
}

var ideTargets = map[string]ideTargetDef{
	"vscode":   {ID: "vscode", ConfigDirectory: "Code"},
	"cursor":   {ID: "cursor", ConfigDirectory: "Cursor"},
	"windsurf": {ID: "windsurf", ConfigDirectory: "Windsurf"},
}

// Target 表示解析后的单个可编辑配置文件目标。
type Target struct {
	AppID        string
	Provider     string
	Platform     string
	HostHomeDir  string
	TargetPath   string
	ConfigName   string
	ConfigFormat string
}

// ConfigFormat 根据文件名/扩展名返回编辑器语法高亮与格式标识。
func ConfigFormat(configPath string) string {
	rawPath := strings.TrimSpace(configPath)
	base := strings.ToLower(filepath.Base(strings.ReplaceAll(rawPath, `\`, `/`)))
	if base == ".env" || strings.HasPrefix(base, ".env.") {
		return "dotenv"
	}
	ext := strings.ToLower(filepath.Ext(base))
	switch ext {
	case ".toml":
		return "toml"
	case ".jsonc":
		return "jsonc"
	case ".json":
		return "json"
	case ".yaml", ".yml":
		return "yaml"
	case ".ini", ".properties":
		return "ini"
	case ".sh", ".bash", ".zsh":
		return "shellscript"
	default:
		stripped := strings.TrimPrefix(ext, ".")
		if stripped != "" {
			return stripped
		}
		return "text"
	}
}

// NormalizePlatform 将 GOOS 或客户端平台名统一为 macos / windows / linux。
func NormalizePlatform(goos string) string {
	switch strings.ToLower(strings.TrimSpace(goos)) {
	case "darwin", "macos", "mac":
		return "macos"
	case "windows", "win32":
		return "windows"
	default:
		return "linux"
	}
}

// ResolveAppTarget 根据 Provider Catalog 与 IDE 注册表解析应用的主配置文件路径。
func ResolveAppTarget(catalog *providers.Catalog, appID string, hostHomeDir string, goos string, lookupEnv func(string) string) (Target, error) {
	normalizedID := strings.ToLower(strings.TrimSpace(appID))
	platform := NormalizePlatform(goos)
	if lookupEnv == nil {
		lookupEnv = func(string) string { return "" }
	}
	provider := resolveConfigAppAlias(catalog, normalizedID)
	if provider == "" {
		return Target{}, NewError("unsupported_app", "不支持编辑应用 "+nonEmptyOr(normalizedID, "unknown"))
	}
	if strings.TrimSpace(hostHomeDir) == "" {
		return Target{}, NewError("config_target_unavailable", "当前平台没有可解析的配置目标")
	}

	targetPath := resolveProviderConfigPath(catalog, provider, hostHomeDir, platform, lookupEnv)
	if strings.TrimSpace(targetPath) == "" {
		return Target{}, NewError("config_target_unavailable", "当前平台没有可解析的配置目标")
	}
	return Target{
		AppID:        normalizedID,
		Provider:     provider,
		Platform:     platform,
		HostHomeDir:  hostHomeDir,
		TargetPath:   targetPath,
		ConfigName:   filepath.Base(targetPath),
		ConfigFormat: ConfigFormat(targetPath),
	}, nil
}

func resolveConfigAppAlias(catalog *providers.Catalog, normalizedID string) string {
	if _, isIDE := ideTargets[normalizedID]; isIDE {
		return normalizedID
	}
	if normalizedID == "claude" {
		return "claude"
	}
	if catalog != nil {
		for _, def := range catalog.List() {
			id := strings.ToLower(strings.TrimSpace(def.ID))
			if id == "" {
				continue
			}
			if normalizedID == id {
				return id
			}
			if def.Clients.Desktop && normalizedID == id+"-desktop" {
				if id == "claude" {
					return "claude-desktop"
				}
				return id
			}
		}
	}
	return ""
}

func resolveProviderConfigPath(catalog *providers.Catalog, provider string, home string, platform string, lookupEnv func(string) string) string {
	if ide, ok := ideTargets[provider]; ok {
		return resolveIDEConfigPath(ide, home, platform, lookupEnv)
	}
	if provider == "claude-desktop" {
		if platform == "macos" {
			return filepath.Join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
		}
		return filepath.Join(resolveConfigHome(home, platform, lookupEnv), "Claude", "claude_desktop_config.json")
	}
	configHome := resolveConfigHome(home, platform, lookupEnv)
	if catalog != nil {
		if def, ok := catalog.Get(provider); ok && def.CLI != nil {
			globalDir := strings.TrimSpace(def.CLI.GlobalDir)
			if globalDir == "" {
				globalDir = "." + provider
			}
			parts := splitRelParts(globalDir)
			var root string
			if len(parts) > 0 && parts[0] == ".config" {
				root = filepath.Join(append([]string{configHome}, parts[1:]...)...)
			} else {
				root = filepath.Join(append([]string{home}, parts...)...)
			}
			if subParts := splitRelParts(def.CLI.ConfigSubDir); len(subParts) > 0 {
				root = filepath.Join(append([]string{root}, subParts...)...)
			}
			if fileParts := splitRelParts(def.CLI.ConfigFile); len(fileParts) > 0 {
				return filepath.Join(append([]string{root}, fileParts...)...)
			}
			return root
		}
	}
	return filepath.Join(home, "."+provider)
}

func resolveIDEConfigPath(ide ideTargetDef, home string, platform string, lookupEnv func(string) string) string {
	switch platform {
	case "macos":
		return filepath.Join(home, "Library", "Application Support", ide.ConfigDirectory, "User", "settings.json")
	case "windows":
		appData := nonEmptyOr(strings.TrimSpace(lookupEnv("APPDATA")), filepath.Join(home, "AppData", "Roaming"))
		return filepath.Join(appData, ide.ConfigDirectory, "User", "settings.json")
	default:
		configHome := nonEmptyOr(strings.TrimSpace(lookupEnv("XDG_CONFIG_HOME")), filepath.Join(home, ".config"))
		return filepath.Join(configHome, ide.ConfigDirectory, "User", "settings.json")
	}
}

func resolveConfigHome(home string, platform string, lookupEnv func(string) string) string {
	if xdg := strings.TrimSpace(lookupEnv("XDG_CONFIG_HOME")); xdg != "" {
		return xdg
	}
	if platform == "windows" {
		if appData := strings.TrimSpace(lookupEnv("APPDATA")); appData != "" {
			return appData
		}
		return filepath.Join(home, "AppData", "Roaming")
	}
	return filepath.Join(home, ".config")
}

func splitRelParts(raw string) []string {
	cleaned := strings.ReplaceAll(strings.TrimSpace(raw), `\`, `/`)
	cleaned = strings.Trim(cleaned, `/`)
	if cleaned == "" {
		return nil
	}
	segments := strings.Split(cleaned, `/`)
	out := make([]string, 0, len(segments))
	for _, seg := range segments {
		if s := strings.TrimSpace(seg); s != "" {
			out = append(out, s)
		}
	}
	return out
}

func nonEmptyOr(val string, fallback string) string {
	if strings.TrimSpace(val) != "" {
		return val
	}
	return fallback
}

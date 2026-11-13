package terminalicon

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/madou1217/ai_home/assets"
)

// Layout 是一次安装需要的路径与环境。
type Layout struct {
	AIHomeDir   string
	HostHomeDir string
	Env         map[string]string
	Platform    string
	AIHCommand  string
}

// IconsDir 返回 aih 自己物化图标的目录：不放仓库路径，安装包也能用。
func IconsDir(aiHomeDir string) string {
	return filepath.Join(strings.TrimSpace(aiHomeDir), "run", "terminal-icons")
}

// MaterializeIcons 把内嵌 PNG 写到 AIH 数据目录，返回 providerID -> 图标路径。
func MaterializeIcons(items []Provider, aiHomeDir string) (map[string]string, error) {
	directory := IconsDir(aiHomeDir)
	if strings.TrimSpace(aiHomeDir) == "" {
		return nil, errors.New("terminal icon: AIH home is required")
	}
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return nil, err
	}
	paths := make(map[string]string, len(items))
	for _, provider := range items {
		data, ok := assets.ProviderIcon(provider.ID)
		if !ok {
			continue
		}
		target := filepath.Join(directory, provider.ID+".png")
		if err := writeFileAtomic(target, data, 0o600); err != nil {
			return nil, err
		}
		paths[provider.ID] = target
	}
	return paths, nil
}

// IconPathFunc 生成 Build* 需要的图标路径回调。
func IconPathFunc(paths map[string]string) func(Provider) string {
	return func(provider Provider) string {
		return paths[provider.ID]
	}
}

// Iterm2DynamicProfilePath 返回 iTerm2 DynamicProfiles 文件路径。
func Iterm2DynamicProfilePath(hostHomeDir string) string {
	home := strings.TrimSpace(hostHomeDir)
	if home == "" {
		return ""
	}
	return filepath.Join(home, "Library", "Application Support", "iTerm2", "DynamicProfiles", "provider-icons.json")
}

// WriteIterm2Profiles 写入 iTerm2 Dynamic Profiles（整份覆盖，与 Node 同语义）。
func WriteIterm2Profiles(items []Provider, layout Layout) (string, Iterm2Profiles, error) {
	paths, err := MaterializeIcons(items, layout.AIHomeDir)
	if err != nil {
		return "", Iterm2Profiles{}, err
	}
	profiles, err := BuildIterm2Profiles(items, layout.AIHCommand, IconPathFunc(paths))
	if err != nil {
		return "", Iterm2Profiles{}, err
	}
	target := Iterm2DynamicProfilePath(layout.HostHomeDir)
	if target == "" {
		return "", Iterm2Profiles{}, errors.New("terminal icon: host home is required for iTerm2 profiles")
	}
	payload, err := json.MarshalIndent(profiles, "", "  ")
	if err != nil {
		return "", Iterm2Profiles{}, err
	}
	if err := writeFileAtomic(target, append(payload, '\n'), 0o600); err != nil {
		return "", Iterm2Profiles{}, err
	}
	return target, profiles, nil
}

// LinuxEntry 是单个 Provider 的 Linux 安装结果。
type LinuxEntry struct {
	Provider       string
	IconPath       string
	DesktopEntry   string
	KonsoleProfile string
}

// LinuxDataHome 解析 XDG_DATA_HOME（缺省 ~/.local/share）。
func LinuxDataHome(layout Layout) string {
	if explicit := strings.TrimSpace(layout.Env["XDG_DATA_HOME"]); explicit != "" {
		return explicit
	}
	home := strings.TrimSpace(layout.HostHomeDir)
	if home == "" {
		return ""
	}
	return filepath.Join(home, ".local", "share")
}

// WriteLinuxFiles 写 PNG/桌面入口/Konsole profile。
func WriteLinuxFiles(items []Provider, layout Layout) (string, []LinuxEntry, error) {
	dataHome := LinuxDataHome(layout)
	if dataHome == "" {
		return "", nil, errors.New("terminal icon: HOME or XDG_DATA_HOME is required for Linux icons")
	}
	paths, err := MaterializeIcons(items, layout.AIHomeDir)
	if err != nil {
		return "", nil, err
	}
	entries := make([]LinuxEntry, 0, len(items))
	for _, provider := range items {
		iconSource, ok := paths[provider.ID]
		if !ok {
			continue
		}
		iconTarget := filepath.Join(dataHome, "icons", "hicolor", "256x256", "apps", IconName(provider)+".png")
		desktopTarget := filepath.Join(dataHome, "applications", IconName(provider)+".desktop")
		konsoleTarget := filepath.Join(dataHome, "konsole", IconName(provider)+".profile")
		iconData, readErr := os.ReadFile(iconSource)
		if readErr != nil {
			return "", nil, readErr
		}
		if err := writeFileAtomic(iconTarget, iconData, 0o644); err != nil {
			return "", nil, err
		}
		if err := writeFileAtomic(desktopTarget, []byte(DesktopEntry(provider, layout.AIHCommand)), 0o644); err != nil {
			return "", nil, err
		}
		if err := writeFileAtomic(konsoleTarget, []byte(KonsoleProfile(provider, layout.AIHCommand)), 0o644); err != nil {
			return "", nil, err
		}
		entries = append(entries, LinuxEntry{
			Provider:       provider.ID,
			IconPath:       iconTarget,
			DesktopEntry:   desktopTarget,
			KonsoleProfile: konsoleTarget,
		})
	}
	return dataHome, entries, nil
}

// WindowsLocalAppData 解析 LOCALAPPDATA / USERPROFILE。
func WindowsLocalAppData(layout Layout) string {
	if explicit := strings.TrimSpace(layout.Env["LOCALAPPDATA"]); explicit != "" {
		return explicit
	}
	profile := strings.TrimSpace(layout.Env["USERPROFILE"])
	if profile == "" {
		profile = strings.TrimSpace(layout.HostHomeDir)
	}
	if profile == "" {
		return ""
	}
	return filepath.Join(profile, "AppData", "Local")
}

// WindowsTerminalFragmentPath 返回 fragment 文件路径。
func WindowsTerminalFragmentPath(layout Layout) string {
	local := WindowsLocalAppData(layout)
	if local == "" {
		return ""
	}
	return filepath.Join(local, "Microsoft", "Windows Terminal", "Fragments", "AI Home", "provider-icons.json")
}

// WindowsTerminalSettingsPath 返回 Windows Terminal settings.json 路径。
func WindowsTerminalSettingsPath(layout Layout) string {
	local := WindowsLocalAppData(layout)
	if local == "" {
		return ""
	}
	return filepath.Join(local, "Packages", "Microsoft.WindowsTerminal_8wekyb3d8bbwe", "LocalState", "settings.json")
}

// WindowsSettingsResult 是 settings.json 同步结果。
type WindowsSettingsResult struct {
	Path     string
	Changed  bool
	Profiles []string
	Skipped  string
}

// WindowsFragmentResult 是 fragment 写入结果。
type WindowsFragmentResult struct {
	Path     string
	Fragment WindowsTerminalFragment
	Settings WindowsSettingsResult
}

// WriteWindowsTerminalFragment 写 fragment，并在能读到用户 settings.json 时同步其中已有的 AIH profile。
func WriteWindowsTerminalFragment(items []Provider, layout Layout) (WindowsFragmentResult, error) {
	paths, err := MaterializeIcons(items, layout.AIHomeDir)
	if err != nil {
		return WindowsFragmentResult{}, err
	}
	fragment, err := BuildWindowsTerminalFragment(items, layout.AIHCommand, "", IconPathFunc(paths))
	if err != nil {
		return WindowsFragmentResult{}, err
	}
	target := WindowsTerminalFragmentPath(layout)
	if target == "" {
		return WindowsFragmentResult{}, errors.New("terminal icon: LOCALAPPDATA or USERPROFILE is required")
	}
	payload, err := json.MarshalIndent(fragment, "", "  ")
	if err != nil {
		return WindowsFragmentResult{}, err
	}
	if err := writeFileAtomic(target, append(payload, '\n'), 0o644); err != nil {
		return WindowsFragmentResult{}, err
	}
	settings := syncWindowsTerminalSettings(items, layout, paths)
	return WindowsFragmentResult{Path: target, Fragment: fragment, Settings: settings}, nil
}

func syncWindowsTerminalSettings(
	items []Provider,
	layout Layout,
	iconPaths map[string]string,
) WindowsSettingsResult {
	settingsPath := WindowsTerminalSettingsPath(layout)
	if settingsPath == "" {
		return WindowsSettingsResult{Skipped: "missing-path"}
	}
	raw, err := os.ReadFile(settingsPath)
	if err != nil {
		return WindowsSettingsResult{Path: settingsPath, Skipped: "missing-file"}
	}
	var document map[string]any
	if err := json.Unmarshal(raw, &document); err != nil {
		return WindowsSettingsResult{Path: settingsPath, Skipped: "parse-error"}
	}
	profiles, ok := document["profiles"].(map[string]any)
	if !ok {
		return WindowsSettingsResult{Path: settingsPath, Skipped: "missing-profile-list"}
	}
	list, ok := profiles["list"].([]any)
	if !ok {
		return WindowsSettingsResult{Path: settingsPath, Skipped: "missing-profile-list"}
	}
	desired := make(map[string]WindowsTerminalProfile, len(items))
	for _, provider := range items {
		profile, buildErr := buildWindowsProfile(provider, layout.AIHCommand, iconPaths)
		if buildErr != nil {
			return WindowsSettingsResult{Path: settingsPath, Skipped: "build-error"}
		}
		desired[normalizeGUID(profile.GUID)] = profile
	}
	changed := false
	updated := make([]string, 0)
	for _, entry := range list {
		record, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		guid, _ := record["guid"].(string)
		profile, found := desired[normalizeGUID(guid)]
		if !found {
			continue
		}
		entryChanged := false
		for key, value := range map[string]string{
			"commandline":       profile.Commandline,
			"icon":              profile.Icon,
			"startingDirectory": profile.StartingDirectory,
		} {
			if record[key] != value {
				record[key] = value
				changed = true
				entryChanged = true
			}
		}
		if entryChanged {
			updated = append(updated, profile.Name)
		}
	}
	if changed {
		encoded, err := json.MarshalIndent(document, "", "    ")
		if err == nil {
			_ = writeFileAtomic(settingsPath, append(encoded, '\n'), 0o644)
		}
	}
	return WindowsSettingsResult{Path: settingsPath, Changed: changed, Profiles: updated}
}

// buildWindowsProfile 生成单个 profile（settings 同步与 fragment 共用）。
func buildWindowsProfile(provider Provider, aihCommand string, iconPaths map[string]string) (WindowsTerminalProfile, error) {
	fragment, err := BuildWindowsTerminalFragment([]Provider{provider}, aihCommand, "", IconPathFunc(iconPaths))
	if err != nil || len(fragment.Profiles) != 1 {
		return WindowsTerminalProfile{}, err
	}
	return fragment.Profiles[0], nil
}

// normalizeGUID 去掉花括号并小写。
func normalizeGUID(value string) string {
	return strings.ToLower(strings.NewReplacer("{", "", "}", "").Replace(strings.TrimSpace(value)))
}

// WarpSettingsPath 解析 Warp settings.toml。
func WarpSettingsPath(layout Layout) string {
	platform := strings.TrimSpace(layout.Platform)
	if platform == "" {
		platform = runtime.GOOS
	}
	switch platform {
	case "win32", "windows":
		local := WindowsLocalAppData(layout)
		if local == "" {
			return ""
		}
		return filepath.Join(local, "warp", "Warp", "config", "settings.toml")
	case "linux":
		if explicit := strings.TrimSpace(layout.Env["XDG_CONFIG_HOME"]); explicit != "" {
			return filepath.Join(explicit, "warp-terminal", "settings.toml")
		}
		if home := strings.TrimSpace(layout.HostHomeDir); home != "" {
			return filepath.Join(home, ".config", "warp-terminal", "settings.toml")
		}
		return ""
	default:
		if home := strings.TrimSpace(layout.HostHomeDir); home != "" {
			return filepath.Join(home, ".warp", "settings.toml")
		}
		return ""
	}
}

// WriteWarpSettings 把 agent 命令映射写进 settings.toml。
func WriteWarpSettings(items []Provider, layout Layout) (string, []WarpEntry, bool, error) {
	entries := BuildWarpEntries(items, layout.AIHCommand)
	if len(entries) == 0 {
		return "", nil, false, errors.New("terminal icon: no Warp-supported providers selected")
	}
	target := WarpSettingsPath(layout)
	if target == "" {
		return "", nil, false, errors.New("terminal icon: HOME is required for Warp settings")
	}
	current := ""
	if raw, err := os.ReadFile(target); err == nil {
		current = string(raw)
	}
	next := UpdateWarpSettingsContent(current, entries)
	changed := next != current
	if changed {
		if err := writeFileAtomic(target, []byte(next), 0o600); err != nil {
			return target, entries, false, err
		}
	}
	return target, entries, changed, nil
}

// writeFileAtomic 先写临时文件再 rename，避免半截文件。
func writeFileAtomic(path string, data []byte, mode fs.FileMode) error {
	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(directory, ".terminal-icon-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(mode); err != nil {
		_ = temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryPath, path)
}

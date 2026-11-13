package webuitoolsettingsapi

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/madou1217/ai_home/core/providers"
)

// 宿主权限写入声明：只有「字段位置已被真机/官方 schema 验证」的 Provider 才登记。
// 未登记 = WebUI 明确显示不可写入宿主，绝不猜测字段名（与 Node HOST_PERMISSION_PROFILES 同源）。
//
// 这里只负责「目标文件在哪、能不能写」，真正的写入仍在 Node（PUT applyToHost）。
var hostPermissionProfiles = map[string]hostProfile{
	"claude": {
		FileID:   "settings",
		Format:   "json",
		Location: hostLocation{Kind: "provider-root", Parts: []string{"settings.json"}},
		Patch:    map[string]string{"permissions.defaultMode": "bypassPermissions"},
	},
	"codex": {
		FileID:   "config",
		Format:   "toml",
		Location: hostLocation{Kind: "provider-root", Parts: []string{"config.toml"}},
		Patch:    map[string]string{"approval_policy": "never", "sandbox_mode": "danger-full-access"},
	},
	"opencode": {
		FileID:   "config",
		Format:   "json",
		Location: hostLocation{Kind: "provider-root", Parts: []string{"opencode.json"}},
		Alternatives: []hostLocation{
			{Kind: "provider-root", Parts: []string{"opencode.jsonc"}},
		},
		Patch: map[string]string{"permission": "allow"},
	},
	"agy": {
		FileID:   "settings",
		Format:   "json",
		Location: hostLocation{Kind: "home", Parts: []string{".gemini", "antigravity-cli", "settings.json"}},
		Patch:    map[string]string{"toolPermission": "always-proceed"},
	},
}

type hostLocation struct {
	Kind  string
	Parts []string
}

type hostProfile struct {
	FileID       string
	Format       string
	Location     hostLocation
	Alternatives []hostLocation
	// Patch 是「写入最大权限」时要设置的字段；只有验证过 schema 的 provider 才登记。
	Patch map[string]string
}

type hostTarget struct {
	FileID            string
	AbsolutePath      string
	DisplayPath       string
	Format            string
	Patch             map[string]string
	Exists            bool
	Writable          bool
	RequiresElevation bool
}

// HostWriteTarget 是宿主配置文件写入所需的事实（路径 + 格式 + 字段补丁）。
type HostWriteTarget struct {
	Provider          string
	FileID            string
	AbsolutePath      string
	DisplayPath       string
	Format            string
	Patch             map[string]string
	Exists            bool
	Writable          bool
	RequiresElevation bool
}

// ResolveHostWriteTarget 返回某个 Provider 的宿主权限写入目标；未登记返回 known=false。
func ResolveHostWriteTarget(
	definition providers.Definition,
	home string,
	lookupEnv func(string) string,
) (HostWriteTarget, bool, error) {
	profile, known := hostPermissionProfiles[definition.ID]
	if !known {
		return HostWriteTarget{}, false, nil
	}
	target, err := describeHostTarget(definition, profile, home, lookupEnv)
	if err != nil {
		return HostWriteTarget{}, true, err
	}
	return HostWriteTarget{
		Provider:          definition.ID,
		FileID:            target.FileID,
		AbsolutePath:      target.AbsolutePath,
		DisplayPath:       target.DisplayPath,
		Format:            target.Format,
		Patch:             target.Patch,
		Exists:            target.Exists,
		Writable:          target.Writable,
		RequiresElevation: target.RequiresElevation,
	}, true, nil
}

// maxHostConfigBytes 与 Node provider-config-manager 的 2MB 编辑上限一致：
// 超过上限的文件 Node 会拒绝读取，capability 也就不能声称可写。
const maxHostConfigBytes = 2 * 1024 * 1024

var errHostHomeUnavailable = errors.New("host_home_unavailable")

// hostTargetError 携带 Node 错误映射里的领域码（provider_config_too_large /
// provider_config_read_failed），让 hostReason 与旧实现同名。
type hostTargetError struct{ code string }

func (err hostTargetError) Error() string { return err.code }

// describeHostTarget 复刻 Node describeHostPermissionTarget + provider-config-manager 的探测：
// 候选路径先选第一个存在的文件，没有则用第一个候选路径，再判断可写性。
func describeHostTarget(
	definition providers.Definition,
	profile hostProfile,
	home string,
	lookupEnv func(string) string,
) (hostTarget, error) {
	if strings.TrimSpace(home) == "" {
		return hostTarget{}, errHostHomeUnavailable
	}
	candidates := make([]string, 0, 1+len(profile.Alternatives))
	candidates = append(candidates, resolveHostLocation(profile.Location, definition, home, lookupEnv))
	for _, alternative := range profile.Alternatives {
		candidates = append(candidates, resolveHostLocation(alternative, definition, home, lookupEnv))
	}
	absolute := candidates[0]
	exists := false
	for _, candidate := range candidates {
		if candidate == "" {
			continue
		}
		if _, err := os.Stat(candidate); err == nil {
			absolute = candidate
			exists = true
			break
		}
	}
	if absolute == "" {
		return hostTarget{}, hostTargetError{code: "host_config_unavailable"}
	}
	if exists {
		info, statErr := os.Stat(absolute)
		if statErr != nil {
			return hostTarget{}, hostTargetError{code: "provider_config_read_failed"}
		}
		if info.Size() > maxHostConfigBytes {
			return hostTarget{}, hostTargetError{code: "provider_config_too_large"}
		}
		file, openErr := os.Open(absolute)
		if openErr != nil {
			return hostTarget{}, hostTargetError{code: "provider_config_read_failed"}
		}
		_ = file.Close()
	}
	writable := writableTarget(absolute)
	return hostTarget{
		FileID:            profile.FileID,
		AbsolutePath:      absolute,
		DisplayPath:       displayHostPath(absolute, home),
		Format:            profile.Format,
		Patch:             profile.Patch,
		Exists:            exists,
		Writable:          writable,
		RequiresElevation: !writable,
	}, nil
}

func resolveHostLocation(
	location hostLocation,
	definition providers.Definition,
	home string,
	lookupEnv func(string) string,
) string {
	switch location.Kind {
	case "home":
		return filepath.Join(append([]string{home}, location.Parts...)...)
	default:
		// 未声明的 kind 与 provider-root 同义（Node resolveLocation 的 default 分支）。
		return filepath.Join(append([]string{providerConfigRoot(definition, home, lookupEnv)}, location.Parts...)...)
	}
}

// providerConfigRoot 是「宿主全局配置根目录」：与合同里的 cli.globalDir / configSubDir 同源。
// 唯一把 .config 映射到 XDG/APPDATA 的逻辑就在这里，调用方不要重复推导。
func providerConfigRoot(definition providers.Definition, home string, lookupEnv func(string) string) string {
	raw := "." + definition.ID
	if definition.CLI != nil && strings.TrimSpace(definition.CLI.GlobalDir) != "" {
		raw = definition.CLI.GlobalDir
	}
	parts := splitPathParts(raw)
	if len(parts) == 0 {
		return home
	}
	var root string
	if parts[0] == ".config" {
		root = filepath.Join(append([]string{configHome(lookupEnv, home)}, parts[1:]...)...)
	} else {
		root = filepath.Join(append([]string{home}, parts...)...)
	}
	if definition.CLI != nil && definition.CLI.ConfigSubDir != "" {
		root = filepath.Join(append([]string{root}, splitPathParts(definition.CLI.ConfigSubDir)...)...)
	}
	return root
}

func configHome(lookupEnv func(string) string, home string) string {
	if value := strings.TrimSpace(lookupEnv("XDG_CONFIG_HOME")); value != "" {
		return value
	}
	if runtime.GOOS == "windows" {
		if value := strings.TrimSpace(lookupEnv("APPDATA")); value != "" {
			return value
		}
		return filepath.Join(home, "AppData", "Roaming")
	}
	return filepath.Join(home, ".config")
}

func splitPathParts(value string) []string {
	normalized := strings.NewReplacer("\\", "/").Replace(strings.TrimSpace(value))
	normalized = strings.Trim(normalized, "/")
	if normalized == "" {
		return nil
	}
	parts := make([]string, 0, 4)
	for _, part := range strings.Split(normalized, "/") {
		if part != "" {
			parts = append(parts, part)
		}
	}
	return parts
}

// displayHostPath 只给波浪号展示路径，不把宿主绝对家目录泄漏给 WebUI。
func displayHostPath(absolute string, home string) string {
	cleanHome := strings.TrimSpace(home)
	if cleanHome == "" || absolute == "" {
		return absolute
	}
	if absolute == cleanHome {
		return "~"
	}
	prefix := cleanHome + string(filepath.Separator)
	if strings.HasPrefix(absolute, prefix) {
		return "~" + absolute[len(cleanHome):]
	}
	return absolute
}

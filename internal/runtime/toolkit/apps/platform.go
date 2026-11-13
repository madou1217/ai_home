package apps

import (
	"os"
	"os/user"
	"path"
	"path/filepath"
	"runtime"
	"strings"
)

const (
	platformMacOS   = "macos"
	platformWindows = "windows"
	platformLinux   = "linux"
)

// NormalizePlatform 把 OS 名称统一为 macos / windows / linux。
func NormalizePlatform(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "macos", "darwin", "mac":
		return platformMacOS
	case "windows", "win32", "win":
		return platformWindows
	case "linux":
		return platformLinux
	case "":
		return NormalizePlatform(runtime.GOOS)
	default:
		return strings.ToLower(strings.TrimSpace(value))
	}
}

func resolvePlatform(opts Options) string {
	return NormalizePlatform(opts.Platform)
}

func resolveArch(opts Options) string {
	raw := strings.ToLower(strings.TrimSpace(opts.Arch))
	if raw == "" {
		raw = strings.ToLower(strings.TrimSpace(runtime.GOARCH))
		if raw == "amd64" {
			raw = "x64"
		}
	}
	if raw == "amd64" || raw == "x86_64" {
		return "x64"
	}
	if raw == "aarch64" {
		return "arm64"
	}
	return raw
}

func isArchSupported(opts Options, allowed ...string) bool {
	arch := resolveArch(opts)
	for _, candidate := range allowed {
		if arch == strings.ToLower(strings.TrimSpace(candidate)) {
			return true
		}
	}
	return false
}

func resolveEnvMap(opts Options) map[string]string {
	merged := make(map[string]string)
	for _, kv := range os.Environ() {
		idx := strings.IndexByte(kv, '=')
		if idx <= 0 {
			continue
		}
		merged[kv[:idx]] = kv[idx+1:]
	}
	for k, v := range opts.Env {
		merged[k] = v
	}
	return merged
}

func envLookup(env map[string]string, keys ...string) string {
	for _, k := range keys {
		if v, ok := env[k]; ok && strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
		for ek, ev := range env {
			if strings.EqualFold(ek, k) && strings.TrimSpace(ev) != "" {
				return strings.TrimSpace(ev)
			}
		}
	}
	return ""
}

// ResolveHostHome 解析宿主 HOME，尊重显式 HostHomeDir 与 AIH_HOST_HOME。
func ResolveHostHome(opts Options) string {
	if explicit := strings.TrimSpace(opts.HostHomeDir); explicit != "" {
		return stripNestedCodexHome(explicit)
	}
	env := resolveEnvMap(opts)
	if explicit := envLookup(env, "AIH_HOST_HOME"); explicit != "" {
		return stripNestedCodexHome(explicit)
	}
	if resolvePlatform(opts) == platformWindows {
		if up := envLookup(env, "USERPROFILE"); up != "" {
			return stripNestedCodexHome(up)
		}
		drive := envLookup(env, "HOMEDRIVE")
		homePath := envLookup(env, "HOMEPATH")
		if drive != "" && homePath != "" {
			return stripNestedCodexHome(joinPlatformPath(platformWindows, drive, homePath))
		}
	}
	if h := envLookup(env, "HOME"); h != "" {
		return stripNestedCodexHome(h)
	}
	if u, err := user.Current(); err == nil && strings.TrimSpace(u.HomeDir) != "" {
		return stripNestedCodexHome(strings.TrimSpace(u.HomeDir))
	}
	if h, err := os.UserHomeDir(); err == nil {
		return stripNestedCodexHome(strings.TrimSpace(h))
	}
	return ""
}

func stripNestedCodexHome(home string) string {
	trimmed := strings.TrimSpace(home)
	normalized := strings.TrimRight(strings.ReplaceAll(trimmed, "\\", "/"), "/")
	if strings.HasSuffix(strings.ToLower(normalized), "/.codex") {
		root := normalized[:len(normalized)-len("/.codex")]
		if root != "" {
			if strings.Contains(trimmed, "\\") {
				return strings.ReplaceAll(root, "/", "\\")
			}
			return root
		}
	}
	return trimmed
}

func joinPlatformPath(platform string, parts ...string) string {
	cleanParts := make([]string, 0, len(parts))
	for _, p := range parts {
		trimmed := strings.TrimSpace(p)
		if trimmed != "" {
			cleanParts = append(cleanParts, trimmed)
		}
	}
	if len(cleanParts) == 0 {
		return ""
	}
	if NormalizePlatform(platform) == platformWindows {
		joined := strings.ReplaceAll(cleanParts[0], "/", "\\")
		for _, part := range cleanParts[1:] {
			p := strings.TrimLeft(strings.ReplaceAll(part, "/", "\\"), "\\")
			if strings.HasSuffix(joined, "\\") {
				joined += p
			} else {
				joined += "\\" + p
			}
		}
		return joined
	}
	return path.Clean(strings.Join(cleanParts, "/"))
}

func basePlatformPath(platform string, target string) string {
	normalized := strings.ReplaceAll(strings.TrimSpace(target), "\\", "/")
	normalized = strings.TrimRight(normalized, "/")
	if normalized == "" {
		return ""
	}
	_ = platform
	return path.Base(normalized)
}

func dirPlatformPath(platform string, target string) string {
	if NormalizePlatform(platform) == platformWindows {
		normalized := strings.ReplaceAll(strings.TrimSpace(target), "/", "\\")
		idx := strings.LastIndex(normalized, "\\")
		if idx <= 0 {
			return ""
		}
		return normalized[:idx]
	}
	return filepath.Dir(target)
}

func fileExists(target string) bool {
	if strings.TrimSpace(target) == "" {
		return false
	}
	info, err := os.Stat(target)
	return err == nil && !info.IsDir()
}

func dirExists(target string) bool {
	if strings.TrimSpace(target) == "" {
		return false
	}
	info, err := os.Stat(target)
	return err == nil && info.IsDir()
}

func pathExists(target string) bool {
	if strings.TrimSpace(target) == "" {
		return false
	}
	_, err := os.Stat(target)
	return err == nil
}

func uniqueStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, item := range values {
		trimmed := strings.TrimSpace(item)
		if trimmed == "" {
			continue
		}
		if _, ok := seen[trimmed]; ok {
			continue
		}
		seen[trimmed] = struct{}{}
		out = append(out, trimmed)
	}
	return out
}

//go:build windows

package apps

import (
	"context"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/core/providers"
	"golang.org/x/sys/windows/registry"
)

// findWindowsRegisteredDesktopClientNative detects an installed Windows desktop
// client by reading the uninstall registry hive directly.
//
// The registry probes intentionally avoid a child powershell.exe: under the
// desktop helper's scheduled-task context a child PowerShell can stall, which
// silently made installed apps look absent (and blocked uninstall flows).
func findWindowsRegisteredDesktopClientNative(_ context.Context, provider string, cfg *providers.DesktopPlatform, _ Options) *DesktopRecord {
	if cfg == nil || len(cfg.DisplayNames) == 0 {
		return nil
	}
	wanted := make([]string, 0, len(cfg.DisplayNames))
	for _, name := range cfg.DisplayNames {
		if trimmed := strings.TrimSpace(name); trimmed != "" {
			wanted = append(wanted, trimmed)
		}
	}
	if len(wanted) == 0 {
		return nil
	}
	matches := func(displayName string) bool {
		candidate := strings.ToLower(strings.TrimSpace(displayName))
		if candidate == "" {
			return false
		}
		for _, name := range wanted {
			lower := strings.ToLower(name)
			if candidate == lower || strings.Contains(candidate, lower) {
				return true
			}
		}
		return false
	}

	entries := make([]RegistryUninstallEntry, 0, 64)
	for _, spec := range []struct {
		root  registry.Key
		scope RegistryScope
		path  string
	}{
		{registry.CURRENT_USER, RegistryScopeHKCU, RegPathUninstall},
		{registry.LOCAL_MACHINE, RegistryScopeHKLM, RegPathUninstall},
		{registry.LOCAL_MACHINE, RegistryScopeHKLM, RegPathUninstallWOW64},
	} {
		found, _ := readUninstallSubKeys(spec.root, spec.scope, spec.path)
		entries = append(entries, found...)
	}

	for _, entry := range entries {
		if !matches(entry.DisplayName) {
			continue
		}
		iconPath := strings.Trim(strings.Split(entry.DisplayIcon, ",")[0], `" `)
		installDirs := make([]string, 0, 2)
		if dir := strings.TrimSpace(entry.InstallLocation); dir != "" {
			installDirs = append(installDirs, dir)
		}
		if iconPath != "" && !strings.HasSuffix(strings.ToLower(iconPath), ".exe") {
			if dir := filepath.Dir(iconPath); dir != "" && dir != "." && dir != iconPath {
				installDirs = append(installDirs, dir)
			}
		}
		version := strings.TrimSpace(entry.DisplayVersion)
		for _, dir := range uniqueStrings(installDirs) {
			for _, execName := range cfg.ExecNames {
				candidate := joinPlatformPath(platformWindows, dir, execName)
				if fileExists(candidate) {
					return &DesktopRecord{
						Provider:       provider,
						ClientName:     nonEmpty(cfg.ClientName, provider),
						ExecutablePath: candidate,
						DisplayPath:    candidate,
						Version:        version,
					}
				}
			}
		}
		if iconPath != "" && fileExists(iconPath) && strings.HasSuffix(strings.ToLower(iconPath), ".exe") {
			return &DesktopRecord{
				Provider:       provider,
				ClientName:     nonEmpty(cfg.ClientName, provider),
				ExecutablePath: iconPath,
				DisplayPath:    iconPath,
				Version:        version,
			}
		}
	}
	return nil
}

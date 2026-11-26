//go:build windows

package apps

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/sys/windows/registry"
)

const maxRegistryDeleteDepth = 16

// CleanupProviderResidue scans Windows shortcuts (Start Menu\Programs and
// Desktop) and allowlisted registry locations (HKCU Uninstall / App Paths /
// Run / RunOnce; HKLM read-only probe) and removes leftover residue belonging
// to the specified provider (or all known providers when provider is empty).
//
// In manual/diagnostic mode, live installed providers and registry entries
// whose target executables still exist on disk are preserved.
func CleanupProviderResidue(ctx context.Context, provider string, opts Options) ResidueCleanupResult {
	return runWindowsResidueCleanup(ctx, provider, "", opts, true, nil, false)
}

func cleanupProviderResidueAfterUninstall(
	ctx context.Context,
	provider string,
	kind string,
	opts Options,
	preUninstallPaths []string,
) ResidueCleanupResult {
	return runWindowsResidueCleanup(ctx, provider, kind, opts, false, preUninstallPaths, true)
}

func runWindowsResidueCleanup(
	ctx context.Context,
	provider string,
	kind string,
	opts Options,
	excludeLive bool,
	preUninstallPaths []string,
	allowUnknownProvider bool,
) ResidueCleanupResult {
	norm := normalizeResidueProvider(provider)
	shortcutCriteria, ok := resolveProviderResidueCriteria(norm, kind, opts, excludeLive, false, preUninstallPaths)
	if !ok {
		if allowUnknownProvider {
			return emptyResidueCleanupResult(norm)
		}
		res := emptyResidueCleanupResult(norm)
		res.OK = false
		res.Error = "unknown_provider"
		res.Message = fmt.Sprintf("未知 Provider: %s", provider)
		return res
	}

	registryCriteria := shortcutCriteria
	if excludeLive {
		registryCriteria, _ = resolveProviderResidueCriteria(norm, kind, opts, true, true, preUninstallPaths)
	}

	var warnings []string

	removedShortcuts, removedDirs, keptBroken, scWarnings := cleanupWindowsShortcuts(ctx, shortcutCriteria)
	warnings = append(warnings, scWarnings...)

	removedRegistry := []string{}
	if len(registryCriteria) > 0 {
		candidates, enumWarnings := enumerateWindowsRegistryCandidates()
		warnings = append(warnings, enumWarnings...)
		if excludeLive {
			candidates = filterLiveRegistryCandidates(candidates)
		}
		matched := MatchRegistryResidue(candidates, registryCriteria)
		regRemoved, regWarnings := applyWindowsRegistryCleanup(matched)
		removedRegistry = regRemoved
		warnings = append(warnings, regWarnings...)
	}

	return ResidueCleanupResult{
		OK:               true,
		Provider:         norm,
		RemovedShortcuts: removedShortcuts,
		RemovedRegistry:  removedRegistry,
		RemovedDirs:      removedDirs,
		KeptBroken:       keptBroken,
		Warnings:         warnings,
	}
}

func enumerateWindowsRegistryCandidates() (RegistryCandidates, []string) {
	var candidates RegistryCandidates
	var warnings []string

	// HKCU (writable targets)
	hkcuUninstall, w := readUninstallSubKeys(registry.CURRENT_USER, RegistryScopeHKCU, RegPathUninstall)
	candidates.Uninstall = append(candidates.Uninstall, hkcuUninstall...)
	warnings = append(warnings, w...)

	hkcuAppPaths, w := readAppPathsSubKeys(registry.CURRENT_USER, RegistryScopeHKCU, RegPathAppPaths)
	candidates.AppPaths = append(candidates.AppPaths, hkcuAppPaths...)
	warnings = append(warnings, w...)

	hkcuRun, w := readRunValues(registry.CURRENT_USER, RegistryScopeHKCU, RegPathRun)
	candidates.Run = append(candidates.Run, hkcuRun...)
	warnings = append(warnings, w...)

	hkcuRunOnce, w := readRunValues(registry.CURRENT_USER, RegistryScopeHKCU, RegPathRunOnce)
	candidates.Run = append(candidates.Run, hkcuRunOnce...)
	warnings = append(warnings, w...)

	// HKLM (strictly read-only probe; never opened for write or elevated)
	hklmUninstall, _ := readUninstallSubKeys(registry.LOCAL_MACHINE, RegistryScopeHKLM, RegPathUninstall)
	candidates.Uninstall = append(candidates.Uninstall, hklmUninstall...)

	hklmUninstallWOW, _ := readUninstallSubKeys(registry.LOCAL_MACHINE, RegistryScopeHKLM, RegPathUninstallWOW64)
	candidates.Uninstall = append(candidates.Uninstall, hklmUninstallWOW...)

	hklmAppPaths, _ := readAppPathsSubKeys(registry.LOCAL_MACHINE, RegistryScopeHKLM, RegPathAppPaths)
	candidates.AppPaths = append(candidates.AppPaths, hklmAppPaths...)

	hklmRun, _ := readRunValues(registry.LOCAL_MACHINE, RegistryScopeHKLM, RegPathRun)
	candidates.Run = append(candidates.Run, hklmRun...)

	hklmRunOnce, _ := readRunValues(registry.LOCAL_MACHINE, RegistryScopeHKLM, RegPathRunOnce)
	candidates.Run = append(candidates.Run, hklmRunOnce...)

	return candidates, warnings
}

func readUninstallSubKeys(root registry.Key, scope RegistryScope, parentPath string) ([]RegistryUninstallEntry, []string) {
	parent, err := registry.OpenKey(root, parentPath, registry.READ)
	if err != nil {
		if errors.Is(err, registry.ErrNotExist) {
			return nil, nil
		}
		if scope == RegistryScopeHKCU {
			return nil, []string{fmt.Sprintf("读取注册表 %s\\%s 失败: %v", scope, parentPath, err)}
		}
		return nil, nil
	}
	defer parent.Close()

	subKeys, err := parent.ReadSubKeyNames(0)
	if err != nil {
		if scope == RegistryScopeHKCU {
			return nil, []string{fmt.Sprintf("枚举注册表子键 %s\\%s 失败: %v", scope, parentPath, err)}
		}
		return nil, nil
	}

	entries := make([]RegistryUninstallEntry, 0, len(subKeys))
	for _, subKey := range subKeys {
		if !isValidRegistrySubKeyName(subKey) {
			continue
		}
		child, openErr := registry.OpenKey(parent, subKey, registry.QUERY_VALUE)
		if openErr != nil {
			continue
		}
		entry := RegistryUninstallEntry{
			Scope:                scope,
			ParentPath:           parentPath,
			SubKey:               subKey,
			DisplayName:          readRegistryStringValue(child, "DisplayName", false),
			InstallLocation:      readRegistryStringValue(child, "InstallLocation", true),
			DisplayIcon:          readRegistryStringValue(child, "DisplayIcon", true),
			UninstallString:      readRegistryStringValue(child, "UninstallString", true),
			QuietUninstallString: readRegistryStringValue(child, "QuietUninstallString", true),
			DisplayVersion:       readRegistryStringValue(child, "DisplayVersion", true),
		}
		_ = child.Close()
		entries = append(entries, entry)
	}
	return entries, nil
}

func readAppPathsSubKeys(root registry.Key, scope RegistryScope, parentPath string) ([]RegistryAppPathEntry, []string) {
	parent, err := registry.OpenKey(root, parentPath, registry.READ)
	if err != nil {
		if errors.Is(err, registry.ErrNotExist) {
			return nil, nil
		}
		if scope == RegistryScopeHKCU {
			return nil, []string{fmt.Sprintf("读取注册表 %s\\%s 失败: %v", scope, parentPath, err)}
		}
		return nil, nil
	}
	defer parent.Close()

	subKeys, err := parent.ReadSubKeyNames(0)
	if err != nil {
		if scope == RegistryScopeHKCU {
			return nil, []string{fmt.Sprintf("枚举注册表子键 %s\\%s 失败: %v", scope, parentPath, err)}
		}
		return nil, nil
	}

	entries := make([]RegistryAppPathEntry, 0, len(subKeys))
	for _, subKey := range subKeys {
		if !isValidRegistrySubKeyName(subKey) {
			continue
		}
		child, openErr := registry.OpenKey(parent, subKey, registry.QUERY_VALUE)
		if openErr != nil {
			continue
		}
		entry := RegistryAppPathEntry{
			Scope:       scope,
			ParentPath:  parentPath,
			ExeName:     subKey,
			DefaultPath: readRegistryStringValue(child, "", true),
			Path:        readRegistryStringValue(child, "Path", true),
		}
		_ = child.Close()
		entries = append(entries, entry)
	}
	return entries, nil
}

func readRunValues(root registry.Key, scope RegistryScope, keyPath string) ([]RegistryRunEntry, []string) {
	k, err := registry.OpenKey(root, keyPath, registry.READ)
	if err != nil {
		if errors.Is(err, registry.ErrNotExist) {
			return nil, nil
		}
		if scope == RegistryScopeHKCU {
			return nil, []string{fmt.Sprintf("读取注册表 %s\\%s 失败: %v", scope, keyPath, err)}
		}
		return nil, nil
	}
	defer k.Close()

	names, err := k.ReadValueNames(0)
	if err != nil {
		if scope == RegistryScopeHKCU {
			return nil, []string{fmt.Sprintf("枚举注册表值 %s\\%s 失败: %v", scope, keyPath, err)}
		}
		return nil, nil
	}

	entries := make([]RegistryRunEntry, 0, len(names))
	for _, name := range names {
		if strings.TrimSpace(name) == "" {
			continue
		}
		entries = append(entries, RegistryRunEntry{
			Scope:     scope,
			KeyPath:   keyPath,
			ValueName: name,
			Command:   readRegistryStringValue(k, name, true),
		})
	}
	return entries, nil
}

func readRegistryStringValue(k registry.Key, name string, expandEnv bool) string {
	val, valType, err := k.GetStringValue(name)
	if err != nil {
		return ""
	}
	val = strings.TrimSpace(val)
	if val == "" {
		return ""
	}
	if expandEnv && (valType == registry.EXPAND_SZ || strings.Contains(val, "%")) {
		if expanded, expErr := registry.ExpandString(val); expErr == nil && strings.TrimSpace(expanded) != "" {
			return strings.TrimSpace(expanded)
		}
	}
	return val
}

func filterLiveRegistryCandidates(in RegistryCandidates) RegistryCandidates {
	var out RegistryCandidates
	for _, entry := range in.Uninstall {
		if isUninstallEntryLiveOnDisk(entry) {
			continue
		}
		out.Uninstall = append(out.Uninstall, entry)
	}
	for _, entry := range in.AppPaths {
		if isAppPathEntryLiveOnDisk(entry) {
			continue
		}
		out.AppPaths = append(out.AppPaths, entry)
	}
	for _, entry := range in.Run {
		if isRunEntryLiveOnDisk(entry) {
			continue
		}
		out.Run = append(out.Run, entry)
	}
	return out
}

func applyWindowsRegistryCleanup(matched RegistryMatchResult) ([]string, []string) {
	removed := []string{}
	var warnings []string

	for _, entry := range matched.RemoveUninstall {
		deleted, err := deleteHKCUKeyRecursive(entry.ParentPath, entry.SubKey)
		if err != nil {
			warnings = append(warnings, fmt.Sprintf("删除注册表项失败 %s: %v", entry.FullPath(), err))
			continue
		}
		if deleted {
			removed = append(removed, entry.FullPath())
		}
	}

	for _, entry := range matched.RemoveAppPaths {
		deleted, err := deleteHKCUKeyRecursive(entry.ParentPath, entry.ExeName)
		if err != nil {
			warnings = append(warnings, fmt.Sprintf("删除注册表项失败 %s: %v", entry.FullPath(), err))
			continue
		}
		if deleted {
			removed = append(removed, entry.FullPath())
		}
	}

	for _, entry := range matched.RemoveRun {
		deleted, err := deleteHKCURunValue(entry.KeyPath, entry.ValueName)
		if err != nil {
			warnings = append(warnings, fmt.Sprintf("删除注册表启动项失败 %s: %v", entry.FullPath(), err))
			continue
		}
		if deleted {
			removed = append(removed, entry.FullPath())
		}
	}

	for _, hklmPath := range matched.AdminSkipped {
		warnings = append(warnings, formatHKLMRegistrySkippedWarning(hklmPath))
	}

	sortPathsCaseInsensitive(removed)
	return removed, warnings
}

func isUninstallEntryLiveOnDisk(entry RegistryUninstallEntry) bool {
	if icon := extractRegistryIconPath(entry.DisplayIcon); icon != "" && hasExecutableFileExt(icon) && fileExists(icon) {
		return true
	}
	return false
}

func isAppPathEntryLiveOnDisk(entry RegistryAppPathEntry) bool {
	target := extractWindowsCommandPath(entry.DefaultPath)
	if target == "" {
		target = cleanRegistryDirPath(entry.DefaultPath)
	}
	return target != "" && fileExists(target)
}

func isRunEntryLiveOnDisk(entry RegistryRunEntry) bool {
	target := extractWindowsCommandPath(entry.Command)
	return target != "" && fileExists(target)
}

func deleteHKCUKeyRecursive(parentPath, subKey string) (bool, error) {
	if !isAllowedHKCUKeyParent(parentPath) || !isValidRegistrySubKeyName(subKey) {
		return false, fmt.Errorf("disallowed registry target: %s\\%s", parentPath, subKey)
	}
	targetPath := parentPath + `\` + subKey
	return deleteHKCUSubTree(targetPath, maxRegistryDeleteDepth)
}

func deleteHKCUSubTree(path string, remainingDepth int) (bool, error) {
	if remainingDepth < 0 {
		return false, fmt.Errorf("registry nesting depth exceeded for %s", path)
	}
	k, err := registry.OpenKey(registry.CURRENT_USER, path, registry.ENUMERATE_SUB_KEYS|registry.QUERY_VALUE)
	if err != nil {
		if errors.Is(err, registry.ErrNotExist) {
			return false, nil
		}
		return false, err
	}
	children, readErr := k.ReadSubKeyNames(0)
	_ = k.Close()
	if readErr != nil {
		return false, readErr
	}
	for _, child := range children {
		if !isValidRegistrySubKeyName(child) {
			continue
		}
		if _, err := deleteHKCUSubTree(path+`\`+child, remainingDepth-1); err != nil {
			return false, err
		}
	}
	if err := registry.DeleteKey(registry.CURRENT_USER, path); err != nil {
		if errors.Is(err, registry.ErrNotExist) {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

func deleteHKCURunValue(keyPath, valueName string) (bool, error) {
	if !isAllowedHKCURunPath(keyPath) || strings.TrimSpace(valueName) == "" {
		return false, fmt.Errorf("disallowed registry value target: %s::%s", keyPath, valueName)
	}
	k, err := registry.OpenKey(registry.CURRENT_USER, keyPath, registry.SET_VALUE)
	if err != nil {
		if errors.Is(err, registry.ErrNotExist) {
			return false, nil
		}
		return false, err
	}
	defer k.Close()
	if err := k.DeleteValue(valueName); err != nil {
		if errors.Is(err, registry.ErrNotExist) {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

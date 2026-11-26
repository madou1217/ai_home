//go:build windows

package apps

import (
	"context"
	"fmt"

	"github.com/madou1217/ai_home/internal/runtime/winshell"
)

// CleanupShortcutResidue scans Windows Start Menu\Programs and Desktop
// shortcuts and removes leftover .lnk entries belonging to the specified
// provider (or all known providers when provider is empty).
func CleanupShortcutResidue(ctx context.Context, provider string, opts Options) ShortcutCleanupResult {
	return runWindowsShortcutCleanup(ctx, provider, opts, true)
}

func cleanupProviderShortcutsAfterUninstall(ctx context.Context, provider string, opts Options) ShortcutCleanupResult {
	return runWindowsShortcutCleanup(ctx, provider, opts, false)
}

func runWindowsShortcutCleanup(ctx context.Context, provider string, opts Options, excludeLiveRoots bool) ShortcutCleanupResult {
	norm := normalizeShortcutProvider(provider)
	criteria, ok := resolveShortcutResidueCriteria(norm, opts, excludeLiveRoots)
	if !ok {
		return ShortcutCleanupResult{
			OK:         false,
			Provider:   norm,
			Removed:    []string{},
			KeptBroken: []string{},
			Error:      "unknown_provider",
			Message:    fmt.Sprintf("未知 Provider: %s", provider),
		}
	}

	shortcuts, err := winshell.ListShortcuts(ctx)
	if err != nil {
		return ShortcutCleanupResult{
			OK:         false,
			Provider:   norm,
			Removed:    []string{},
			KeptBroken: []string{},
			Error:      "shortcut_enumeration_failed",
			Message:    err.Error(),
		}
	}

	matched := MatchShortcutResidue(shortcuts, criteria)
	removed, removedDirs, warnings := RemoveMatchedShortcuts(matched.Matched, winshell.StartMenuProgramsRoots())
	return ShortcutCleanupResult{
		OK:          true,
		Provider:    norm,
		Removed:     removed,
		RemovedDirs: removedDirs,
		KeptBroken:  shortcutLinkPaths(matched.KeptBroken),
		Warnings:    warnings,
	}
}

//go:build windows

package apps

import (
	"context"
	"fmt"

	"github.com/madou1217/ai_home/internal/runtime/winshell"
)

// CleanupShortcutResidue delegates to CleanupProviderResidue so existing
// callers receive the combined shortcut + registry residue cleanup behavior.
func CleanupShortcutResidue(ctx context.Context, provider string, opts Options) ResidueCleanupResult {
	return CleanupProviderResidue(ctx, provider, opts)
}

func cleanupWindowsShortcuts(ctx context.Context, criteria []ProviderResidueCriteria) (removed []string, removedDirs []string, keptBroken []string, warnings []string) {
	removed = []string{}
	keptBroken = []string{}
	if len(criteria) == 0 {
		return removed, nil, keptBroken, nil
	}
	shortcuts, err := winshell.ListShortcuts(ctx)
	if err != nil {
		return removed, nil, keptBroken, []string{fmt.Sprintf("枚举残留快捷方式失败: %v", err)}
	}
	matched := MatchShortcutResidue(shortcuts, criteria)
	removed, removedDirs, warnings = RemoveMatchedShortcuts(matched.Matched, winshell.StartMenuProgramsRoots())
	keptBroken = shortcutLinkPaths(matched.KeptBroken)
	return removed, removedDirs, keptBroken, warnings
}

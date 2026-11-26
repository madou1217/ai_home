//go:build !windows

package apps

import (
	"context"
	"fmt"
)

// CleanupShortcutResidue validates the provider parameter and returns an empty
// no-op result on non-Windows platforms.
func CleanupShortcutResidue(_ context.Context, provider string, opts Options) ShortcutCleanupResult {
	norm := normalizeShortcutProvider(provider)
	if norm != "" {
		if _, ok := resolveShortcutResidueCriteria(norm, opts, true); !ok {
			return ShortcutCleanupResult{
				OK:         false,
				Provider:   norm,
				Removed:    []string{},
				KeptBroken: []string{},
				Error:      "unknown_provider",
				Message:    fmt.Sprintf("未知 Provider: %s", provider),
			}
		}
	}
	return ShortcutCleanupResult{
		OK:         true,
		Provider:   norm,
		Removed:    []string{},
		KeptBroken: []string{},
	}
}

func cleanupProviderShortcutsAfterUninstall(_ context.Context, provider string, _ Options) ShortcutCleanupResult {
	return ShortcutCleanupResult{
		OK:         true,
		Provider:   normalizeShortcutProvider(provider),
		Removed:    []string{},
		KeptBroken: []string{},
	}
}

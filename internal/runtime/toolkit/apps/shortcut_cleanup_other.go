//go:build !windows

package apps

import "context"

// CleanupShortcutResidue delegates to CleanupProviderResidue on non-Windows
// platforms.
func CleanupShortcutResidue(ctx context.Context, provider string, opts Options) ResidueCleanupResult {
	return CleanupProviderResidue(ctx, provider, opts)
}

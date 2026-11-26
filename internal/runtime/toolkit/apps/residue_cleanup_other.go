//go:build !windows

package apps

import (
	"context"
	"fmt"
)

// CleanupProviderResidue validates the provider parameter and returns an empty
// no-op result on non-Windows platforms.
func CleanupProviderResidue(_ context.Context, provider string, opts Options) ResidueCleanupResult {
	norm := normalizeResidueProvider(provider)
	if norm != "" {
		if _, ok := resolveProviderResidueCriteria(norm, "", opts, true, true, nil); !ok {
			res := emptyResidueCleanupResult(norm)
			res.OK = false
			res.Error = "unknown_provider"
			res.Message = fmt.Sprintf("未知 Provider: %s", provider)
			return res
		}
	}
	return emptyResidueCleanupResult(norm)
}

func cleanupProviderResidueAfterUninstall(
	_ context.Context,
	provider string,
	_ string,
	_ Options,
	_ []string,
) ResidueCleanupResult {
	return emptyResidueCleanupResult(normalizeResidueProvider(provider))
}

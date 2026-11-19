package main

import (
	"context"
	"strings"
)

// runRootLS owns the account list command, including provider selectors,
// --scope and --json. Node has no JSON form; Go keeps it as a stable script
// interface and prints the same human table without --json.
func runRootLS(ctx context.Context, arguments []string, runtime commandRuntime) (bool, error) {
	if len(arguments) == 0 || (arguments[0] != "ls" && arguments[0] != "list") {
		return false, nil
	}
	parsed, err := parseLSArguments(arguments[1:])
	if err != nil {
		return true, err
	}
	if parsed.Help {
		writeLSHelp(runtime.stdout, paletteFor(runtime.stdout), "aih ls")
		return true, nil
	}
	providersForScope := append([]string(nil), parsed.Scope...)
	explicit := len(parsed.Scope) > 0
	if parsed.FilterID == 0 && len(parsed.Positional) > 0 {
		matched, matchErr := matchLSProviders(parsed.Positional, lsProviderNames())
		if matchErr != nil {
			return true, matchErr
		}
		providersForScope = append(providersForScope, matched...)
		explicit = true
	}
	providersForScope = dedupeLSProviders(providersForScope)
	return true, runLSList(ctx, runtime, lsOptions{
		Providers:        providersForScope,
		FilterID:         parsed.FilterID,
		ProviderExplicit: explicit,
		JSON:             parsed.JSON,
	})
}

func dedupeLSProviders(values []string) []string {
	seen := make(map[string]bool, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		normalized := strings.ToLower(strings.TrimSpace(value))
		if normalized == "" || seen[normalized] {
			continue
		}
		seen[normalized] = true
		out = append(out, normalized)
	}
	return out
}

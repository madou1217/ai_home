package main

import (
	"context"
	"strings"
)

// runRootLS owns the common account list command. Provider-scoped wildcards and
// --json remain on the legacy CLI until their planning path is migrated.
func runRootLS(ctx context.Context, arguments []string, runtime commandRuntime) (bool, error) {
	if len(arguments) == 0 || (arguments[0] != "ls" && arguments[0] != "list") {
		return false, nil
	}
	for _, argument := range arguments[1:] {
		if strings.TrimSpace(argument) == "--json" {
			return false, nil
		}
	}
	parsed, err := parseLSArguments(arguments[1:])
	if err != nil {
		return true, err
	}
	if parsed.Help {
		writeLSHelp(runtime.stdout, paletteFor(runtime.stdout), "aih ls")
		return true, nil
	}
	if len(parsed.Positional) > 0 {
		// Provider names/globs and other positional forms still go through the
		// Node request planner.
		return false, nil
	}
	return true, runLSList(ctx, runtime, lsOptions{
		Providers: parsed.Scope,
		FilterID:  parsed.FilterID,
	})
}

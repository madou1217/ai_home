package main

import (
	"context"
	"fmt"
	"io"
	"strings"
)

// runProviderList 实现 aih <provider> ls [id]。
func runProviderList(ctx context.Context, providerID string, arguments []string, runtime commandRuntime) error {
	parsed, err := parseLSArguments(arguments)
	if err != nil {
		return err
	}
	if parsed.Help {
		writeProviderListUsage(runtime.stdout, providerID)
		return nil
	}
	if len(parsed.Scope) > 0 {
		matched, matchErr := matchLSProviders(parsed.Scope, lsProviderNames())
		if matchErr != nil {
			return matchErr
		}
		found := false
		for _, provider := range matched {
			if provider == providerID {
				found = true
				break
			}
		}
		if !found {
			return fmt.Errorf("%w: --scope %s 与 %s 不重叠", errInvalidCommand, strings.Join(parsed.Scope, " "), providerID)
		}
	}
	if len(parsed.Positional) > 0 && parsed.FilterID == 0 {
		return fmt.Errorf("%w: 账号 ID 必须是正整数", errInvalidCommand)
	}
	return runLSList(ctx, runtime, lsOptions{Providers: []string{providerID}, FilterID: parsed.FilterID, ProviderExplicit: true})
}

func writeProviderListUsage(output io.Writer, providerID string) {
	writeLSHelp(output, paletteFor(output), "aih "+providerID+" ls")
}

func titleCase(value string) string {
	text := strings.TrimSpace(value)
	if text == "" {
		return ""
	}
	return strings.ToUpper(text[:1]) + text[1:]
}

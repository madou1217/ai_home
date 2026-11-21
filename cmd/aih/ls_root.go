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
	providersForScope, explicit, resolveErr := resolveLSProviders(parsed)
	if resolveErr != nil {
		return true, resolveErr
	}
	return true, runLSList(ctx, runtime, lsOptions{
		Providers:        providersForScope,
		FilterID:         parsed.FilterID,
		ProviderExplicit: explicit,
		JSON:             parsed.JSON,
	})
}

// resolveLSProviders 是 --scope / 位置 provider 位的唯一解析入口：
// 两者都交给同一个选择器解析器（精确名 → 子串 → 通配符），解析不到就是错误。
// 直接把 --scope 原文塞进过滤集合会让 "odebudd" 这种子串选择器匹配不到任何
// 已注册 Provider，最后显示成 "No profiles found."——那是最难查的一种失败。
func resolveLSProviders(parsed lsArguments) ([]string, bool, error) {
	patterns := make([]string, 0, len(parsed.Scope)+len(parsed.Positional))
	patterns = append(patterns, parsed.Scope...)
	explicit := len(parsed.Scope) > 0
	if parsed.FilterID == 0 && len(parsed.Positional) > 0 {
		patterns = append(patterns, parsed.Positional...)
		explicit = true
	}
	if len(patterns) == 0 {
		return nil, explicit, nil
	}
	matched, err := matchLSProviders(patterns, lsProviderNames())
	if err != nil {
		return nil, explicit, err
	}
	return dedupeLSProviders(matched), true, nil
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

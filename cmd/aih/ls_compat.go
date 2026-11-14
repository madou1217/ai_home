package main

import "github.com/madou1217/ai_home/core/providers"

// matchProviderScope 保留旧测试与调用方的 manifest 顺序语义。
func matchProviderScope(catalog *providers.Catalog, patterns []string) []string {
	if catalog == nil {
		return nil
	}
	names := make([]string, 0, len(catalog.List()))
	for _, definition := range catalog.List() {
		names = append(names, definition.ID)
	}
	matched, err := matchLSProviders(patterns, names)
	if err != nil {
		return nil
	}
	return matched
}

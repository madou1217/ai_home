//go:build no_builtin_engines

package egress

// poolKernelLabels 在无内置引擎的构建里只报告插件引擎；宿主不再探测 mihomo 客户端内核。
func poolKernelLabels(string, string) []string { return nil }

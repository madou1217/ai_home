//go:build !no_builtin_engines

package egress

func poolKernelLabels(aiHomeDir, platform string) []string {
	labels := make([]string, 0, 1)
	// mihomo 沿用自己的 tools/客户端/PATH 解析约定。
	if resolved, err := ResolveMihomoCorePath(CoreResolverOptions{AIHomeDir: aiHomeDir, Platform: platform}); err == nil && resolved != nil {
		labels = append(labels, "mihomo")
	}
	return labels
}

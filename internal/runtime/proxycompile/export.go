package proxycompile

// 这些导出仅用于宿主内置参考渲染器/中转编译器的兼容桥；
// 真正的外部插件直接使用同名导出 API。

func YAMLMapToOrderedJSON(v any, indent string) []byte { return yamlMapToOrderedJSON(v, indent) }
func CompileRelayMihomoEntry(name string, ep RelayEndpoint) *YAMLMap {
	return compileRelayMihomoEntry(name, ep)
}
func CompileRelaySurgeEntry(name string, ep RelayEndpoint) CompiledLineEntry {
	return compileRelaySurgeEntry(name, ep)
}
func CollectSurgeLines(entries []CompiledLineEntry) ([]string, []string) {
	return collectSurgeLines(entries)
}

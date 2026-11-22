//go:build !no_builtin_renderers

package subaggregator

import "github.com/madou1217/ai_home/internal/runtime/proxycompile"

type CompiledLineEntry = proxycompile.CompiledLineEntry
type CompiledSection = proxycompile.CompiledSection
type SingBoxCompiled = proxycompile.SingBoxCompiled

func CompileMihomoProxy(node ProxyNode, name, target string) (*YAMLMap, error) {
	return proxycompile.CompileMihomoProxy(node, name, target)
}

func CompileSingBoxOutbound(node ProxyNode, tag, singBoxVersion string, officialApp bool) (SingBoxCompiled, error) {
	return proxycompile.CompileSingBoxOutbound(node, tag, singBoxVersion, officialApp)
}

func CompileSurgeFamilyEntry(target string, node ProxyNode, name string, chainName string, proxyChainParam string) (CompiledLineEntry, error) {
	return proxycompile.CompileSurgeFamilyEntry(target, node, name, chainName, proxyChainParam)
}

func CompileQuantumultXEntry(node ProxyNode, name string) (CompiledLineEntry, error) {
	return proxycompile.CompileQuantumultXEntry(node, name)
}

func CompileEgernProxy(node ProxyNode, name string) (*YAMLMap, error) {
	return proxycompile.CompileEgernProxy(node, name)
}

func SupportsUDPRelay(node ProxyNode) bool { return proxycompile.SupportsUDPRelay(node) }

func VersionAtLeast(version, minimum string) bool {
	return proxycompile.VersionAtLeast(version, minimum)
}

func yamlMapToOrderedJSON(v any, indent string) []byte {
	return proxycompile.YAMLMapToOrderedJSON(v, indent)
}

func compileRelayMihomoEntry(name string, ep RelayEndpoint) *YAMLMap {
	return proxycompile.CompileRelayMihomoEntry(name, ep)
}

func compileRelaySurgeEntry(name string, ep RelayEndpoint) CompiledLineEntry {
	return proxycompile.CompileRelaySurgeEntry(name, ep)
}

func collectSurgeLines(entries []CompiledLineEntry) ([]string, []string) {
	return proxycompile.CollectSurgeLines(entries)
}

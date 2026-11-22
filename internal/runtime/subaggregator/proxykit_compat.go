package subaggregator

import "github.com/madou1217/ai_home/internal/runtime/proxykit"

// 类型别名让聚合层与渲染器保持原有 API，同时把协议/编译实现下沉到独立库。
type ProxyNode = proxykit.ProxyNode
type YAMLKV = proxykit.YAMLKV
type YAMLMap = proxykit.YAMLMap
type RelayEndpoint = proxykit.RelayEndpoint
type DomainError = proxykit.DomainError
type FieldOptionDef = proxykit.FieldOptionDef
type ProtocolFieldDef = proxykit.ProtocolFieldDef
type ProtocolFormDef = proxykit.ProtocolFormDef

func BuildProxyNodeConnectionKey(node ProxyNode) string {
	return proxykit.BuildProxyNodeConnectionKey(node)
}
func EncodeProxyURI(node ProxyNode) string     { return proxykit.EncodeProxyURI(node) }
func NormalizeProtocolAlias(raw string) string { return proxykit.NormalizeProtocolAlias(raw) }
func ValidateAndNormalizeNode(raw ProxyNode) (ProxyNode, error) {
	return proxykit.ValidateAndNormalizeNode(raw)
}
func ProtocolForms() []ProtocolFormDef { return proxykit.ProtocolForms() }

var AllSupportedProtocols = proxykit.AllSupportedProtocols
var SupportedTransports = proxykit.SupportedTransports

func SanitizeSurgeName(name string) string { return proxykit.SanitizeSurgeName(name) }

func toString(v any) string                     { return proxykit.ToString(v) }
func toInt(v any) (int, bool)                   { return proxykit.ToInt(v) }
func toFloat(v any) (float64, bool)             { return proxykit.ToFloat(v) }
func toBool(v any) (bool, bool)                 { return proxykit.ToBool(v) }
func isValidPort(p int) bool                    { return proxykit.IsValidPort(p) }
func normalizeServerHost(server string) string  { return proxykit.NormalizeServerHost(server) }
func normalizePortRanges(raw any) string        { return proxykit.NormalizePortRanges(raw) }
func firstPortOf(ports string) int              { return proxykit.FirstPortOf(ports) }
func pluginKeyFor(protocol string) string       { return proxykit.PluginKeyFor(protocol) }
func parsePluginOptsMap(raw any) map[string]any { return proxykit.ParsePluginOptsMap(raw) }
func normalizeShadowsocksPluginName(plugin string) string {
	return proxykit.NormalizeShadowsocksPluginName(plugin)
}
func marshalCompactNoEscape(v any) ([]byte, error) { return proxykit.MarshalCompactNoEscape(v) }

type ResolvedKernelBinary = proxykit.ResolvedKernelBinary
type RelayKernelSpec = proxykit.RelayKernelSpec
type PoolKernel = proxykit.PoolKernel

var singBoxKernelSpec = proxykit.SingBoxKernelSpec
var mihomoKernelSpec = proxykit.MihomoKernelSpec

func ParseRelaySettings(raw string) map[string]string { return proxykit.ParseRelaySettings(raw) }
func ReadRelaySetting(env map[string]string, key, fallback string) string {
	return proxykit.ReadRelaySetting(env, key, fallback)
}
func ResolveKernelBinary(spec RelayKernelSpec, env map[string]string, aiHomeDir, platform string) *ResolvedKernelBinary {
	return proxykit.ResolveKernelBinary(spec, env, aiHomeDir, platform)
}
func ResolvePoolKernel(id, aiHomeDir, platform string) *PoolKernel {
	return proxykit.ResolvePoolKernel(id, aiHomeDir, platform)
}
func readKernelVersion(spec RelayKernelSpec, path string) string {
	return proxykit.ReadKernelVersion(spec, path)
}

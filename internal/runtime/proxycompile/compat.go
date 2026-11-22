package proxycompile

import "github.com/madou1217/ai_home/internal/runtime/proxykit"

type ProxyNode = proxykit.ProxyNode
type YAMLMap = proxykit.YAMLMap
type YAMLKV = proxykit.YAMLKV
type RelayEndpoint = proxykit.RelayEndpoint

func errInvalid(code string, detail ...string) error { return proxykit.ErrInvalid(code, detail...) }

func NormalizeProtocolAlias(raw string) string { return proxykit.NormalizeProtocolAlias(raw) }
func SanitizeSurgeName(name string) string     { return proxykit.SanitizeSurgeName(name) }

func normalizeServerHost(server string) string  { return proxykit.NormalizeServerHost(server) }
func normalizePortRanges(raw any) string        { return proxykit.NormalizePortRanges(raw) }
func firstPortOf(ports string) int              { return proxykit.FirstPortOf(ports) }
func isValidPort(p int) bool                    { return proxykit.IsValidPort(p) }
func toString(v any) string                     { return proxykit.ToString(v) }
func toInt(v any) (int, bool)                   { return proxykit.ToInt(v) }
func toFloat(v any) (float64, bool)             { return proxykit.ToFloat(v) }
func toBool(v any) (bool, bool)                 { return proxykit.ToBool(v) }
func pluginKeyFor(protocol string) string       { return proxykit.PluginKeyFor(protocol) }
func parsePluginOptsMap(raw any) map[string]any { return proxykit.ParsePluginOptsMap(raw) }
func normalizeShadowsocksPluginName(plugin string) string {
	return proxykit.NormalizeShadowsocksPluginName(plugin)
}
func marshalCompactNoEscape(v any) ([]byte, error) { return proxykit.MarshalCompactNoEscape(v) }
func normalizeStringSlice(raw any) []string        { return proxykit.NormalizeStringSlice(raw) }
func parseHopInterval(raw any) (float64, bool)     { return proxykit.ParseHopInterval(raw) }
func shadowsocksPluginIdentity(node ProxyNode) any { return proxykit.ShadowsocksPluginIdentity(node) }
func buildOrderedQuery(pairs [][2]string) string   { return proxykit.BuildOrderedQuery(pairs) }
func vlessSecurity(node ProxyNode) string          { return proxykit.VlessSecurity(node) }
func b64URLEncode(s string) string                 { return proxykit.B64URLEncode(s) }

func isSupportedTransport(t string) bool { return proxykit.IsSupportedTransport(t) }

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

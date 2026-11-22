package proxykit

// 这些导出函数仅供编译库复用协议归一化/字段转换实现；
// 聚合层保持原有未导出名称，避免调用方直接依赖内部细节。

func ToString(v any) string                     { return toString(v) }
func ToInt(v any) (int, bool)                   { return toInt(v) }
func ToFloat(v any) (float64, bool)             { return toFloat(v) }
func ToBool(v any) (bool, bool)                 { return toBool(v) }
func IsValidPort(p int) bool                    { return isValidPort(p) }
func NormalizeServerHost(s string) string       { return normalizeServerHost(s) }
func NormalizePortRanges(raw any) string        { return normalizePortRanges(raw) }
func FirstPortOf(ports string) int              { return firstPortOf(ports) }
func PluginKeyFor(protocol string) string       { return pluginKeyFor(protocol) }
func ParsePluginOptsMap(raw any) map[string]any { return parsePluginOptsMap(raw) }
func NormalizeShadowsocksPluginName(plugin string) string {
	return normalizeShadowsocksPluginName(plugin)
}
func MarshalCompactNoEscape(v any) ([]byte, error) { return marshalCompactNoEscape(v) }
func NormalizeStringSlice(raw any) []string        { return normalizeStringSlice(raw) }
func ParseHopInterval(raw any) (float64, bool)     { return parseHopInterval(raw) }
func ShadowsocksPluginIdentity(node ProxyNode) any { return shadowsocksPluginIdentity(node) }
func BuildOrderedQuery(pairs [][2]string) string   { return buildOrderedQuery(pairs) }
func VlessSecurity(node ProxyNode) string          { return vlessSecurity(node) }
func IsSupportedTransport(t string) bool           { return isSupportedTransport(t) }
func B64URLEncode(s string) string                 { return b64URLEncode(s) }

// ProtocolFields 返回协议声明的可复制字段顺序。
func ProtocolFields(protocol string) ([]string, bool) {
	meta, ok := protocolRegistry[protocol]
	if !ok {
		return nil, false
	}
	return append([]string(nil), meta.Fields...), true
}

// ReadKernelVersion 读取内核版本，供聚合层兼容桥复用。
func ReadKernelVersion(spec RelayKernelSpec, path string) string {
	return readKernelVersion(spec, path)
}

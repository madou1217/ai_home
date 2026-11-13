package subaggregator

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// AllSupportedProtocols 按 catalog.protocols 顺序列出支持的代理协议。
var AllSupportedProtocols = []string{
	"shadowsocks",
	"shadowsocksr",
	"vmess",
	"vless",
	"trojan",
	"hysteria2",
	"hysteria",
	"tuic",
	"anytls",
	"wireguard",
	"snell",
	"socks5",
	"http",
	"https",
	"ssh",
	"mieru",
	"naive",
}

// SupportedTransports 列出支持的底层传输方式。
var SupportedTransports = []string{"tcp", "ws", "grpc", "h2", "http", "httpupgrade", "xhttp"}

var (
	transportFieldsOrder = []string{"network", "path", "host", "serviceName"}
	tlsFieldsOrder       = []string{"tls", "sni", "alpn", "allowInsecure", "fingerprint"}
)

type protocolMeta struct {
	Fields        []string
	Required      []string
	DefaultFields map[string]any
}

var protocolRegistry = map[string]protocolMeta{
	"shadowsocks": {
		Fields:   []string{"password", "cipher", "plugin", "pluginOpts"},
		Required: []string{"cipher", "password"},
		DefaultFields: map[string]any{
			"cipher": "aes-256-gcm",
		},
	},
	"shadowsocksr": {
		Fields:   []string{"cipher", "password", "ssrProtocol", "ssrProtocolParam", "ssrObfs", "ssrObfsParam"},
		Required: []string{"cipher", "password"},
	},
	"vmess": {
		Fields:   append(append([]string{"uuid", "cipher", "alterId", "type"}, transportFieldsOrder...), tlsFieldsOrder...),
		Required: []string{"uuid"},
		DefaultFields: map[string]any{
			"cipher":  "auto",
			"alterId": 0,
		},
	},
	"vless": {
		Fields:   append(append([]string{"uuid", "flow", "security", "publicKey", "shortId", "mode", "encryption", "pqv"}, transportFieldsOrder...), tlsFieldsOrder...),
		Required: []string{"uuid"},
	},
	"trojan": {
		Fields:   append(append([]string{"password"}, transportFieldsOrder...), tlsFieldsOrder...),
		Required: []string{"password"},
		DefaultFields: map[string]any{
			"tls": true,
		},
	},
	"hysteria2": {
		Fields:   append([]string{"password", "insecure", "obfs", "obfsPassword", "upMbps", "downMbps", "ports", "hopInterval"}, tlsFieldsOrder...),
		Required: []string{"password"},
		DefaultFields: map[string]any{
			"tls": true,
		},
	},
	"hysteria": {
		Fields:   append([]string{"authStr", "hysteriaProtocol", "obfs", "upMbps", "downMbps"}, tlsFieldsOrder...),
		Required: nil,
		DefaultFields: map[string]any{
			"tls": true,
		},
	},
	"tuic": {
		Fields:   append([]string{"uuid", "password", "token", "congestionControl", "udpRelayMode"}, tlsFieldsOrder...),
		Required: nil,
		DefaultFields: map[string]any{
			"tls":               true,
			"congestionControl": "bbr",
			"alpn":              []string{"h3"},
		},
	},
	"anytls": {
		Fields:   append([]string{"password"}, tlsFieldsOrder...),
		Required: []string{"password"},
		DefaultFields: map[string]any{
			"tls": true,
		},
	},
	"wireguard": {
		Fields:   []string{"privateKey", "publicKey", "presharedKey", "ip", "ipv6", "mtu", "reserved"},
		Required: []string{"privateKey", "publicKey"},
	},
	"snell": {
		Fields:   []string{"psk", "version", "obfs", "obfsHost", "mode"},
		Required: []string{"psk"},
		DefaultFields: map[string]any{
			"version": 4,
		},
	},
	"socks5": {
		Fields:   []string{"username", "password"},
		Required: nil,
	},
	"http": {
		Fields:   []string{"username", "password", "tls", "sni", "allowInsecure"},
		Required: nil,
	},
	"ssh": {
		Fields:   []string{"username", "password", "privateKey", "privateKeyPassphrase", "hostKey", "hostKeyAlgorithms"},
		Required: []string{"username"},
	},
	"mieru": {
		Fields:   []string{"username", "password", "transport", "multiplexing", "handshakeMode", "trafficPattern", "ports"},
		Required: []string{"username", "password"},
	},
	"naive": {
		Fields:   []string{"username", "password", "quic", "sni"},
		Required: []string{"username", "password"},
	},
}

// NormalizeProtocolAlias 将协议别名折叠为标准协议标识。
func NormalizeProtocolAlias(raw string) string {
	p := strings.ToLower(strings.TrimSpace(raw))
	switch p {
	case "ss":
		return "shadowsocks"
	case "ssr":
		return "shadowsocksr"
	case "hy2":
		return "hysteria2"
	case "hysteria1", "hy1":
		return "hysteria"
	case "tuic-v5", "tuic-v4":
		return "tuic"
	case "wg":
		return "wireguard"
	}
	return p
}

func pluginKeyFor(protocol string) string {
	p := NormalizeProtocolAlias(protocol)
	if p == "https" {
		return "http"
	}
	return p
}

func toString(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case bool:
		if x {
			return "true"
		}
		return "false"
	case int:
		return strconv.Itoa(x)
	case int64:
		return strconv.FormatInt(x, 10)
	case float64:
		if x == math.Trunc(x) {
			return strconv.FormatInt(int64(x), 10)
		}
		return strconv.FormatFloat(x, 'f', -1, 64)
	default:
		return fmt.Sprint(x)
	}
}

func toInt(v any) (int, bool) {
	switch x := v.(type) {
	case int:
		return x, true
	case int64:
		return int(x), true
	case float64:
		if math.IsNaN(x) || math.IsInf(x, 0) {
			return 0, false
		}
		return int(x), true
	case string:
		s := strings.TrimSpace(x)
		if s == "" {
			return 0, false
		}
		iv, err := strconv.Atoi(s)
		if err != nil {
			fv, ferr := strconv.ParseFloat(s, 64)
			if ferr != nil || math.IsNaN(fv) || math.IsInf(fv, 0) {
				return 0, false
			}
			return int(fv), true
		}
		return iv, true
	}
	return 0, false
}

func toFloat(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, !math.IsNaN(x) && !math.IsInf(x, 0)
	case float32:
		f := float64(x)
		return f, !math.IsNaN(f) && !math.IsInf(f, 0)
	case int:
		return float64(x), true
	case int64:
		return float64(x), true
	case string:
		s := strings.TrimSpace(x)
		if s == "" {
			return 0, false
		}
		f, err := strconv.ParseFloat(s, 64)
		return f, err == nil && !math.IsNaN(f) && !math.IsInf(f, 0)
	}
	return 0, false
}

func toBool(v any) (bool, bool) {
	switch x := v.(type) {
	case bool:
		return x, true
	case int:
		return x != 0, true
	case int64:
		return x != 0, true
	case float64:
		return x != 0, true
	case string:
		s := strings.ToLower(strings.TrimSpace(x))
		switch s {
		case "true", "1", "yes", "on":
			return true, true
		case "false", "0", "no", "off":
			return false, true
		}
	}
	return false, false
}

func isValidPort(p int) bool {
	return p >= 1 && p <= 65535
}

func normalizeServerHost(server string) string {
	s := strings.TrimSpace(server)
	if strings.HasPrefix(s, "[") && strings.HasSuffix(s, "]") {
		s = s[1 : len(s)-1]
	}
	return strings.ToLower(s)
}

func normalizePortRanges(raw any) string {
	s := strings.TrimSpace(toString(raw))
	if s == "" {
		return ""
	}
	parts := strings.FieldsFunc(s, func(r rune) bool {
		return r == ',' || r == ' ' || r == '\t'
	})
	var clean []string
	for _, part := range parts {
		if part == "" {
			continue
		}
		if strings.Contains(part, "-") || strings.Contains(part, ":") {
			sep := "-"
			if strings.Contains(part, ":") {
				sep = ":"
			}
			bounds := strings.SplitN(part, sep, 2)
			a, okA := toInt(bounds[0])
			b, okB := toInt(bounds[1])
			if okA && okB && isValidPort(a) && isValidPort(b) && a <= b {
				clean = append(clean, fmt.Sprintf("%d-%d", a, b))
			}
			continue
		}
		if p, ok := toInt(part); ok && isValidPort(p) {
			clean = append(clean, strconv.Itoa(p))
		}
	}
	return strings.Join(clean, ",")
}

func firstPortOf(ports string) int {
	for _, part := range strings.Split(ports, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if idx := strings.IndexByte(part, '-'); idx > 0 {
			if p, ok := toInt(part[:idx]); ok && isValidPort(p) {
				return p
			}
		}
		if p, ok := toInt(part); ok && isValidPort(p) {
			return p
		}
	}
	return 0
}

var reDurationGo = regexp.MustCompile(`^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$`)

func parseHopInterval(raw any) (float64, bool) {
	if f, ok := toFloat(raw); ok {
		return f, f > 0
	}
	s := strings.TrimSpace(toString(raw))
	if s == "" {
		return 0, false
	}
	m := reDurationGo.FindStringSubmatch(s)
	if m == nil || (m[1] == "" && m[2] == "" && m[3] == "") {
		return 0, false
	}
	var total float64
	if m[1] != "" {
		h, _ := strconv.ParseFloat(m[1], 64)
		total += h * 3600
	}
	if m[2] != "" {
		min, _ := strconv.ParseFloat(m[2], 64)
		total += min * 60
	}
	if m[3] != "" {
		sec, _ := strconv.ParseFloat(m[3], 64)
		total += sec
	}
	return total, total > 0
}

func normalizeStringSlice(raw any) []string {
	if raw == nil {
		return nil
	}
	var items []string
	switch x := raw.(type) {
	case []string:
		items = x
	case []any:
		for _, v := range x {
			s := strings.TrimSpace(toString(v))
			if s != "" {
				items = append(items, s)
			}
		}
		if len(items) == 0 {
			return nil
		}
		return items
	case string:
		for _, p := range strings.Split(x, ",") {
			p = strings.TrimSpace(p)
			if p != "" {
				items = append(items, p)
			}
		}
		if len(items) == 0 {
			return nil
		}
		return items
	default:
		return nil
	}
	var out []string
	for _, s := range items {
		s = strings.TrimSpace(s)
		if s != "" {
			out = append(out, s)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func normalizeShadowsocksPluginName(plugin string) string {
	p := strings.ToLower(strings.TrimSpace(plugin))
	switch p {
	case "obfs", "simple-obfs", "obfs-local":
		return "obfs-local"
	case "v2ray", "v2ray-plugin":
		return "v2ray-plugin"
	case "shadow-tls", "shadowtls":
		return "shadow-tls"
	}
	return strings.TrimSpace(plugin)
}

func parsePluginOptsMap(raw any) map[string]any {
	if raw == nil {
		return nil
	}
	if m, ok := raw.(map[string]any); ok {
		return m
	}
	s := strings.TrimSpace(toString(raw))
	if s == "" {
		return nil
	}
	if strings.HasPrefix(s, "{") {
		var m map[string]any
		if json.Unmarshal([]byte(s), &m) == nil {
			return m
		}
	}
	out := map[string]any{}
	for _, part := range strings.Split(s, ";") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if idx := strings.IndexByte(part, '='); idx >= 0 {
			k := strings.TrimSpace(part[:idx])
			v := strings.TrimSpace(part[idx+1:])
			switch strings.ToLower(v) {
			case "true":
				out[k] = true
			case "false":
				out[k] = false
			default:
				out[k] = v
			}
		} else {
			out[part] = true
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func shadowsocksPluginIdentity(node ProxyNode) any {
	plugin := normalizeShadowsocksPluginName(node.Str("plugin"))
	if plugin == "" {
		return nil
	}
	opts := parsePluginOptsMap(node["pluginOpts"])
	switch plugin {
	case "obfs-local":
		return map[string]any{
			"plugin": "obfs-local",
			"mode":   toString(opts["mode"]),
			"host":   toString(opts["host"]),
		}
	case "v2ray-plugin":
		tlsVal, _ := toBool(opts["tls"])
		return map[string]any{
			"plugin": "v2ray-plugin",
			"mode":   toString(opts["mode"]),
			"host":   toString(opts["host"]),
			"path":   toString(opts["path"]),
			"tls":    tlsVal,
		}
	case "shadow-tls":
		ver, _ := toInt(opts["version"])
		if ver == 0 {
			ver = 3
		}
		return map[string]any{
			"plugin":   "shadow-tls",
			"host":     toString(opts["host"]),
			"password": toString(opts["password"]),
			"version":  ver,
		}
	}
	return map[string]any{
		"plugin": plugin,
		"opts":   opts,
	}
}

func sortMapRecursive(v any) any {
	switch x := v.(type) {
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		arr := make(orderedJSONObj, 0, len(keys))
		for _, k := range keys {
			arr = append(arr, [2]any{k, sortMapRecursive(x[k])})
		}
		return arr
	case []any:
		out := make([]any, len(x))
		for i, item := range x {
			out[i] = sortMapRecursive(item)
		}
		return out
	default:
		return v
	}
}

type orderedJSONObj [][2]any

func (o orderedJSONObj) MarshalJSON() ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteByte('{')
	for i, kv := range o {
		if i > 0 {
			buf.WriteByte(',')
		}
		kb, err := marshalCompactNoEscape(kv[0])
		if err != nil {
			return nil, err
		}
		vb, err := marshalCompactNoEscape(kv[1])
		if err != nil {
			return nil, err
		}
		buf.Write(kb)
		buf.WriteByte(':')
		buf.Write(vb)
	}
	buf.WriteByte('}')
	return buf.Bytes(), nil
}

func marshalCompactNoEscape(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	b := buf.Bytes()
	if len(b) > 0 && b[len(b)-1] == '\n' {
		b = b[:len(b)-1]
	}
	return b, nil
}

// BuildProxyNodeConnectionKey 返回与 Node 完全一致的 64 位 SHA-256 hex 连接指纹（用于去重与稳定 ID）。
func BuildProxyNodeConnectionKey(node ProxyNode) string {
	p := NormalizeProtocolAlias(node.Str("protocol"))
	pk := pluginKeyFor(p)
	meta, ok := protocolRegistry[pk]

	server := normalizeServerHost(node.Str("server"))
	port, _ := node.Int("port")

	var override map[string]any
	switch pk {
	case "shadowsocks":
		override = map[string]any{
			"plugin":     shadowsocksPluginIdentity(node),
			"pluginOpts": nil,
		}
	case "shadowsocksr":
		ssrProto := strings.TrimSpace(node.Str("ssrProtocol"))
		if ssrProto == "" {
			ssrProto = "origin"
		}
		ssrObfs := strings.TrimSpace(node.Str("ssrObfs"))
		if ssrObfs == "" {
			ssrObfs = "plain"
		}
		override = map[string]any{
			"ssrProtocol": ssrProto,
			"ssrObfs":     ssrObfs,
		}
	case "ssh":
		override = map[string]any{
			"hostKey":           normalizeStringSlice(node["hostKey"]),
			"hostKeyAlgorithms": normalizeStringSlice(node["hostKeyAlgorithms"]),
		}
	}

	var fields []string
	if ok {
		fields = meta.Fields
	}
	entries := make([][2]any, 0, 3+len(fields))
	entries = append(entries,
		[2]any{"protocol", p},
		[2]any{"server", server},
		[2]any{"port", port},
	)
	for _, field := range fields {
		if override != nil {
			if ov, exists := override[field]; exists {
				entries = append(entries, [2]any{field, normalizeConnectionFieldValue(field, ov)})
				continue
			}
		}
		entries = append(entries, [2]any{field, normalizeConnectionFieldValue(field, node[field])})
	}

	raw, _ := marshalCompactNoEscape(entries)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func normalizeConnectionFieldValue(field string, val any) any {
	if field == "network" {
		s := strings.TrimSpace(toString(val))
		if s == "" {
			return "tcp"
		}
		return s
	}
	if field == "ports" {
		s := normalizePortRanges(val)
		if s == "" {
			return nil
		}
		return s
	}
	if field == "alpn" {
		sl := normalizeStringSlice(val)
		if len(sl) == 0 {
			return nil
		}
		return sl
	}
	if field == "tls" || field == "allowInsecure" || field == "insecure" {
		b, ok := toBool(val)
		if !ok {
			return false
		}
		return b
	}
	if val == nil {
		return nil
	}
	switch x := val.(type) {
	case string:
		if x == "" {
			return nil
		}
		return x
	case map[string]any:
		return sortMapRecursive(x)
	case []any:
		return sortMapRecursive(x)
	default:
		return val
	}
}

// ValidateAndNormalizeNode 校验并标准化节点，返回规范化节点（不修改入参）。
func ValidateAndNormalizeNode(raw ProxyNode) (ProxyNode, error) {
	if raw == nil {
		return nil, errInvalid("invalid_proxy_node")
	}
	protoRaw := NormalizeProtocolAlias(raw.Str("protocol"))
	pk := pluginKeyFor(protoRaw)
	meta, exists := protocolRegistry[pk]
	if !exists {
		return nil, errInvalid("unsupported_proxy_protocol_" + protoRaw)
	}
	server := strings.TrimSpace(raw.Str("server"))
	if server == "" {
		return nil, errInvalid("invalid_proxy_server")
	}
	port, ok := raw.Int("port")
	if !ok || !isValidPort(port) {
		return nil, errInvalid("invalid_proxy_port")
	}

	node := raw.Clone()
	node["protocol"] = protoRaw
	node["server"] = server
	node["port"] = port
	if strings.TrimSpace(node.Str("name")) == "" {
		node["name"] = fmt.Sprintf("%s:%d", server, port)
	}

	for _, reqField := range meta.Required {
		if strings.TrimSpace(node.Str(reqField)) == "" {
			return nil, errInvalid("missing_required_proxy_field_" + reqField)
		}
	}

	switch pk {
	case "shadowsocksr":
		if strings.TrimSpace(node.Str("ssrProtocol")) == "" {
			node["ssrProtocol"] = "origin"
		}
		if strings.TrimSpace(node.Str("ssrObfs")) == "" {
			node["ssrObfs"] = "plain"
		}
	case "vmess":
		if netName := strings.ToLower(strings.TrimSpace(node.Str("network"))); netName != "" {
			node["network"] = netName
			if netName == "xhttp" {
				return nil, errInvalid("unsupported_proxy_transport_xhttp")
			}
			if !isSupportedTransport(netName) {
				return nil, errInvalid("unsupported_proxy_transport_" + netName)
			}
		}
		if aid, ok := node.Int("alterId"); ok {
			node["alterId"] = aid
		} else {
			node["alterId"] = 0
		}
		if strings.TrimSpace(node.Str("cipher")) == "" {
			node["cipher"] = "auto"
		}
	case "vless":
		sec := strings.ToLower(strings.TrimSpace(node.Str("security")))
		if sec != "" && sec != "none" && sec != "tls" && sec != "reality" {
			return nil, errInvalid("unsupported_proxy_security_" + sec)
		}
		if sec != "" {
			node["security"] = sec
		}
		if sec == "reality" && strings.TrimSpace(node.Str("publicKey")) == "" {
			return nil, errInvalid("missing_required_proxy_field_publicKey")
		}
		if netName := strings.ToLower(strings.TrimSpace(node.Str("network"))); netName != "" {
			node["network"] = netName
			if !isSupportedTransport(netName) {
				return nil, errInvalid("unsupported_proxy_transport_" + netName)
			}
		}
	case "trojan":
		node["tls"] = true
		if netName := strings.ToLower(strings.TrimSpace(node.Str("network"))); netName != "" {
			node["network"] = netName
			if !isSupportedTransport(netName) {
				return nil, errInvalid("unsupported_proxy_transport_" + netName)
			}
		}
	case "hysteria2":
		node["tls"] = true
		if ports := normalizePortRanges(node["ports"]); ports != "" {
			node["ports"] = ports
		} else {
			delete(node, "ports")
		}
		if _, hasHop := node["hopInterval"]; hasHop && toString(node["hopInterval"]) != "" {
			secs, ok := parseHopInterval(node["hopInterval"])
			if !ok {
				return nil, errInvalid("invalid_proxy_hopInterval")
			}
			node["hopInterval"] = secs
		}
	case "hysteria":
		node["tls"] = true
	case "tuic":
		hasUUID := node["uuid"] != nil && strings.TrimSpace(node.Str("uuid")) != ""
		hasPass := node["password"] != nil && strings.TrimSpace(node.Str("password")) != ""
		_, hasUUIDKey := node["uuid"]
		_, hasPassKey := node["password"]
		if hasUUIDKey || hasPassKey || hasUUID || hasPass {
			if !hasUUID {
				return nil, errInvalid("missing_required_proxy_field_uuid")
			}
			if !hasPass {
				return nil, errInvalid("missing_required_proxy_field_password")
			}
		} else if strings.TrimSpace(node.Str("token")) == "" {
			return nil, errInvalid("missing_required_proxy_field_token")
		}
		node["tls"] = true
	case "anytls":
		node["tls"] = true
	case "http":
		if protoRaw == "https" {
			node["tls"] = true
		}
	case "ssh":
		if strings.TrimSpace(node.Str("password")) == "" && strings.TrimSpace(node.Str("privateKey")) == "" {
			return nil, errInvalid("missing_required_proxy_field_password")
		}
		if hk := normalizeStringSlice(node["hostKey"]); len(hk) > 0 {
			node["hostKey"] = hk
		}
		if hka := normalizeStringSlice(node["hostKeyAlgorithms"]); len(hka) > 0 {
			node["hostKeyAlgorithms"] = hka
		}
	case "mieru":
		if t := strings.ToUpper(strings.TrimSpace(node.Str("transport"))); t != "" {
			if t != "TCP" && t != "UDP" {
				return nil, errInvalid("invalid_proxy_transport")
			}
			node["transport"] = t
		}
		if m := strings.ToUpper(strings.TrimSpace(node.Str("multiplexing"))); m != "" {
			switch m {
			case "MULTIPLEXING_OFF", "MULTIPLEXING_LOW", "MULTIPLEXING_MIDDLE", "MULTIPLEXING_HIGH":
				node["multiplexing"] = m
			default:
				return nil, errInvalid("invalid_proxy_multiplexing")
			}
		}
		if hm := strings.ToUpper(strings.TrimSpace(node.Str("handshakeMode"))); hm != "" {
			if hm != "HANDSHAKE_STANDARD" && hm != "HANDSHAKE_NO_WAIT" {
				return nil, errInvalid("invalid_proxy_handshakeMode")
			}
			node["handshakeMode"] = hm
		}
	}

	if alpn := normalizeStringSlice(node["alpn"]); len(alpn) > 0 {
		node["alpn"] = alpn
	} else {
		delete(node, "alpn")
	}
	return node, nil
}

func isSupportedTransport(t string) bool {
	for _, s := range SupportedTransports {
		if s == t {
			return true
		}
	}
	return false
}

// EncodeProxyURI 将节点编码为分享 URI（不支持 URI 分享的协议返回 ""）。
func EncodeProxyURI(node ProxyNode) string {
	p := NormalizeProtocolAlias(node.Str("protocol"))
	host := node.Str("server")
	if strings.Contains(host, ":") && !strings.HasPrefix(host, "[") {
		host = "[" + host + "]"
	}
	port, _ := node.Int("port")
	name := url.PathEscape(node.Str("name"))

	switch p {
	case "shadowsocks":
		cipher := node.Str("cipher")
		pass := node.Str("password")
		var userInfo string
		if strings.HasPrefix(cipher, "2022-") {
			userInfo = url.QueryEscape(cipher) + ":" + url.QueryEscape(pass)
		} else {
			userInfo = base64.StdEncoding.EncodeToString([]byte(cipher + ":" + pass))
		}
		q := url.Values{}
		if plug := normalizeShadowsocksPluginName(node.Str("plugin")); plug != "" {
			opts := parsePluginOptsMap(node["pluginOpts"])
			if len(opts) > 0 {
				var parts []string
				keys := make([]string, 0, len(opts))
				for k := range opts {
					keys = append(keys, k)
				}
				sort.Strings(keys)
				for _, k := range keys {
					if v := opts[k]; v != nil && v != "" && v != false {
						if v == true {
							parts = append(parts, k)
						} else {
							parts = append(parts, fmt.Sprintf("%s=%s", k, toString(v)))
						}
					}
				}
				q.Set("plugin", plug+";"+strings.Join(parts, ";"))
			} else {
				q.Set("plugin", plug)
			}
		}
		qs := q.Encode()
		if qs != "" {
			qs = "?" + qs
		}
		return fmt.Sprintf("ss://%s@%s:%d%s#%s", userInfo, host, port, qs, name)

	case "shadowsocksr":
		proto := orDefault(node.Str("ssrProtocol"), "origin")
		obfs := orDefault(node.Str("ssrObfs"), "plain")
		passB64 := b64URLEncode(node.Str("password"))
		basePart := fmt.Sprintf("%s:%d:%s:%s:%s:%s", node.Str("server"), port, proto, node.Str("cipher"), obfs, passB64)
		var qParts []string
		if v := node.Str("ssrObfsParam"); v != "" {
			qParts = append(qParts, "obfsparam="+b64URLEncode(v))
		}
		if v := node.Str("ssrProtocolParam"); v != "" {
			qParts = append(qParts, "protoparam="+b64URLEncode(v))
		}
		if v := node.Str("name"); v != "" {
			qParts = append(qParts, "remarks="+b64URLEncode(v))
		}
		raw := basePart
		if len(qParts) > 0 {
			raw += "/?" + strings.Join(qParts, "&")
		}
		return "ssr://" + b64URLEncode(raw)

	case "vmess":
		netName := orDefault(node.Str("network"), "tcp")
		tlsStr := ""
		if b, ok := node.Bool("tls"); ok && b {
			tlsStr = "tls"
		}
		aid, _ := node.Int("alterId")
		payload := map[string]any{
			"v":    "2",
			"ps":   node.Str("name"),
			"add":  node.Str("server"),
			"port": port,
			"id":   node.Str("uuid"),
			"aid":  aid,
			"scy":  orDefault(node.Str("cipher"), "auto"),
			"net":  netName,
			"type": orDefault(node.Str("type"), "none"),
			"host": node.Str("host"),
			"path": node.Str("path"),
			"tls":  tlsStr,
			"sni":  node.Str("sni"),
			"alpn": strings.Join(normalizeStringSlice(node["alpn"]), ","),
			"fp":   node.Str("fingerprint"),
		}
		if netName == "grpc" && node.Str("serviceName") != "" {
			payload["path"] = node.Str("serviceName")
		}
		if allow, ok := node.Bool("allowInsecure"); ok && allow {
			payload["allowInsecure"] = true
		}
		raw, _ := json.Marshal(payload)
		return "vmess://" + base64.StdEncoding.EncodeToString(raw)

	case "vless":
		q := buildOrderedQuery([][2]string{
			{"type", node.Str("network")},
			{"encryption", node.Str("encryption")},
			{"security", vlessSecurity(node)},
			{"flow", node.Str("flow")},
			{"sni", node.Str("sni")},
			{"pbk", node.Str("publicKey")},
			{"sid", node.Str("shortId")},
			{"fp", node.Str("fingerprint")},
			{"alpn", strings.Join(normalizeStringSlice(node["alpn"]), ",")},
			{"allowInsecure", boolFlagStr(node.Bool("allowInsecure"))},
			{"host", node.Str("host")},
			{"path", node.Str("path")},
			{"serviceName", node.Str("serviceName")},
			{"mode", node.Str("mode")},
			{"pqv", node.Str("pqv")},
		})
		return fmt.Sprintf("vless://%s@%s:%d%s#%s", url.PathEscape(node.Str("uuid")), host, port, q, name)

	case "trojan":
		q := buildOrderedQuery([][2]string{
			{"type", node.Str("network")},
			{"sni", node.Str("sni")},
			{"alpn", strings.Join(normalizeStringSlice(node["alpn"]), ",")},
			{"fp", node.Str("fingerprint")},
			{"allowInsecure", boolFlagStr(node.Bool("allowInsecure"))},
			{"host", node.Str("host")},
			{"path", node.Str("path")},
			{"serviceName", node.Str("serviceName")},
		})
		return fmt.Sprintf("trojan://%s@%s:%d%s#%s", url.PathEscape(node.Str("password")), host, port, q, name)

	case "hysteria2":
		q := buildOrderedQuery([][2]string{
			{"obfs", node.Str("obfs")},
			{"obfs-password", node.Str("obfsPassword")},
			{"sni", node.Str("sni")},
			{"insecure", func() string {
				a, aOK := node.Bool("insecure")
				b, bOK := node.Bool("allowInsecure")
				return boolFlagStr(orBool(a, aOK, b, bOK))
			}()},
			{"alpn", strings.Join(normalizeStringSlice(node["alpn"]), ",")},
			{"mport", node.Str("ports")},
		})
		return fmt.Sprintf("hy2://%s@%s:%d%s#%s", url.PathEscape(node.Str("password")), host, port, q, name)

	case "hysteria":
		upMbps := ""
		if u, ok := node.Int("upMbps"); ok && u > 0 {
			upMbps = strconv.Itoa(u)
		}
		downMbps := ""
		if d, ok := node.Int("downMbps"); ok && d > 0 {
			downMbps = strconv.Itoa(d)
		}
		q := buildOrderedQuery([][2]string{
			{"protocol", node.Str("hysteriaProtocol")},
			{"auth", node.Str("authStr")},
			{"obfsParam", node.Str("obfs")},
			{"upmbps", upMbps},
			{"downmbps", downMbps},
			{"peer", node.Str("sni")},
			{"insecure", boolFlagStr(node.Bool("allowInsecure"))},
			{"alpn", strings.Join(normalizeStringSlice(node["alpn"]), ",")},
		})
		return fmt.Sprintf("hysteria://%s:%d%s#%s", host, port, q, name)

	case "tuic":
		uuid := node.Str("uuid")
		pass := node.Str("password")
		if uuid == "" || pass == "" {
			return ""
		}
		q := buildOrderedQuery([][2]string{
			{"congestion_control", node.Str("congestionControl")},
			{"udp_relay_mode", node.Str("udpRelayMode")},
			{"sni", node.Str("sni")},
			{"alpn", strings.Join(normalizeStringSlice(node["alpn"]), ",")},
			{"allow_insecure", boolFlagStr(node.Bool("allowInsecure"))},
		})
		return fmt.Sprintf("tuic://%s:%s@%s:%d%s#%s", url.PathEscape(uuid), url.PathEscape(pass), host, port, q, name)

	case "anytls":
		q := buildOrderedQuery([][2]string{
			{"sni", node.Str("sni")},
			{"insecure", boolFlagStr(node.Bool("allowInsecure"))},
			{"fp", node.Str("fingerprint")},
			{"alpn", strings.Join(normalizeStringSlice(node["alpn"]), ",")},
		})
		return fmt.Sprintf("anytls://%s@%s:%d%s#%s", url.PathEscape(node.Str("password")), host, port, q, name)

	case "wireguard":
		mtu := ""
		if m, ok := node.Int("mtu"); ok && m > 0 {
			mtu = strconv.Itoa(m)
		}
		addr := strings.TrimSpace(strings.Join(nonEmptySlice(node.Str("ip"), node.Str("ipv6")), ","))
		q := buildOrderedQuery([][2]string{
			{"publickey", node.Str("publicKey")},
			{"presharedkey", node.Str("presharedKey")},
			{"address", addr},
			{"mtu", mtu},
			{"reserved", toString(node["reserved"])},
		})
		return fmt.Sprintf("wireguard://%s@%s:%d%s#%s", url.PathEscape(node.Str("privateKey")), host, port, q, name)

	case "socks5":
		auth := ""
		if u := node.Str("username"); u != "" || node.Str("password") != "" {
			auth = url.PathEscape(u) + ":" + url.PathEscape(node.Str("password")) + "@"
		}
		return fmt.Sprintf("socks5://%s%s:%d#%s", auth, host, port, name)

	case "http", "https":
		scheme := "http"
		if tlsB, ok := node.Bool("tls"); ok && tlsB {
			scheme = "https"
		}
		auth := ""
		if u := node.Str("username"); u != "" || node.Str("password") != "" {
			auth = url.PathEscape(u) + ":" + url.PathEscape(node.Str("password")) + "@"
		}
		return fmt.Sprintf("%s://%s%s:%d#%s", scheme, auth, host, port, name)

	case "naive":
		scheme := "naive+https"
		if qB, ok := node.Bool("quic"); ok && qB {
			scheme = "naive+quic"
		}
		q := buildOrderedQuery([][2]string{{"sni", node.Str("sni")}})
		return fmt.Sprintf("%s://%s:%s@%s:%d%s#%s", scheme, url.PathEscape(node.Str("username")), url.PathEscape(node.Str("password")), host, port, q, name)
	}
	return ""
}

func vlessSecurity(node ProxyNode) string {
	if s := node.Str("security"); s != "" {
		return s
	}
	if tlsB, ok := node.Bool("tls"); ok && tlsB {
		return "tls"
	}
	return ""
}

func boolFlagStr(v bool, ok bool) string {
	if ok && v {
		return "1"
	}
	return ""
}

func orBool(aVal bool, aOK bool, bVal bool, bOK bool) (bool, bool) {
	if aOK {
		return aVal, true
	}
	return bVal, bOK
}

func orDefault(v, d string) string {
	if strings.TrimSpace(v) == "" {
		return d
	}
	return v
}

func nonEmptySlice(vals ...string) []string {
	var out []string
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			out = append(out, strings.TrimSpace(v))
		}
	}
	return out
}

func buildOrderedQuery(pairs [][2]string) string {
	var parts []string
	for _, kv := range pairs {
		if kv[1] == "" {
			continue
		}
		parts = append(parts, url.QueryEscape(kv[0])+"="+url.QueryEscape(kv[1]))
	}
	if len(parts) == 0 {
		return ""
	}
	return "?" + strings.Join(parts, "&")
}

func b64URLEncode(s string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(s))
}

// ProtocolForms 返回供前端协议表单渲染的精确元数据列表。
func ProtocolForms() []ProtocolFormDef {
	transOpts := make([]FieldOptionDef, 0, len(SupportedTransports))
	for _, t := range SupportedTransports {
		transOpts = append(transOpts, FieldOptionDef{Value: t, Label: t})
	}
	alpnOpts := []FieldOptionDef{
		{Value: "h2", Label: "h2"},
		{Value: "http/1.1", Label: "http/1.1"},
		{Value: "h3", Label: "h3"},
	}
	fpOpts := []FieldOptionDef{
		{Value: "chrome", Label: "chrome"},
		{Value: "firefox", Label: "firefox"},
		{Value: "safari", Label: "safari"},
		{Value: "ios", Label: "ios"},
		{Value: "android", Label: "android"},
		{Value: "edge", Label: "edge"},
		{Value: "random", Label: "random"},
	}
	transportFields := []ProtocolFieldDef{
		{Key: "network", Label: "传输", Control: "select", Section: "transport", Required: false, Options: transOpts},
		{Key: "path", Label: "路径", Control: "text", Section: "transport", Required: false},
		{Key: "host", Label: "Host", Control: "text", Section: "transport", Required: false},
		{Key: "serviceName", Label: "gRPC 服务名", Control: "text", Section: "transport", Required: false},
	}
	tlsFields := []ProtocolFieldDef{
		{Key: "tls", Label: "启用 TLS", Control: "switch", Section: "tls", Required: false},
		{Key: "sni", Label: "SNI", Control: "text", Section: "tls", Required: false},
		{Key: "alpn", Label: "ALPN", Control: "tags", Section: "tls", Required: false, Options: alpnOpts},
		{Key: "allowInsecure", Label: "跳过证书验证", Control: "switch", Section: "tls", Required: false},
		{Key: "fingerprint", Label: "uTLS 指纹", Control: "suggest", Section: "tls", Required: false, Options: fpOpts},
	}

	httpFields := []ProtocolFieldDef{
		{Key: "username", Label: "用户名", Control: "text", Section: "basic", Required: false},
		{Key: "password", Label: "密码", Control: "secret", Section: "basic", Required: false},
		{Key: "tls", Label: "启用 TLS", Control: "switch", Section: "tls", Required: false},
		{Key: "sni", Label: "SNI", Control: "text", Section: "tls", Required: false},
		{Key: "allowInsecure", Label: "跳过证书验证", Control: "switch", Section: "tls", Required: false},
	}

	return []ProtocolFormDef{
		{
			Protocol: "shadowsocks", Name: "Shadowsocks", Defaults: map[string]any{"cipher": "aes-256-gcm"},
			Fields: []ProtocolFieldDef{
				{Key: "password", Label: "密码", Control: "secret", Section: "basic", Required: true},
				{Key: "cipher", Label: "加密方式", Control: "suggest", Section: "basic", Required: true, Options: []FieldOptionDef{
					{Value: "aes-128-gcm", Label: "aes-128-gcm"}, {Value: "aes-256-gcm", Label: "aes-256-gcm"},
					{Value: "chacha20-ietf-poly1305", Label: "chacha20-ietf-poly1305"}, {Value: "xchacha20-ietf-poly1305", Label: "xchacha20-ietf-poly1305"},
					{Value: "2022-blake3-aes-128-gcm", Label: "2022-blake3-aes-128-gcm"}, {Value: "2022-blake3-aes-256-gcm", Label: "2022-blake3-aes-256-gcm"},
					{Value: "2022-blake3-chacha20-poly1305", Label: "2022-blake3-chacha20-poly1305"}, {Value: "none", Label: "none"},
				}},
				{Key: "plugin", Label: "插件", Control: "suggest", Section: "basic", Required: false, Options: []FieldOptionDef{
					{Value: "obfs-local", Label: "obfs-local"}, {Value: "v2ray-plugin", Label: "v2ray-plugin"}, {Value: "shadow-tls", Label: "shadow-tls"},
				}},
				{Key: "pluginOpts", Label: "插件参数", Control: "text", Section: "basic", Required: false},
			},
		},
		{
			Protocol: "shadowsocksr", Name: "ShadowsocksR", Defaults: map[string]any{},
			Fields: []ProtocolFieldDef{
				{Key: "cipher", Label: "加密方式", Control: "suggest", Section: "basic", Required: true, Options: []FieldOptionDef{
					{Value: "aes-128-cfb", Label: "aes-128-cfb"}, {Value: "aes-256-cfb", Label: "aes-256-cfb"},
					{Value: "chacha20-ietf", Label: "chacha20-ietf"}, {Value: "rc4-md5", Label: "rc4-md5"}, {Value: "none", Label: "none"},
				}},
				{Key: "password", Label: "密码", Control: "secret", Section: "basic", Required: true},
				{Key: "ssrProtocol", Label: "协议", Control: "suggest", Section: "basic", Required: false, Options: []FieldOptionDef{
					{Value: "origin", Label: "origin"}, {Value: "auth_sha1_v4", Label: "auth_sha1_v4"},
					{Value: "auth_aes128_md5", Label: "auth_aes128_md5"}, {Value: "auth_aes128_sha1", Label: "auth_aes128_sha1"},
					{Value: "auth_chain_a", Label: "auth_chain_a"}, {Value: "auth_chain_b", Label: "auth_chain_b"},
				}},
				{Key: "ssrProtocolParam", Label: "协议参数", Control: "text", Section: "basic", Required: false},
				{Key: "ssrObfs", Label: "混淆", Control: "suggest", Section: "basic", Required: false, Options: []FieldOptionDef{
					{Value: "plain", Label: "plain"}, {Value: "http_simple", Label: "http_simple"}, {Value: "http_post", Label: "http_post"},
					{Value: "random_head", Label: "random_head"}, {Value: "tls1.2_ticket_auth", Label: "tls1.2_ticket_auth"}, {Value: "tls1.2_ticket_fastauth", Label: "tls1.2_ticket_fastauth"},
				}},
				{Key: "ssrObfsParam", Label: "混淆参数", Control: "text", Section: "basic", Required: false},
			},
		},
		{
			Protocol: "vmess", Name: "VMess", Defaults: map[string]any{"cipher": "auto", "alterId": 0},
			Fields: append(append([]ProtocolFieldDef{
				{Key: "uuid", Label: "UUID", Control: "secret", Section: "basic", Required: true},
				{Key: "cipher", Label: "加密方式", Control: "suggest", Section: "basic", Required: false, Options: []FieldOptionDef{
					{Value: "auto", Label: "auto"}, {Value: "aes-128-gcm", Label: "aes-128-gcm"},
					{Value: "chacha20-poly1305", Label: "chacha20-poly1305"}, {Value: "none", Label: "none"}, {Value: "zero", Label: "zero"},
				}},
				{Key: "alterId", Label: "alterId", Control: "number", Section: "basic", Required: false},
				{Key: "type", Label: "伪装类型", Control: "text", Section: "transport", Required: false},
			}, transportFields...), tlsFields...),
		},
		{
			Protocol: "vless", Name: "VLESS", Defaults: map[string]any{},
			Fields: append(append([]ProtocolFieldDef{
				{Key: "uuid", Label: "UUID", Control: "secret", Section: "basic", Required: true},
				{Key: "flow", Label: "流控（flow）", Control: "suggest", Section: "basic", Required: false, Options: []FieldOptionDef{
					{Value: "xtls-rprx-vision", Label: "xtls-rprx-vision"},
				}},
				{Key: "security", Label: "安全层", Control: "suggest", Section: "tls", Required: false, Options: []FieldOptionDef{
					{Value: "none", Label: "none"}, {Value: "tls", Label: "tls"}, {Value: "reality", Label: "reality"},
				}},
				{Key: "publicKey", Label: "公钥（public key）", Control: "text", Section: "tls", Required: false},
				{Key: "shortId", Label: "Short ID", Control: "text", Section: "tls", Required: false},
				{Key: "mode", Label: "mode", Control: "text", Section: "basic", Required: false},
				{Key: "encryption", Label: "encryption", Control: "text", Section: "basic", Required: false},
				{Key: "pqv", Label: "pqv", Control: "text", Section: "basic", Required: false},
			}, transportFields...), tlsFields...),
		},
		{
			Protocol: "trojan", Name: "Trojan", Defaults: map[string]any{"tls": true},
			Fields: append(append([]ProtocolFieldDef{
				{Key: "password", Label: "密码", Control: "secret", Section: "basic", Required: true},
			}, transportFields...), tlsFields...),
		},
		{
			Protocol: "hysteria2", Name: "Hysteria2", Defaults: map[string]any{"tls": true},
			Fields: append([]ProtocolFieldDef{
				{Key: "password", Label: "密码", Control: "secret", Section: "basic", Required: true},
				{Key: "insecure", Label: "跳过证书验证（协议层）", Control: "switch", Section: "tls", Required: false},
				{Key: "obfs", Label: "混淆", Control: "suggest", Section: "basic", Required: false, Options: []FieldOptionDef{{Value: "salamander", Label: "salamander"}}},
				{Key: "obfsPassword", Label: "混淆密码", Control: "secret", Section: "basic", Required: false},
				{Key: "upMbps", Label: "上行带宽（Mbps）", Control: "number", Section: "advanced", Required: false},
				{Key: "downMbps", Label: "下行带宽（Mbps）", Control: "number", Section: "advanced", Required: false},
				{Key: "ports", Label: "端口跳跃（端口列表）", Control: "text", Section: "advanced", Required: false},
				{Key: "hopInterval", Label: "端口跳跃间隔（秒）", Control: "number", Section: "advanced", Required: false},
			}, tlsFields...),
		},
		{
			Protocol: "hysteria", Name: "Hysteria", Defaults: map[string]any{"tls": true},
			Fields: append([]ProtocolFieldDef{
				{Key: "authStr", Label: "认证字符串", Control: "secret", Section: "basic", Required: false},
				{Key: "hysteriaProtocol", Label: "传输协议", Control: "suggest", Section: "basic", Required: false, Options: []FieldOptionDef{
					{Value: "udp", Label: "udp"}, {Value: "wechat-video", Label: "wechat-video"}, {Value: "faketcp", Label: "faketcp"},
				}},
				{Key: "obfs", Label: "混淆", Control: "text", Section: "basic", Required: false},
				{Key: "upMbps", Label: "上行带宽（Mbps）", Control: "number", Section: "advanced", Required: false},
				{Key: "downMbps", Label: "下行带宽（Mbps）", Control: "number", Section: "advanced", Required: false},
			}, tlsFields...),
		},
		{
			Protocol: "tuic", Name: "TUIC", Defaults: map[string]any{"tls": true, "congestionControl": "bbr", "alpn": []string{"h3"}},
			Fields: append([]ProtocolFieldDef{
				{Key: "uuid", Label: "UUID", Control: "secret", Section: "basic", Required: false},
				{Key: "password", Label: "密码", Control: "secret", Section: "basic", Required: false},
				{Key: "token", Label: "token", Control: "text", Section: "basic", Required: false},
				{Key: "congestionControl", Label: "拥塞控制", Control: "suggest", Section: "advanced", Required: false, Options: []FieldOptionDef{
					{Value: "bbr", Label: "bbr"}, {Value: "cubic", Label: "cubic"}, {Value: "new_reno", Label: "new_reno"},
				}},
				{Key: "udpRelayMode", Label: "UDP 转发模式", Control: "suggest", Section: "advanced", Required: false, Options: []FieldOptionDef{
					{Value: "native", Label: "native"}, {Value: "quic", Label: "quic"},
				}},
			}, tlsFields...),
		},
		{
			Protocol: "anytls", Name: "AnyTLS", Defaults: map[string]any{"tls": true},
			Fields: append([]ProtocolFieldDef{
				{Key: "password", Label: "密码", Control: "secret", Section: "basic", Required: true},
			}, tlsFields...),
		},
		{
			Protocol: "wireguard", Name: "WireGuard", Defaults: map[string]any{},
			Fields: []ProtocolFieldDef{
				{Key: "privateKey", Label: "私钥", Control: "secret", Section: "basic", Required: true},
				{Key: "publicKey", Label: "公钥（public key）", Control: "text", Section: "tls", Required: true},
				{Key: "presharedKey", Label: "预共享密钥", Control: "secret", Section: "basic", Required: false},
				{Key: "ip", Label: "本机 IPv4 地址", Control: "text", Section: "basic", Required: false},
				{Key: "ipv6", Label: "本机 IPv6 地址", Control: "text", Section: "basic", Required: false},
				{Key: "mtu", Label: "MTU", Control: "number", Section: "advanced", Required: false},
				{Key: "reserved", Label: "reserved", Control: "text", Section: "advanced", Required: false},
			},
		},
		{
			Protocol: "snell", Name: "Snell", Defaults: map[string]any{"version": 4},
			Fields: []ProtocolFieldDef{
				{Key: "psk", Label: "PSK", Control: "secret", Section: "basic", Required: true},
				{Key: "version", Label: "版本", Control: "select", Section: "basic", Required: false, Options: []FieldOptionDef{
					{Value: 1, Label: "1"}, {Value: 2, Label: "2"}, {Value: 3, Label: "3"}, {Value: 4, Label: "4"}, {Value: 5, Label: "5"},
				}},
				{Key: "obfs", Label: "混淆", Control: "suggest", Section: "basic", Required: false, Options: []FieldOptionDef{
					{Value: "http", Label: "http"}, {Value: "tls", Label: "tls"},
				}},
				{Key: "obfsHost", Label: "混淆 Host", Control: "text", Section: "basic", Required: false},
				{Key: "mode", Label: "mode", Control: "suggest", Section: "basic", Required: false, Options: []FieldOptionDef{
					{Value: "default", Label: "default"}, {Value: "unshaped", Label: "unshaped"}, {Value: "unsafe-raw", Label: "unsafe-raw"},
				}},
			},
		},
		{
			Protocol: "socks5", Name: "SOCKS5", Defaults: map[string]any{},
			Fields: []ProtocolFieldDef{
				{Key: "username", Label: "用户名", Control: "text", Section: "basic", Required: false},
				{Key: "password", Label: "密码", Control: "secret", Section: "basic", Required: false},
			},
		},
		{Protocol: "http", Name: "HTTP / HTTPS", Defaults: map[string]any{}, Fields: httpFields},
		{Protocol: "https", Name: "HTTP / HTTPS", Defaults: map[string]any{"tls": true}, Fields: httpFields},
		{
			Protocol: "ssh", Name: "SSH", Defaults: map[string]any{},
			Fields: []ProtocolFieldDef{
				{Key: "username", Label: "用户名", Control: "text", Section: "basic", Required: true},
				{Key: "password", Label: "密码", Control: "secret", Section: "basic", Required: false},
				{Key: "privateKey", Label: "私钥", Control: "secret", Section: "basic", Required: false},
				{Key: "privateKeyPassphrase", Label: "privateKeyPassphrase", Control: "text", Section: "basic", Required: false},
				{Key: "hostKey", Label: "hostKey", Control: "tags", Section: "basic", Required: false},
				{Key: "hostKeyAlgorithms", Label: "hostKeyAlgorithms", Control: "tags", Section: "basic", Required: false},
			},
		},
		{
			Protocol: "mieru", Name: "Mieru", Defaults: map[string]any{},
			Fields: []ProtocolFieldDef{
				{Key: "username", Label: "用户名", Control: "text", Section: "basic", Required: true},
				{Key: "password", Label: "密码", Control: "secret", Section: "basic", Required: true},
				{Key: "transport", Label: "transport", Control: "suggest", Section: "basic", Required: false, Options: []FieldOptionDef{{Value: "TCP", Label: "TCP"}, {Value: "UDP", Label: "UDP"}}},
				{Key: "multiplexing", Label: "multiplexing", Control: "suggest", Section: "basic", Required: false, Options: []FieldOptionDef{
					{Value: "MULTIPLEXING_OFF", Label: "MULTIPLEXING_OFF"}, {Value: "MULTIPLEXING_LOW", Label: "MULTIPLEXING_LOW"},
					{Value: "MULTIPLEXING_MIDDLE", Label: "MULTIPLEXING_MIDDLE"}, {Value: "MULTIPLEXING_HIGH", Label: "MULTIPLEXING_HIGH"},
				}},
				{Key: "handshakeMode", Label: "handshakeMode", Control: "suggest", Section: "basic", Required: false, Options: []FieldOptionDef{
					{Value: "HANDSHAKE_STANDARD", Label: "HANDSHAKE_STANDARD"}, {Value: "HANDSHAKE_NO_WAIT", Label: "HANDSHAKE_NO_WAIT"},
				}},
				{Key: "trafficPattern", Label: "trafficPattern", Control: "text", Section: "basic", Required: false},
				{Key: "ports", Label: "端口跳跃（端口列表）", Control: "text", Section: "advanced", Required: false},
			},
		},
		{
			Protocol: "naive", Name: "NaiveProxy", Defaults: map[string]any{},
			Fields: []ProtocolFieldDef{
				{Key: "username", Label: "用户名", Control: "text", Section: "basic", Required: true},
				{Key: "password", Label: "密码", Control: "secret", Section: "basic", Required: true},
				{Key: "quic", Label: "quic", Control: "switch", Section: "basic", Required: false},
				{Key: "sni", Label: "SNI", Control: "text", Section: "tls", Required: false},
			},
		},
	}
}

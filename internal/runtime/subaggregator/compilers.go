package subaggregator

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

const (
	SingBoxBaselineVersion = "1.12.0"
	sectionSlotPlaceholder = "@@aih-section@@"
	shadowTLSHideMark      = "§hide§"
)

var (
	surgeSpecialValuePattern = regexp.MustCompile(`[,=]|^\s|\s$`)
	multiSpacePattern        = regexp.MustCompile(`\s+`)
	surgeNameBadChars        = strings.NewReplacer(",", " ", "=", " ")
	versionPattern           = regexp.MustCompile(`^(\d+)\.(\d+)(?:\.(\d+))?`)
	unsafePluginKeySet       = map[string]bool{"__proto__": true, "prototype": true, "constructor": true}
	safeYAMLPluginKeyPattern = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
	reservedBytes3Pattern    = regexp.MustCompile(`^\d{1,3}(?:\s*,\s*\d{1,3}){2}$`)
	tunnelMaskSuffixPattern  = regexp.MustCompile(`/(?:32|128)$`)
	egernSecuritySet         = map[string]bool{"auto": true, "aes-128-gcm": true, "chacha20-poly1305": true, "none": true, "zero": true}
)

// CompiledLineEntry 表示行式渲染器（Surge/Surfboard/Loon/Quantumult X）的单节点编译结果。
type CompiledLineEntry struct {
	Line     string
	Sections []CompiledSection
}

// CompiledSection 描述附加段落（如 Surge/Surfboard WireGuard 的 [WireGuard wg1]）。
type CompiledSection struct {
	Header string
	Prefix string
	Lines  []string
}

// SingBoxCompiled 表示 sing-box 单节点编译结果（主出站/endpoint 与附加 ShadowTLS 出站）。
type SingBoxCompiled struct {
	Item       *YAMLMap
	IsEndpoint bool
	Extras     []*YAMLMap
	ChainTag   string
}

// canonicalSSPlugin 描述统一归一化后的 Shadowsocks 插件参数。
type canonicalSSPlugin struct {
	Name       string
	Mode       string
	Host       string
	URI        string
	TLS        bool
	Path       string
	Password   string
	Version    string
	RawOptions map[string]any
}

// SupportsUDPRelay 判断节点协议是否支持 UDP 转发（http/https 为 false，snell 需 >=3）。
func SupportsUDPRelay(node ProxyNode) bool {
	p := NormalizeProtocolAlias(node.Str("protocol"))
	if p == "http" || p == "https" {
		return false
	}
	if p == "snell" {
		v, ok := node.Int("version")
		return ok && v >= 3
	}
	return true
}

func formatServerHost(host string) string {
	h := normalizeServerHost(host)
	if h == "" {
		return ""
	}
	if strings.Contains(h, ":") && !strings.HasPrefix(h, "[") {
		if ip := net.ParseIP(h); ip != nil {
			return "[" + h + "]"
		}
	}
	return h
}

// SanitizeSurgeName 清洗 Surge 系节点/组名中的逗号与等号。
func SanitizeSurgeName(name string) string {
	cleaned := surgeNameBadChars.Replace(name)
	cleaned = multiSpacePattern.ReplaceAllString(cleaned, " ")
	return strings.TrimSpace(cleaned)
}

type surgeVal struct {
	Text   string
	Quoted bool
	Raw    bool
}

func surgeKV(v any) (string, bool) {
	switch t := v.(type) {
	case nil:
		return "", false
	case surgeVal:
		if t.Raw {
			return t.Text, true
		}
		if t.Quoted {
			return `"` + t.Text + `"`, true
		}
		if t.Text == "" {
			return "", false
		}
		if surgeSpecialValuePattern.MatchString(t.Text) {
			return `"` + t.Text + `"`, true
		}
		return t.Text, true
	case string:
		if t == "" {
			return "", false
		}
		if surgeSpecialValuePattern.MatchString(t) {
			return `"` + t + `"`, true
		}
		return t, true
	case bool:
		if t {
			return "true", true
		}
		return "false", true
	case int:
		return strconv.Itoa(t), true
	case int64:
		return strconv.FormatInt(t, 10), true
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64), true
	default:
		s := fmt.Sprint(t)
		if s == "" {
			return "", false
		}
		if surgeSpecialValuePattern.MatchString(s) {
			return `"` + s + `"`, true
		}
		return s, true
	}
}

// FormatSurgeLine 格式化 Surge / Surfboard / Loon 的单条代理行。
func FormatSurgeLine(name, proxyType string, args []any, params []YAMLKV) string {
	parts := []string{proxyType}
	for _, a := range args {
		if s, ok := surgeKV(a); ok {
			parts = append(parts, s)
		}
	}
	for _, kv := range params {
		if s, ok := surgeKV(kv.Value); ok {
			parts = append(parts, kv.Key+"="+s)
		}
	}
	return name + " = " + strings.Join(parts, ", ")
}

// FormatQuantumultXLine 格式化 Quantumult X [server_local] 行。
func FormatQuantumultXLine(name, proxyType, server string, port int, params []YAMLKV) string {
	parts := []string{fmt.Sprintf("%s=%s:%d", proxyType, formatServerHost(server), port)}
	for _, kv := range params {
		switch v := kv.Value.(type) {
		case nil:
			continue
		case string:
			if v == "" {
				continue
			}
			parts = append(parts, kv.Key+"="+v)
		case bool:
			if v {
				parts = append(parts, kv.Key+"=true")
			} else {
				parts = append(parts, kv.Key+"=false")
			}
		default:
			s := fmt.Sprint(v)
			if s != "" {
				parts = append(parts, kv.Key+"="+s)
			}
		}
	}
	parts = append(parts, "tag="+SanitizeSurgeName(name))
	return strings.Join(parts, ", ")
}

func collectSurgeLines(entries []CompiledLineEntry) (lines []string, sections []string) {
	count := 0
	for _, e := range entries {
		line := e.Line
		for _, sec := range e.Sections {
			count++
			prefix := sec.Prefix
			if prefix == "" {
				prefix = "section"
			}
			secName := fmt.Sprintf("%s%d", prefix, count)
			line = strings.ReplaceAll(line, sectionSlotPlaceholder, secName)
			sections = append(sections, fmt.Sprintf("[%s %s]", sec.Header, secName))
			sections = append(sections, sec.Lines...)
			sections = append(sections, "")
		}
		lines = append(lines, line)
	}
	return lines, sections
}

func formatPortRanges(raw any, rangeSep string, listSep string, alwaysRange bool) (string, error) {
	norm := normalizePortRanges(raw)
	if norm == "" {
		return "", nil
	}
	tokens := strings.Split(norm, ",")
	parts := make([]string, 0, len(tokens))
	for _, tok := range tokens {
		tok = strings.TrimSpace(tok)
		if tok == "" {
			continue
		}
		a, b, has := strings.Cut(tok, "-")
		if !has {
			if alwaysRange {
				parts = append(parts, a+rangeSep+a)
			} else {
				parts = append(parts, a)
			}
		} else {
			parts = append(parts, a+rangeSep+b)
		}
	}
	return strings.Join(parts, listSep), nil
}

func canonicalShadowsocksPlugin(node ProxyNode) *canonicalSSPlugin {
	name := strings.TrimSpace(node.Str("plugin"))
	if name == "" {
		return nil
	}
	opts := parsePluginOptsMap(node["pluginOpts"])
	if name == "obfs" || name == "obfs-local" || name == "simple-obfs" {
		return &canonicalSSPlugin{
			Name: "obfs",
			Mode: firstNonEmpty(toString(opts["obfs"]), toString(opts["mode"])),
			Host: firstNonEmpty(toString(opts["obfs-host"]), toString(opts["host"])),
			URI:  firstNonEmpty(toString(opts["obfs-uri"]), toString(opts["uri"]), toString(opts["path"])),
		}
	}
	if name == "v2ray-plugin" {
		tlsFlag := false
		if b, ok := toBool(opts["tls"]); ok {
			tlsFlag = b
		}
		return &canonicalSSPlugin{
			Name: "v2ray-plugin",
			Mode: firstNonEmpty(toString(opts["mode"]), "websocket"),
			TLS:  tlsFlag,
			Host: toString(opts["host"]),
			Path: toString(opts["path"]),
		}
	}
	if name == "shadow-tls" {
		return &canonicalSSPlugin{
			Name:     "shadow-tls",
			Host:     firstNonEmpty(toString(opts["host"]), toString(opts["sni"]), toString(opts["shadow-tls-sni"])),
			Password: firstNonEmpty(toString(opts["password"]), toString(opts["shadow-tls-password"])),
			Version:  firstNonEmpty(toString(opts["version"]), toString(opts["shadow-tls-version"])),
		}
	}
	cleanOpts := map[string]any{}
	for k, v := range opts {
		if !unsafePluginKeySet[k] {
			cleanOpts[k] = v
		}
	}
	return &canonicalSSPlugin{Name: name, RawOptions: cleanOpts}
}

func toClashPlugin(canonical *canonicalSSPlugin) (string, *YAMLMap, error) {
	if canonical == nil {
		return "", nil, nil
	}
	opts := &YAMLMap{}
	switch canonical.Name {
	case "obfs":
		if canonical.Mode != "" {
			opts.Set("mode", canonical.Mode)
		}
		if canonical.Host != "" {
			opts.Set("host", canonical.Host)
		}
		return "obfs", opts, nil
	case "v2ray-plugin":
		if canonical.Mode != "" {
			opts.Set("mode", canonical.Mode)
		}
		opts.Set("tls", canonical.TLS)
		if canonical.Host != "" {
			opts.Set("host", canonical.Host)
		}
		if canonical.Path != "" {
			opts.Set("path", canonical.Path)
		}
		return "v2ray-plugin", opts, nil
	case "shadow-tls":
		if canonical.Host != "" {
			opts.Set("host", canonical.Host)
		}
		if canonical.Password != "" {
			opts.Set("password", canonical.Password)
		}
		if canonical.Version != "" {
			if n, err := strconv.Atoi(canonical.Version); err == nil && n > 0 {
				opts.Set("version", n)
			} else {
				opts.Set("version", canonical.Version)
			}
		}
		return "shadow-tls", opts, nil
	default:
		keys := make([]string, 0, len(canonical.RawOptions))
		for k := range canonical.RawOptions {
			if !safeYAMLPluginKeyPattern.MatchString(k) || unsafePluginKeySet[k] {
				return "", nil, errInvalid("unsupported_shadowsocks_plugin_option")
			}
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			opts.Set(k, canonical.RawOptions[k])
		}
		return canonical.Name, opts, nil
	}
}

func toSIP003Plugin(canonical *canonicalSSPlugin) (string, string) {
	if canonical == nil {
		return "", ""
	}
	joinPairs := func(pairs [][2]any) string {
		var parts []string
		for _, p := range pairs {
			k := fmt.Sprint(p[0])
			switch v := p[1].(type) {
			case nil:
				continue
			case bool:
				if v {
					parts = append(parts, k)
				}
			case string:
				if v != "" {
					parts = append(parts, k+"="+v)
				}
			}
		}
		return strings.Join(parts, ";")
	}
	switch canonical.Name {
	case "obfs":
		return "obfs-local", joinPairs([][2]any{{"obfs", canonical.Mode}, {"obfs-host", canonical.Host}, {"obfs-uri", canonical.URI}})
	case "v2ray-plugin":
		return "v2ray-plugin", joinPairs([][2]any{{"mode", canonical.Mode}, {"tls", canonical.TLS}, {"host", canonical.Host}, {"path", canonical.Path}})
	case "shadow-tls":
		return "shadow-tls", joinPairs([][2]any{{"host", canonical.Host}, {"password", canonical.Password}, {"version", canonical.Version}})
	default:
		keys := make([]string, 0, len(canonical.RawOptions))
		for k := range canonical.RawOptions {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		pairs := make([][2]any, 0, len(keys))
		for _, k := range keys {
			pairs = append(pairs, [2]any{k, canonical.RawOptions[k]})
		}
		return canonical.Name, joinPairs(pairs)
	}
}

func reqNodeString(node ProxyNode, field string) (string, error) {
	v := strings.TrimSpace(node.Str(field))
	if v == "" {
		return "", errInvalid("missing_required_proxy_field_" + field)
	}
	return v, nil
}

func reqNodeRawString(node ProxyNode, field string) (string, error) {
	raw, ok := node[field]
	if !ok {
		return "", errInvalid("missing_required_proxy_field_" + field)
	}
	s, ok := raw.(string)
	if !ok || s == "" {
		return "", errInvalid("missing_required_proxy_field_" + field)
	}
	return s, nil
}

func nodeInsecure(node ProxyNode) bool {
	if b, ok := node.Bool("allowInsecure"); ok && b {
		return true
	}
	if b, ok := node.Bool("insecure"); ok && b {
		return true
	}
	return false
}

func applyMihomoTransport(node ProxyNode, proxy *YAMLMap) error {
	network := strings.ToLower(strings.TrimSpace(node.Str("network")))
	if network == "" {
		network = "tcp"
	}
	if !isSupportedTransport(network) {
		return errInvalid("unsupported_proxy_transport_" + network)
	}
	if network == "httpupgrade" {
		proxy.Set("network", "ws")
	} else {
		proxy.Set("network", network)
	}
	path := node.Str("path")
	if path == "" {
		path = "/"
	}
	host := node.Str("host")
	switch network {
	case "ws", "httpupgrade":
		ws := &YAMLMap{}
		ws.Set("path", path)
		if host != "" {
			hdr := &YAMLMap{}
			hdr.Set("Host", host)
			ws.Set("headers", hdr)
		}
		if network == "httpupgrade" {
			ws.Set("v2ray-http-upgrade", true)
		}
		proxy.Set("ws-opts", ws)
	case "grpc":
		g := &YAMLMap{}
		g.Set("grpc-service-name", node.Str("serviceName"))
		proxy.Set("grpc-opts", g)
	case "h2":
		h2 := &YAMLMap{}
		if host != "" {
			h2.Set("host", []string{host})
		}
		h2.Set("path", path)
		proxy.Set("h2-opts", h2)
	case "http":
		ho := &YAMLMap{}
		ho.Set("method", "GET")
		ho.Set("path", []string{path})
		if host != "" {
			hdr := &YAMLMap{}
			hdr.Set("Host", []string{host})
			ho.Set("headers", hdr)
		}
		proxy.Set("http-opts", ho)
	case "xhttp":
		xo := &YAMLMap{}
		xo.Set("path", path)
		if host != "" {
			xo.Set("host", host)
		}
		if mode := node.Str("mode"); mode != "" {
			xo.Set("mode", mode)
		}
		proxy.Set("xhttp-opts", xo)
	}
	return nil
}

func applyMihomoTLS(node ProxyNode, proxy *YAMLMap, forceTLS bool) {
	if b, ok := node.Bool("tls"); (ok && b) || forceTLS {
		proxy.Set("tls", true)
	}
	if sni := node.Str("sni"); sni != "" {
		proxy.Set("servername", sni)
	}
	if alpn := normalizeStringSlice(node["alpn"]); len(alpn) > 0 {
		proxy.Set("alpn", alpn)
	}
	if nodeInsecure(node) {
		proxy.Set("skip-cert-verify", true)
	}
}

func wireguardReservedValue(raw any) (any, bool) {
	if raw == nil {
		return nil, false
	}
	if arr, ok := raw.([]any); ok && len(arr) > 0 {
		out := make([]int, 0, len(arr))
		for _, v := range arr {
			if n, ok := toInt(v); ok {
				out = append(out, n)
			}
		}
		if len(out) > 0 {
			return out, true
		}
	}
	if arr, ok := raw.([]int); ok && len(arr) > 0 {
		return arr, true
	}
	s := strings.TrimSpace(toString(raw))
	if s == "" {
		return nil, false
	}
	if reservedBytes3Pattern.MatchString(s) {
		parts := strings.Split(s, ",")
		out := make([]int, 3)
		for i := 0; i < 3; i++ {
			n, _ := strconv.Atoi(strings.TrimSpace(parts[i]))
			out[i] = n
		}
		return out, true
	}
	return s, true
}

func wireguardReservedBytes(raw any) ([]int, bool, error) {
	val, ok := wireguardReservedValue(raw)
	if !ok {
		return nil, false, nil
	}
	if arr, isArr := val.([]int); isArr {
		if len(arr) != 3 {
			return nil, false, errInvalid("invalid_proxy_field_reserved")
		}
		for _, b := range arr {
			if b < 0 || b > 255 {
				return nil, false, errInvalid("invalid_proxy_field_reserved")
			}
		}
		return arr, true, nil
	}
	b, err := base64.StdEncoding.DecodeString(fmt.Sprint(val))
	if err != nil || len(b) != 3 {
		return nil, false, errInvalid("invalid_proxy_field_reserved")
	}
	return []int{int(b[0]), int(b[1]), int(b[2])}, true, nil
}

func wireguardAddresses(node ProxyNode) ([]string, error) {
	var out []string
	if ip := strings.TrimSpace(node.Str("ip")); ip != "" {
		if strings.Contains(ip, "/") {
			out = append(out, ip)
		} else {
			out = append(out, ip+"/32")
		}
	}
	if ip6 := strings.TrimSpace(node.Str("ipv6")); ip6 != "" {
		if strings.Contains(ip6, "/") {
			out = append(out, ip6)
		} else {
			out = append(out, ip6+"/128")
		}
	}
	if len(out) == 0 {
		return nil, errInvalid("missing_required_proxy_field_ip")
	}
	return out, nil
}

func wireguardTunnelAddresses(node ProxyNode) (ip string, ipv6 string, err error) {
	ip = tunnelMaskSuffixPattern.ReplaceAllString(strings.TrimSpace(node.Str("ip")), "")
	ipv6 = tunnelMaskSuffixPattern.ReplaceAllString(strings.TrimSpace(node.Str("ipv6")), "")
	if ip == "" && ipv6 == "" {
		return "", "", errInvalid("missing_required_proxy_field_ip")
	}
	return ip, ipv6, nil
}

func textListFromNode(raw any) []string {
	if raw == nil {
		return nil
	}
	if arr, ok := raw.([]string); ok {
		if len(arr) > 0 {
			return arr
		}
		return nil
	}
	return normalizeStringSlice(raw)
}

func validateHysteriaBandwidth(node ProxyNode, field string) (float64, error) {
	f, ok := node.Float(field)
	if !ok || f <= 0 {
		return 0, errInvalid("missing_required_proxy_field_" + field)
	}
	return f, nil
}

// CompileMihomoProxy 将节点编译为 mihomo/clash-classic/stash 条目。
func CompileMihomoProxy(node ProxyNode, name, target string) (*YAMLMap, error) {
	proto := NormalizeProtocolAlias(node.Str("protocol"))
	server := normalizeServerHost(node.Str("server"))
	if server == "" {
		return nil, errInvalid("missing_required_proxy_field_server")
	}
	port, ok := node.Int("port")
	if !ok || !isValidPort(port) {
		return nil, errInvalid("invalid_proxy_port")
	}
	proxy := &YAMLMap{}
	proxy.Set("name", name)
	proxy.Set("server", server)
	proxy.Set("port", port)

	switch proto {
	case "shadowsocks":
		cipher, err := reqNodeRawString(node, "cipher")
		if err != nil {
			return nil, err
		}
		pass, err := reqNodeRawString(node, "password")
		if err != nil {
			return nil, err
		}
		proxy.Set("type", "ss")
		proxy.Set("cipher", cipher)
		proxy.Set("password", pass)
		if pName, pOpts, err := toClashPlugin(canonicalShadowsocksPlugin(node)); err != nil {
			return nil, err
		} else if pName != "" {
			proxy.Set("plugin", pName)
			if pOpts != nil && len(pOpts.Entries) > 0 {
				proxy.Set("plugin-opts", pOpts)
			}
		}
	case "shadowsocksr":
		cipher, err := reqNodeRawString(node, "cipher")
		if err != nil {
			return nil, err
		}
		pass, err := reqNodeRawString(node, "password")
		if err != nil {
			return nil, err
		}
		proxy.Set("type", "ssr")
		proxy.Set("cipher", cipher)
		proxy.Set("password", pass)
		proxy.Set("protocol", firstNonEmpty(node.Str("ssrProtocol"), "origin"))
		if pp := node.Str("ssrProtocolParam"); pp != "" {
			proxy.Set("protocol-param", pp)
		}
		proxy.Set("obfs", firstNonEmpty(node.Str("ssrObfs"), "plain"))
		if op := node.Str("ssrObfsParam"); op != "" {
			proxy.Set("obfs-param", op)
		}
	case "vmess":
		if t := node.Str("type"); t != "" && t != "none" {
			return nil, errInvalid("unsupported_proxy_field_type_" + t)
		}
		uuid, err := reqNodeRawString(node, "uuid")
		if err != nil {
			return nil, err
		}
		proxy.Set("type", "vmess")
		proxy.Set("uuid", uuid)
		alt := 0
		if n, ok := node.Int("alterId"); ok {
			alt = n
		}
		proxy.Set("alterId", alt)
		proxy.Set("cipher", firstNonEmpty(node.Str("cipher"), "auto"))
		if err := applyMihomoTransport(node, proxy); err != nil {
			return nil, err
		}
		applyMihomoTLS(node, proxy, false)
	case "vless":
		uuid, err := reqNodeRawString(node, "uuid")
		if err != nil {
			return nil, err
		}
		proxy.Set("type", "vless")
		proxy.Set("uuid", uuid)
		if err := applyMihomoTransport(node, proxy); err != nil {
			return nil, err
		}
		applyMihomoTLS(node, proxy, false)
		if flow := node.Str("flow"); flow != "" {
			proxy.Set("flow", flow)
		}
		if enc := strings.TrimSpace(node.Str("encryption")); enc != "" && strings.ToLower(enc) != "none" {
			proxy.Set("encryption", enc)
		}
		tlsB, _ := node.Bool("tls")
		sec := strings.ToLower(node.Str("security"))
		if sec == "" {
			if tlsB {
				sec = "tls"
			} else {
				sec = "none"
			}
		}
		if sec != "none" && sec != "tls" && sec != "reality" {
			return nil, errInvalid("unsupported_proxy_security_" + sec)
		}
		if sec == "tls" {
			proxy.Set("tls", true)
		}
		pubKey := node.Str("publicKey")
		if sec == "reality" || pubKey != "" {
			if pubKey == "" {
				return nil, errInvalid("missing_required_proxy_field_publicKey")
			}
			proxy.Set("tls", true)
			ro := &YAMLMap{}
			ro.Set("public-key", pubKey)
			ro.Set("short-id", node.Str("shortId"))
			proxy.Set("reality-opts", ro)
			proxy.Set("client-fingerprint", firstNonEmpty(node.Str("fingerprint"), "chrome"))
		} else if fp := node.Str("fingerprint"); fp != "" {
			proxy.Set("client-fingerprint", fp)
		}
	case "trojan":
		pass, err := reqNodeRawString(node, "password")
		if err != nil {
			return nil, err
		}
		proxy.Set("type", "trojan")
		proxy.Set("password", pass)
		if err := applyMihomoTransport(node, proxy); err != nil {
			return nil, err
		}
		applyMihomoTLS(node, proxy, true)
	case "hysteria":
		up, err := validateHysteriaBandwidth(node, "upMbps")
		if err != nil {
			return nil, err
		}
		down, err := validateHysteriaBandwidth(node, "downMbps")
		if err != nil {
			return nil, err
		}
		proxy.Set("type", "hysteria")
		proxy.Set("up", fmt.Sprintf("%g Mbps", up))
		proxy.Set("down", fmt.Sprintf("%g Mbps", down))
		if a := node.Str("authStr"); a != "" {
			proxy.Set("auth-str", a)
		}
		if hp := node.Str("hysteriaProtocol"); hp != "" {
			proxy.Set("protocol", hp)
		}
		if obfs := node.Str("obfs"); obfs != "" {
			proxy.Set("obfs", obfs)
		}
		if sni := node.Str("sni"); sni != "" {
			proxy.Set("sni", sni)
		}
		if alpn := normalizeStringSlice(node["alpn"]); len(alpn) > 0 {
			proxy.Set("alpn", alpn)
		}
		if nodeInsecure(node) {
			proxy.Set("skip-cert-verify", true)
		}
	case "hysteria2":
		pass, err := reqNodeRawString(node, "password")
		if err != nil {
			return nil, err
		}
		proxy.Set("type", "hysteria2")
		proxy.Set("password", pass)
		if sni := node.Str("sni"); sni != "" {
			proxy.Set("sni", sni)
		}
		proxy.Set("skip-cert-verify", nodeInsecure(node))
		if obfs := node.Str("obfs"); obfs != "" {
			opw, err := reqNodeRawString(node, "obfsPassword")
			if err != nil {
				return nil, err
			}
			proxy.Set("obfs", obfs)
			proxy.Set("obfs-password", opw)
		}
		if rawUp, ok := node["upMbps"]; ok && rawUp != nil && rawUp != "" {
			up, okF := toFloat(rawUp)
			if !okF || up <= 0 {
				return nil, errInvalid("invalid_proxy_field_upMbps")
			}
			proxy.Set("up", fmt.Sprintf("%g Mbps", up))
		}
		if rawDown, ok := node["downMbps"]; ok && rawDown != nil && rawDown != "" {
			down, okF := toFloat(rawDown)
			if !okF || down <= 0 {
				return nil, errInvalid("invalid_proxy_field_downMbps")
			}
			proxy.Set("down", fmt.Sprintf("%g Mbps", down))
		}
		if ports := normalizePortRanges(node["ports"]); ports != "" {
			proxy.Set("ports", ports)
		}
		if rawHop, ok := node["hopInterval"]; ok && rawHop != nil && rawHop != "" {
			hv, okH := parseHopInterval(rawHop)
			if !okH {
				return nil, errInvalid("invalid_proxy_field_hopInterval")
			}
			proxy.Set("hop-interval", hv)
		}
	case "tuic":
		proxy.Set("type", "tuic")
		if uuid, pass := node.Str("uuid"), node.Str("password"); uuid != "" && pass != "" {
			proxy.Set("uuid", uuid)
			proxy.Set("password", pass)
		} else {
			if target != "stash" {
				return nil, errInvalid("unsupported_proxy_protocol_tuic-v4")
			}
			tok, err := reqNodeRawString(node, "token")
			if err != nil {
				return nil, err
			}
			proxy.Set("token", tok)
		}
		if alpn := normalizeStringSlice(node["alpn"]); len(alpn) > 0 {
			proxy.Set("alpn", alpn)
		}
		if cc := node.Str("congestionControl"); cc != "" {
			proxy.Set("congestion-controller", cc)
		}
		if ur := node.Str("udpRelayMode"); ur != "" {
			proxy.Set("udp-relay-mode", ur)
		}
		if sni := node.Str("sni"); sni != "" {
			proxy.Set("sni", sni)
		}
		if nodeInsecure(node) {
			proxy.Set("skip-cert-verify", true)
		}
	case "anytls":
		pass, err := reqNodeRawString(node, "password")
		if err != nil {
			return nil, err
		}
		proxy.Set("type", "anytls")
		proxy.Set("password", pass)
		applyMihomoTLS(node, proxy, false)
		if sn, ok := proxy.Get("servername"); ok {
			proxy.Set("sni", sn)
			proxy.Delete("servername")
		}
		proxy.Delete("tls")
		if fp := node.Str("fingerprint"); fp != "" {
			proxy.Set("client-fingerprint", fp)
		}
	case "wireguard":
		pk, err := reqNodeRawString(node, "privateKey")
		if err != nil {
			return nil, err
		}
		pub, err := reqNodeRawString(node, "publicKey")
		if err != nil {
			return nil, err
		}
		if _, err := wireguardAddresses(node); err != nil {
			return nil, err
		}
		proxy.Set("type", "wireguard")
		proxy.Set("private-key", pk)
		proxy.Set("public-key", pub)
		if ip := node.Str("ip"); ip != "" {
			proxy.Set("ip", ip)
		}
		if ipv6 := node.Str("ipv6"); ipv6 != "" {
			proxy.Set("ipv6", ipv6)
		}
		if psk := node.Str("presharedKey"); psk != "" {
			proxy.Set("pre-shared-key", psk)
		}
		if mtu, ok := node.Int("mtu"); ok && mtu > 0 {
			proxy.Set("mtu", mtu)
		}
		if res, ok := wireguardReservedValue(node["reserved"]); ok {
			proxy.Set("reserved", res)
		}
	case "snell":
		if ver, ok := node.Int("version"); ok && ver > 0 && ver != 1 && ver != 2 && ver != 3 {
			return nil, errInvalid(fmt.Sprintf("unsupported_snell_version_%d", ver))
		}
		psk, err := reqNodeRawString(node, "psk")
		if err != nil {
			return nil, err
		}
		proxy.Set("type", "snell")
		proxy.Set("psk", psk)
		if ver, ok := node.Int("version"); ok && ver > 0 {
			proxy.Set("version", ver)
		}
		if obfs := node.Str("obfs"); obfs != "" {
			oo := &YAMLMap{}
			oo.Set("mode", obfs)
			if oh := node.Str("obfsHost"); oh != "" {
				oo.Set("host", oh)
			}
			proxy.Set("obfs-opts", oo)
		}
	case "socks5":
		proxy.Set("type", "socks5")
		if u := node.Str("username"); u != "" {
			proxy.Set("username", u)
		}
		if p := node.Str("password"); p != "" {
			proxy.Set("password", p)
		}
	case "http", "https":
		proxy.Set("type", "http")
		if u := node.Str("username"); u != "" {
			proxy.Set("username", u)
		}
		if p := node.Str("password"); p != "" {
			proxy.Set("password", p)
		}
		tlsB, _ := node.Bool("tls")
		if proto == "https" || tlsB {
			proxy.Set("tls", true)
			if sni := node.Str("sni"); sni != "" {
				proxy.Set("sni", sni)
			}
			if b, ok := node.Bool("allowInsecure"); ok && b {
				proxy.Set("skip-cert-verify", true)
			}
		}
	case "ssh":
		user, err := reqNodeRawString(node, "username")
		if err != nil {
			return nil, err
		}
		proxy.Set("type", "ssh")
		proxy.Set("username", user)
		if p := node.Str("password"); p != "" {
			proxy.Set("password", p)
		}
		if pk := node.Str("privateKey"); pk != "" {
			proxy.Set("private-key", pk)
		}
		if pp := node.Str("privateKeyPassphrase"); pp != "" {
			proxy.Set("private-key-passphrase", pp)
		}
		if hk := textListFromNode(node["hostKey"]); len(hk) > 0 {
			proxy.Set("host-key", hk)
		}
		if alg := textListFromNode(node["hostKeyAlgorithms"]); len(alg) > 0 {
			proxy.Set("host-key-algorithms", alg)
		}
	case "mieru":
		user, err := reqNodeRawString(node, "username")
		if err != nil {
			return nil, err
		}
		pass, err := reqNodeRawString(node, "password")
		if err != nil {
			return nil, err
		}
		tr := strings.ToUpper(strings.TrimSpace(node.Str("transport")))
		if tr == "" {
			return nil, errInvalid("missing_required_proxy_field_transport")
		}
		if tr != "TCP" && tr != "UDP" {
			return nil, errInvalid("invalid_proxy_field_transport")
		}
		proxy.Set("type", "mieru")
		proxy.Set("username", user)
		proxy.Set("password", pass)
		proxy.Set("transport", tr)
		if mp := strings.ToUpper(strings.TrimSpace(node.Str("multiplexing"))); mp != "" {
			proxy.Set("multiplexing", mp)
		}
		if hm := strings.ToUpper(strings.TrimSpace(node.Str("handshakeMode"))); hm != "" {
			proxy.Set("handshake-mode", hm)
		}
		if tp := node.Str("trafficPattern"); tp != "" {
			proxy.Set("traffic-pattern", tp)
		}
		if ports := normalizePortRanges(node["ports"]); ports != "" {
			proxy.Delete("port")
			proxy.Set("port-range", ports)
		}
	default:
		if proto == "" {
			proto = "empty"
		}
		return nil, errInvalid("unsupported_proxy_protocol_" + proto)
	}
	return proxy, nil
}

// VersionAtLeast 比较 sing-box 语义版本号。
func VersionAtLeast(version, minimum string) bool {
	parseVer := func(s string) [3]int {
		m := versionPattern.FindStringSubmatch(strings.TrimSpace(s))
		if len(m) == 0 {
			return [3]int{}
		}
		a, _ := strconv.Atoi(m[1])
		b, _ := strconv.Atoi(m[2])
		c, _ := strconv.Atoi(m[3])
		return [3]int{a, b, c}
	}
	v := version
	if strings.TrimSpace(v) == "" {
		v = SingBoxBaselineVersion
	}
	left := parseVer(v)
	right := parseVer(minimum)
	for i := 0; i < 3; i++ {
		if left[i] != right[i] {
			return left[i] > right[i]
		}
	}
	return true
}

func buildSingBoxTransport(node ProxyNode) (*YAMLMap, error) {
	network := strings.ToLower(strings.TrimSpace(node.Str("network")))
	if network == "" {
		network = "tcp"
	}
	if !isSupportedTransport(network) {
		return nil, errInvalid("unsupported_proxy_transport_" + network)
	}
	if network == "tcp" {
		return nil, nil
	}
	path := strings.TrimSpace(node.Str("path"))
	host := strings.TrimSpace(node.Str("host"))
	tr := &YAMLMap{}
	switch network {
	case "ws":
		tr.Set("type", "ws")
		if path != "" {
			tr.Set("path", path)
		}
		if host != "" {
			hdr := &YAMLMap{}
			hdr.Set("Host", host)
			tr.Set("headers", hdr)
		}
		return tr, nil
	case "httpupgrade":
		tr.Set("type", "httpupgrade")
		if path != "" {
			tr.Set("path", path)
		}
		if host != "" {
			tr.Set("host", host)
		}
		return tr, nil
	case "h2", "http":
		tr.Set("type", "http")
		if host != "" {
			tr.Set("host", []string{host})
		}
		if path != "" {
			tr.Set("path", path)
		}
		if network == "http" {
			tr.Set("method", "GET")
		}
		return tr, nil
	case "grpc":
		tr.Set("type", "grpc")
		if sn := strings.TrimSpace(node.Str("serviceName")); sn != "" {
			tr.Set("service_name", sn)
		}
		return tr, nil
	default:
		return nil, errInvalid("unsupported_proxy_transport_" + network)
	}
}

func buildSingBoxTLS(node ProxyNode, force bool) (*YAMLMap, error) {
	sec := strings.ToLower(strings.TrimSpace(node.Str("security")))
	reality := sec == "reality"
	tlsFlag, _ := node.Bool("tls")
	if !force && !reality && !tlsFlag && sec != "tls" {
		return nil, nil
	}
	tlsObj := &YAMLMap{}
	tlsObj.Set("enabled", true)
	if sni := strings.TrimSpace(node.Str("sni")); sni != "" {
		tlsObj.Set("server_name", sni)
	}
	if nodeInsecure(node) {
		tlsObj.Set("insecure", true)
	}
	if alpn := normalizeStringSlice(node["alpn"]); len(alpn) > 0 {
		tlsObj.Set("alpn", alpn)
	}
	if reality {
		pubKey, err := reqNodeString(node, "publicKey")
		if err != nil {
			return nil, err
		}
		rObj := &YAMLMap{}
		rObj.Set("enabled", true)
		rObj.Set("public_key", pubKey)
		if sid := strings.TrimSpace(node.Str("shortId")); sid != "" {
			rObj.Set("short_id", sid)
		}
		tlsObj.Set("reality", rObj)
	}
	fp := strings.TrimSpace(node.Str("fingerprint"))
	if fp == "" && reality {
		fp = "chrome"
	}
	if fp != "" {
		utls := &YAMLMap{}
		utls.Set("enabled", true)
		utls.Set("fingerprint", fp)
		tlsObj.Set("utls", utls)
	}
	return tlsObj, nil
}

func hiddenShadowTLSTag(tag string) string {
	t := strings.TrimSpace(tag)
	if t == "" {
		t = "node"
	}
	if strings.Contains(t, shadowTLSHideMark) {
		return t
	}
	return t + shadowTLSHideMark
}

// CompileSingBoxOutbound 将节点编译为 sing-box outbound/endpoint 结构。
func CompileSingBoxOutbound(node ProxyNode, tag, singBoxVersion string, officialApp bool) (SingBoxCompiled, error) {
	proto := NormalizeProtocolAlias(node.Str("protocol"))
	server := normalizeServerHost(node.Str("server"))
	if server == "" {
		return SingBoxCompiled{}, errInvalid("missing_required_proxy_field_server")
	}
	port, ok := node.Int("port")
	if !ok || !isValidPort(port) {
		return SingBoxCompiled{}, errInvalid("invalid_proxy_port")
	}

	if minVer := protocolSingBoxSince(proto); minVer != "" && !VersionAtLeast(singBoxVersion, minVer) {
		return SingBoxCompiled{}, errInvalid("requires_sing_box_version_" + minVer)
	}

	base := &YAMLMap{}
	base.Set("type", proto)
	base.Set("tag", tag)
	base.Set("server", server)
	base.Set("server_port", port)

	switch proto {
	case "shadowsocks":
		method, err := reqNodeString(node, "cipher")
		if err != nil {
			return SingBoxCompiled{}, err
		}
		pass, err := reqNodeString(node, "password")
		if err != nil {
			return SingBoxCompiled{}, err
		}
		base.Set("method", method)
		base.Set("password", pass)
		canonical := canonicalShadowsocksPlugin(node)
		if canonical != nil && canonical.Name == "shadow-tls" {
			if strings.TrimSpace(canonical.Password) == "" {
				return SingBoxCompiled{}, errInvalid("missing_required_proxy_field_shadowTlsPassword")
			}
			aux := &YAMLMap{}
			aux.Set("type", "shadowtls")
			aux.Set("tag", hiddenShadowTLSTag(tag))
			aux.Set("server", server)
			aux.Set("server_port", port)
			ver := 3
			if v, err := strconv.Atoi(canonical.Version); err == nil && v > 0 {
				ver = v
			}
			aux.Set("version", ver)
			aux.Set("password", strings.TrimSpace(canonical.Password))
			auxTLS := &YAMLMap{}
			auxTLS.Set("enabled", true)
			if strings.TrimSpace(canonical.Host) != "" {
				auxTLS.Set("server_name", strings.TrimSpace(canonical.Host))
			}
			aux.Set("tls", auxTLS)
			base.Set("detour", hiddenShadowTLSTag(tag))
			return SingBoxCompiled{Item: base, Extras: []*YAMLMap{aux}}, nil
		}
		if canonical != nil && canonical.Name != "obfs" && canonical.Name != "v2ray-plugin" {
			return SingBoxCompiled{}, errInvalid("unsupported_shadowsocks_plugin_" + canonical.Name)
		}
		if canonical != nil {
			pn, po := toSIP003Plugin(canonical)
			base.Set("plugin", pn)
			if po != "" {
				base.Set("plugin_opts", po)
			}
		}
		return SingBoxCompiled{Item: base}, nil
	case "vmess":
		uuid, err := reqNodeString(node, "uuid")
		if err != nil {
			return SingBoxCompiled{}, err
		}
		alt := 0
		if n, ok := node.Int("alterId"); ok {
			alt = n
		}
		base.Set("uuid", uuid)
		base.Set("security", firstNonEmpty(strings.TrimSpace(node.Str("cipher")), "auto"))
		base.Set("alter_id", alt)
		if tr, err := buildSingBoxTransport(node); err != nil {
			return SingBoxCompiled{}, err
		} else if tr != nil {
			base.Set("transport", tr)
		}
		if tlsObj, err := buildSingBoxTLS(node, false); err != nil {
			return SingBoxCompiled{}, err
		} else if tlsObj != nil {
			base.Set("tls", tlsObj)
		}
		return SingBoxCompiled{Item: base}, nil
	case "vless":
		if enc := strings.TrimSpace(node.Str("encryption")); enc != "" && strings.ToLower(enc) != "none" {
			return SingBoxCompiled{}, errInvalid("unsupported_vless_encryption")
		}
		uuid, err := reqNodeString(node, "uuid")
		if err != nil {
			return SingBoxCompiled{}, err
		}
		base.Set("uuid", uuid)
		if flow := strings.TrimSpace(node.Str("flow")); flow != "" {
			base.Set("flow", flow)
		}
		if tr, err := buildSingBoxTransport(node); err != nil {
			return SingBoxCompiled{}, err
		} else if tr != nil {
			base.Set("transport", tr)
		}
		if tlsObj, err := buildSingBoxTLS(node, false); err != nil {
			return SingBoxCompiled{}, err
		} else if tlsObj != nil {
			base.Set("tls", tlsObj)
		}
		return SingBoxCompiled{Item: base}, nil
	case "trojan":
		pass, err := reqNodeString(node, "password")
		if err != nil {
			return SingBoxCompiled{}, err
		}
		base.Set("password", pass)
		if tr, err := buildSingBoxTransport(node); err != nil {
			return SingBoxCompiled{}, err
		} else if tr != nil {
			base.Set("transport", tr)
		}
		if tlsObj, err := buildSingBoxTLS(node, true); err != nil {
			return SingBoxCompiled{}, err
		} else if tlsObj != nil {
			base.Set("tls", tlsObj)
		}
		return SingBoxCompiled{Item: base}, nil
	case "hysteria":
		tp := strings.ToLower(firstNonEmpty(node.Str("hysteriaProtocol"), "udp"))
		if tp != "udp" {
			return SingBoxCompiled{}, errInvalid("unsupported_hysteria_protocol_" + tp)
		}
		up, err := validateHysteriaBandwidth(node, "upMbps")
		if err != nil {
			return SingBoxCompiled{}, err
		}
		down, err := validateHysteriaBandwidth(node, "downMbps")
		if err != nil {
			return SingBoxCompiled{}, err
		}
		tlsObj, err := buildSingBoxTLS(node, true)
		if err != nil {
			return SingBoxCompiled{}, err
		}
		base.Set("up_mbps", up)
		base.Set("down_mbps", down)
		base.Set("tls", tlsObj)
		if a := node.Str("authStr"); a != "" {
			base.Set("auth_str", a)
		}
		if obfs := node.Str("obfs"); obfs != "" {
			base.Set("obfs", obfs)
		}
		return SingBoxCompiled{Item: base}, nil
	case "hysteria2":
		pass, err := reqNodeString(node, "password")
		if err != nil {
			return SingBoxCompiled{}, err
		}
		tlsObj, err := buildSingBoxTLS(node, true)
		if err != nil {
			return SingBoxCompiled{}, err
		}
		base.Set("password", pass)
		base.Set("tls", tlsObj)
		if sp, _ := formatPortRanges(node["ports"], ":", ",", true); sp != "" {
			base.Delete("server_port")
			base.Set("server_ports", strings.Split(sp, ","))
		}
		if rawHop, ok := node["hopInterval"]; ok && rawHop != nil && rawHop != "" {
			hv, okH := parseHopInterval(rawHop)
			if !okH {
				return SingBoxCompiled{}, errInvalid("invalid_proxy_field_hopInterval")
			}
			base.Set("hop_interval", fmt.Sprintf("%gs", hv))
		}
		if up, ok := node.Float("upMbps"); ok {
			base.Set("up_mbps", up)
		}
		if down, ok := node.Float("downMbps"); ok {
			base.Set("down_mbps", down)
		}
		if obfsType, obfsPass := strings.TrimSpace(node.Str("obfs")), strings.TrimSpace(node.Str("obfsPassword")); obfsType != "" || obfsPass != "" {
			if obfsPass == "" {
				return SingBoxCompiled{}, errInvalid("missing_required_proxy_field_obfsPassword")
			}
			if obfsType == "" {
				obfsType = "salamander"
			}
			oo := &YAMLMap{}
			oo.Set("type", obfsType)
			oo.Set("password", obfsPass)
			base.Set("obfs", oo)
		}
		return SingBoxCompiled{Item: base}, nil
	case "tuic":
		if node.Str("uuid") == "" || node.Str("password") == "" {
			return SingBoxCompiled{}, errInvalid("unsupported_proxy_protocol_tuic-v4")
		}
		uuid, err := reqNodeString(node, "uuid")
		if err != nil {
			return SingBoxCompiled{}, err
		}
		pass, err := reqNodeString(node, "password")
		if err != nil {
			return SingBoxCompiled{}, err
		}
		tlsObj, err := buildSingBoxTLS(node, true)
		if err != nil {
			return SingBoxCompiled{}, err
		}
		base.Set("uuid", uuid)
		base.Set("password", pass)
		base.Set("tls", tlsObj)
		if cc := node.Str("congestionControl"); cc != "" {
			base.Set("congestion_control", cc)
		}
		if ur := node.Str("udpRelayMode"); ur != "" {
			base.Set("udp_relay_mode", ur)
		}
		return SingBoxCompiled{Item: base}, nil
	case "anytls":
		pass, err := reqNodeString(node, "password")
		if err != nil {
			return SingBoxCompiled{}, err
		}
		tlsObj, err := buildSingBoxTLS(node, true)
		if err != nil {
			return SingBoxCompiled{}, err
		}
		base.Set("password", pass)
		base.Set("tls", tlsObj)
		return SingBoxCompiled{Item: base}, nil
	case "wireguard":
		addrs, err := wireguardAddresses(node)
		if err != nil {
			return SingBoxCompiled{}, err
		}
		priv, err := reqNodeString(node, "privateKey")
		if err != nil {
			return SingBoxCompiled{}, err
		}
		pub, err := reqNodeString(node, "publicKey")
		if err != nil {
			return SingBoxCompiled{}, err
		}
		peer := &YAMLMap{}
		peer.Set("address", server)
		peer.Set("port", port)
		peer.Set("public_key", pub)
		peer.Set("allowed_ips", []string{"0.0.0.0/0", "::/0"})
		if psk := node.Str("presharedKey"); psk != "" {
			peer.Set("pre_shared_key", psk)
		}
		if res, ok := wireguardReservedValue(node["reserved"]); ok {
			peer.Set("reserved", res)
		}
		ep := &YAMLMap{}
		ep.Set("type", "wireguard")
		ep.Set("tag", tag)
		ep.Set("address", addrs)
		ep.Set("private_key", priv)
		ep.Set("peers", []*YAMLMap{peer})
		if mtu, ok := node.Int("mtu"); ok && mtu > 0 {
			ep.Set("mtu", mtu)
		}
		return SingBoxCompiled{Item: ep, IsEndpoint: true}, nil
	case "snell":
		ver, ok := node.Int("version")
		if !ok || (ver != 4 && ver != 6) {
			vStr := "unknown"
			if ok {
				vStr = strconv.Itoa(ver)
			}
			return SingBoxCompiled{}, errInvalid("unsupported_sing_box_snell_version_" + vStr)
		}
		psk, err := reqNodeString(node, "psk")
		if err != nil {
			return SingBoxCompiled{}, err
		}
		base.Set("version", ver)
		base.Set("psk", psk)
		if ver == 4 {
			obfs := strings.ToLower(strings.TrimSpace(node.Str("obfs")))
			if obfs == "tls" {
				return SingBoxCompiled{}, errInvalid("unsupported_sing_box_snell_obfs_tls")
			}
			if obfs == "http" {
				base.Set("obfs_mode", "http")
				if oh := node.Str("obfsHost"); oh != "" {
					base.Set("obfs_host", oh)
				}
			}
		} else if mode := node.Str("mode"); mode != "" {
			base.Set("mode", mode)
		}
		return SingBoxCompiled{Item: base}, nil
	case "socks5":
		base.Set("type", "socks")
		base.Set("version", "5")
		if u := node.Str("username"); u != "" {
			base.Set("username", u)
		}
		if p := node.Str("password"); p != "" {
			base.Set("password", p)
		}
		return SingBoxCompiled{Item: base}, nil
	case "http", "https":
		base.Set("type", "http")
		if u := node.Str("username"); u != "" {
			base.Set("username", u)
		}
		if p := node.Str("password"); p != "" {
			base.Set("password", p)
		}
		if tlsObj, err := buildSingBoxTLS(node, proto == "https"); err != nil {
			return SingBoxCompiled{}, err
		} else if tlsObj != nil {
			base.Set("tls", tlsObj)
		}
		return SingBoxCompiled{Item: base}, nil
	case "ssh":
		user, err := reqNodeString(node, "username")
		if err != nil {
			return SingBoxCompiled{}, err
		}
		base.Set("user", user)
		if p := node.Str("password"); p != "" {
			base.Set("password", p)
		}
		if pk := node.Str("privateKey"); pk != "" {
			base.Set("private_key", pk)
		}
		if pp := node.Str("privateKeyPassphrase"); pp != "" {
			base.Set("private_key_passphrase", pp)
		}
		if hk := textListFromNode(node["hostKey"]); len(hk) > 0 {
			base.Set("host_key", hk)
		}
		if alg := textListFromNode(node["hostKeyAlgorithms"]); len(alg) > 0 {
			base.Set("host_key_algorithms", alg)
		}
		return SingBoxCompiled{Item: base}, nil
	case "naive":
		if !officialApp {
			return SingBoxCompiled{}, errInvalid("requires_sing_box_official_app")
		}
		user, err := reqNodeString(node, "username")
		if err != nil {
			return SingBoxCompiled{}, err
		}
		pass, err := reqNodeString(node, "password")
		if err != nil {
			return SingBoxCompiled{}, err
		}
		base.Set("username", user)
		base.Set("password", pass)
		tlsObj := &YAMLMap{}
		tlsObj.Set("enabled", true)
		if sni := node.Str("sni"); sni != "" {
			tlsObj.Set("server_name", sni)
		}
		base.Set("tls", tlsObj)
		if b, ok := node.Bool("quic"); ok && b {
			base.Set("quic", true)
		}
		return SingBoxCompiled{Item: base}, nil
	default:
		if proto == "" {
			proto = "empty"
		}
		return SingBoxCompiled{}, errInvalid("unsupported_proxy_protocol_" + proto)
	}
}

func protocolSingBoxSince(proto string) string {
	switch proto {
	case "anytls":
		return "1.12.0"
	case "naive":
		return "1.13.0"
	case "snell":
		return "1.14.0"
	default:
		return ""
	}
}

// CompileSurgeFamilyEntry 编译 Surge / Surfboard / Loon 的节点代理行（含 WireGuard 附加段落）。
func CompileSurgeFamilyEntry(target string, node ProxyNode, name string, chainName string, proxyChainParam string) (CompiledLineEntry, error) {
	proto := NormalizeProtocolAlias(node.Str("protocol"))
	server := normalizeServerHost(node.Str("server"))
	if server == "" {
		return CompiledLineEntry{}, errInvalid("invalid_proxy_server")
	}
	port, ok := node.Int("port")
	if !ok || !isValidPort(port) {
		return CompiledLineEntry{}, errInvalid("invalid_proxy_port")
	}

	var pType string
	var args []any
	var params []YAMLKV
	var sections []CompiledSection
	omitAddr := false

	appendParams := func(kvs ...YAMLKV) {
		params = append(params, kvs...)
	}
	surgeTLS := func() {
		if sni := node.Str("sni"); sni != "" {
			appendParams(YAMLKV{Key: "sni", Value: sni})
		}
		if nodeInsecure(node) {
			appendParams(YAMLKV{Key: "skip-cert-verify", Value: true})
		}
	}
	surgeTransport := func() error {
		netw := strings.ToLower(strings.TrimSpace(node.Str("network")))
		if netw == "" || netw == "tcp" {
			return nil
		}
		if netw != "ws" {
			return errInvalid("unsupported_proxy_transport_" + netw)
		}
		path := firstNonEmpty(node.Str("path"), "/")
		appendParams(YAMLKV{Key: "ws", Value: true}, YAMLKV{Key: "ws-path", Value: path})
		if h := node.Str("host"); h != "" {
			appendParams(YAMLKV{Key: "ws-headers", Value: "Host:" + h})
		}
		return nil
	}
	loonTLS := func(forceTLS bool) {
		tlsOn := forceTLS
		if !tlsOn {
			b, _ := node.Bool("tls")
			tlsOn = b
		}
		if !forceTLS && tlsOn {
			appendParams(YAMLKV{Key: "over-tls", Value: true})
		}
		if tlsOn {
			if sni := node.Str("sni"); sni != "" {
				appendParams(YAMLKV{Key: "sni", Value: sni})
			}
			if nodeInsecure(node) {
				appendParams(YAMLKV{Key: "skip-cert-verify", Value: true})
			}
		}
	}
	loonTransport := func() error {
		netw := strings.ToLower(strings.TrimSpace(node.Str("network")))
		if netw == "" {
			netw = "tcp"
		}
		if netw != "tcp" && netw != "ws" && netw != "http" {
			return errInvalid("unsupported_proxy_transport_" + netw)
		}
		appendParams(YAMLKV{Key: "transport", Value: netw})
		if netw != "tcp" {
			appendParams(YAMLKV{Key: "path", Value: firstNonEmpty(node.Str("path"), "/")})
			if h := node.Str("host"); h != "" {
				appendParams(YAMLKV{Key: "host", Value: h})
			}
		}
		return nil
	}
	surgeObfs := func() (obfs, host, uri string, err error) {
		plugin := canonicalShadowsocksPlugin(node)
		if plugin == nil {
			return "", "", "", nil
		}
		if plugin.Name != "obfs" {
			return "", "", "", errInvalid("unsupported_shadowsocks_plugin_" + plugin.Name)
		}
		if plugin.Mode != "http" && plugin.Mode != "tls" {
			return "", "", "", errInvalid("unsupported_shadowsocks_plugin_options")
		}
		return plugin.Mode, plugin.Host, plugin.URI, nil
	}

	if target == "loon" {
		switch proto {
		case "shadowsocks":
			cipher, err := reqNodeString(node, "cipher")
			if err != nil {
				return CompiledLineEntry{}, err
			}
			pass, err := reqNodeString(node, "password")
			if err != nil {
				return CompiledLineEntry{}, err
			}
			pType = "Shadowsocks"
			args = []any{cipher, surgeVal{Text: pass, Quoted: true}}
			plugin := canonicalShadowsocksPlugin(node)
			if plugin != nil && plugin.Name == "shadow-tls" {
				if strings.TrimSpace(plugin.Password) == "" {
					return CompiledLineEntry{}, errInvalid("missing_required_proxy_field_shadowTlsPassword")
				}
				appendParams(
					YAMLKV{Key: "shadow-tls-password", Value: surgeVal{Text: strings.TrimSpace(plugin.Password), Quoted: true}},
					YAMLKV{Key: "shadow-tls-sni", Value: plugin.Host},
					YAMLKV{Key: "shadow-tls-version", Value: plugin.Version},
				)
			} else {
				o, h, u, err := surgeObfs()
				if err != nil {
					return CompiledLineEntry{}, err
				}
				appendParams(YAMLKV{Key: "obfs-name", Value: o}, YAMLKV{Key: "obfs-host", Value: h}, YAMLKV{Key: "obfs-uri", Value: u})
			}
			appendParams(YAMLKV{Key: "fast-open", Value: false}, YAMLKV{Key: "udp", Value: true})
		case "shadowsocksr":
			cipher, err := reqNodeString(node, "cipher")
			if err != nil {
				return CompiledLineEntry{}, err
			}
			pass, err := reqNodeString(node, "password")
			if err != nil {
				return CompiledLineEntry{}, err
			}
			pType = "ShadowsocksR"
			args = []any{cipher, surgeVal{Text: pass, Quoted: true}}
			appendParams(
				YAMLKV{Key: "protocol", Value: firstNonEmpty(node.Str("ssrProtocol"), "origin")},
				YAMLKV{Key: "protocol-param", Value: node.Str("ssrProtocolParam")},
				YAMLKV{Key: "obfs", Value: firstNonEmpty(node.Str("ssrObfs"), "plain")},
				YAMLKV{Key: "obfs-param", Value: node.Str("ssrObfsParam")},
				YAMLKV{Key: "fast-open", Value: false},
				YAMLKV{Key: "udp", Value: true},
			)
		case "vmess":
			uuid, err := reqNodeString(node, "uuid")
			if err != nil {
				return CompiledLineEntry{}, err
			}
			pType = "vmess"
			args = []any{firstNonEmpty(node.Str("cipher"), "auto"), surgeVal{Text: uuid, Quoted: true}}
			if err := loonTransport(); err != nil {
				return CompiledLineEntry{}, err
			}
			alt, _ := node.Int("alterId")
			appendParams(YAMLKV{Key: "alterId", Value: alt})
			loonTLS(false)
		case "vless":
			if enc := strings.TrimSpace(node.Str("encryption")); enc != "" && strings.ToLower(enc) != "none" {
				return CompiledLineEntry{}, errInvalid("unsupported_vless_encryption")
			}
			uuid, err := reqNodeString(node, "uuid")
			if err != nil {
				return CompiledLineEntry{}, err
			}
			reality := strings.ToLower(node.Str("security")) == "reality"
			pType = "VLESS"
			args = []any{surgeVal{Text: uuid, Quoted: true}}
			if err := loonTransport(); err != nil {
				return CompiledLineEntry{}, err
			}
			if flow := node.Str("flow"); flow != "" {
				appendParams(YAMLKV{Key: "flow", Value: flow})
			}
			if reality {
				pub, err := reqNodeString(node, "publicKey")
				if err != nil {
					return CompiledLineEntry{}, err
				}
				appendParams(YAMLKV{Key: "public-key", Value: surgeVal{Text: pub, Quoted: true}})
				if sid := node.Str("shortId"); sid != "" {
					appendParams(YAMLKV{Key: "short-id", Value: sid})
				}
			}
			tlsB, _ := node.Bool("tls")
			loonTLS(tlsB || reality)
		case "trojan":
			pass, err := reqNodeString(node, "password")
			if err != nil {
				return CompiledLineEntry{}, err
			}
			pType = "trojan"
			args = []any{surgeVal{Text: pass, Quoted: true}}
			if err := loonTransport(); err != nil {
				return CompiledLineEntry{}, err
			}
			loonTLS(true)
		case "hysteria2":
			obfs := strings.ToLower(strings.TrimSpace(node.Str("obfs")))
			if obfs != "" && obfs != "salamander" {
				return CompiledLineEntry{}, errInvalid("unsupported_hysteria2_obfs_" + obfs)
			}
			pass, err := reqNodeString(node, "password")
			if err != nil {
				return CompiledLineEntry{}, err
			}
			pType = "Hysteria2"
			args = []any{surgeVal{Text: pass, Quoted: true}}
			loonTLS(true)
			if sp, _ := formatPortRanges(node["ports"], ":", ",", false); sp != "" {
				appendParams(YAMLKV{Key: "server-ports", Value: sp})
			}
			if down, ok := node["downMbps"]; ok && down != nil && down != "" {
				appendParams(YAMLKV{Key: "download-bandwidth", Value: down})
			}
			if obfs != "" {
				opw, err := reqNodeString(node, "obfsPassword")
				if err != nil {
					return CompiledLineEntry{}, err
				}
				appendParams(YAMLKV{Key: "salamander-password", Value: surgeVal{Text: opw, Quoted: true}})
			}
			appendParams(YAMLKV{Key: "udp", Value: true})
		case "anytls":
			pass, err := reqNodeString(node, "password")
			if err != nil {
				return CompiledLineEntry{}, err
			}
			pType = "AnyTLS"
			args = []any{surgeVal{Text: pass, Quoted: true}}
			loonTLS(true)
		case "wireguard":
			priv, err := reqNodeString(node, "privateKey")
			if err != nil {
				return CompiledLineEntry{}, err
			}
			pub, err := reqNodeString(node, "publicKey")
			if err != nil {
				return CompiledLineEntry{}, err
			}
			ip, ip6, err := wireguardTunnelAddresses(node)
			if err != nil {
				return CompiledLineEntry{}, err
			}
			rb, hasRB, err := wireguardReservedBytes(node["reserved"])
			if err != nil {
				return CompiledLineEntry{}, err
			}
			ep := formatServerHost(server) + ":" + strconv.Itoa(port)
			peerParts := []string{fmt.Sprintf(`public-key="%s"`, pub)}
			if psk := node.Str("presharedKey"); psk != "" {
				peerParts = append(peerParts, fmt.Sprintf(`preshared-key="%s"`, psk))
			}
			if hasRB {
				peerParts = append(peerParts, fmt.Sprintf(`reserved=[%d,%d,%d]`, rb[0], rb[1], rb[2]))
			}
			peerParts = append(peerParts, `allowed-ips="0.0.0.0/0,::/0"`, "endpoint="+ep)
			pType = "WireGuard"
			omitAddr = true
			if ip != "" {
				appendParams(YAMLKV{Key: "interface-ip", Value: ip})
			}
			if ip6 != "" {
				appendParams(YAMLKV{Key: "interface-ipv6", Value: ip6})
			}
			appendParams(YAMLKV{Key: "private-key", Value: surgeVal{Text: priv, Quoted: true}})
			if mtu, ok := node.Int("mtu"); ok && mtu > 0 {
				appendParams(YAMLKV{Key: "mtu", Value: mtu})
			}
			appendParams(
				YAMLKV{Key: "peers", Value: surgeVal{Text: "[{" + strings.Join(peerParts, ",") + "}]", Raw: true}},
				YAMLKV{Key: "udp", Value: true},
			)
		case "socks5":
			pType = "socks5"
			if u := node.Str("username"); u != "" {
				args = []any{u, surgeVal{Text: node.Str("password"), Quoted: true}}
			}
		case "http", "https":
			tlsB, _ := node.Bool("tls")
			https := proto == "https" || tlsB
			if https {
				pType = "https"
			} else {
				pType = "http"
			}
			if u := node.Str("username"); u != "" {
				args = []any{u, surgeVal{Text: node.Str("password"), Quoted: true}}
			}
			if https {
				surgeTLS()
			}
		default:
			return CompiledLineEntry{}, errInvalid("unsupported_proxy_protocol_" + proto)
		}
	} else {
		// Surge / Surfboard (Surfboard inherits surge)
		switch proto {
		case "shadowsocks":
			cipher, err := reqNodeString(node, "cipher")
			if err != nil {
				return CompiledLineEntry{}, err
			}
			pass, err := reqNodeString(node, "password")
			if err != nil {
				return CompiledLineEntry{}, err
			}
			o, h, u, err := surgeObfs()
			if err != nil {
				return CompiledLineEntry{}, err
			}
			pType = "ss"
			appendParams(
				YAMLKV{Key: "encrypt-method", Value: cipher},
				YAMLKV{Key: "password", Value: pass},
				YAMLKV{Key: "obfs", Value: o},
				YAMLKV{Key: "obfs-host", Value: h},
				YAMLKV{Key: "obfs-uri", Value: u},
				YAMLKV{Key: "udp-relay", Value: true},
			)
		case "vmess":
			uuid, err := reqNodeString(node, "uuid")
			if err != nil {
				return CompiledLineEntry{}, err
			}
			pType = "vmess"
			appendParams(YAMLKV{Key: "username", Value: uuid})
			if err := surgeTransport(); err != nil {
				return CompiledLineEntry{}, err
			}
			if b, ok := node.Bool("tls"); ok && b {
				appendParams(YAMLKV{Key: "tls", Value: true})
			}
			surgeTLS()
			alt, _ := node.Int("alterId")
			if alt == 0 {
				appendParams(YAMLKV{Key: "vmess-aead", Value: true})
			}
		case "trojan":
			pass, err := reqNodeString(node, "password")
			if err != nil {
				return CompiledLineEntry{}, err
			}
			pType = "trojan"
			appendParams(YAMLKV{Key: "password", Value: pass})
			if err := surgeTransport(); err != nil {
				return CompiledLineEntry{}, err
			}
			surgeTLS()
		case "hysteria2":
			if node.Str("obfs") != "" || node.Str("obfsPassword") != "" {
				return CompiledLineEntry{}, errInvalid("unsupported_hysteria2_obfs")
			}
			pass, err := reqNodeString(node, "password")
			if err != nil {
				return CompiledLineEntry{}, err
			}
			pType = "hysteria2"
			appendParams(YAMLKV{Key: "password", Value: pass})
			surgeTLS()
			if ph, _ := formatPortRanges(node["ports"], "-", ";", false); ph != "" {
				appendParams(YAMLKV{Key: "port-hopping", Value: ph})
			}
			if down, ok := node["downMbps"]; ok && down != nil && down != "" {
				appendParams(YAMLKV{Key: "download-bandwidth", Value: down})
			}
		case "tuic":
			if node.Str("uuid") == "" || node.Str("password") == "" {
				return CompiledLineEntry{}, errInvalid("unsupported_proxy_protocol_tuic-v4")
			}
			uuid, err := reqNodeString(node, "uuid")
			if err != nil {
				return CompiledLineEntry{}, err
			}
			pass, err := reqNodeString(node, "password")
			if err != nil {
				return CompiledLineEntry{}, err
			}
			alpn := normalizeStringSlice(node["alpn"])
			if len(alpn) == 0 {
				alpn = []string{"h3"}
			}
			pType = "tuic-v5"
			appendParams(
				YAMLKV{Key: "uuid", Value: uuid},
				YAMLKV{Key: "password", Value: pass},
				YAMLKV{Key: "alpn", Value: strings.Join(alpn, ",")},
			)
			surgeTLS()
		case "snell":
			psk, err := reqNodeString(node, "psk")
			if err != nil {
				return CompiledLineEntry{}, err
			}
			pType = "snell"
			appendParams(YAMLKV{Key: "psk", Value: psk})
			if ver, ok := node.Int("version"); ok && ver > 0 {
				appendParams(YAMLKV{Key: "version", Value: ver})
			}
			if obfs := node.Str("obfs"); obfs != "" {
				appendParams(YAMLKV{Key: "obfs", Value: obfs})
				if oh := node.Str("obfsHost"); oh != "" {
					appendParams(YAMLKV{Key: "obfs-host", Value: oh})
				}
			}
		case "anytls":
			pass, err := reqNodeString(node, "password")
			if err != nil {
				return CompiledLineEntry{}, err
			}
			pType = "anytls"
			appendParams(YAMLKV{Key: "password", Value: pass})
			surgeTLS()
		case "wireguard":
			priv, err := reqNodeString(node, "privateKey")
			if err != nil {
				return CompiledLineEntry{}, err
			}
			pub, err := reqNodeString(node, "publicKey")
			if err != nil {
				return CompiledLineEntry{}, err
			}
			ip, ip6, err := wireguardTunnelAddresses(node)
			if err != nil {
				return CompiledLineEntry{}, err
			}
			rb, hasRB, err := wireguardReservedBytes(node["reserved"])
			if err != nil {
				return CompiledLineEntry{}, err
			}
			ep := formatServerHost(server) + ":" + strconv.Itoa(port)
			peerParts := []string{"public-key = " + pub}
			if psk := node.Str("presharedKey"); psk != "" {
				peerParts = append(peerParts, "preshared-key = "+psk)
			}
			peerParts = append(peerParts, `allowed-ips = "0.0.0.0/0, ::/0"`, "endpoint = "+ep)
			if hasRB {
				peerParts = append(peerParts, fmt.Sprintf("client-id = %d/%d/%d", rb[0], rb[1], rb[2]))
			}
			var secLines []string
			secLines = append(secLines, "private-key = "+priv)
			if ip != "" {
				secLines = append(secLines, "self-ip = "+ip)
			}
			if ip6 != "" {
				secLines = append(secLines, "self-ip-v6 = "+ip6)
			}
			if mtu, ok := node.Int("mtu"); ok && mtu > 0 {
				secLines = append(secLines, fmt.Sprintf("mtu = %d", mtu))
			}
			secLines = append(secLines, "peer = ("+strings.Join(peerParts, ", ")+")")
			pType = "wireguard"
			omitAddr = true
			appendParams(YAMLKV{Key: "section-name", Value: sectionSlotPlaceholder})
			sections = append(sections, CompiledSection{Header: "WireGuard", Prefix: "wg", Lines: secLines})
		case "socks5":
			pType = "socks5"
			if u := node.Str("username"); u != "" {
				args = []any{u, node.Str("password")}
			}
		case "http", "https":
			tlsB, _ := node.Bool("tls")
			https := proto == "https" || tlsB
			if https {
				pType = "https"
			} else {
				pType = "http"
			}
			if u := node.Str("username"); u != "" {
				args = []any{u, node.Str("password")}
			}
			if https {
				surgeTLS()
			}
		default:
			return CompiledLineEntry{}, errInvalid("unsupported_proxy_protocol_" + proto)
		}
	}

	if chainName != "" && proxyChainParam != "" {
		appendParams(YAMLKV{Key: proxyChainParam, Value: chainName})
	}
	var fullArgs []any
	if omitAddr {
		fullArgs = args
	} else {
		fullArgs = append([]any{server, port}, args...)
	}
	return CompiledLineEntry{
		Line:     FormatSurgeLine(name, pType, fullArgs, params),
		Sections: sections,
	}, nil
}

// CompileQuantumultXEntry 编译 Quantumult X [server_local] 行。
func CompileQuantumultXEntry(node ProxyNode, name string) (CompiledLineEntry, error) {
	proto := NormalizeProtocolAlias(node.Str("protocol"))
	server := normalizeServerHost(node.Str("server"))
	if server == "" {
		return CompiledLineEntry{}, errInvalid("invalid_proxy_server")
	}
	port, ok := node.Int("port")
	if !ok || !isValidPort(port) {
		return CompiledLineEntry{}, errInvalid("invalid_proxy_port")
	}
	tlsVerif := any(nil)
	if nodeInsecure(node) {
		tlsVerif = false
	}
	qxObfs := func(forceTLS bool) ([]YAMLKV, error) {
		netw := strings.ToLower(strings.TrimSpace(node.Str("network")))
		if netw == "" {
			netw = "tcp"
		}
		tlsB, _ := node.Bool("tls")
		tlsOn := forceTLS || tlsB || strings.ToLower(node.Str("security")) == "reality"
		if netw == "tcp" {
			if !tlsOn {
				return nil, nil
			}
			return []YAMLKV{{Key: "obfs", Value: "over-tls"}, {Key: "obfs-host", Value: node.Str("sni")}}, nil
		}
		if netw == "ws" {
			ob := "ws"
			if tlsOn {
				ob = "wss"
			}
			return []YAMLKV{
				{Key: "obfs", Value: ob},
				{Key: "obfs-host", Value: firstNonEmpty(node.Str("host"), node.Str("sni"))},
				{Key: "obfs-uri", Value: firstNonEmpty(node.Str("path"), "/")},
			}, nil
		}
		if netw == "http" && !tlsOn {
			return []YAMLKV{
				{Key: "obfs", Value: "http"},
				{Key: "obfs-host", Value: node.Str("host")},
				{Key: "obfs-uri", Value: firstNonEmpty(node.Str("path"), "/")},
			}, nil
		}
		return nil, errInvalid("unsupported_proxy_transport_" + netw)
	}

	var pType string
	var params []YAMLKV
	switch proto {
	case "shadowsocks":
		cipher, err := reqNodeString(node, "cipher")
		if err != nil {
			return CompiledLineEntry{}, err
		}
		pass, err := reqNodeString(node, "password")
		if err != nil {
			return CompiledLineEntry{}, err
		}
		pType = "shadowsocks"
		params = append(params, YAMLKV{Key: "method", Value: cipher}, YAMLKV{Key: "password", Value: pass})
		if plugin := canonicalShadowsocksPlugin(node); plugin != nil {
			switch {
			case plugin.Name == "obfs":
				if plugin.Mode != "http" && plugin.Mode != "tls" {
					return CompiledLineEntry{}, errInvalid("unsupported_shadowsocks_plugin_options")
				}
				params = append(params, YAMLKV{Key: "obfs", Value: plugin.Mode}, YAMLKV{Key: "obfs-host", Value: plugin.Host})
				if plugin.Mode == "http" {
					params = append(params, YAMLKV{Key: "obfs-uri", Value: plugin.URI})
				}
			case plugin.Name == "v2ray-plugin" && plugin.Mode == "websocket":
				ob := "ws"
				if plugin.TLS {
					ob = "wss"
				}
				params = append(params, YAMLKV{Key: "obfs", Value: ob}, YAMLKV{Key: "obfs-host", Value: plugin.Host}, YAMLKV{Key: "obfs-uri", Value: firstNonEmpty(plugin.Path, "/")})
			default:
				return CompiledLineEntry{}, errInvalid("unsupported_shadowsocks_plugin_" + plugin.Name)
			}
		}
		params = append(params, YAMLKV{Key: "fast-open", Value: false}, YAMLKV{Key: "udp-relay", Value: true})
	case "shadowsocksr":
		cipher, err := reqNodeString(node, "cipher")
		if err != nil {
			return CompiledLineEntry{}, err
		}
		pass, err := reqNodeString(node, "password")
		if err != nil {
			return CompiledLineEntry{}, err
		}
		pType = "shadowsocks"
		params = []YAMLKV{
			{Key: "method", Value: cipher},
			{Key: "password", Value: pass},
			{Key: "ssr-protocol", Value: firstNonEmpty(node.Str("ssrProtocol"), "origin")},
			{Key: "ssr-protocol-param", Value: node.Str("ssrProtocolParam")},
			{Key: "obfs", Value: firstNonEmpty(node.Str("ssrObfs"), "plain")},
			{Key: "obfs-host", Value: node.Str("ssrObfsParam")},
			{Key: "fast-open", Value: false},
			{Key: "udp-relay", Value: false},
		}
	case "vmess":
		uuid, err := reqNodeString(node, "uuid")
		if err != nil {
			return CompiledLineEntry{}, err
		}
		cipher := strings.ToLower(firstNonEmpty(strings.TrimSpace(node.Str("cipher")), "auto"))
		if cipher == "auto" {
			cipher = "chacha20-poly1305"
		}
		ob, err := qxObfs(false)
		if err != nil {
			return CompiledLineEntry{}, err
		}
		pType = "vmess"
		params = append(params, YAMLKV{Key: "method", Value: cipher}, YAMLKV{Key: "password", Value: uuid})
		params = append(params, ob...)
		params = append(params, YAMLKV{Key: "tls-verification", Value: tlsVerif}, YAMLKV{Key: "fast-open", Value: false}, YAMLKV{Key: "udp-relay", Value: false})
	case "vless":
		if enc := strings.TrimSpace(node.Str("encryption")); enc != "" && strings.ToLower(enc) != "none" {
			return CompiledLineEntry{}, errInvalid("unsupported_vless_encryption")
		}
		uuid, err := reqNodeString(node, "uuid")
		if err != nil {
			return CompiledLineEntry{}, err
		}
		reality := strings.ToLower(node.Str("security")) == "reality"
		ob, err := qxObfs(false)
		if err != nil {
			return CompiledLineEntry{}, err
		}
		pType = "vless"
		params = append(params, YAMLKV{Key: "method", Value: "none"}, YAMLKV{Key: "password", Value: uuid})
		params = append(params, ob...)
		if reality {
			pub, err := reqNodeString(node, "publicKey")
			if err != nil {
				return CompiledLineEntry{}, err
			}
			params = append(params, YAMLKV{Key: "reality-base64-pubkey", Value: pub}, YAMLKV{Key: "reality-hex-shortid", Value: node.Str("shortId")})
		}
		params = append(params, YAMLKV{Key: "vless-flow", Value: node.Str("flow")}, YAMLKV{Key: "tls-verification", Value: tlsVerif}, YAMLKV{Key: "udp-relay", Value: false})
	case "trojan":
		pass, err := reqNodeString(node, "password")
		if err != nil {
			return CompiledLineEntry{}, err
		}
		netw := strings.ToLower(firstNonEmpty(strings.TrimSpace(node.Str("network")), "tcp"))
		var tr []YAMLKV
		if netw == "tcp" {
			tr = []YAMLKV{{Key: "over-tls", Value: true}, {Key: "tls-host", Value: node.Str("sni")}}
		} else {
			var err error
			tr, err = qxObfs(true)
			if err != nil {
				return CompiledLineEntry{}, err
			}
		}
		pType = "trojan"
		params = append(params, YAMLKV{Key: "password", Value: pass})
		params = append(params, tr...)
		params = append(params, YAMLKV{Key: "tls-verification", Value: tlsVerif}, YAMLKV{Key: "fast-open", Value: false}, YAMLKV{Key: "udp-relay", Value: false})
	case "anytls":
		pass, err := reqNodeString(node, "password")
		if err != nil {
			return CompiledLineEntry{}, err
		}
		pType = "anytls"
		params = []YAMLKV{{Key: "password", Value: pass}, {Key: "tls-verification", Value: tlsVerif}, {Key: "sni", Value: node.Str("sni")}}
	case "socks5":
		pType = "socks5"
		params = []YAMLKV{{Key: "username", Value: node.Str("username")}, {Key: "password", Value: node.Str("password")}, {Key: "fast-open", Value: false}, {Key: "udp-relay", Value: false}}
	case "http", "https":
		tlsB, _ := node.Bool("tls")
		https := proto == "https" || tlsB
		pType = "http"
		params = []YAMLKV{{Key: "username", Value: node.Str("username")}, {Key: "password", Value: node.Str("password")}}
		if https {
			params = append(params, YAMLKV{Key: "over-tls", Value: true}, YAMLKV{Key: "tls-host", Value: node.Str("sni")}, YAMLKV{Key: "tls-verification", Value: tlsVerif})
		}
		params = append(params, YAMLKV{Key: "fast-open", Value: false}, YAMLKV{Key: "udp-relay", Value: false})
	default:
		return CompiledLineEntry{}, errInvalid("unsupported_proxy_protocol_" + proto)
	}
	return CompiledLineEntry{Line: FormatQuantumultXLine(name, pType, server, port, params)}, nil
}

// CompileEgernProxy 将节点编译为 Egern YAML proxy 条目。
func CompileEgernProxy(node ProxyNode, name string) (*YAMLMap, error) {
	proto := NormalizeProtocolAlias(node.Str("protocol"))
	server := normalizeServerHost(node.Str("server"))
	if server == "" {
		return nil, errInvalid("invalid_proxy_server")
	}
	port, ok := node.Int("port")
	if !ok || !isValidPort(port) {
		return nil, errInvalid("invalid_proxy_port")
	}

	fields := &YAMLMap{}
	fields.Set("name", name)
	fields.Set("server", server)
	fields.Set("port", port)

	setEgernTLS := func(m *YAMLMap) {
		if sni := node.Str("sni"); sni != "" {
			m.Set("sni", sni)
		}
		if nodeInsecure(node) {
			m.Set("skip_tls_verify", true)
		}
	}
	buildEgernReality := func() (*YAMLMap, error) {
		if strings.ToLower(strings.TrimSpace(node.Str("security"))) != "reality" {
			return nil, nil
		}
		pub, err := reqNodeString(node, "publicKey")
		if err != nil {
			return nil, err
		}
		r := &YAMLMap{}
		r.Set("public_key", pub)
		if sid := node.Str("shortId"); sid != "" {
			r.Set("short_id", sid)
		}
		return r, nil
	}
	buildEgernTransport := func() (*YAMLMap, error) {
		netw := strings.ToLower(firstNonEmpty(strings.TrimSpace(node.Str("network")), "tcp"))
		sec := strings.ToLower(strings.TrimSpace(node.Str("security")))
		tlsB, _ := node.Bool("tls")
		tlsOn := tlsB || sec == "reality" || sec == "tls"
		reality, err := buildEgernReality()
		if err != nil {
			return nil, err
		}
		var headers *YAMLMap
		if h := node.Str("host"); h != "" {
			headers = &YAMLMap{}
			headers.Set("Host", h)
		}
		tr := &YAMLMap{}
		switch netw {
		case "tcp":
			if !tlsOn {
				return nil, nil
			}
			inner := &YAMLMap{}
			setEgernTLS(inner)
			if reality != nil {
				inner.Set("reality", reality)
			}
			tr.Set("tls", inner)
			return tr, nil
		case "ws":
			inner := &YAMLMap{}
			inner.Set("path", firstNonEmpty(node.Str("path"), "/"))
			if headers != nil {
				inner.Set("headers", headers)
			}
			if tlsOn {
				setEgernTLS(inner)
				tr.Set("wss", inner)
			} else {
				tr.Set("ws", inner)
			}
			return tr, nil
		case "grpc":
			if !tlsOn {
				return nil, errInvalid("unsupported_proxy_transport_" + netw)
			}
			inner := &YAMLMap{}
			inner.Set("service_name", node.Str("serviceName"))
			setEgernTLS(inner)
			if reality != nil {
				inner.Set("reality", reality)
			}
			tr.Set("grpc", inner)
			return tr, nil
		case "h2":
			inner := &YAMLMap{}
			inner.Set("path", firstNonEmpty(node.Str("path"), "/"))
			if headers != nil {
				inner.Set("headers", headers)
			}
			setEgernTLS(inner)
			tr.Set("http2", inner)
			return tr, nil
		case "http":
			if tlsOn {
				return nil, errInvalid("unsupported_proxy_transport_" + netw)
			}
			inner := &YAMLMap{}
			inner.Set("method", "GET")
			inner.Set("path", firstNonEmpty(node.Str("path"), "/"))
			if headers != nil {
				inner.Set("headers", headers)
			}
			tr.Set("http1", inner)
			return tr, nil
		default:
			return nil, errInvalid("unsupported_proxy_transport_" + netw)
		}
	}

	var eType string
	switch proto {
	case "shadowsocks":
		cipher, err := reqNodeString(node, "cipher")
		if err != nil {
			return nil, err
		}
		pass, err := reqNodeString(node, "password")
		if err != nil {
			return nil, err
		}
		if cipher == "chacha20-ietf-poly1305" {
			cipher = "chacha20-poly1305"
		}
		plugin := canonicalShadowsocksPlugin(node)
		var oMode, oHost, oURI string
		if plugin != nil {
			if plugin.Name != "obfs" {
				return nil, errInvalid("unsupported_shadowsocks_plugin_" + plugin.Name)
			}
			if plugin.Mode != "http" && plugin.Mode != "tls" {
				return nil, errInvalid("unsupported_shadowsocks_plugin_options")
			}
			oMode, oHost, oURI = plugin.Mode, plugin.Host, plugin.URI
		}
		eType = "shadowsocks"
		fields.Set("method", cipher)
		fields.Set("password", pass)
		if oMode != "" {
			fields.Set("obfs", oMode)
		}
		if oHost != "" {
			fields.Set("obfs_host", oHost)
		}
		if oURI != "" {
			fields.Set("obfs_uri", oURI)
		}
		fields.Set("udp_relay", true)
	case "vmess":
		uuid, err := reqNodeString(node, "uuid")
		if err != nil {
			return nil, err
		}
		tr, err := buildEgernTransport()
		if err != nil {
			return nil, err
		}
		cipher := strings.ToLower(strings.TrimSpace(node.Str("cipher")))
		if !egernSecuritySet[cipher] {
			cipher = "auto"
		}
		eType = "vmess"
		fields.Set("user_id", uuid)
		fields.Set("security", cipher)
		if alt, ok := node.Int("alterId"); ok && alt > 0 {
			fields.Set("legacy", true)
		}
		fields.Set("udp_relay", true)
		if tr != nil {
			fields.Set("transport", tr)
		}
	case "vless":
		if enc := strings.TrimSpace(node.Str("encryption")); enc != "" && strings.ToLower(enc) != "none" {
			return nil, errInvalid("unsupported_vless_encryption")
		}
		uuid, err := reqNodeString(node, "uuid")
		if err != nil {
			return nil, err
		}
		tr, err := buildEgernTransport()
		if err != nil {
			return nil, err
		}
		eType = "vless"
		fields.Set("user_id", uuid)
		if flow := node.Str("flow"); flow != "" {
			fields.Set("flow", flow)
		}
		fields.Set("udp_relay", true)
		if tr != nil {
			fields.Set("transport", tr)
		}
	case "trojan":
		netw := strings.ToLower(firstNonEmpty(strings.TrimSpace(node.Str("network")), "tcp"))
		if netw != "tcp" && netw != "ws" {
			return nil, errInvalid("unsupported_proxy_transport_" + netw)
		}
		pass, err := reqNodeString(node, "password")
		if err != nil {
			return nil, err
		}
		reality, err := buildEgernReality()
		if err != nil {
			return nil, err
		}
		eType = "trojan"
		fields.Set("password", pass)
		setEgernTLS(fields)
		if reality != nil {
			fields.Set("reality", reality)
		}
		if netw == "ws" {
			ws := &YAMLMap{}
			ws.Set("path", firstNonEmpty(node.Str("path"), "/"))
			if h := node.Str("host"); h != "" {
				ws.Set("host", h)
			}
			fields.Set("websocket", ws)
		}
		fields.Set("udp_relay", true)
	case "hysteria2":
		obfs := strings.ToLower(strings.TrimSpace(node.Str("obfs")))
		if obfs != "" && obfs != "salamander" {
			return nil, errInvalid("unsupported_hysteria2_obfs_" + obfs)
		}
		pass, err := reqNodeString(node, "password")
		if err != nil {
			return nil, err
		}
		eType = "hysteria2"
		fields.Set("auth", pass)
		setEgernTLS(fields)
		if obfs != "" {
			opw, err := reqNodeString(node, "obfsPassword")
			if err != nil {
				return nil, err
			}
			fields.Set("obfs", obfs)
			fields.Set("obfs_password", opw)
		}
		if ports := normalizePortRanges(node["ports"]); ports != "" {
			fields.Set("port_hopping", ports)
		}
	case "tuic":
		if node.Str("uuid") == "" || node.Str("password") == "" {
			return nil, errInvalid("unsupported_proxy_protocol_tuic-v4")
		}
		uuid, err := reqNodeString(node, "uuid")
		if err != nil {
			return nil, err
		}
		pass, err := reqNodeString(node, "password")
		if err != nil {
			return nil, err
		}
		alpn := normalizeStringSlice(node["alpn"])
		if len(alpn) == 0 {
			alpn = []string{"h3"}
		}
		eType = "tuic"
		fields.Set("uuid", uuid)
		fields.Set("password", pass)
		if ur := node.Str("udpRelayMode"); ur != "" {
			fields.Set("udp_relay_mode", ur)
		}
		fields.Set("alpn", alpn)
		setEgernTLS(fields)
	case "anytls":
		pass, err := reqNodeString(node, "password")
		if err != nil {
			return nil, err
		}
		eType = "anytls"
		fields.Set("password", pass)
		if sni := node.Str("sni"); sni != "" {
			fields.Set("sni", sni)
		}
		fields.Set("skip_tls_verify", nodeInsecure(node))
		fields.Set("udp_relay", true)
	case "wireguard":
		if _, err := wireguardAddresses(node); err != nil {
			return nil, err
		}
		priv, err := reqNodeString(node, "privateKey")
		if err != nil {
			return nil, err
		}
		pub, err := reqNodeString(node, "publicKey")
		if err != nil {
			return nil, err
		}
		rb, hasRB, err := wireguardReservedBytes(node["reserved"])
		if err != nil {
			return nil, err
		}
		eType = "wireguard"
		fields.Set("private_key", priv)
		fields.Set("peer_public_key", pub)
		if psk := node.Str("presharedKey"); psk != "" {
			fields.Set("preshared_key", psk)
		}
		if hasRB {
			fields.Set("reserved", rb)
		}
		if ip := node.Str("ip"); ip != "" {
			fields.Set("local_ipv4", ip)
		}
		if ipv6 := node.Str("ipv6"); ipv6 != "" {
			fields.Set("local_ipv6", ipv6)
		}
		if mtu, ok := node.Int("mtu"); ok && mtu > 0 {
			fields.Set("mtu", mtu)
		}
	case "snell":
		psk, err := reqNodeString(node, "psk")
		if err != nil {
			return nil, err
		}
		eType = "snell"
		fields.Set("psk", psk)
		ver, ok := node.Int("version")
		if ok && ver > 0 {
			fields.Set("version", ver)
		}
		if obfs := node.Str("obfs"); obfs != "" {
			fields.Set("obfs", obfs)
			if oh := node.Str("obfsHost"); oh != "" {
				fields.Set("obfs_host", oh)
			}
		}
		if ver >= 3 {
			fields.Set("udp_relay", true)
		}
	case "socks5":
		eType = "socks5"
		if u := node.Str("username"); u != "" {
			fields.Set("username", u)
		}
		if p := node.Str("password"); p != "" {
			fields.Set("password", p)
		}
		fields.Set("udp_relay", true)
	case "http", "https":
		tlsB, _ := node.Bool("tls")
		https := proto == "https" || tlsB
		if https {
			eType = "https"
		} else {
			eType = "http"
		}
		if u := node.Str("username"); u != "" {
			fields.Set("username", u)
		}
		if p := node.Str("password"); p != "" {
			fields.Set("password", p)
		}
		if https {
			setEgernTLS(fields)
		}
	default:
		return nil, errInvalid("unsupported_proxy_protocol_" + proto)
	}
	wrapper := &YAMLMap{}
	wrapper.Set(eType, fields)
	return wrapper, nil
}

// RelayEndpoint 表示边车提供的本机 socks5 入口信息。
type RelayEndpoint struct {
	Host     string
	Port     int
	Username string
	Password string
	UDP      bool
}

func compileRelayMihomoEntry(name string, ep RelayEndpoint) *YAMLMap {
	host := ep.Host
	if host == "" {
		host = "127.0.0.1"
	}
	proxy := &YAMLMap{}
	proxy.Set("name", name)
	proxy.Set("type", "socks5")
	proxy.Set("server", host)
	proxy.Set("port", ep.Port)
	if ep.Username != "" {
		proxy.Set("username", ep.Username)
		proxy.Set("password", ep.Password)
	}
	if ep.UDP {
		proxy.Set("udp", true)
	}
	return proxy
}

func compileRelaySurgeEntry(name string, ep RelayEndpoint) CompiledLineEntry {
	host := ep.Host
	if host == "" {
		host = "127.0.0.1"
	}
	args := []any{host, ep.Port}
	if ep.Username != "" {
		args = append(args, ep.Username, ep.Password)
	}
	var params []YAMLKV
	if ep.UDP {
		params = append(params, YAMLKV{Key: "udp-relay", Value: true})
	}
	return CompiledLineEntry{Line: FormatSurgeLine(name, "socks5", args, params)}
}

// marshalOrderedJSON 将 YAMLMap（及其嵌套值）序列化为保留键序的格式化 JSON 字节。
func yamlMapToOrderedJSON(v any, indent string) []byte {
	switch t := v.(type) {
	case *YAMLMap:
		if t == nil || len(t.Entries) == 0 {
			return []byte("{}")
		}
		var b strings.Builder
		b.WriteString("{\n")
		nextIndent := indent + "  "
		for i, kv := range t.Entries {
			keyB, _ := json.Marshal(kv.Key)
			b.WriteString(nextIndent)
			b.Write(keyB)
			b.WriteString(": ")
			b.Write(yamlMapToOrderedJSON(kv.Value, nextIndent))
			if i < len(t.Entries)-1 {
				b.WriteByte(',')
			}
			b.WriteByte('\n')
		}
		b.WriteString(indent)
		b.WriteByte('}')
		return []byte(b.String())
	case []*YAMLMap:
		if len(t) == 0 {
			return []byte("[]")
		}
		var b strings.Builder
		b.WriteString("[\n")
		nextIndent := indent + "  "
		for i, item := range t {
			b.WriteString(nextIndent)
			b.Write(yamlMapToOrderedJSON(item, nextIndent))
			if i < len(t)-1 {
				b.WriteByte(',')
			}
			b.WriteByte('\n')
		}
		b.WriteString(indent)
		b.WriteByte(']')
		return []byte(b.String())
	case []any:
		if len(t) == 0 {
			return []byte("[]")
		}
		var b strings.Builder
		b.WriteString("[\n")
		nextIndent := indent + "  "
		for i, item := range t {
			b.WriteString(nextIndent)
			b.Write(yamlMapToOrderedJSON(item, nextIndent))
			if i < len(t)-1 {
				b.WriteByte(',')
			}
			b.WriteByte('\n')
		}
		b.WriteString(indent)
		b.WriteByte(']')
		return []byte(b.String())
	default:
		out, _ := marshalCompactNoEscape(t)
		return out
	}
}

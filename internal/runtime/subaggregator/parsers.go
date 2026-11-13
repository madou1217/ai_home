package subaggregator

import (
	"encoding/base64"
	"encoding/json"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

// SkippedNodeInfo 描述解析阶段跳过的节点及其原因。
type SkippedNodeInfo struct {
	Name   string `json:"name,omitempty"`
	Line   string `json:"line,omitempty"`
	Reason string `json:"reason"`
}

// ParseImportResult 表示订阅文本的多格式解析结果。
type ParseImportResult struct {
	Format       string            `json:"format"`
	Nodes        []ProxyNode       `json:"nodes"`
	SkippedNodes []SkippedNodeInfo `json:"skippedNodes"`
}

func decodeBase64Flexible(s string) ([]byte, error) {
	s = strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(s, "-", "+"), "_", "/"))
	if mod := len(s) % 4; mod != 0 {
		s += strings.Repeat("=", 4-mod)
	}
	return base64.StdEncoding.DecodeString(s)
}

func decodeURLComponent(s string) string {
	u, err := url.QueryUnescape(s)
	if err == nil {
		return u
	}
	u, err = url.PathUnescape(s)
	if err == nil {
		return u
	}
	return s
}

func queryFlagBool(q url.Values, keys ...string) bool {
	for _, k := range keys {
		v := strings.ToLower(strings.TrimSpace(q.Get(k)))
		if v == "1" || v == "true" || v == "yes" {
			return true
		}
	}
	return false
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

// ParseImportContent 识别并解析 URI 列表、Base64 订阅、Clash/Mihomo/Egern YAML、sing-box/Xray/SIP008/AIH JSON、Surge/QX/WireGuard 配置。
func ParseImportContent(content string) (ParseImportResult, error) {
	raw := strings.TrimSpace(strings.TrimPrefix(content, "\uFEFF"))
	if raw == "" {
		return ParseImportResult{}, errInvalid("invalid_subscription_content")
	}

	if strings.HasPrefix(raw, "{") || strings.HasPrefix(raw, "[") {
		if res, ok := tryParseJSONImport(raw); ok {
			return res, nil
		}
	}

	if strings.Contains(raw, "[Interface]") && strings.Contains(raw, "[Peer]") {
		if res, ok := parseWireGuardConf(raw); ok {
			return res, nil
		}
	}

	if hasINISection(raw, "Proxy") {
		if res, ok := parseSurgeConfig(raw); ok {
			return res, nil
		}
	}

	if hasINISection(raw, "server_local") {
		if res, ok := parseQXConfig(raw); ok {
			return res, nil
		}
	}

	if looksLikeYAML(raw) {
		if res, ok := tryParseYAMLImport(raw); ok {
			return res, nil
		}
	}

	res := parseLineList(raw)
	if len(res.Nodes) > 0 || len(res.SkippedNodes) > 0 {
		return res, nil
	}

	if decoded, err := decodeBase64Flexible(raw); err == nil && len(decoded) > 0 {
		text := strings.TrimSpace(string(decoded))
		if text != "" && text != raw {
			if strings.HasPrefix(text, "{") || strings.HasPrefix(text, "[") {
				if jRes, ok := tryParseJSONImport(text); ok {
					return jRes, nil
				}
			}
			if looksLikeYAML(text) {
				if yRes, ok := tryParseYAMLImport(text); ok {
					return yRes, nil
				}
			}
			lRes := parseLineList(text)
			if len(lRes.Nodes) > 0 || len(lRes.SkippedNodes) > 0 {
				lRes.Format = "base64"
				return lRes, nil
			}
		}
	}

	return ParseImportResult{}, errInvalid("no_valid_proxy_nodes_found")
}

func hasINISection(raw, name string) bool {
	re := regexp.MustCompile(`(?im)^\[` + regexp.QuoteMeta(name) + `\]\s*$`)
	return re.MatchString(raw)
}

func looksLikeYAML(raw string) bool {
	return strings.Contains(raw, "proxies:") || strings.Contains(raw, "Proxy:")
}

func finalizeParsedNodes(format string, candidates []any, originName map[int]string) ParseImportResult {
	res := ParseImportResult{Format: format, Nodes: []ProxyNode{}, SkippedNodes: []SkippedNodeInfo{}}
	for idx, c := range candidates {
		m, ok := c.(map[string]any)
		if !ok || m == nil {
			continue
		}
		norm, err := ValidateAndNormalizeNode(ProxyNode(m))
		if err != nil {
			reason := err.Error()
			if de, ok := AsDomainError(err); ok {
				reason = de.Code
			}
			name := toString(m["name"])
			if name == "" && originName != nil {
				name = originName[idx]
			}
			res.SkippedNodes = append(res.SkippedNodes, SkippedNodeInfo{Name: name, Reason: reason})
			continue
		}
		res.Nodes = append(res.Nodes, norm)
	}
	return res
}

func tryParseJSONImport(raw string) (ParseImportResult, bool) {
	cleaned := StripJSONC(raw)
	var doc any
	if err := json.Unmarshal([]byte(cleaned), &doc); err != nil {
		return ParseImportResult{}, false
	}
	if arr, ok := doc.([]any); ok {
		return parseJSONNodeArray("json", arr), len(arr) > 0
	}
	obj, ok := doc.(map[string]any)
	if !ok {
		return ParseImportResult{}, false
	}
	if nodes, ok := obj["nodes"].([]any); ok {
		return parseJSONNodeArray("aih-json", nodes), true
	}
	if servers, ok := obj["servers"].([]any); ok {
		var candidates []any
		for _, item := range servers {
			sm, ok := item.(map[string]any)
			if !ok {
				continue
			}
			candidates = append(candidates, map[string]any{
				"protocol":   "shadowsocks",
				"name":       firstNonEmpty(toString(sm["remarks"]), toString(sm["name"])),
				"server":     sm["server"],
				"port":       sm["server_port"],
				"cipher":     sm["method"],
				"password":   sm["password"],
				"plugin":     sm["plugin"],
				"pluginOpts": sm["plugin_opts"],
			})
		}
		return finalizeParsedNodes("sip008", candidates, nil), true
	}
	if _, hasOutbounds := obj["outbounds"]; hasOutbounds || obj["endpoints"] != nil {
		return parseSingBoxConfigDoc(obj), true
	}
	if _, hasProtocol := obj["protocol"]; hasProtocol && obj["server"] != nil {
		res := finalizeParsedNodes("json", []any{obj}, nil)
		return res, true
	}
	return ParseImportResult{}, false
}

func parseJSONNodeArray(defaultFmt string, items []any) ParseImportResult {
	var candidates []any
	isXray := false
	isSingBox := false
	for _, it := range items {
		m, ok := it.(map[string]any)
		if !ok {
			continue
		}
		if _, hasSettings := m["settings"]; hasSettings {
			isXray = true
			candidates = append(candidates, convertXrayOutbound(m)...)
		} else if _, hasServerPort := m["server_port"]; hasServerPort && m["type"] != nil {
			isSingBox = true
			if conv := convertSingBoxOutbound(m); conv != nil {
				candidates = append(candidates, conv)
			}
		} else {
			candidates = append(candidates, m)
		}
	}
	fmtName := defaultFmt
	if isXray {
		fmtName = "xray"
	} else if isSingBox {
		fmtName = "sing-box"
	}
	return finalizeParsedNodes(fmtName, candidates, nil)
}

func parseSingBoxConfigDoc(doc map[string]any) ParseImportResult {
	var candidates []any
	xrayCount := 0
	if eps, ok := doc["endpoints"].([]any); ok {
		for _, ep := range eps {
			if m, ok := ep.(map[string]any); ok {
				if conv := convertSingBoxEndpoint(m); conv != nil {
					candidates = append(candidates, conv)
				}
			}
		}
	}
	if obs, ok := doc["outbounds"].([]any); ok {
		for _, ob := range obs {
			m, ok := ob.(map[string]any)
			if !ok {
				continue
			}
			if _, hasSettings := m["settings"]; hasSettings {
				xrayCount++
				candidates = append(candidates, convertXrayOutbound(m)...)
				continue
			}
			if conv := convertSingBoxOutbound(m); conv != nil {
				candidates = append(candidates, conv)
			}
		}
	}
	fmtName := "sing-box"
	if xrayCount > 0 && len(candidates) > 0 {
		fmtName = "xray"
	}
	return finalizeParsedNodes(fmtName, candidates, nil)
}

func convertSingBoxEndpoint(m map[string]any) map[string]any {
	if strings.ToLower(toString(m["type"])) != "wireguard" {
		return nil
	}
	peers, _ := m["peers"].([]any)
	var peer map[string]any
	if len(peers) > 0 {
		peer, _ = peers[0].(map[string]any)
	}
	node := map[string]any{
		"protocol":     "wireguard",
		"name":         m["tag"],
		"server":       peer["address"],
		"port":         peer["port"],
		"privateKey":   m["private_key"],
		"publicKey":    peer["public_key"],
		"presharedKey": peer["pre_shared_key"],
		"mtu":          m["mtu"],
		"reserved":     peer["reserved"],
	}
	if addrs, ok := m["address"].([]any); ok {
		for _, a := range addrs {
			s := toString(a)
			if strings.Contains(s, ":") {
				node["ipv6"] = s
			} else if s != "" {
				node["ip"] = s
			}
		}
	}
	return node
}

func convertSingBoxOutbound(m map[string]any) map[string]any {
	typ := strings.ToLower(toString(m["type"]))
	switch typ {
	case "", "direct", "block", "dns", "selector", "urltest":
		return nil
	}
	node := map[string]any{
		"name":   firstNonEmpty(toString(m["tag"]), toString(m["name"])),
		"server": m["server"],
		"port":   m["server_port"],
	}
	switch typ {
	case "shadowsocks":
		node["protocol"] = "shadowsocks"
		node["cipher"] = m["method"]
		node["password"] = m["password"]
		node["plugin"] = m["plugin"]
		node["pluginOpts"] = m["plugin_opts"]
	case "vmess":
		node["protocol"] = "vmess"
		node["uuid"] = m["uuid"]
		node["cipher"] = m["security"]
		node["alterId"] = m["alter_id"]
	case "vless":
		node["protocol"] = "vless"
		node["uuid"] = m["uuid"]
		node["flow"] = m["flow"]
	case "trojan":
		node["protocol"] = "trojan"
		node["password"] = m["password"]
	case "hysteria2":
		node["protocol"] = "hysteria2"
		node["password"] = m["password"]
		node["upMbps"] = m["up_mbps"]
		node["downMbps"] = m["down_mbps"]
		if ports, ok := m["server_ports"].([]any); ok {
			var ps []string
			for _, p := range ports {
				ps = append(ps, strings.ReplaceAll(toString(p), ":", "-"))
			}
			node["ports"] = strings.Join(ps, ",")
		}
		if m["hop_interval"] != nil {
			node["hopInterval"] = m["hop_interval"]
		}
		if obfs, ok := m["obfs"].(map[string]any); ok {
			node["obfs"] = obfs["type"]
			node["obfsPassword"] = obfs["password"]
		}
	case "hysteria":
		node["protocol"] = "hysteria"
		node["authStr"] = firstNonEmpty(toString(m["auth_str"]), toString(m["auth"]))
		node["upMbps"] = m["up_mbps"]
		node["downMbps"] = m["down_mbps"]
		node["obfs"] = m["obfs"]
	case "tuic":
		node["protocol"] = "tuic"
		node["uuid"] = m["uuid"]
		node["password"] = m["password"]
		node["congestionControl"] = m["congestion_control"]
		node["udpRelayMode"] = m["udp_relay_mode"]
	case "anytls":
		node["protocol"] = "anytls"
		node["password"] = m["password"]
	case "wireguard":
		node["protocol"] = "wireguard"
		node["privateKey"] = m["private_key"]
		node["publicKey"] = m["peer_public_key"]
		node["presharedKey"] = m["pre_shared_key"]
		node["mtu"] = m["mtu"]
		node["reserved"] = m["reserved"]
		if addrs, ok := m["local_address"].([]any); ok {
			for _, a := range addrs {
				s := toString(a)
				if strings.Contains(s, ":") {
					node["ipv6"] = s
				} else if s != "" {
					node["ip"] = s
				}
			}
		}
	case "socks":
		node["protocol"] = "socks5"
		node["username"] = m["username"]
		node["password"] = m["password"]
	case "http":
		node["protocol"] = "http"
		node["username"] = m["username"]
		node["password"] = m["password"]
	case "ssh":
		node["protocol"] = "ssh"
		node["username"] = m["user"]
		node["password"] = m["password"]
		node["privateKey"] = m["private_key"]
		node["privateKeyPassphrase"] = m["private_key_passphrase"]
		node["hostKey"] = m["host_key"]
		node["hostKeyAlgorithms"] = m["host_key_algorithms"]
	case "naive":
		node["protocol"] = "naive"
		node["username"] = m["username"]
		node["password"] = m["password"]
	default:
		return nil
	}
	if tr, ok := m["transport"].(map[string]any); ok {
		node["network"] = tr["type"]
		node["path"] = tr["path"]
		if h, ok := tr["host"].([]any); ok && len(h) > 0 {
			node["host"] = toString(h[0])
		} else if tr["host"] != nil {
			node["host"] = tr["host"]
		} else if hdrs, ok := tr["headers"].(map[string]any); ok && hdrs["Host"] != nil {
			node["host"] = hdrs["Host"]
		}
		node["serviceName"] = tr["service_name"]
	}
	if tlsM, ok := m["tls"].(map[string]any); ok {
		if b, ok := toBool(tlsM["enabled"]); ok && b {
			node["tls"] = true
			if typ == "vless" {
				node["security"] = "tls"
			}
		}
		node["sni"] = tlsM["server_name"]
		node["alpn"] = tlsM["alpn"]
		node["allowInsecure"] = tlsM["insecure"]
		if utls, ok := tlsM["utls"].(map[string]any); ok {
			node["fingerprint"] = utls["fingerprint"]
		}
		if reality, ok := tlsM["reality"].(map[string]any); ok {
			if b, ok := toBool(reality["enabled"]); ok && b {
				node["security"] = "reality"
				node["publicKey"] = reality["public_key"]
				node["shortId"] = reality["short_id"]
			}
		}
	}
	return node
}

func convertXrayOutbound(m map[string]any) []any {
	proto := strings.ToLower(toString(m["protocol"]))
	settings, _ := m["settings"].(map[string]any)
	stream, _ := m["streamSettings"].(map[string]any)
	tag := toString(m["tag"])
	if settings == nil {
		return nil
	}
	var nodes []any
	applyStream := func(node map[string]any) {
		if stream == nil {
			return
		}
		if net := toString(stream["network"]); net != "" {
			if net == "splithttp" {
				net = "xhttp"
			}
			node["network"] = net
		}
		if sec := strings.ToLower(toString(stream["security"])); sec == "tls" || sec == "reality" {
			node["tls"] = true
			if proto == "vless" {
				node["security"] = sec
			}
			if sec == "reality" {
				if rs, ok := stream["realitySettings"].(map[string]any); ok {
					node["sni"] = rs["serverName"]
					node["fingerprint"] = rs["fingerprint"]
					node["publicKey"] = rs["publicKey"]
					node["shortId"] = rs["shortId"]
				}
			} else if ts, ok := stream["tlsSettings"].(map[string]any); ok {
				node["sni"] = ts["serverName"]
				node["alpn"] = ts["alpn"]
				node["allowInsecure"] = ts["allowInsecure"]
				node["fingerprint"] = ts["fingerprint"]
			}
		}
		if ws, ok := stream["wsSettings"].(map[string]any); ok {
			node["path"] = ws["path"]
			if hdrs, ok := ws["headers"].(map[string]any); ok {
				node["host"] = firstNonEmpty(toString(hdrs["Host"]), toString(hdrs["host"]))
			}
		}
		if grpc, ok := stream["grpcSettings"].(map[string]any); ok {
			node["serviceName"] = grpc["serviceName"]
		}
	}
	if vnext, ok := settings["vnext"].([]any); ok {
		for _, item := range vnext {
			v, _ := item.(map[string]any)
			users, _ := v["users"].([]any)
			var u map[string]any
			if len(users) > 0 {
				u, _ = users[0].(map[string]any)
			}
			node := map[string]any{
				"protocol": proto,
				"name":     tag,
				"server":   v["address"],
				"port":     v["port"],
				"uuid":     u["id"],
			}
			if proto == "vmess" {
				node["alterId"] = u["alterId"]
				node["cipher"] = u["security"]
			} else if proto == "vless" {
				node["flow"] = u["flow"]
				node["encryption"] = u["encryption"]
			}
			applyStream(node)
			nodes = append(nodes, node)
		}
	}
	if servers, ok := settings["servers"].([]any); ok {
		for _, item := range servers {
			s, _ := item.(map[string]any)
			node := map[string]any{
				"protocol": proto,
				"name":     tag,
				"server":   s["address"],
				"port":     s["port"],
				"password": s["password"],
				"cipher":   s["method"],
			}
			if proto == "socks" {
				node["protocol"] = "socks5"
			}
			applyStream(node)
			nodes = append(nodes, node)
		}
	}
	return nodes
}

func tryParseYAMLImport(raw string) (ParseImportResult, bool) {
	doc, err := ParseYAML(raw)
	if err != nil || doc == nil {
		return ParseImportResult{}, false
	}
	m, ok := doc.(map[string]any)
	if !ok {
		return ParseImportResult{}, false
	}
	rawProxies, hasProxies := m["proxies"]
	if !hasProxies {
		return ParseImportResult{}, false
	}
	var list []any
	isEgern := false
	switch x := rawProxies.(type) {
	case []any:
		list = x
	case map[string]any:
		isEgern = true
		for name, entry := range x {
			if em, ok := entry.(map[string]any); ok {
				if conv := convertEgernEntry(em, name); conv != nil {
					list = append(list, conv)
				}
			}
		}
	default:
		return ParseImportResult{}, false
	}
	var candidates []any
	for _, entry := range list {
		em, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		if _, hasType := em["type"]; !hasType {
			if conv := convertEgernEntry(em, ""); conv != nil {
				isEgern = true
				candidates = append(candidates, conv)
			}
			continue
		}
		if conv := convertClashEntry(em); conv != nil {
			candidates = append(candidates, conv)
		}
	}
	fmtName := "clash"
	if isEgern {
		fmtName = "egern"
	}
	return finalizeParsedNodes(fmtName, candidates, nil), true
}

func convertEgernEntry(m map[string]any, fallbackName string) map[string]any {
	for _, protoKey := range []string{"shadowsocks", "vmess", "vless", "trojan", "hysteria2", "tuic", "anytls", "socks5", "http", "wireguard"} {
		sub, ok := m[protoKey].(map[string]any)
		if !ok {
			continue
		}
		node := map[string]any{
			"protocol": protoKey,
			"name":     firstNonEmpty(toString(sub["name"]), fallbackName),
			"server":   sub["server"],
			"port":     sub["port"],
			"password": sub["password"],
			"uuid":     firstNonEmpty(toString(sub["user_id"]), toString(sub["uuid"])),
			"sni":      sub["sni"],
		}
		if protoKey == "shadowsocks" {
			method := toString(sub["method"])
			if method == "chacha20-poly1305" {
				method = "chacha20-ietf-poly1305"
			}
			node["cipher"] = method
		}
		if tr, ok := sub["transport"].(map[string]any); ok {
			if ws, ok := tr["wss"].(map[string]any); ok {
				node["network"] = "ws"
				node["tls"] = true
				node["path"] = ws["path"]
				node["sni"] = firstNonEmpty(toString(ws["sni"]), toString(node["sni"]))
			} else if ws, ok := tr["ws"].(map[string]any); ok {
				node["network"] = "ws"
				node["path"] = ws["path"]
			} else if grpc, ok := tr["grpc"].(map[string]any); ok {
				node["network"] = "grpc"
				node["serviceName"] = grpc["service_name"]
			}
		}
		if protoKey == "vless" {
			node["flow"] = sub["flow"]
			if tlsB, ok := toBool(node["tls"]); ok && tlsB {
				node["security"] = "tls"
			}
		}
		return node
	}
	return nil
}

func convertClashEntry(m map[string]any) map[string]any {
	typ := NormalizeProtocolAlias(toString(m["type"]))
	if typ == "" {
		return nil
	}
	node := map[string]any{
		"protocol":      typ,
		"name":          m["name"],
		"server":        m["server"],
		"port":          m["port"],
		"sni":           firstNonEmpty(toString(m["sni"]), toString(m["servername"])),
		"alpn":          m["alpn"],
		"allowInsecure": m["skip-cert-verify"],
		"fingerprint":   firstNonEmpty(toString(m["client-fingerprint"]), toString(m["fingerprint"])),
	}
	if b, ok := toBool(m["tls"]); ok {
		node["tls"] = b
	}
	if net := toString(m["network"]); net != "" {
		node["network"] = net
	}
	if ws, ok := m["ws-opts"].(map[string]any); ok {
		node["path"] = ws["path"]
		if hdrs, ok := ws["headers"].(map[string]any); ok {
			node["host"] = firstNonEmpty(toString(hdrs["Host"]), toString(hdrs["host"]))
		}
	}
	if grpc, ok := m["grpc-opts"].(map[string]any); ok {
		node["serviceName"] = grpc["grpc-service-name"]
	}
	if h2, ok := m["h2-opts"].(map[string]any); ok {
		node["path"] = h2["path"]
		if h, ok := h2["host"].([]any); ok && len(h) > 0 {
			node["host"] = toString(h[0])
		}
	}
	if httpOpts, ok := m["http-opts"].(map[string]any); ok {
		if p, ok := httpOpts["path"].([]any); ok && len(p) > 0 {
			node["path"] = toString(p[0])
		} else if httpOpts["path"] != nil {
			node["path"] = httpOpts["path"]
		}
	}
	switch typ {
	case "shadowsocks":
		node["cipher"] = m["cipher"]
		node["password"] = m["password"]
		node["plugin"] = m["plugin"]
		node["pluginOpts"] = m["plugin-opts"]
	case "shadowsocksr":
		node["cipher"] = m["cipher"]
		node["password"] = m["password"]
		node["ssrProtocol"] = m["protocol"]
		node["ssrProtocolParam"] = m["protocol-param"]
		node["ssrObfs"] = m["obfs"]
		node["ssrObfsParam"] = m["obfs-param"]
	case "vmess":
		node["uuid"] = m["uuid"]
		node["cipher"] = m["cipher"]
		node["alterId"] = m["alterId"]
	case "vless":
		node["uuid"] = m["uuid"]
		node["flow"] = m["flow"]
		node["encryption"] = m["encryption"]
		if reality, ok := m["reality-opts"].(map[string]any); ok {
			node["security"] = "reality"
			node["publicKey"] = reality["public-key"]
			node["shortId"] = reality["short-id"]
		} else if tlsB, ok := toBool(m["tls"]); ok && tlsB {
			node["security"] = "tls"
		}
	case "trojan":
		node["password"] = m["password"]
	case "hysteria2":
		node["password"] = m["password"]
		node["obfs"] = m["obfs"]
		node["obfsPassword"] = m["obfs-password"]
		node["ports"] = m["ports"]
		node["hopInterval"] = m["hop-interval"]
		node["upMbps"] = m["up"]
		node["downMbps"] = m["down"]
	case "hysteria":
		node["authStr"] = firstNonEmpty(toString(m["auth-str"]), toString(m["auth_str"]))
		node["hysteriaProtocol"] = m["protocol"]
		node["obfs"] = m["obfs"]
		node["upMbps"] = m["up"]
		node["downMbps"] = m["down"]
	case "tuic":
		node["uuid"] = m["uuid"]
		node["password"] = m["password"]
		node["token"] = m["token"]
		node["congestionControl"] = m["congestion-controller"]
		node["udpRelayMode"] = m["udp-relay-mode"]
	case "anytls":
		node["password"] = m["password"]
	case "wireguard":
		node["privateKey"] = m["private-key"]
		node["publicKey"] = m["public-key"]
		node["presharedKey"] = m["pre-shared-key"]
		node["ip"] = m["ip"]
		node["ipv6"] = m["ipv6"]
		node["mtu"] = m["mtu"]
		node["reserved"] = m["reserved"]
	case "snell":
		node["psk"] = m["psk"]
		node["version"] = m["version"]
		if obfs, ok := m["obfs-opts"].(map[string]any); ok {
			node["obfs"] = obfs["mode"]
			node["obfsHost"] = obfs["host"]
		}
	case "socks5", "http":
		node["username"] = m["username"]
		node["password"] = m["password"]
	case "ssh":
		node["username"] = m["username"]
		node["password"] = m["password"]
		node["privateKey"] = m["private-key"]
		node["privateKeyPassphrase"] = m["private-key-passphrase"]
		node["hostKey"] = m["host-key"]
		node["hostKeyAlgorithms"] = m["host-key-algorithms"]
	case "mieru":
		node["username"] = m["username"]
		node["password"] = m["password"]
		node["transport"] = m["transport"]
		node["multiplexing"] = m["multiplexing"]
		node["handshakeMode"] = m["handshake-mode"]
		node["trafficPattern"] = m["traffic-pattern"]
		node["ports"] = m["port-range"]
	}
	return node
}

func parseWireGuardConf(raw string) (ParseImportResult, bool) {
	var privKey, pubKey, psk, ip4, ip6, server string
	var port int
	var mtu any
	section := ""
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			section = strings.ToLower(strings.TrimSpace(line[1 : len(line)-1]))
			continue
		}
		kv := strings.SplitN(line, "=", 2)
		if len(kv) != 2 {
			continue
		}
		k := strings.ToLower(strings.TrimSpace(kv[0]))
		v := strings.TrimSpace(kv[1])
		switch section {
		case "interface":
			switch k {
			case "privatekey":
				privKey = v
			case "address":
				for _, addr := range strings.Split(v, ",") {
					addr = strings.TrimSpace(addr)
					if strings.Contains(addr, ":") {
						ip6 = addr
					} else if addr != "" {
						ip4 = addr
					}
				}
			case "mtu":
				if m, ok := toInt(v); ok {
					mtu = m
				}
			}
		case "peer":
			switch k {
			case "publickey":
				pubKey = v
			case "presharedkey":
				psk = v
			case "endpoint":
				host, portVal := splitHostPort(v)
				server = host
				port = portVal
			}
		}
	}
	if server == "" || !isValidPort(port) {
		return ParseImportResult{}, false
	}
	node := map[string]any{
		"protocol":     "wireguard",
		"name":         "WireGuard",
		"server":       server,
		"port":         port,
		"privateKey":   privKey,
		"publicKey":    pubKey,
		"presharedKey": psk,
		"ip":           ip4,
		"ipv6":         ip6,
		"mtu":          mtu,
	}
	return finalizeParsedNodes("wireguard-conf", []any{node}, nil), true
}

func parseSurgeConfig(raw string) (ParseImportResult, bool) {
	inProxy := false
	var candidates []any
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			inProxy = strings.EqualFold(strings.TrimSpace(line[1:len(line)-1]), "Proxy")
			continue
		}
		if !inProxy {
			continue
		}
		if n := parseSurgeProxyLine(line); n != nil {
			candidates = append(candidates, n)
		}
	}
	return finalizeParsedNodes("surge", candidates, nil), true
}

func parseSurgeProxyLine(line string) map[string]any {
	eq := strings.IndexByte(line, '=')
	if eq <= 0 {
		return nil
	}
	name := strings.TrimSpace(line[:eq])
	rest := strings.TrimSpace(line[eq+1:])
	parts := strings.Split(rest, ",")
	if len(parts) < 3 {
		return nil
	}
	typ := strings.ToLower(strings.TrimSpace(parts[0]))
	if typ == "direct" || typ == "reject" || typ == "reject-tinygif" {
		return nil
	}
	server := strings.TrimSpace(parts[1])
	port, _ := toInt(strings.TrimSpace(parts[2]))
	kv := map[string]string{}
	for _, seg := range parts[3:] {
		if k, v, ok := strings.Cut(seg, "="); ok {
			kv[strings.ToLower(strings.TrimSpace(k))] = strings.Trim(strings.TrimSpace(v), `"`)
		}
	}
	node := map[string]any{
		"name":   name,
		"server": server,
		"port":   port,
		"sni":    kv["sni"],
	}
	if b, ok := toBool(kv["skip-cert-verify"]); ok {
		node["allowInsecure"] = b
	}
	switch typ {
	case "ss":
		node["protocol"] = "shadowsocks"
		node["cipher"] = kv["encrypt-method"]
		node["password"] = kv["password"]
	case "vmess":
		node["protocol"] = "vmess"
		node["uuid"] = firstNonEmpty(kv["username"], kv["uuid"])
		if b, ok := toBool(kv["tls"]); ok {
			node["tls"] = b
		}
		if ws, ok := toBool(kv["ws"]); ok && ws {
			node["network"] = "ws"
			node["path"] = kv["ws-path"]
		}
	case "trojan":
		node["protocol"] = "trojan"
		node["password"] = kv["password"]
	case "hysteria2":
		node["protocol"] = "hysteria2"
		node["password"] = kv["password"]
	case "snell":
		node["protocol"] = "snell"
		node["psk"] = kv["psk"]
		if v, ok := toInt(kv["version"]); ok {
			node["version"] = v
		}
		node["obfs"] = kv["obfs"]
		node["obfsHost"] = kv["obfs-host"]
	case "tuic":
		node["protocol"] = "tuic"
		node["token"] = kv["token"]
	case "socks5", "socks5-tls":
		node["protocol"] = "socks5"
		node["username"] = kv["username"]
		node["password"] = kv["password"]
	case "http", "https":
		node["protocol"] = "http"
		node["tls"] = typ == "https"
		node["username"] = kv["username"]
		node["password"] = kv["password"]
	default:
		return nil
	}
	return node
}

func parseQXConfig(raw string) (ParseImportResult, bool) {
	inSec := false
	var candidates []any
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			inSec = strings.EqualFold(strings.TrimSpace(line[1:len(line)-1]), "server_local")
			continue
		}
		if !inSec {
			continue
		}
		if n := parseQXLine(line); n != nil {
			candidates = append(candidates, n)
		}
	}
	return finalizeParsedNodes("quantumult-x", candidates, nil), true
}

func parseQXLine(line string) map[string]any {
	eq := strings.IndexByte(line, '=')
	if eq <= 0 {
		return nil
	}
	typ := strings.ToLower(strings.TrimSpace(line[:eq]))
	parts := strings.Split(line[eq+1:], ",")
	if len(parts) < 2 {
		return nil
	}
	host, port := splitHostPort(strings.TrimSpace(parts[0]))
	kv := map[string]string{}
	for _, seg := range parts[1:] {
		if k, v, ok := strings.Cut(seg, "="); ok {
			kv[strings.ToLower(strings.TrimSpace(k))] = strings.Trim(strings.TrimSpace(v), `"`)
		}
	}
	node := map[string]any{
		"server": host,
		"port":   port,
		"name":   kv["tag"],
	}
	switch typ {
	case "shadowsocks":
		node["protocol"] = "shadowsocks"
		node["cipher"] = kv["method"]
		node["password"] = kv["password"]
	case "vmess":
		node["protocol"] = "vmess"
		node["cipher"] = kv["method"]
		node["uuid"] = kv["password"]
		if kv["obfs"] == "wss" {
			node["network"] = "ws"
			node["tls"] = true
			node["path"] = kv["obfs-uri"]
			node["sni"] = kv["obfs-host"]
		} else if kv["obfs"] == "ws" {
			node["network"] = "ws"
			node["path"] = kv["obfs-uri"]
			node["host"] = kv["obfs-host"]
		}
	case "vless":
		node["protocol"] = "vless"
		node["uuid"] = kv["password"]
		if kv["obfs"] == "wss" {
			node["network"] = "ws"
			node["tls"] = true
			node["security"] = "tls"
			node["path"] = kv["obfs-uri"]
			node["sni"] = kv["obfs-host"]
		}
	case "trojan":
		node["protocol"] = "trojan"
		node["password"] = kv["password"]
		node["sni"] = kv["tls-host"]
	case "http":
		node["protocol"] = "http"
		node["username"] = kv["username"]
		node["password"] = kv["password"]
	default:
		return nil
	}
	return node
}

func parseLineList(raw string) ParseImportResult {
	res := ParseImportResult{Format: "uri", Nodes: []ProxyNode{}, SkippedNodes: []SkippedNodeInfo{}}
	lines := strings.FieldsFunc(raw, func(r rune) bool { return r == '\r' || r == '\n' })
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, "//") {
			continue
		}
		if strings.Contains(line, "://") {
			nodeMap, err := parseProxyURI(line)
			if err != nil {
				reason := err.Error()
				if de, ok := AsDomainError(err); ok {
					reason = de.Code
				}
				res.SkippedNodes = append(res.SkippedNodes, SkippedNodeInfo{Line: line, Reason: reason})
				continue
			}
			norm, err := ValidateAndNormalizeNode(ProxyNode(nodeMap))
			if err != nil {
				reason := err.Error()
				if de, ok := AsDomainError(err); ok {
					reason = de.Code
				}
				res.SkippedNodes = append(res.SkippedNodes, SkippedNodeInfo{Name: toString(nodeMap["name"]), Line: line, Reason: reason})
				continue
			}
			res.Nodes = append(res.Nodes, norm)
			continue
		}
		if n := parseQXLine(line); n != nil {
			res.Format = "quantumult-x"
			if norm, err := ValidateAndNormalizeNode(ProxyNode(n)); err == nil {
				res.Nodes = append(res.Nodes, norm)
			}
			continue
		}
		if n := parseSurgeProxyLine(line); n != nil {
			res.Format = "surge"
			if norm, err := ValidateAndNormalizeNode(ProxyNode(n)); err == nil {
				res.Nodes = append(res.Nodes, norm)
			}
		}
	}
	return res
}

func splitHostPort(hp string) (string, int) {
	hp = strings.TrimSpace(hp)
	if strings.HasPrefix(hp, "[") {
		if end := strings.IndexByte(hp, ']'); end > 0 {
			host := hp[1:end]
			rest := strings.TrimPrefix(hp[end+1:], ":")
			p, _ := toInt(rest)
			return host, p
		}
	}
	if idx := strings.LastIndexByte(hp, ':'); idx > 0 {
		if p, ok := toInt(hp[idx+1:]); ok {
			return hp[:idx], p
		}
	}
	return hp, 0
}

func parseProxyURI(raw string) (map[string]any, error) {
	idx := strings.Index(raw, "://")
	if idx <= 0 {
		return nil, errInvalid("invalid_proxy_uri")
	}
	scheme := strings.ToLower(raw[:idx])
	switch scheme {
	case "ss":
		return parseSSURI(raw)
	case "ssr":
		return parseSSRURI(raw)
	case "vmess":
		return parseVMessURI(raw)
	case "vless":
		return parseVLESSURI(raw)
	case "trojan":
		return parseTrojanURI(raw)
	case "hy2", "hysteria2":
		return parseHysteria2URI(raw)
	case "hysteria", "hysteria1", "hy1":
		return parseHysteria1URI(raw)
	case "tuic":
		return parseTUICURI(raw)
	case "anytls":
		return parseAnyTLSURI(raw)
	case "wireguard", "wg":
		return parseWireGuardURI(raw)
	case "socks", "socks5":
		return parseSocks5URI(raw)
	case "http", "https":
		return parseHTTPURI(raw)
	case "naive+https", "naive+quic":
		return parseNaiveURI(raw, scheme == "naive+quic")
	}
	return nil, errInvalid("unsupported_proxy_protocol_" + scheme)
}

func parseSSURI(raw string) (map[string]any, error) {
	rest := raw[len("ss://"):]
	name := ""
	if hash := strings.IndexByte(rest, '#'); hash >= 0 {
		name = decodeURLComponent(rest[hash+1:])
		rest = rest[:hash]
	}
	var queryStr string
	if q := strings.IndexByte(rest, '?'); q >= 0 {
		queryStr = rest[q+1:]
		rest = rest[:q]
	}
	rest = strings.TrimSuffix(rest, "/")
	var cipher, password, server string
	var port int
	if at := strings.LastIndexByte(rest, '@'); at >= 0 {
		userPart := rest[:at]
		hostPart := rest[at+1:]
		server, port = splitHostPort(hostPart)
		if !strings.Contains(userPart, ":") {
			if dec, err := decodeBase64Flexible(decodeURLComponent(userPart)); err == nil {
				userPart = string(dec)
			}
		} else {
			userPart = decodeURLComponent(userPart)
		}
		if c, p, ok := strings.Cut(userPart, ":"); ok {
			cipher, password = decodeURLComponent(c), decodeURLComponent(p)
		}
	} else {
		dec, err := decodeBase64Flexible(rest)
		if err != nil {
			return nil, errInvalid("invalid_proxy_uri")
		}
		full := string(dec)
		at2 := strings.LastIndexByte(full, '@')
		if at2 <= 0 {
			return nil, errInvalid("invalid_proxy_uri")
		}
		c, p, ok := strings.Cut(full[:at2], ":")
		if !ok {
			return nil, errInvalid("invalid_proxy_uri")
		}
		cipher, password = c, p
		server, port = splitHostPort(full[at2+1:])
	}
	node := map[string]any{
		"protocol": "shadowsocks",
		"name":     name,
		"server":   server,
		"port":     port,
		"cipher":   cipher,
		"password": password,
	}
	if queryStr != "" {
		q, _ := url.ParseQuery(queryStr)
		if plugRaw := q.Get("plugin"); plugRaw != "" {
			plugName, optsStr, _ := strings.Cut(plugRaw, ";")
			node["plugin"] = normalizeShadowsocksPluginName(plugName)
			if optsStr != "" {
				node["pluginOpts"] = parsePluginOptsMap(optsStr)
			}
		}
	}
	return node, nil
}

func parseSSRURI(raw string) (map[string]any, error) {
	dec, err := decodeBase64Flexible(strings.TrimPrefix(raw, "ssr://"))
	if err != nil {
		return nil, errInvalid("invalid_proxy_uri")
	}
	body := string(dec)
	mainPart, qPart, _ := strings.Cut(body, "/?")
	if mainPart == body {
		mainPart, qPart, _ = strings.Cut(body, "?")
	}
	segs := strings.Split(mainPart, ":")
	if len(segs) < 6 {
		return nil, errInvalid("invalid_proxy_uri")
	}
	n := len(segs)
	passRaw, err := decodeBase64Flexible(segs[n-1])
	if err != nil {
		return nil, errInvalid("invalid_proxy_uri")
	}
	obfs := segs[n-2]
	cipher := segs[n-3]
	ssrProto := segs[n-4]
	port, _ := toInt(segs[n-5])
	server := strings.Join(segs[:n-5], ":")

	node := map[string]any{
		"protocol":    "shadowsocksr",
		"server":      server,
		"port":        port,
		"ssrProtocol": ssrProto,
		"cipher":      cipher,
		"ssrObfs":     obfs,
		"password":    string(passRaw),
	}
	if qPart != "" {
		q, _ := url.ParseQuery(qPart)
		if b, err := decodeBase64Flexible(q.Get("remarks")); err == nil && len(b) > 0 {
			node["name"] = string(b)
		}
		if b, err := decodeBase64Flexible(q.Get("obfsparam")); err == nil && len(b) > 0 {
			node["ssrObfsParam"] = string(b)
		}
		if b, err := decodeBase64Flexible(q.Get("protoparam")); err == nil && len(b) > 0 {
			node["ssrProtocolParam"] = string(b)
		}
	}
	return node, nil
}

func parseVMessURI(raw string) (map[string]any, error) {
	rest := strings.TrimPrefix(raw, "vmess://")
	if dec, err := decodeBase64Flexible(rest); err == nil {
		var obj map[string]any
		if json.Unmarshal(dec, &obj) == nil && obj["add"] != nil {
			netName := strings.ToLower(toString(obj["net"]))
			if netName == "splithttp" {
				netName = "xhttp"
			}
			tlsVal := strings.EqualFold(toString(obj["tls"]), "tls")
			if b, ok := toBool(obj["tls"]); ok {
				tlsVal = b
			}
			node := map[string]any{
				"protocol":    "vmess",
				"name":        toString(obj["ps"]),
				"server":      toString(obj["add"]),
				"port":        obj["port"],
				"uuid":        toString(obj["id"]),
				"cipher":      firstNonEmpty(toString(obj["scy"]), "auto"),
				"alterId":     obj["aid"],
				"type":        toString(obj["type"]),
				"network":     netName,
				"host":        toString(obj["host"]),
				"path":        toString(obj["path"]),
				"tls":         tlsVal,
				"sni":         toString(obj["sni"]),
				"alpn":        obj["alpn"],
				"fingerprint": toString(obj["fp"]),
			}
			if netName == "grpc" && toString(obj["path"]) != "" {
				node["serviceName"] = toString(obj["path"])
			}
			if b, ok := toBool(obj["allowInsecure"]); ok {
				node["allowInsecure"] = b
			}
			return node, nil
		}
	}
	u, err := url.Parse(raw)
	if err != nil {
		return nil, errInvalid("invalid_proxy_uri")
	}
	port, _ := toInt(u.Port())
	q := u.Query()
	return map[string]any{
		"protocol": "vmess",
		"name":     decodeURLComponent(u.Fragment),
		"server":   u.Hostname(),
		"port":     port,
		"uuid":     u.User.Username(),
		"network":  q.Get("type"),
		"tls":      q.Get("security") == "tls" || queryFlagBool(q, "tls"),
		"sni":      q.Get("sni"),
		"path":     q.Get("path"),
		"host":     q.Get("host"),
	}, nil
}

func parseVLESSURI(raw string) (map[string]any, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, errInvalid("invalid_proxy_uri")
	}
	port, _ := toInt(u.Port())
	q := u.Query()
	netName := strings.ToLower(q.Get("type"))
	if netName == "splithttp" {
		netName = "xhttp"
	}
	sec := strings.ToLower(q.Get("security"))
	tlsEnabled := sec == "tls" || sec == "reality" || queryFlagBool(q, "tls")
	node := map[string]any{
		"protocol":      "vless",
		"name":          decodeURLComponent(u.Fragment),
		"server":        u.Hostname(),
		"port":          port,
		"uuid":          u.User.Username(),
		"flow":          q.Get("flow"),
		"security":      sec,
		"publicKey":     firstNonEmpty(q.Get("pbk"), q.Get("publicKey")),
		"shortId":       firstNonEmpty(q.Get("sid"), q.Get("shortId")),
		"mode":          q.Get("mode"),
		"encryption":    q.Get("encryption"),
		"pqv":           q.Get("pqv"),
		"network":       netName,
		"path":          q.Get("path"),
		"host":          q.Get("host"),
		"serviceName":   q.Get("serviceName"),
		"tls":           tlsEnabled,
		"sni":           q.Get("sni"),
		"fingerprint":   firstNonEmpty(q.Get("fp"), q.Get("fingerprint")),
		"allowInsecure": queryFlagBool(q, "allowInsecure", "insecure"),
	}
	if alpn := q.Get("alpn"); alpn != "" {
		node["alpn"] = strings.Split(alpn, ",")
	}
	return node, nil
}

func parseTrojanURI(raw string) (map[string]any, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, errInvalid("invalid_proxy_uri")
	}
	port, _ := toInt(u.Port())
	q := u.Query()
	node := map[string]any{
		"protocol":      "trojan",
		"name":          decodeURLComponent(u.Fragment),
		"server":        u.Hostname(),
		"port":          port,
		"password":      decodeURLComponent(u.User.Username()),
		"network":       q.Get("type"),
		"path":          q.Get("path"),
		"host":          q.Get("host"),
		"serviceName":   q.Get("serviceName"),
		"tls":           true,
		"sni":           firstNonEmpty(q.Get("sni"), q.Get("peer")),
		"fingerprint":   firstNonEmpty(q.Get("fp"), q.Get("fingerprint")),
		"allowInsecure": queryFlagBool(q, "allowInsecure", "insecure"),
	}
	if alpn := q.Get("alpn"); alpn != "" {
		node["alpn"] = strings.Split(alpn, ",")
	}
	return node, nil
}

func parseHysteria2URI(raw string) (map[string]any, error) {
	normRaw := raw
	if strings.HasPrefix(strings.ToLower(raw), "hysteria2://") {
		normRaw = "hy2://" + raw[len("hysteria2://"):]
	}
	mportRe := regexp.MustCompile(`^hy2://(?:([^@]+)@)?(\[[^\]]+\]|[^:/?#]+):([^/?#]+)(.*)$`)
	var extraMport string
	if m := mportRe.FindStringSubmatch(normRaw); m != nil && (strings.Contains(m[3], "-") || strings.Contains(m[3], ",")) {
		extraMport = m[3]
		fp := firstPortOf(normalizePortRanges(extraMport))
		if fp == 0 {
			fp = 443
		}
		auth := ""
		if m[1] != "" {
			auth = m[1] + "@"
		}
		normRaw = "hy2://" + auth + m[2] + ":" + strconv.Itoa(fp) + m[4]
	}
	u, err := url.Parse(normRaw)
	if err != nil {
		return nil, errInvalid("invalid_proxy_uri")
	}
	q := u.Query()
	ports := normalizePortRanges(firstNonEmpty(q.Get("mport"), extraMport))
	port, ok := toInt(u.Port())
	if !ok || port == 0 {
		port = firstPortOf(ports)
		if port == 0 {
			port = 443
		}
	}
	pass := decodeURLComponent(u.User.Username())
	if p, ok := u.User.Password(); ok {
		pass = pass + ":" + decodeURLComponent(p)
	}
	insecure := queryFlagBool(q, "insecure", "allowInsecure")
	node := map[string]any{
		"protocol":      "hysteria2",
		"name":          decodeURLComponent(u.Fragment),
		"server":        u.Hostname(),
		"port":          port,
		"password":      pass,
		"obfs":          q.Get("obfs"),
		"obfsPassword":  q.Get("obfs-password"),
		"ports":         ports,
		"tls":           true,
		"sni":           q.Get("sni"),
		"insecure":      insecure,
		"allowInsecure": insecure,
		"fingerprint":   firstNonEmpty(q.Get("fp"), q.Get("pinSHA256")),
	}
	if alpn := q.Get("alpn"); alpn != "" {
		node["alpn"] = strings.Split(alpn, ",")
	}
	return node, nil
}

func parseHysteria1URI(raw string) (map[string]any, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, errInvalid("invalid_proxy_uri")
	}
	port, _ := toInt(u.Port())
	q := u.Query()
	node := map[string]any{
		"protocol":         "hysteria",
		"name":             decodeURLComponent(u.Fragment),
		"server":           u.Hostname(),
		"port":             port,
		"authStr":          firstNonEmpty(q.Get("auth"), decodeURLComponent(u.User.Username())),
		"hysteriaProtocol": q.Get("protocol"),
		"obfs":             firstNonEmpty(q.Get("obfsParam"), q.Get("obfs")),
		"tls":              true,
		"sni":              firstNonEmpty(q.Get("peer"), q.Get("sni")),
		"allowInsecure":    queryFlagBool(q, "insecure", "allowInsecure"),
	}
	if up, ok := toInt(q.Get("upmbps")); ok && up > 0 {
		node["upMbps"] = up
	}
	if dn, ok := toInt(q.Get("downmbps")); ok && dn > 0 {
		node["downMbps"] = dn
	}
	if alpn := q.Get("alpn"); alpn != "" {
		node["alpn"] = strings.Split(alpn, ",")
	}
	return node, nil
}

func parseTUICURI(raw string) (map[string]any, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, errInvalid("invalid_proxy_uri")
	}
	port, _ := toInt(u.Port())
	q := u.Query()
	pass, _ := u.User.Password()
	node := map[string]any{
		"protocol":          "tuic",
		"name":              decodeURLComponent(u.Fragment),
		"server":            u.Hostname(),
		"port":              port,
		"uuid":              decodeURLComponent(u.User.Username()),
		"password":          decodeURLComponent(pass),
		"congestionControl": firstNonEmpty(q.Get("congestion_control"), "bbr"),
		"udpRelayMode":      q.Get("udp_relay_mode"),
		"tls":               true,
		"sni":               q.Get("sni"),
		"allowInsecure":     queryFlagBool(q, "allow_insecure", "allowInsecure", "insecure"),
	}
	if alpn := q.Get("alpn"); alpn != "" {
		node["alpn"] = strings.Split(alpn, ",")
	}
	return node, nil
}

func parseAnyTLSURI(raw string) (map[string]any, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, errInvalid("invalid_proxy_uri")
	}
	port, _ := toInt(u.Port())
	if port == 0 {
		port = 443
	}
	q := u.Query()
	node := map[string]any{
		"protocol":      "anytls",
		"name":          decodeURLComponent(u.Fragment),
		"server":        u.Hostname(),
		"port":          port,
		"password":      decodeURLComponent(u.User.Username()),
		"tls":           true,
		"sni":           q.Get("sni"),
		"allowInsecure": queryFlagBool(q, "insecure", "allowInsecure"),
		"fingerprint":   firstNonEmpty(q.Get("fp"), q.Get("fingerprint")),
	}
	if alpn := q.Get("alpn"); alpn != "" {
		node["alpn"] = strings.Split(alpn, ",")
	}
	return node, nil
}

func parseWireGuardURI(raw string) (map[string]any, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, errInvalid("invalid_proxy_uri")
	}
	port, _ := toInt(u.Port())
	q := u.Query()
	node := map[string]any{
		"protocol":     "wireguard",
		"name":         decodeURLComponent(u.Fragment),
		"server":       u.Hostname(),
		"port":         port,
		"privateKey":   decodeURLComponent(u.User.Username()),
		"publicKey":    firstNonEmpty(q.Get("publickey"), q.Get("publicKey")),
		"presharedKey": firstNonEmpty(q.Get("presharedkey"), q.Get("presharedKey")),
		"reserved":     q.Get("reserved"),
	}
	if addr := q.Get("address"); addr != "" {
		for _, a := range strings.Split(addr, ",") {
			a = strings.TrimSpace(a)
			if strings.Contains(a, ":") {
				node["ipv6"] = a
			} else if a != "" {
				node["ip"] = a
			}
		}
	}
	if mtu, ok := toInt(q.Get("mtu")); ok && mtu > 0 {
		node["mtu"] = mtu
	}
	return node, nil
}

func parseSocks5URI(raw string) (map[string]any, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, errInvalid("invalid_proxy_uri")
	}
	if u.Path != "" && u.Path != "/" {
		return nil, errInvalid("invalid_proxy_uri")
	}
	port, _ := toInt(u.Port())
	node := map[string]any{
		"protocol": "socks5",
		"name":     decodeURLComponent(u.Fragment),
		"server":   u.Hostname(),
		"port":     port,
	}
	if u.User != nil {
		node["username"] = decodeURLComponent(u.User.Username())
		if p, ok := u.User.Password(); ok {
			node["password"] = decodeURLComponent(p)
		}
	}
	return node, nil
}

func parseHTTPURI(raw string) (map[string]any, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, errInvalid("invalid_proxy_uri")
	}
	port, _ := toInt(u.Port())
	isHTTPS := strings.EqualFold(u.Scheme, "https")
	if port == 0 {
		if isHTTPS {
			port = 443
		} else {
			port = 80
		}
	}
	node := map[string]any{
		"protocol": "http",
		"name":     decodeURLComponent(u.Fragment),
		"server":   u.Hostname(),
		"port":     port,
		"tls":      isHTTPS,
	}
	if u.User != nil {
		node["username"] = decodeURLComponent(u.User.Username())
		if p, ok := u.User.Password(); ok {
			node["password"] = decodeURLComponent(p)
		}
	}
	return node, nil
}

func parseNaiveURI(raw string, quic bool) (map[string]any, error) {
	norm := "https://" + strings.TrimPrefix(strings.TrimPrefix(raw, "naive+https://"), "naive+quic://")
	u, err := url.Parse(norm)
	if err != nil {
		return nil, errInvalid("invalid_proxy_uri")
	}
	port, _ := toInt(u.Port())
	if port == 0 {
		port = 443
	}
	q := u.Query()
	var user, pass string
	if u.User != nil {
		user = decodeURLComponent(u.User.Username())
		pass, _ = u.User.Password()
		pass = decodeURLComponent(pass)
	}
	return map[string]any{
		"protocol": "naive",
		"name":     decodeURLComponent(u.Fragment),
		"server":   u.Hostname(),
		"port":     port,
		"username": user,
		"password": pass,
		"quic":     quic,
		"sni":      q.Get("sni"),
	}, nil
}

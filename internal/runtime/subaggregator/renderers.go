package subaggregator

import (
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

const maxChainDepth = 8

// ClassicClashProtocols 列出 Clash Premium（非 Meta）原版内核支持的协议集合。
var ClassicClashProtocols = []string{
	"shadowsocks", "shadowsocksr", "vmess", "trojan", "snell", "socks5", "http", "https",
}

// DetectedClient 描述按 User-Agent 或 ?client 识别出的客户端信息及能力选项。
type DetectedClient struct {
	ID               string   `json:"id"`
	Name             string   `json:"name"`
	Target           string   `json:"target"`
	View             string   `json:"view,omitempty"`
	SingBoxVersion   string   `json:"singBoxVersion,omitempty"`
	OfficialApp      bool     `json:"officialApp,omitempty"`
	ClassicProtocols []string `json:"classicProtocols,omitempty"`
}

type clientRule struct {
	ID      string
	Name    string
	Pattern *regexp.Regexp
	Target  string
	Resolve func(ua string) DetectedClient
}

var (
	singBoxVerPattern = regexp.MustCompile(`(?i)sing-box[ /]v?(\d+\.\d+(?:\.\d+)?)`)
	hiddifyVerPattern = regexp.MustCompile(`(?i)^HiddifyNext/v?(\d+)`)
	hostHeaderPattern = regexp.MustCompile(`^[A-Za-z0-9.-]+(?::\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](?::\d{1,5})?$`)
)

var clientProfiles = []clientRule{
	{ID: "stash", Name: "Stash", Pattern: regexp.MustCompile(`(?i)^Stash/`), Target: "stash"},
	{ID: "hiddify-xray", Name: "Hiddify（Xray 内核）", Pattern: regexp.MustCompile(`(?i)^HiddifyNextX/`), Target: "base64"},
	{
		ID: "hiddify", Name: "Hiddify", Pattern: regexp.MustCompile(`(?i)^HiddifyNext/`), Target: "sing-box",
		Resolve: func(ua string) DetectedClient {
			major := 0
			if m := hiddifyVerPattern.FindStringSubmatch(ua); len(m) == 2 {
				major, _ = strconv.Atoi(m[1])
			}
			if ua != "" && major < 4 {
				return DetectedClient{ID: "hiddify", Name: "Hiddify", Target: "base64"}
			}
			return DetectedClient{ID: "hiddify", Name: "Hiddify", Target: "sing-box", View: "nodes", SingBoxVersion: "1.13.0"}
		},
	},
	{
		ID: "karing", Name: "Karing", Pattern: regexp.MustCompile(`(?i)^Karing/`), Target: "sing-box",
		Resolve: func(ua string) DetectedClient {
			return DetectedClient{ID: "karing", Name: "Karing", Target: "sing-box", View: "nodes", SingBoxVersion: extractSingBoxVersion(ua)}
		},
	},
	{ID: "nekobox", Name: "NekoBox", Pattern: regexp.MustCompile(`(?i)\bNeko(?:Box|Ray)/`), Target: "mihomo"},
	{
		ID: "husi", Name: "Husi", Pattern: regexp.MustCompile(`(?i)^husi/`), Target: "sing-box",
		Resolve: func(ua string) DetectedClient {
			return DetectedClient{ID: "husi", Name: "Husi", Target: "sing-box", View: "nodes", SingBoxVersion: extractSingBoxVersion(ua)}
		},
	},
	{
		ID: "sing-box", Name: "sing-box（SFA / SFI / SFM / SFT）", Pattern: regexp.MustCompile(`(?i)^SF[AIMT](?:[/ (]|$)`), Target: "sing-box",
		Resolve: func(ua string) DetectedClient {
			return DetectedClient{ID: "sing-box", Name: "sing-box（SFA / SFI / SFM / SFT）", Target: "sing-box", SingBoxVersion: extractSingBoxVersion(ua), OfficialApp: true}
		},
	},
	{ID: "flclash", Name: "FlClash", Pattern: regexp.MustCompile(`(?i)\bFlClash/`), Target: "mihomo"},
	{ID: "clash-verge", Name: "Clash Verge Rev", Pattern: regexp.MustCompile(`(?i)^clash-verge/`), Target: "mihomo"},
	{ID: "clash-meta-android", Name: "Clash Meta for Android", Pattern: regexp.MustCompile(`(?i)\bClashMetaForAndroid/`), Target: "mihomo"},
	{ID: "clash-party", Name: "Clash Party（Mihomo Party）", Pattern: regexp.MustCompile(`(?i)\bmihomo\.party/`), Target: "mihomo"},
	{ID: "clash-nyanpasu", Name: "Clash Nyanpasu", Pattern: regexp.MustCompile(`(?i)\bclash-nyanpasu/`), Target: "mihomo"},
	{ID: "clashx-meta", Name: "ClashX Meta", Pattern: regexp.MustCompile(`(?i)^ClashX\b.*(?:meta|metacubex)`), Target: "mihomo"},
	{
		ID: "clash-premium", Name: "ClashX / Clash for Windows / Clash for Android",
		Pattern: regexp.MustCompile(`(?i)^(?:ClashX|ClashforWindows|Clash for Windows|ClashForAndroid)\b`),
		Target:  "clash-classic",
		Resolve: func(_ string) DetectedClient {
			return DetectedClient{
				ID:               "clash-premium",
				Name:             "ClashX / Clash for Windows / Clash for Android",
				Target:           "clash-classic",
				ClassicProtocols: append([]string(nil), ClassicClashProtocols...),
			}
		},
	},
	{ID: "surfboard", Name: "Surfboard", Pattern: regexp.MustCompile(`(?i)\bsurfboard\b`), Target: "surfboard"},
	{ID: "surge", Name: "Surge", Pattern: regexp.MustCompile(`(?i)\bsurge\b`), Target: "surge"},
	{ID: "loon", Name: "Loon", Pattern: regexp.MustCompile(`(?i)\bloon\b`), Target: "loon"},
	{ID: "quantumult-x", Name: "Quantumult X", Pattern: regexp.MustCompile(`(?i)\bquantumult\b`), Target: "quantumult-x"},
	{ID: "egern", Name: "Egern", Pattern: regexp.MustCompile(`(?i)\begern\b`), Target: "egern"},
	{ID: "shadowrocket", Name: "Shadowrocket", Pattern: regexp.MustCompile(`(?i)^Shadowrocket/`), Target: "base64"},
	{ID: "v2rayng", Name: "v2rayNG", Pattern: regexp.MustCompile(`(?i)^v2rayNG/`), Target: "base64"},
	{ID: "v2rayn", Name: "v2rayN", Pattern: regexp.MustCompile(`(?i)^v2rayN/`), Target: "base64"},
	{ID: "v2raya", Name: "v2rayA", Pattern: regexp.MustCompile(`(?i)^v2rayA/`), Target: "base64"},
	{ID: "streisand", Name: "Streisand", Pattern: regexp.MustCompile(`(?i)^Streisand/`), Target: "base64"},
	{ID: "v2box", Name: "V2Box", Pattern: regexp.MustCompile(`(?i)^V2Box\b`), Target: "base64"},
	{ID: "foxray", Name: "FoXray", Pattern: regexp.MustCompile(`(?i)^FoXray\b`), Target: "base64"},
	{ID: "happ", Name: "Happ", Pattern: regexp.MustCompile(`(?i)^Happ/`), Target: "base64"},
	{ID: "passwall", Name: "PassWall / SSR Plus", Pattern: regexp.MustCompile(`(?i)\b(?:passwall|ssrplus|ssr-plus)\b`), Target: "base64"},
	{
		ID: "sing-box-generic", Name: "sing-box 系（其它）", Pattern: regexp.MustCompile(`(?i)\bsing-box\b`), Target: "sing-box",
		Resolve: func(ua string) DetectedClient {
			return DetectedClient{ID: "sing-box-generic", Name: "sing-box 系（其它）", Target: "sing-box", SingBoxVersion: extractSingBoxVersion(ua)}
		},
	},
	{ID: "v2ray-generic", Name: "v2ray / Xray 系（其它）", Pattern: regexp.MustCompile(`(?i)\b(?:v2ray|xray)`), Target: "base64"},
	{ID: "clash-generic", Name: "Clash 系（其它）", Pattern: regexp.MustCompile(`(?i)clash\.meta|\bmihomo\b|\bclash\b`), Target: "mihomo"},
}

func extractSingBoxVersion(ua string) string {
	if m := singBoxVerPattern.FindStringSubmatch(ua); len(m) == 2 {
		return m[1]
	}
	return ""
}

// DetectClient 按 User-Agent 识别拉取订阅的客户端（先将 %20 还原）。
func DetectClient(userAgent string) DetectedClient {
	ua := strings.TrimSpace(strings.ReplaceAll(userAgent, "%20", " "))
	if ua != "" {
		for _, r := range clientProfiles {
			if r.Pattern.MatchString(ua) {
				if r.Resolve != nil {
					return r.Resolve(ua)
				}
				return DetectedClient{ID: r.ID, Name: r.Name, Target: r.Target}
			}
		}
	}
	return DetectedClient{ID: "unknown", Name: "未识别的客户端", Target: "mihomo"}
}

// ClientByID 按客户端 ID 查找预设客户端定义（用于预览模拟客户端）。
func ClientByID(id string) (DetectedClient, bool) {
	id = strings.TrimSpace(id)
	if id == "" {
		return DetectedClient{}, false
	}
	for _, r := range clientProfiles {
		if r.ID == id {
			if r.Resolve != nil {
				return r.Resolve(""), true
			}
			return DetectedClient{ID: r.ID, Name: r.Name, Target: r.Target}, true
		}
	}
	return DetectedClient{}, false
}

// NormalizeView 规范化渲染视图参数（full / nodes）。
func NormalizeView(view string) string {
	v := strings.ToLower(strings.TrimSpace(view))
	if v == "nodes" {
		return "nodes"
	}
	if v == "full" {
		return "full"
	}
	return ""
}

// NormalizeOrigin 规范化对外可访问服务 origin（http/https scheme + host）。
func NormalizeOrigin(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return ""
	}
	u, err := url.Parse(s)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return ""
	}
	return u.Scheme + "://" + u.Host
}

// RequestOrigin 从 HTTP 请求头中提取客户端可访问的 origin（带 Host 正则防注入）。
func RequestOrigin(req *http.Request) string {
	if req == nil {
		return ""
	}
	firstHeader := func(v string) string {
		if v == "" {
			return ""
		}
		head, _, _ := strings.Cut(v, ",")
		return strings.TrimSpace(head)
	}
	host := firstHeader(req.Header.Get("X-Forwarded-Host"))
	if host == "" {
		host = firstHeader(req.Header.Get("Host"))
	}
	if host == "" {
		host = strings.TrimSpace(req.Host)
	}
	if host == "" || !hostHeaderPattern.MatchString(host) {
		return ""
	}
	proto := strings.ToLower(firstHeader(req.Header.Get("X-Forwarded-Proto")))
	if proto != "http" && proto != "https" {
		if req.TLS != nil {
			proto = "https"
		} else {
			proto = "http"
		}
	}
	return proto + "://" + host
}

// HostOfOrigin 从 origin 提取纯主机名（不含端口；IPv6 保留去括号后形式）。
func HostOfOrigin(origin string) string {
	norm := NormalizeOrigin(origin)
	if norm == "" {
		return ""
	}
	u, err := url.Parse(norm)
	if err != nil {
		return ""
	}
	h := u.Hostname()
	return strings.Trim(h, "[]")
}

// PortOfOrigin 从 origin 提取服务端口（默认 80 / 443）。
func PortOfOrigin(origin string) int {
	norm := NormalizeOrigin(origin)
	if norm == "" {
		return 0
	}
	u, err := url.Parse(norm)
	if err != nil {
		return 0
	}
	if p := u.Port(); p != "" {
		n, err := strconv.Atoi(p)
		if err == nil && n > 0 && n <= 65535 {
			return n
		}
		return 0
	}
	if u.Scheme == "https" {
		return 443
	}
	return 80
}

// IsLoopbackRemoteAddress 判断请求远端地址是否为本机回环。
func IsLoopbackRemoteAddress(raw string) bool {
	s := strings.TrimSpace(raw)
	if s == "" {
		return false
	}
	if h, _, err := net.SplitHostPort(s); err == nil {
		s = h
	}
	s = strings.TrimPrefix(strings.TrimSuffix(s, "]"), "[")
	if zone := strings.IndexByte(s, '%'); zone >= 0 {
		s = s[:zone]
	}
	if strings.EqualFold(s, "localhost") {
		return true
	}
	ip := net.ParseIP(s)
	if ip == nil {
		return false
	}
	if ip4 := ip.To4(); ip4 != nil {
		return ip4[0] == 127
	}
	return ip.IsLoopback()
}

// UserNameForNode 生成 server 模式本机中转使用的确定性 SOCKS5 用户名（n + sha1 前 12 位 hex）。
func UserNameForNode(nodeID string) string {
	sum := sha1.Sum([]byte(nodeID))
	return "n" + hex.EncodeToString(sum[:])[:12]
}

// RelayContext 传递本轮渲染可用的本机中转端点映射。
type RelayContext struct {
	Endpoints map[string]RelayEndpoint
	Status    *RelayRenderStatus
}

// RelayRenderStatus 描述渲染/预览结果中的中转状态摘要。
type RelayRenderStatus struct {
	Requested     bool               `json:"requested"`
	Local         bool               `json:"local"`
	Remote        bool               `json:"remote"`
	PortMode      string             `json:"portMode"`
	AdvertiseHost string             `json:"advertiseHost"`
	ServerPort    int                `json:"serverPort"`
	Available     bool               `json:"available"`
	Active        bool               `json:"active"`
	Candidates    int                `json:"candidates"`
	Nodes         int                `json:"nodes"`
	Binary        string             `json:"binary"`
	Source        string             `json:"source"`
	Version       string             `json:"version"`
	PortRange     string             `json:"portRange"`
	ListenHost    string             `json:"listenHost"`
	AuthRequired  bool               `json:"authRequired"`
	UDPReady      bool               `json:"udpReady,omitempty"`
	Error         string             `json:"error"`
	Detail        string             `json:"detail"`
	Skipped       []RelaySkippedItem `json:"skipped"`
}

// RelaySkippedItem 记录未能纳入边车中转的节点及原因。
type RelaySkippedItem struct {
	NodeID string `json:"nodeId"`
	Reason string `json:"reason"`
}

// RenderContext 保存一次渲染的全部上下文选项。
type RenderContext struct {
	Origin                string
	Token                 string
	Target                string
	Client                DetectedClient
	View                  string
	SubscriptionURL       string
	UpdateIntervalSeconds int
	CoreProtocols         []string
	Relay                 *RelayContext
}

func (c RenderContext) ruleSetEndpoint(rs RuleSetRef) string {
	if c.Origin == "" || c.Token == "" {
		return ""
	}
	tag := rs.Tag
	if tag == "" {
		tag = RuleSetTag(rs)
	}
	return fmt.Sprintf("%s/sub/%s/rules/%s?target=%s", c.Origin, url.PathEscape(c.Token), url.PathEscape(tag), url.QueryEscape(c.Target))
}

// BuildRenderContext 构造渲染上下文。
func BuildRenderContext(origin, token string, rendererID string, profile AggregatorProfile, client DetectedClient, view string, relay *RelayContext) RenderContext {
	normOrigin := NormalizeOrigin(origin)
	v := NormalizeView(view)
	if v == "" {
		v = "full"
	}
	hours := profile.RefreshHours
	if hours <= 0 {
		hours = 24
	}
	subURL := ""
	if normOrigin != "" && token != "" {
		vq := ""
		if v == "nodes" {
			vq = "&view=nodes"
		}
		subURL = fmt.Sprintf("%s/sub/%s?target=%s%s", normOrigin, url.PathEscape(token), url.QueryEscape(rendererID), vq)
	}
	return RenderContext{
		Origin:                normOrigin,
		Token:                 token,
		Target:                rendererID,
		Client:                client,
		View:                  v,
		SubscriptionURL:       subURL,
		UpdateIntervalSeconds: hours * 3600,
		CoreProtocols:         client.ClassicProtocols,
		Relay:                 relay,
	}
}

// Renderer 定义一种客户端配置渲染器。
type Renderer struct {
	ID           string
	Name         string
	Note         string
	ContentType  string
	Extension    string
	Capabilities RendererCapabilities
	CompileNode  func(entry PlannedNode, chainName string, ctx RenderContext) (any, error)
	Render       func(plan AggregationPlan, compiled []any, ctx RenderContext) string
}

var targetAliases = map[string]string{
	"clash":         "mihomo",
	"clash-meta":    "mihomo",
	"meta":          "mihomo",
	"singbox":       "sing-box",
	"qx":            "quantumult-x",
	"quantumultx":   "quantumult-x",
	"clash-premium": "clash-classic",
	"v2ray":         "base64",
	"v2rayn":        "base64",
	"shadowrocket":  "base64",
}

var allRenderers []Renderer
var rendererByID map[string]Renderer

func init() {
	stashProtos := []string{"shadowsocks", "shadowsocksr", "vmess", "vless", "trojan", "hysteria", "hysteria2", "tuic", "wireguard", "snell", "socks5", "http", "https"}
	surgeProtos := []string{"shadowsocks", "vmess", "trojan", "hysteria2", "tuic", "snell", "anytls", "wireguard", "socks5", "http", "https"}
	surfboardProtos := []string{"shadowsocks", "vmess", "trojan", "snell", "tuic", "hysteria2", "anytls", "wireguard", "socks5", "http", "https"}
	loonProtos := []string{"shadowsocks", "shadowsocksr", "vmess", "vless", "trojan", "hysteria2", "anytls", "wireguard", "socks5", "http", "https"}
	qxProtos := []string{"shadowsocks", "shadowsocksr", "vmess", "vless", "trojan", "anytls", "socks5", "http", "https"}
	egernProtos := []string{"shadowsocks", "vmess", "vless", "trojan", "hysteria2", "tuic", "anytls", "wireguard", "snell", "socks5", "http", "https"}

	allRenderers = []Renderer{
		newClashFamilyRenderer("mihomo", "Clash Meta / mihomo", "", nil, "mihomo", "mrs", []YAMLKV{
			{Key: "unified-delay", Value: true},
			{Key: "tcp-concurrent", Value: true},
		}, "dialer-proxy", false),
		newClashFamilyRenderer("clash-classic", "Clash（YAML 规则集 · 全协议）",
			"输出全部协议；VLESS / Hysteria2 / TUIC / WireGuard 等需 Meta 系内核（Clash Verge Rev、mihomo、FlClash）",
			nil, "clash-yaml", "", nil, "dialer-proxy", true),
		newClashFamilyRenderer("stash", "Stash", "", stashProtos, "clash-yaml", "", nil, "dialer-proxy", false),
		newSingBoxRenderer(),
		newSurgeFamilyRenderer("surge", "Surge", surgeProtos, "surge", ",dns-failed", "underlying-proxy", true,
			func(testURL string) []string {
				return []string{
					"loglevel = notify",
					"ipv6 = false",
					"dns-server = system, 223.5.5.5, 119.29.29.29",
					"skip-proxy = 127.0.0.1, 192.168.0.0/16, 10.0.0.0/8, 172.16.0.0/12, 100.64.0.0/10, localhost, *.local",
					"exclude-simple-hostnames = true",
					"internet-test-url = http://www.apple.com/library/test/success.html",
					"proxy-test-url = " + testURL,
					"test-timeout = 5",
				}
			}),
		newSurgeFamilyRenderer("surfboard", "Surfboard", surfboardProtos, "surfboard", "", "", true,
			func(testURL string) []string {
				return []string{
					"dns-server = system, 223.5.5.5, 119.29.29.29",
					"skip-proxy = 127.0.0.1, 192.168.0.0/16, 10.0.0.0/8, 172.16.0.0/12, 100.64.0.0/10, localhost, *.local",
					"proxy-test-url = " + testURL,
					"internet-test-url = http://www.gstatic.com/generate_204",
					"test-timeout = 5",
				}
			}),
		newLoonRenderer(loonProtos),
		newQuantumultXRenderer(qxProtos),
		newEgernRenderer(egernProtos),
		newBase64Renderer(),
		newURIRenderer(),
		newJSONRenderer(),
	}
	rendererByID = make(map[string]Renderer, len(allRenderers))
	for _, r := range allRenderers {
		rendererByID[r.ID] = r
	}
}

// GetRenderer 根据 format ID 或别名获取渲染器。
func GetRenderer(target string) (Renderer, bool) {
	id := strings.ToLower(strings.TrimSpace(target))
	if alias, ok := targetAliases[id]; ok {
		id = alias
	}
	r, ok := rendererByID[id]
	return r, ok
}

// DetectRendererByUserAgent 按 UA 选择默认渲染器。
func DetectRendererByUserAgent(userAgent string) Renderer {
	c := DetectClient(userAgent)
	if r, ok := GetRenderer(c.Target); ok {
		return r
	}
	return allRenderers[0]
}

// DescribeRenderers 返回 catalog.formats 描述列表。
func DescribeRenderers() []FormatDef {
	out := make([]FormatDef, 0, len(allRenderers))
	for _, r := range allRenderers {
		out = append(out, FormatDef{
			ID:        r.ID,
			Name:      r.Name,
			Extension: r.Extension,
			Groups:    r.Capabilities.Groups,
			Note:      r.Note,
		})
	}
	return out
}

func clashTargetName(ref TargetRef) string {
	switch ref.Kind {
	case "direct":
		return "DIRECT"
	case "reject":
		return "REJECT"
	default:
		return ref.Name
	}
}

func surgePolicyName(ref TargetRef) string {
	switch ref.Kind {
	case "direct":
		return "DIRECT"
	case "reject":
		return "REJECT"
	default:
		return SanitizeSurgeName(ref.Name)
	}
}

func qxPolicyName(ref TargetRef) string {
	switch ref.Kind {
	case "direct":
		return "direct"
	case "reject":
		return "reject"
	default:
		return SanitizeSurgeName(ref.Name)
	}
}

func testURLOfPlan(plan AggregationPlan) string {
	for _, g := range plan.Groups {
		if g.Type == "url-test" && g.URL != "" {
			return g.URL
		}
	}
	return DefaultTestURL
}

func relayEndpointForNode(ctx RenderContext, nodeID string) (RelayEndpoint, bool) {
	if ctx.Relay == nil || len(ctx.Relay.Endpoints) == 0 || nodeID == "" {
		return RelayEndpoint{}, false
	}
	ep, ok := ctx.Relay.Endpoints[nodeID]
	return ep, ok
}

func adaptStashProxy(proxy *YAMLMap, node ProxyNode) {
	pType, _ := proxy.Get("type")
	if pType == "hysteria" {
		if up, ok := node.Float("upMbps"); ok {
			proxy.Set("up-speed", up)
		}
		if down, ok := node.Float("downMbps"); ok {
			proxy.Set("down-speed", down)
		}
		if proto, ok := proxy.Get("protocol"); ok {
			proxy.Set("obfs-protocol", proto)
		}
	}
	if pType == "tuic" {
		if _, hasUUID := proxy.Get("uuid"); hasUUID {
			proxy.Set("version", 5)
		}
	}
}

func newClashFamilyRenderer(id, name, note string, protocols []string, ruleSetFile, ruleSetFormat string, extraConfig []YAMLKV, proxyChain string, relayFallback bool) Renderer {
	var supported map[string]bool
	if protocols != nil {
		supported = make(map[string]bool, len(protocols))
		for _, p := range protocols {
			supported[p] = true
		}
	}
	providerExt := "mrs"
	if ruleSetFile == "clash-yaml" {
		providerExt = "yaml"
	}
	return Renderer{
		ID:          id,
		Name:        name,
		Note:        note,
		ContentType: "text/yaml; charset=utf-8",
		Extension:   "yaml",
		Capabilities: RendererCapabilities{
			RejectInGroups: true,
			Groups:         true,
			Protocols:      protocols,
			ProxyChain:     proxyChain,
			RelayFallback:  relayFallback,
		},
		CompileNode: func(entry PlannedNode, chainName string, ctx RenderContext) (any, error) {
			proto := NormalizeProtocolAlias(entry.Node.Str("protocol"))
			if supported != nil && !supported[proto] {
				return nil, errInvalid("unsupported_proxy_protocol_" + proto)
			}
			if relayFallback {
				if ep, ok := relayEndpointForNode(ctx, entry.Node.Str("id")); ok {
					return compileRelayMihomoEntry(entry.Name, ep), nil
				}
				if ep, ok := relayEndpointForNode(ctx, entry.ID); ok {
					return compileRelayMihomoEntry(entry.Name, ep), nil
				}
			}
			proxy, err := CompileMihomoProxy(entry.Node, entry.Name, id)
			if err != nil {
				return nil, err
			}
			if SupportsUDPRelay(entry.Node) {
				proxy.Set("udp", true)
			}
			if id == "stash" {
				adaptStashProxy(proxy, entry.Node)
			}
			if chainName != "" {
				proxy.Set("dialer-proxy", chainName)
			}
			return proxy, nil
		},
		Render: func(plan AggregationPlan, compiled []any, ctx RenderContext) string {
			if ctx.View == "nodes" {
				root := &YAMLMap{}
				root.Set("proxies", compiled)
				return EmitYAML(root) + "\n"
			}
			ruleProviders := &YAMLMap{}
			for _, rs := range plan.RuleSets {
				behavior := "domain"
				if rs.Kind == "geoip" {
					behavior = "ipcidr"
				}
				rp := &YAMLMap{}
				rp.Set("type", "http")
				rp.Set("behavior", behavior)
				if ruleSetFormat != "" {
					rp.Set("format", ruleSetFormat)
				}
				rp.Set("url", RuleSetURL(rs, ruleSetFile))
				rp.Set("path", fmt.Sprintf("./rule-providers/%s.%s", rs.Tag, providerExt))
				rp.Set("interval", 86400)
				ruleProviders.Set(rs.Tag, rp)
			}
			groups := make([]any, 0, len(plan.Groups))
			for _, g := range plan.Groups {
				gm := &YAMLMap{}
				gm.Set("name", g.Name)
				gm.Set("type", g.Type)
				members := make([]string, 0, len(g.Members))
				for _, m := range g.Members {
					members = append(members, clashTargetName(m))
				}
				gm.Set("proxies", members)
				if g.Type == "url-test" || g.Type == "fallback" || g.Type == "load-balance" {
					gm.Set("url", g.URL)
					gm.Set("interval", g.Interval)
				}
				if g.Type == "url-test" {
					gm.Set("tolerance", g.Tolerance)
				}
				if g.Type == "load-balance" {
					st := g.Strategy
					if st == "" {
						st = "consistent-hashing"
					}
					gm.Set("strategy", st)
				}
				groups = append(groups, gm)
			}
			rules := make([]string, 0, len(plan.Rules)+1)
			for _, r := range plan.Rules {
				tgt := clashTargetName(r.Target)
				switch r.Match.Type {
				case "rule-set":
					nr := ""
					if r.Match.NoResolve {
						nr = ",no-resolve"
					}
					rules = append(rules, fmt.Sprintf("RULE-SET,%s,%s%s", r.Match.Value, tgt, nr))
				case "ip-cidr":
					kw := "IP-CIDR"
					addr, _, _ := strings.Cut(r.Match.Value, "/")
					if ip := net.ParseIP(addr); ip != nil && ip.To4() == nil {
						kw = "IP-CIDR6"
					}
					rules = append(rules, fmt.Sprintf("%s,%s,%s,no-resolve", kw, r.Match.Value, tgt))
				case "domain":
					rules = append(rules, fmt.Sprintf("DOMAIN,%s,%s", r.Match.Value, tgt))
				case "domain-suffix":
					rules = append(rules, fmt.Sprintf("DOMAIN-SUFFIX,%s,%s", r.Match.Value, tgt))
				case "domain-keyword":
					rules = append(rules, fmt.Sprintf("DOMAIN-KEYWORD,%s,%s", r.Match.Value, tgt))
				}
			}
			rules = append(rules, "MATCH,"+clashTargetName(plan.Final))

			dns := &YAMLMap{}
			dns.Set("enable", true)
			dns.Set("ipv6", false)
			dns.Set("enhanced-mode", "fake-ip")
			dns.Set("fake-ip-range", "198.18.0.1/16")
			dns.Set("fake-ip-filter", []string{"*.lan", "+.local", "+.msftconnecttest.com", "+.msftncsi.com"})
			dns.Set("default-nameserver", []string{"223.5.5.5", "119.29.29.29"})
			dns.Set("nameserver", []string{"https://dns.alidns.com/dns-query", "https://doh.pub/dns-query"})

			cfg := &YAMLMap{}
			cfg.Set("mixed-port", 7890)
			cfg.Set("allow-lan", false)
			cfg.Set("mode", "rule")
			cfg.Set("log-level", "info")
			cfg.Set("ipv6", false)
			for _, kv := range extraConfig {
				cfg.Set(kv.Key, kv.Value)
			}
			cfg.Set("dns", dns)
			cfg.Set("proxies", compiled)
			cfg.Set("proxy-groups", groups)
			cfg.Set("rule-providers", ruleProviders)
			cfg.Set("rules", rules)
			return EmitYAML(cfg) + "\n"
		},
	}
}

func newSingBoxRenderer() Renderer {
	sbTag := func(ref TargetRef) string {
		if ref.Kind == "direct" {
			return "direct"
		}
		return ref.Name
	}
	resolveSBChains := func(compiled []any) (outbounds []*YAMLMap, endpoints []*YAMLMap, auxiliaries []*YAMLMap) {
		nodes := make([]SingBoxCompiled, 0, len(compiled))
		usedTags := map[string]bool{}
		for _, item := range compiled {
			sc, ok := item.(SingBoxCompiled)
			if !ok {
				continue
			}
			if t, ok := sc.Item.Get("tag"); ok {
				usedTags[fmt.Sprint(t)] = true
			}
			nodes = append(nodes, sc)
		}

		assignedAux := map[string]string{}
		for i := range nodes {
			for j := range nodes[i].Extras {
				aux := nodes[i].Extras[j]
				origV, _ := aux.Get("tag")
				origTag := fmt.Sprint(origV)
				newTag, exists := assignedAux[origTag]
				if !exists {
					newTag = origTag
					for attempt := 1; usedTags[newTag]; attempt++ {
						newTag = fmt.Sprintf("%s-%d", origTag, attempt)
					}
					usedTags[newTag] = true
					assignedAux[origTag] = newTag
					clonedAux := cloneYAMLMap(aux)
					clonedAux.Set("tag", newTag)
					auxiliaries = append(auxiliaries, clonedAux)
				}
				if d, ok := nodes[i].Item.Get("detour"); ok && fmt.Sprint(d) == origTag {
					nodes[i].Item.Set("detour", newTag)
				}
			}
		}

		auxByTag := make(map[string]*YAMLMap, len(auxiliaries))
		for _, a := range auxiliaries {
			if t, ok := a.Get("tag"); ok {
				auxByTag[fmt.Sprint(t)] = a
			}
		}
		for _, sc := range nodes {
			item := cloneYAMLMap(sc.Item)
			if sc.ChainTag != "" {
				existingDetour := ""
				if d, ok := item.Get("detour"); ok {
					existingDetour = fmt.Sprint(d)
				}
				if existingDetour != "" {
					if aux, ok := auxByTag[existingDetour]; ok {
						aux.Set("detour", sc.ChainTag)
					} else {
						item.Set("detour", sc.ChainTag)
					}
				} else {
					item.Set("detour", sc.ChainTag)
				}
			}
			if sc.IsEndpoint {
				endpoints = append(endpoints, item)
			} else {
				outbounds = append(outbounds, item)
			}
		}
		return outbounds, endpoints, auxiliaries
	}

	return Renderer{
		ID:          "sing-box",
		Name:        "sing-box",
		ContentType: "application/json; charset=utf-8",
		Extension:   "json",
		Capabilities: RendererCapabilities{
			RejectInGroups: false,
			Groups:         true,
			GroupTypes:     []string{"select", "url-test"},
			ProxyChain:     "detour",
		},
		CompileNode: func(entry PlannedNode, chainName string, ctx RenderContext) (any, error) {
			compiled, err := CompileSingBoxOutbound(entry.Node, entry.Name, ctx.Client.SingBoxVersion, ctx.Client.OfficialApp)
			if err != nil {
				return nil, err
			}
			compiled.ChainTag = chainName
			return compiled, nil
		},
		Render: func(plan AggregationPlan, compiled []any, ctx RenderContext) string {
			outbounds, endpoints, auxiliaries := resolveSBChains(compiled)
			if ctx.View == "nodes" {
				allOut := make([]*YAMLMap, 0, len(outbounds)+len(auxiliaries))
				allOut = append(allOut, outbounds...)
				allOut = append(allOut, auxiliaries...)
				if allOut == nil {
					allOut = []*YAMLMap{}
				}
				root := &YAMLMap{}
				root.Set("outbounds", allOut)
				if len(endpoints) > 0 {
					root.Set("endpoints", endpoints)
				}
				return prettyJSONFromYAMLMap(root) + "\n"
			}

			proxyGroupTag := ""
			if len(plan.Groups) > 0 {
				proxyGroupTag = plan.Groups[0].Name
			}
			hasCN := false
			for _, rs := range plan.RuleSets {
				if rs.Tag == "geosite-cn" {
					hasCN = true
					break
				}
			}

			dnsRemote := &YAMLMap{}
			dnsRemote.Set("type", "https")
			dnsRemote.Set("tag", "dns-remote")
			dnsRemote.Set("server", "1.1.1.1")
			if proxyGroupTag != "" {
				dnsRemote.Set("detour", proxyGroupTag)
			}
			dnsDirect := &YAMLMap{}
			dnsDirect.Set("type", "https")
			dnsDirect.Set("tag", "dns-direct")
			dnsDirect.Set("server", "223.5.5.5")
			dnsRules := []*YAMLMap{}
			if hasCN {
				r := &YAMLMap{}
				r.Set("rule_set", []string{"geosite-cn"})
				r.Set("server", "dns-direct")
				dnsRules = append(dnsRules, r)
			}
			dns := &YAMLMap{}
			dns.Set("servers", []*YAMLMap{dnsRemote, dnsDirect})
			dns.Set("rules", dnsRules)
			dns.Set("final", "dns-remote")
			dns.Set("strategy", "ipv4_only")

			inTun := &YAMLMap{}
			inTun.Set("type", "tun")
			inTun.Set("tag", "tun-in")
			inTun.Set("address", []string{"172.19.0.1/30"})
			inTun.Set("auto_route", true)
			inTun.Set("strict_route", true)
			inMixed := &YAMLMap{}
			inMixed.Set("type", "mixed")
			inMixed.Set("tag", "mixed-in")
			inMixed.Set("listen", "127.0.0.1")
			inMixed.Set("listen_port", 2080)

			var groupOutbounds []*YAMLMap
			for _, g := range plan.Groups {
				members := make([]string, 0, len(g.Members))
				for _, m := range g.Members {
					members = append(members, sbTag(m))
				}
				gm := &YAMLMap{}
				if g.Type == "url-test" {
					gm.Set("type", "urltest")
					gm.Set("tag", g.Name)
					gm.Set("outbounds", members)
					gm.Set("url", g.URL)
					gm.Set("interval", fmt.Sprintf("%ds", g.Interval))
					gm.Set("tolerance", g.Tolerance)
				} else {
					gm.Set("type", "selector")
					gm.Set("tag", g.Name)
					gm.Set("outbounds", members)
					if len(members) > 0 {
						gm.Set("default", members[0])
					}
				}
				groupOutbounds = append(groupOutbounds, gm)
			}

			directOut := &YAMLMap{}
			directOut.Set("type", "direct")
			directOut.Set("tag", "direct")

			fullOutbounds := make([]*YAMLMap, 0, len(groupOutbounds)+len(outbounds)+len(auxiliaries)+1)
			fullOutbounds = append(fullOutbounds, groupOutbounds...)
			fullOutbounds = append(fullOutbounds, outbounds...)
			fullOutbounds = append(fullOutbounds, auxiliaries...)
			fullOutbounds = append(fullOutbounds, directOut)

			sniffRule := &YAMLMap{}
			sniffRule.Set("action", "sniff")
			dnsHijackRule := &YAMLMap{}
			dnsHijackRule.Set("protocol", "dns")
			dnsHijackRule.Set("action", "hijack-dns")
			routeRules := []*YAMLMap{sniffRule, dnsHijackRule}
			for _, r := range plan.Rules {
				rm := &YAMLMap{}
				switch r.Match.Type {
				case "rule-set":
					rm.Set("rule_set", []string{r.Match.Value})
				case "domain":
					rm.Set("domain", []string{r.Match.Value})
				case "domain-suffix":
					rm.Set("domain_suffix", []string{r.Match.Value})
				case "domain-keyword":
					rm.Set("domain_keyword", []string{r.Match.Value})
				case "ip-cidr":
					rm.Set("ip_cidr", []string{r.Match.Value})
				}
				if r.Target.Kind == "reject" {
					rm.Set("action", "reject")
				} else {
					rm.Set("outbound", sbTag(r.Target))
				}
				routeRules = append(routeRules, rm)
			}

			ruleSetEntries := make([]*YAMLMap, 0, len(plan.RuleSets))
			for _, rs := range plan.RuleSets {
				rsm := &YAMLMap{}
				rsm.Set("type", "remote")
				rsm.Set("tag", rs.Tag)
				rsm.Set("format", "binary")
				rsm.Set("url", RuleSetURL(rs, "sing-box"))
				rsm.Set("download_detour", "direct")
				ruleSetEntries = append(ruleSetEntries, rsm)
			}

			routeObj := &YAMLMap{}
			routeObj.Set("rules", routeRules)
			routeObj.Set("rule_set", ruleSetEntries)
			routeObj.Set("final", sbTag(plan.Final))
			routeObj.Set("auto_detect_interface", true)
			routeObj.Set("default_domain_resolver", "dns-direct")

			logObj := &YAMLMap{}
			logObj.Set("level", "warn")
			logObj.Set("timestamp", true)

			cacheFile := &YAMLMap{}
			cacheFile.Set("enabled", true)
			expObj := &YAMLMap{}
			expObj.Set("cache_file", cacheFile)

			cfg := &YAMLMap{}
			cfg.Set("log", logObj)
			cfg.Set("dns", dns)
			cfg.Set("inbounds", []*YAMLMap{inTun, inMixed})
			cfg.Set("outbounds", fullOutbounds)
			if len(endpoints) > 0 {
				cfg.Set("endpoints", endpoints)
			}
			cfg.Set("route", routeObj)
			cfg.Set("experimental", expObj)
			return prettyJSONFromYAMLMap(cfg) + "\n"
		},
	}
}

func cloneYAMLMap(m *YAMLMap) *YAMLMap {
	if m == nil {
		return nil
	}
	c := &YAMLMap{Entries: make([]YAMLKV, len(m.Entries))}
	copy(c.Entries, m.Entries)
	return c
}

func prettyJSONFromYAMLMap(v any) string {
	return string(renderPrettyJSON(v, ""))
}

func renderPrettyJSON(v any, indent string) []byte {
	nextIndent := indent + "  "
	switch t := v.(type) {
	case *YAMLMap:
		if t == nil || len(t.Entries) == 0 {
			return []byte("{}")
		}
		var b strings.Builder
		b.WriteString("{\n")
		for i, kv := range t.Entries {
			kb, _ := json.Marshal(kv.Key)
			b.WriteString(nextIndent)
			b.Write(kb)
			b.WriteString(": ")
			b.Write(renderPrettyJSON(kv.Value, nextIndent))
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
		for i, item := range t {
			b.WriteString(nextIndent)
			b.Write(renderPrettyJSON(item, nextIndent))
			if i < len(t)-1 {
				b.WriteByte(',')
			}
			b.WriteByte('\n')
		}
		b.WriteString(indent)
		b.WriteByte(']')
		return []byte(b.String())
	case []string:
		if len(t) == 0 {
			return []byte("[]")
		}
		var b strings.Builder
		b.WriteString("[\n")
		for i, s := range t {
			sb, _ := json.Marshal(s)
			b.WriteString(nextIndent)
			b.Write(sb)
			if i < len(t)-1 {
				b.WriteByte(',')
			}
			b.WriteByte('\n')
		}
		b.WriteString(indent)
		b.WriteByte(']')
		return []byte(b.String())
	case []int:
		if len(t) == 0 {
			return []byte("[]")
		}
		var b strings.Builder
		b.WriteString("[\n")
		for i, n := range t {
			b.WriteString(nextIndent)
			b.WriteString(strconv.Itoa(n))
			if i < len(t)-1 {
				b.WriteByte(',')
			}
			b.WriteByte('\n')
		}
		b.WriteString(indent)
		b.WriteByte(']')
		return []byte(b.String())
	default:
		b, _ := marshalCompactNoEscape(t)
		return b
	}
}

func compileSurgeGroupLine(group PlannedGroup, allGroups []PlannedGroup, dialect string) string {
	tested := group.Type != "select"
	refs := group.Members
	if tested {
		refs = FlattenGroupMembers(allGroups, group)
	}
	names := make([]string, 0, len(refs))
	for _, r := range refs {
		names = append(names, surgePolicyName(r))
	}
	if len(names) == 0 {
		names = []string{"DIRECT"}
	}
	list := strings.Join(names, ", ")
	gName := SanitizeSurgeName(group.Name)
	probe := fmt.Sprintf("url=%s, interval=%d", group.URL, group.Interval)
	switch group.Type {
	case "url-test":
		return fmt.Sprintf("%s = url-test, %s, %s, tolerance=%d", gName, list, probe, group.Tolerance)
	case "fallback":
		if dialect == "loon" {
			return fmt.Sprintf("%s = fallback, %s, %s, max-timeout=3000", gName, list, probe)
		}
		return fmt.Sprintf("%s = fallback, %s, %s, timeout=5", gName, list, probe)
	case "load-balance":
		st := group.Strategy
		if st == "" {
			st = "consistent-hashing"
		}
		if dialect == "loon" {
			alg := "PCC"
			if st == "round-robin" {
				alg = "Round-Robin"
			}
			return fmt.Sprintf("%s = load-balance, %s, %s, algorithm=%s", gName, list, probe, alg)
		}
		pers := ""
		if st == "consistent-hashing" {
			pers = ", persistent=true"
		}
		return fmt.Sprintf("%s = load-balance, %s, %s%s", gName, list, probe, pers)
	default:
		return fmt.Sprintf("%s = select, %s", gName, list)
	}
}

func compileSurgeMatchRule(r PlannedRule) string {
	tgt := surgePolicyName(r.Target)
	switch r.Match.Type {
	case "domain":
		return "DOMAIN," + r.Match.Value + "," + tgt
	case "domain-suffix":
		return "DOMAIN-SUFFIX," + r.Match.Value + "," + tgt
	case "domain-keyword":
		return "DOMAIN-KEYWORD," + r.Match.Value + "," + tgt
	case "ip-cidr":
		kw := "IP-CIDR"
		addr, _, _ := strings.Cut(r.Match.Value, "/")
		if ip := net.ParseIP(addr); ip != nil && ip.To4() == nil {
			kw = "IP-CIDR6"
		}
		return kw + "," + r.Match.Value + "," + tgt + ",no-resolve"
	}
	return ""
}

func toCompiledLineEntries(compiled []any) []CompiledLineEntry {
	out := make([]CompiledLineEntry, 0, len(compiled))
	for _, c := range compiled {
		if le, ok := c.(CompiledLineEntry); ok {
			out = append(out, le)
		}
	}
	return out
}

func newSurgeFamilyRenderer(id, name string, protocols []string, compileTarget, finalSuffix, proxyChain string, relayFallback bool, generalFn func(string) []string) Renderer {
	supported := make(map[string]bool, len(protocols))
	for _, p := range protocols {
		supported[p] = true
	}
	return Renderer{
		ID:          id,
		Name:        name,
		ContentType: "text/plain; charset=utf-8",
		Extension:   "conf",
		Capabilities: RendererCapabilities{
			RejectInGroups: true,
			Groups:         true,
			Protocols:      protocols,
			CoreProtocols:  protocols,
			RelayFallback:  relayFallback,
			RuleSetFormat:  "domain-set",
			SanitizeName:   SanitizeSurgeName,
			ProxyChain:     proxyChain,
		},
		CompileNode: func(entry PlannedNode, chainName string, ctx RenderContext) (any, error) {
			proto := NormalizeProtocolAlias(entry.Node.Str("protocol"))
			if relayFallback {
				if ep, ok := relayEndpointForNode(ctx, entry.Node.Str("id")); ok {
					return compileRelaySurgeEntry(entry.Name, ep), nil
				}
				if ep, ok := relayEndpointForNode(ctx, entry.ID); ok {
					return compileRelaySurgeEntry(entry.Name, ep), nil
				}
			}
			if !supported[proto] {
				return nil, errInvalid("unsupported_proxy_protocol_" + proto)
			}
			return CompileSurgeFamilyEntry(compileTarget, entry.Node, entry.Name, chainName, proxyChain)
		},
		Render: func(plan AggregationPlan, compiled []any, ctx RenderContext) string {
			lines, sections := collectSurgeLines(toCompiledLineEntries(compiled))
			if ctx.View == "nodes" {
				if len(lines) == 0 {
					return ""
				}
				parts := append(append([]string(nil), lines...), "")
				parts = append(parts, sections...)
				return strings.Join(parts, "\n") + "\n"
			}
			rsByTag := make(map[string]RuleSetRef, len(plan.RuleSets))
			for _, rs := range plan.RuleSets {
				rsByTag[rs.Tag] = rs
			}
			var out []string
			if ctx.SubscriptionURL != "" {
				out = append(out, fmt.Sprintf("#!MANAGED-CONFIG %s interval=%d strict=false", ctx.SubscriptionURL, ctx.UpdateIntervalSeconds), "")
			}
			out = append(out, "[General]")
			out = append(out, generalFn(testURLOfPlan(plan))...)
			out = append(out, "", "[Proxy]")
			out = append(out, lines...)
			out = append(out, "")
			out = append(out, sections...)
			out = append(out, "[Proxy Group]")
			for _, g := range plan.Groups {
				out = append(out, compileSurgeGroupLine(g, plan.Groups, "surge"))
			}
			out = append(out, "", "[Rule]")
			for _, r := range plan.Rules {
				if r.Match.Type != "rule-set" {
					if line := compileSurgeMatchRule(r); line != "" {
						out = append(out, line)
					}
					continue
				}
				rs, ok := rsByTag[r.Match.Value]
				if !ok {
					continue
				}
				u := ctx.ruleSetEndpoint(rs)
				if u == "" {
					continue
				}
				tgt := surgePolicyName(r.Target)
				if rs.Kind == "geoip" {
					out = append(out, fmt.Sprintf("RULE-SET,%s,%s,no-resolve", u, tgt))
				} else {
					out = append(out, fmt.Sprintf("DOMAIN-SET,%s,%s", u, tgt))
				}
			}
			out = append(out, fmt.Sprintf("FINAL,%s%s", surgePolicyName(plan.Final), finalSuffix), "")
			return strings.Join(out, "\n")
		},
	}
}

func newLoonRenderer(protocols []string) Renderer {
	supported := make(map[string]bool, len(protocols))
	for _, p := range protocols {
		supported[p] = true
	}
	const bypassTUN = "10.0.0.0/8,100.64.0.0/10,127.0.0.0/8,169.254.0.0/16,172.16.0.0/12,192.168.0.0/16,224.0.0.0/4,255.255.255.255/32"
	return Renderer{
		ID:          "loon",
		Name:        "Loon",
		ContentType: "text/plain; charset=utf-8",
		Extension:   "conf",
		Capabilities: RendererCapabilities{
			RejectInGroups: true,
			Groups:         true,
			Protocols:      protocols,
			RuleSetFormat:  "rule-set",
			SanitizeName:   SanitizeSurgeName,
		},
		CompileNode: func(entry PlannedNode, _ string, _ RenderContext) (any, error) {
			proto := NormalizeProtocolAlias(entry.Node.Str("protocol"))
			if !supported[proto] {
				return nil, errInvalid("unsupported_proxy_protocol_" + proto)
			}
			return CompileSurgeFamilyEntry("loon", entry.Node, entry.Name, "", "")
		},
		Render: func(plan AggregationPlan, compiled []any, ctx RenderContext) string {
			lines, _ := collectSurgeLines(toCompiledLineEntries(compiled))
			if ctx.View == "nodes" {
				if len(lines) == 0 {
					return ""
				}
				return strings.Join(lines, "\n") + "\n"
			}
			rsByTag := make(map[string]RuleSetRef, len(plan.RuleSets))
			for _, rs := range plan.RuleSets {
				rsByTag[rs.Tag] = rs
			}
			var remoteRules, localRules []string
			for _, r := range plan.Rules {
				if r.Match.Type != "rule-set" {
					if line := compileSurgeMatchRule(r); line != "" {
						localRules = append(localRules, line)
					}
					continue
				}
				rs, ok := rsByTag[r.Match.Value]
				if !ok {
					continue
				}
				u := ctx.ruleSetEndpoint(rs)
				if u != "" {
					remoteRules = append(remoteRules, fmt.Sprintf("%s, policy=%s, tag=%s, enabled=true", u, surgePolicyName(r.Target), rs.Tag))
				}
			}
			var out []string
			out = append(out,
				"[General]",
				"ip-mode = dual",
				"dns-server = system,223.5.5.5,119.29.29.29",
				"skip-proxy = 192.168.0.0/16,10.0.0.0/8,172.16.0.0/12,localhost,*.local",
				"bypass-tun = "+bypassTUN,
				"proxy-test-url = "+testURLOfPlan(plan),
				"internet-test-url = http://www.gstatic.com/generate_204",
				"test-timeout = 5",
				"",
				"[Proxy]",
			)
			out = append(out, lines...)
			out = append(out, "", "[Proxy Group]")
			for _, g := range plan.Groups {
				out = append(out, compileSurgeGroupLine(g, plan.Groups, "loon"))
			}
			out = append(out, "", "[Remote Rule]")
			out = append(out, remoteRules...)
			out = append(out, "", "[Rule]")
			out = append(out, localRules...)
			out = append(out, "FINAL,"+surgePolicyName(plan.Final), "")
			return strings.Join(out, "\n")
		},
	}
}

func newQuantumultXRenderer(protocols []string) Renderer {
	supported := make(map[string]bool, len(protocols))
	for _, p := range protocols {
		supported[p] = true
	}
	return Renderer{
		ID:          "quantumult-x",
		Name:        "Quantumult X",
		ContentType: "text/plain; charset=utf-8",
		Extension:   "conf",
		Capabilities: RendererCapabilities{
			RejectInGroups: true,
			Groups:         true,
			Protocols:      protocols,
			RuleSetFormat:  "quantumult-x",
			SanitizeName:   SanitizeSurgeName,
		},
		CompileNode: func(entry PlannedNode, _ string, _ RenderContext) (any, error) {
			proto := NormalizeProtocolAlias(entry.Node.Str("protocol"))
			if !supported[proto] {
				return nil, errInvalid("unsupported_proxy_protocol_" + proto)
			}
			return CompileQuantumultXEntry(entry.Node, entry.Name)
		},
		Render: func(plan AggregationPlan, compiled []any, ctx RenderContext) string {
			lines, _ := collectSurgeLines(toCompiledLineEntries(compiled))
			if ctx.View == "nodes" {
				if len(lines) == 0 {
					return ""
				}
				return strings.Join(lines, "\n") + "\n"
			}
			rsByTag := make(map[string]RuleSetRef, len(plan.RuleSets))
			for _, rs := range plan.RuleSets {
				rsByTag[rs.Tag] = rs
			}
			var remoteRules, localRules []string
			for _, r := range plan.Rules {
				tgt := qxPolicyName(r.Target)
				if r.Match.Type != "rule-set" {
					switch r.Match.Type {
					case "ip-cidr":
						kw := "ip-cidr"
						addr, _, _ := strings.Cut(r.Match.Value, "/")
						if ip := net.ParseIP(addr); ip != nil && ip.To4() == nil {
							kw = "ip6-cidr"
						}
						localRules = append(localRules, fmt.Sprintf("%s, %s, %s, no-resolve", kw, r.Match.Value, tgt))
					case "domain":
						localRules = append(localRules, fmt.Sprintf("host, %s, %s", r.Match.Value, tgt))
					case "domain-suffix":
						localRules = append(localRules, fmt.Sprintf("host-suffix, %s, %s", r.Match.Value, tgt))
					case "domain-keyword":
						localRules = append(localRules, fmt.Sprintf("host-keyword, %s, %s", r.Match.Value, tgt))
					}
					continue
				}
				rs, ok := rsByTag[r.Match.Value]
				if !ok {
					continue
				}
				u := ctx.ruleSetEndpoint(rs)
				if u != "" {
					remoteRules = append(remoteRules, fmt.Sprintf("%s, tag=%s, force-policy=%s, update-interval=86400, opt-parser=false, enabled=true", u, rs.Tag, tgt))
				}
			}
			testURL := testURLOfPlan(plan)
			var out []string
			out = append(out,
				"[general]",
				"network_check_url="+testURL,
				"server_check_url="+testURL,
				"server_check_timeout=3000",
				"excluded_routes=192.168.0.0/16, 172.16.0.0/12, 100.64.0.0/10, 10.0.0.0/8",
				"",
				"[dns]",
				"server=223.5.5.5",
				"server=119.29.29.29",
				"",
				"[policy]",
			)
			for _, g := range plan.Groups {
				gName := SanitizeSurgeName(g.Name)
				if g.Type != "select" {
					flat := FlattenGroupMembers(plan.Groups, g)
					var nodeNames []string
					for _, m := range flat {
						if m.Kind == "node" {
							nodeNames = append(nodeNames, qxPolicyName(m))
						}
					}
					if len(nodeNames) > 0 {
						list := strings.Join(nodeNames, ", ")
						switch g.Type {
						case "url-test":
							out = append(out, fmt.Sprintf("url-latency-benchmark=%s, %s, check-interval=%d, tolerance=%d, alive-checking=false", gName, list, g.Interval, g.Tolerance))
						case "fallback":
							out = append(out, fmt.Sprintf("available=%s, %s", gName, list))
						default:
							kind := "dest-hash"
							if g.Strategy == "round-robin" {
								kind = "round-robin"
							}
							out = append(out, fmt.Sprintf("%s=%s, %s", kind, gName, list))
						}
						continue
					}
				}
				members := make([]string, 0, len(g.Members))
				for _, m := range g.Members {
					members = append(members, qxPolicyName(m))
				}
				if len(members) == 0 {
					members = []string{"direct"}
				}
				out = append(out, fmt.Sprintf("static=%s, %s", gName, strings.Join(members, ", ")))
			}
			out = append(out, "", "[server_local]")
			out = append(out, lines...)
			out = append(out, "", "[filter_remote]")
			out = append(out, remoteRules...)
			out = append(out, "", "[filter_local]")
			out = append(out, localRules...)
			out = append(out, "final, "+qxPolicyName(plan.Final), "")
			return strings.Join(out, "\n")
		},
	}
}

func newEgernRenderer(protocols []string) Renderer {
	return Renderer{
		ID:          "egern",
		Name:        "Egern（实验）",
		ContentType: "text/yaml; charset=utf-8",
		Extension:   "yaml",
		Capabilities: RendererCapabilities{
			RejectInGroups: true,
			Groups:         true,
			Protocols:      protocols,
			RuleSetFormat:  "egern",
		},
		CompileNode: func(entry PlannedNode, _ string, _ RenderContext) (any, error) {
			return CompileEgernProxy(entry.Node, entry.Name)
		},
		Render: func(plan AggregationPlan, compiled []any, ctx RenderContext) string {
			if ctx.View == "nodes" {
				root := &YAMLMap{}
				root.Set("proxies", compiled)
				return EmitYAML(root) + "\n"
			}
			rsByTag := make(map[string]RuleSetRef, len(plan.RuleSets))
			for _, rs := range plan.RuleSets {
				rsByTag[rs.Tag] = rs
			}
			policyGroups := make([]*YAMLMap, 0, len(plan.Groups))
			for _, g := range plan.Groups {
				policies := make([]string, 0, len(g.Members))
				for _, m := range g.Members {
					policies = append(policies, clashTargetName(m))
				}
				if len(policies) == 0 {
					policies = []string{"DIRECT"}
				}
				inner := &YAMLMap{}
				inner.Set("name", g.Name)
				inner.Set("policies", policies)
				wrapper := &YAMLMap{}
				switch g.Type {
				case "url-test":
					inner.Set("interval", g.Interval)
					inner.Set("tolerance", g.Tolerance)
					inner.Set("latency_test_url", g.URL)
					wrapper.Set("auto_test", inner)
				case "fallback":
					inner.Set("interval", g.Interval)
					inner.Set("latency_test_url", g.URL)
					wrapper.Set("fallback", inner)
				case "load-balance":
					alg := "hash"
					if g.Strategy == "round-robin" {
						alg = "round_robin"
					}
					inner.Set("algorithm", alg)
					wrapper.Set("load_balance", inner)
				default:
					wrapper.Set("select", inner)
				}
				policyGroups = append(policyGroups, wrapper)
			}
			var rules []*YAMLMap
			for _, r := range plan.Rules {
				pol := clashTargetName(r.Target)
				wrapper := &YAMLMap{}
				if r.Match.Type == "rule-set" {
					rs, ok := rsByTag[r.Match.Value]
					if !ok {
						continue
					}
					u := ctx.ruleSetEndpoint(rs)
					if u == "" {
						continue
					}
					inner := &YAMLMap{}
					inner.Set("match", u)
					inner.Set("policy", pol)
					inner.Set("update_interval", 86400)
					wrapper.Set("rule_set", inner)
				} else if r.Match.Type == "ip-cidr" {
					kw := "ip_cidr"
					addr, _, _ := strings.Cut(r.Match.Value, "/")
					if ip := net.ParseIP(addr); ip != nil && ip.To4() == nil {
						kw = "ip_cidr6"
					}
					inner := &YAMLMap{}
					inner.Set("match", r.Match.Value)
					inner.Set("policy", pol)
					inner.Set("no_resolve", true)
					wrapper.Set(kw, inner)
				} else {
					kw := strings.ReplaceAll(r.Match.Type, "-", "_")
					inner := &YAMLMap{}
					inner.Set("match", r.Match.Value)
					inner.Set("policy", pol)
					wrapper.Set(kw, inner)
				}
				rules = append(rules, wrapper)
			}
			defInner := &YAMLMap{}
			defInner.Set("policy", clashTargetName(plan.Final))
			defRule := &YAMLMap{}
			defRule.Set("default", defInner)
			rules = append(rules, defRule)

			cfg := &YAMLMap{}
			if ctx.SubscriptionURL != "" {
				au := &YAMLMap{}
				au.Set("url", ctx.SubscriptionURL)
				au.Set("interval", ctx.UpdateIntervalSeconds)
				cfg.Set("auto_update", au)
			}
			cfg.Set("proxy_latency_test_url", testURLOfPlan(plan))
			cfg.Set("proxies", compiled)
			cfg.Set("policy_groups", policyGroups)
			cfg.Set("rules", rules)
			return EmitYAML(cfg) + "\n"
		},
	}
}

func newBase64Renderer() Renderer {
	return Renderer{
		ID:          "base64",
		Name:        "通用 Base64",
		ContentType: "text/plain; charset=utf-8",
		Extension:   "txt",
		Capabilities: RendererCapabilities{
			RejectInGroups: true,
			Groups:         false,
		},
		CompileNode: func(entry PlannedNode, _ string, _ RenderContext) (any, error) {
			clone := entry.Node.Clone()
			clone["name"] = entry.Name
			uri := EncodeProxyURI(clone)
			if uri == "" {
				p := entry.Node.Str("protocol")
				if p == "" {
					p = "empty"
				}
				return nil, errInvalid("unsupported_proxy_uri_export_" + p)
			}
			return uri, nil
		},
		Render: func(_ AggregationPlan, compiled []any, _ RenderContext) string {
			lines := make([]string, 0, len(compiled))
			for _, item := range compiled {
				if s, ok := item.(string); ok {
					lines = append(lines, s)
				}
			}
			return base64.StdEncoding.EncodeToString([]byte(strings.Join(lines, "\n")))
		},
	}
}

func newURIRenderer() Renderer {
	b64 := newBase64Renderer()
	return Renderer{
		ID:           "uri",
		Name:         "分享链接列表",
		ContentType:  "text/plain; charset=utf-8",
		Extension:    "txt",
		Capabilities: b64.Capabilities,
		CompileNode:  b64.CompileNode,
		Render: func(_ AggregationPlan, compiled []any, _ RenderContext) string {
			lines := make([]string, 0, len(compiled))
			for _, item := range compiled {
				if s, ok := item.(string); ok {
					lines = append(lines, s)
				}
			}
			if len(lines) == 0 {
				return ""
			}
			return strings.Join(lines, "\n") + "\n"
		},
	}
}

func newJSONRenderer() Renderer {
	return Renderer{
		ID:          "json",
		Name:        "JSON（节点数据）",
		ContentType: "application/json; charset=utf-8",
		Extension:   "json",
		Capabilities: RendererCapabilities{
			RejectInGroups: true,
			Groups:         false,
			ProxyChain:     "reference",
		},
		CompileNode: func(entry PlannedNode, _ string, _ RenderContext) (any, error) {
			proto := NormalizeProtocolAlias(entry.Node.Str("protocol"))
			meta, ok := protocolRegistry[proto]
			if !ok {
				if proto == "" {
					proto = "empty"
				}
				return nil, errInvalid("unsupported_proxy_protocol_" + proto)
			}
			port, _ := entry.Node.Int("port")
			m := &YAMLMap{}
			m.Set("name", entry.Name)
			m.Set("protocol", proto)
			m.Set("server", entry.Node.Str("server"))
			m.Set("port", port)
			for _, field := range meta.Fields {
				val, exists := entry.Node[field]
				if !exists || val == nil {
					continue
				}
				if s, isStr := val.(string); isStr && s == "" {
					continue
				}
				m.Set(field, val)
			}
			if chain := strings.TrimSpace(entry.Node.Str("chain")); chain != "" {
				m.Set("chain", chain)
			}
			return m, nil
		},
		Render: func(_ AggregationPlan, compiled []any, _ RenderContext) string {
			nodes := make([]*YAMLMap, 0, len(compiled))
			for _, item := range compiled {
				if m, ok := item.(*YAMLMap); ok {
					nodes = append(nodes, m)
				}
			}
			root := &YAMLMap{}
			root.Set("version", 1)
			root.Set("nodes", nodes)
			return prettyJSONFromYAMLMap(root) + "\n"
		},
	}
}

// chainResolution 保存节点列表上的链式前置关系与诊断错误。
type chainResolution struct {
	Targets map[int]int
	Errors  map[int]string
}

func resolveProxyChains(entries []PlannedNode) chainResolution {
	byRef := make(map[string]int, len(entries)*2)
	for i, e := range entries {
		if e.ID != "" {
			if _, exists := byRef[e.ID]; !exists {
				byRef[e.ID] = i
			}
		}
		if key := BuildProxyNodeConnectionKey(e.Node); key != "" {
			if _, exists := byRef[key]; !exists {
				byRef[key] = i
			}
		}
	}

	res := chainResolution{
		Targets: make(map[int]int),
		Errors:  make(map[int]string),
	}
	for i, e := range entries {
		ref := strings.TrimSpace(e.Node.Str("chain"))
		if ref == "" {
			continue
		}
		if ref == e.ID {
			res.Errors[i] = "invalid_proxy_chain_cycle"
			continue
		}
		upIdx, ok := byRef[ref]
		if !ok {
			res.Errors[i] = "invalid_proxy_chain_missing"
			continue
		}
		seen := map[int]bool{i: true}
		curIdx := upIdx
		depth := 0
		failure := ""
		for {
			depth++
			if depth > maxChainDepth {
				failure = "invalid_proxy_chain_too_deep"
				break
			}
			if seen[curIdx] {
				failure = "invalid_proxy_chain_cycle"
				break
			}
			seen[curIdx] = true
			nextRef := strings.TrimSpace(entries[curIdx].Node.Str("chain"))
			if nextRef == "" {
				break
			}
			nxt, exists := byRef[nextRef]
			if !exists {
				break
			}
			curIdx = nxt
		}
		if failure != "" {
			res.Errors[i] = failure
		} else {
			res.Targets[i] = upIdx
		}
	}
	return res
}

func orderEntriesByChain(entries []PlannedNode, targets map[int]int) []int {
	ordered := make([]int, 0, len(entries))
	visited := make(map[int]bool, len(entries))
	active := make(map[int]bool, len(entries))
	var visit func(int)
	visit = func(idx int) {
		if visited[idx] || active[idx] {
			return
		}
		active[idx] = true
		if up, ok := targets[idx]; ok {
			visit(up)
		}
		delete(active, idx)
		visited[idx] = true
		ordered = append(ordered, idx)
	}
	for i := range entries {
		visit(i)
	}
	return ordered
}

// RenderResult 表示一次订阅渲染输出的完整结果。
type RenderResult struct {
	Content      string                `json:"content"`
	Format       string                `json:"format"`
	ContentType  string                `json:"contentType"`
	Stats        PlanStats             `json:"stats"`
	SkippedNodes []SkippedNodeInfo     `json:"skippedNodes"`
	Warnings     []string              `json:"warnings"`
	UserInfo     *SubscriptionUserInfo `json:"userInfo"`
}

var chainErrorPrefixPattern = regexp.MustCompile(`^(?:unsupported|invalid)_proxy_chain_`)

// RenderWithPlan 按目标渲染器编译节点并输出最终配置正文、统计与告警。
func RenderWithPlan(profile AggregatorProfile, renderer Renderer, subs []Subscription, rawNodes []ProxyNode, ctx RenderContext) RenderResult {
	sel := SelectAggregatedNodes(profile, subs, rawNodes)
	entries := SanitizeEntriesForRenderer(sel.Entries, renderer.Capabilities.SanitizeName)
	chains := resolveProxyChains(entries)
	chainSyntax := renderer.Capabilities.ProxyChain

	compiledEntries := make([]PlannedNode, 0, len(entries))
	compiledNodes := make([]any, 0, len(entries))
	skippedNodes := make([]SkippedNodeInfo, 0)
	compiledIdx := make(map[int]bool, len(entries))

	for _, idx := range orderEntriesByChain(entries, chains.Targets) {
		e := entries[idx]
		chainFailure := chains.Errors[idx]
		if upIdx, hasUp := chains.Targets[idx]; hasUp {
			if chainFailure == "" && chainSyntax == "" {
				chainFailure = "unsupported_proxy_chain_" + renderer.ID
			}
			if chainFailure == "" && !compiledIdx[upIdx] {
				chainFailure = "unsupported_proxy_chain_upstream_skipped"
			}
		}
		if chainFailure != "" {
			skippedNodes = append(skippedNodes, SkippedNodeInfo{Name: e.Name, Reason: chainFailure})
			continue
		}
		chainName := ""
		if upIdx, hasUp := chains.Targets[idx]; hasUp {
			chainName = entries[upIdx].Name
		}
		nodeObj, err := renderer.CompileNode(e, chainName, ctx)
		if err != nil {
			reason := err.Error()
			if de, ok := AsDomainError(err); ok {
				reason = de.Code
			}
			skippedNodes = append(skippedNodes, SkippedNodeInfo{Name: e.Name, Reason: reason})
			continue
		}
		compiledNodes = append(compiledNodes, nodeObj)
		compiledEntries = append(compiledEntries, e)
		compiledIdx[idx] = true
	}

	plan := BuildPlanFromEntries(profile, compiledEntries, sel.Stats, renderer.Capabilities)
	relayStatus := (*RelayRenderStatus)(nil)
	if ctx.Relay != nil {
		relayStatus = ctx.Relay.Status
	}

	if len(compiledEntries) == 0 && len(skippedNodes) > 0 {
		allChain := true
		for _, item := range skippedNodes {
			if !chainErrorPrefixPattern.MatchString(item.Reason) {
				allChain = false
				break
			}
		}
		relayBlocked := !allChain && relayStatus != nil && relayStatus.Candidates > 0 && !relayStatus.Active && relayStatus.Available
		nextWarn := make([]string, 0, len(plan.Warnings)+1)
		for _, w := range plan.Warnings {
			if w != "aggregator_no_nodes" {
				nextWarn = append(nextWarn, w)
			}
		}
		if allChain {
			nextWarn = append(nextWarn, "aggregator_nodes_chain_blocked")
		} else if relayBlocked {
			errCode := relayStatus.Error
			if errCode == "" {
				errCode = "relay_not_running"
			}
			nextWarn = append(nextWarn, "aggregator_relay_unavailable:"+errCode)
		} else {
			nextWarn = append(nextWarn, "aggregator_nodes_unsupported_by_target")
		}
		plan.Warnings = nextWarn
	}

	if len(ctx.CoreProtocols) > 0 && len(compiledEntries) > 0 {
		coreSet := make(map[string]bool, len(ctx.CoreProtocols))
		for _, cp := range ctx.CoreProtocols {
			coreSet[cp] = true
		}
		seenRej := map[string]bool{}
		var rejected []string
		for _, e := range compiledEntries {
			if ctx.Relay != nil && len(ctx.Relay.Endpoints) > 0 {
				if _, ok := ctx.Relay.Endpoints[e.Node.Str("id")]; ok {
					continue
				}
				if _, ok := ctx.Relay.Endpoints[e.ID]; ok {
					continue
				}
			}
			p := NormalizeProtocolAlias(e.Node.Str("protocol"))
			if !coreSet[p] && !seenRej[p] {
				seenRej[p] = true
				rejected = append(rejected, p)
			}
		}
		if len(rejected) > 0 {
			plan.Warnings = append(plan.Warnings, "aggregator_client_core_protocols:"+strings.Join(rejected, ","))
		}
	}

	if relayStatus != nil && relayStatus.Candidates > 0 && relayStatus.Requested && !relayStatus.Active {
		hasWarn := false
		for _, w := range plan.Warnings {
			if strings.HasPrefix(w, "aggregator_relay_unavailable:") {
				hasWarn = true
				break
			}
		}
		if !hasWarn {
			errCode := relayStatus.Error
			if errCode == "" {
				errCode = "relay_failed"
			}
			plan.Warnings = append(plan.Warnings, "aggregator_relay_unavailable:"+errCode)
		}
	}

	if relayStatus != nil && relayStatus.PortMode != "server" && relayStatus.Remote && relayStatus.Active && relayStatus.AdvertiseHost != "" {
		plan.Warnings = append(plan.Warnings, fmt.Sprintf("aggregator_relay_remote:%s:%s", relayStatus.AdvertiseHost, relayStatus.PortRange))
	}

	stats := plan.Stats
	stats.Selected = len(compiledEntries)
	if ctx.View == "nodes" {
		stats.Groups = 0
		stats.Regions = 0
		stats.Rules = 0
	}

	scopedSubs := scopedSubscriptions(profile, subs)
	var infos []*SubscriptionUserInfo
	for _, s := range scopedSubs {
		infos = append(infos, s.UserInfo)
	}

	return RenderResult{
		Content:      renderer.Render(plan, compiledNodes, ctx),
		Format:       renderer.ID,
		ContentType:  renderer.ContentType,
		Stats:        stats,
		SkippedNodes: skippedNodes,
		Warnings:     plan.Warnings,
		UserInfo:     AggregateUserInfo(infos),
	}
}

func scopedSubscriptions(profile AggregatorProfile, subs []Subscription) []Subscription {
	if profile.Sources.All {
		var out []Subscription
		for _, s := range subs {
			if s.Enabled {
				out = append(out, s)
			}
		}
		return out
	}
	wanted := make(map[string]bool, len(profile.Sources.SubscriptionIds))
	for _, id := range profile.Sources.SubscriptionIds {
		wanted[id] = true
	}
	var out []Subscription
	for _, s := range subs {
		if s.Enabled && wanted[s.ID] {
			out = append(out, s)
		}
	}
	return out
}

// AggregateUserInfo 合并多订阅源流量与最早过期时间戳。
func AggregateUserInfo(list []*SubscriptionUserInfo) *SubscriptionUserInfo {
	var upload, download, total float64
	var expire *float64
	hasAny := false
	for _, info := range list {
		if info == nil {
			continue
		}
		hasAny = true
		if info.Upload != nil {
			upload += *info.Upload
		}
		if info.Download != nil {
			download += *info.Download
		}
		if info.Total != nil {
			total += *info.Total
		}
		if info.Expire != nil {
			if expire == nil || *info.Expire < *expire {
				v := *info.Expire
				expire = &v
			}
		}
	}
	if !hasAny {
		return nil
	}
	return &SubscriptionUserInfo{Upload: &upload, Download: &download, Total: &total, Expire: expire}
}

// ClientImportItem 描述某个客户端的一键导入链接与元数据。
type ClientImportItem struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Platform []string `json:"platform"`
	Scheme   string   `json:"scheme"`
	Kind     string   `json:"kind"`
	DeepLink string   `json:"deepLink"`
	SubURL   string   `json:"subscriptionUrl"`
}

// ImportLinksResult 表示某个订阅在指定 origin 下的通用链接与客户端深链集合。
type ImportLinksResult struct {
	Origin          string             `json:"origin"`
	SubscriptionURL string             `json:"subscriptionUrl"`
	Clients         []ClientImportItem `json:"clients"`
}

type importTargetDef struct {
	ID       string
	Name     string
	Platform []string
	Scheme   string
	Kind     string
	Target   string
	View     string
	Build    func(subURL, profileName string) string
}

func encQ(v string) string { return url.QueryEscape(v) }

var importTargets = []importTargetDef{
	{
		ID: "clash", Name: "Clash 系（Verge Rev / Mihomo Party / FlClash）",
		Platform: []string{"Windows", "macOS", "Linux", "Android"}, Scheme: "clash", Kind: "config", Target: "mihomo",
		Build: func(subURL, name string) string {
			return fmt.Sprintf("clash://install-config?url=%s&name=%s", encQ(subURL), encQ(name))
		},
	},
	{
		ID: "stash", Name: "Stash",
		Platform: []string{"iOS", "macOS"}, Scheme: "stash", Kind: "config", Target: "stash",
		Build: func(subURL, name string) string {
			return fmt.Sprintf("stash://install-config?url=%s&name=%s", encQ(subURL), encQ(name))
		},
	},
	{
		ID: "sing-box", Name: "sing-box 官方 App",
		Platform: []string{"iOS", "macOS", "Android"}, Scheme: "sing-box", Kind: "config", Target: "sing-box",
		Build: func(subURL, name string) string {
			return fmt.Sprintf("sing-box://import-remote-profile?url=%s#%s", encQ(subURL), url.PathEscape(name))
		},
	},
	{
		ID: "hiddify", Name: "Hiddify",
		Platform: []string{"Windows", "macOS", "Linux", "Android", "iOS"}, Scheme: "hiddify", Kind: "nodes", Target: "sing-box", View: "nodes",
		Build: func(subURL, name string) string {
			return fmt.Sprintf("hiddify://import/%s#%s", subURL, url.PathEscape(name))
		},
	},
	{
		ID: "karing", Name: "Karing",
		Platform: []string{"Windows", "macOS", "iOS", "Android"}, Scheme: "karing", Kind: "nodes", Target: "sing-box", View: "nodes",
		Build: func(subURL, name string) string {
			return fmt.Sprintf("karing://install-config?url=%s&name=%s", encQ(subURL), encQ(name))
		},
	},
	{
		ID: "surge", Name: "Surge iOS",
		Platform: []string{"iOS"}, Scheme: "surge", Kind: "config", Target: "surge",
		Build: func(subURL, _ string) string {
			return "surge:///install-config?url=" + encQ(subURL)
		},
	},
	{
		ID: "surge-mac", Name: "Surge Mac",
		Platform: []string{"macOS"}, Scheme: "surge", Kind: "config", Target: "surge",
		Build: func(subURL, _ string) string {
			return "surge:///install-config?url=" + encQ(subURL)
		},
	},
	{
		ID: "shadowrocket", Name: "Shadowrocket",
		Platform: []string{"iOS"}, Scheme: "shadowrocket", Kind: "nodes", Target: "base64",
		Build: func(subURL, name string) string {
			return "shadowrocket://add/sub://" + base64.StdEncoding.EncodeToString([]byte(subURL)) + "?remark=" + encQ(name)
		},
	},
	{
		ID: "loon", Name: "Loon",
		Platform: []string{"iOS"}, Scheme: "loon", Kind: "config", Target: "loon",
		Build: func(subURL, _ string) string {
			return "loon://import?sub=" + encQ(subURL)
		},
	},
	{
		ID: "quantumult-x", Name: "Quantumult X",
		Platform: []string{"iOS"}, Scheme: "quantumult-x", Kind: "nodes", Target: "quantumult-x", View: "nodes",
		Build: func(subURL, name string) string {
			payload, _ := json.Marshal(map[string]any{
				"server_remote": []string{subURL + ", tag=" + name},
			})
			return "quantumult-x:///update-configuration?remote-resource=" + encQ(string(payload))
		},
	},
	{
		ID: "egern", Name: "Egern（实验）",
		Platform: []string{"iOS"}, Scheme: "egern", Kind: "config", Target: "egern",
		Build: func(subURL, name string) string {
			return fmt.Sprintf("egern://%s?name=%s", encQ(subURL), encQ(name))
		},
	},
	{
		ID: "surfboard", Name: "Surfboard",
		Platform: []string{"Android"}, Scheme: "surfboard", Kind: "config", Target: "surfboard",
		Build: func(subURL, _ string) string {
			return "surfboard:///install-config?url=" + encQ(subURL)
		},
	},
	{
		ID: "nekobox", Name: "NekoBox",
		Platform: []string{"Android"}, Scheme: "nekobox", Kind: "config", Target: "mihomo",
		Build: func(subURL, name string) string {
			return fmt.Sprintf("sn://subscription?url=%s&name=%s", encQ(subURL), encQ(name))
		},
	},
	{
		ID: "husi", Name: "Husi",
		Platform: []string{"Android"}, Scheme: "husi", Kind: "nodes", Target: "sing-box", View: "nodes",
		Build: func(subURL, name string) string {
			return fmt.Sprintf("sn://subscription?url=%s&name=%s", encQ(subURL), encQ(name))
		},
	},
	{
		ID: "v2rayng", Name: "v2rayNG",
		Platform: []string{"Android"}, Scheme: "v2rayng", Kind: "nodes", Target: "base64",
		Build: func(subURL, name string) string {
			return fmt.Sprintf("v2rayng://install-sub?url=%s#%s", encQ(subURL), url.PathEscape(name))
		},
	},
	{
		ID: "happ", Name: "Happ",
		Platform: []string{"iOS", "Android", "Windows", "macOS"}, Scheme: "happ", Kind: "nodes", Target: "base64",
		Build: func(subURL, _ string) string {
			return "happ://add/" + subURL
		},
	},
	{
		ID: "streisand", Name: "Streisand",
		Platform: []string{"iOS"}, Scheme: "streisand", Kind: "nodes", Target: "base64",
		Build: func(subURL, name string) string {
			return fmt.Sprintf("streisand://import/%s#%s", subURL, url.PathEscape(name))
		},
	},
	{
		ID: "v2box", Name: "V2Box",
		Platform: []string{"iOS", "Android"}, Scheme: "v2box", Kind: "nodes", Target: "base64",
		Build: func(subURL, name string) string {
			return fmt.Sprintf("v2box://install-sub?url=%s&name=%s", encQ(subURL), encQ(name))
		},
	},
	{
		ID: "v2rayn", Name: "v2rayN",
		Platform: []string{"Windows", "Linux", "macOS"}, Scheme: "v2rayn", Kind: "nodes", Target: "base64",
		Build: func(subURL, name string) string {
			return fmt.Sprintf("v2rayn://install-sub?url=%s&name=%s", encQ(subURL), encQ(name))
		},
	},
}

// ImportSchemes 返回客户端检测器要查询的所有去重 URL scheme。
func ImportSchemes() []string {
	seen := make(map[string]bool, len(importTargets))
	out := make([]string, 0, len(importTargets))
	for _, t := range importTargets {
		if !seen[t.Scheme] {
			seen[t.Scheme] = true
			out = append(out, t.Scheme)
		}
	}
	return out
}

// BuildImportLinks 生成通用订阅地址及 19 款客户端的一键导入深链。
func BuildImportLinks(origin, token, profileName string) (ImportLinksResult, bool) {
	baseOrigin := NormalizeOrigin(origin)
	if baseOrigin == "" || strings.TrimSpace(token) == "" {
		return ImportLinksResult{}, false
	}
	displayName := strings.TrimSpace(profileName)
	if displayName == "" {
		displayName = "AIH 聚合订阅"
	}
	subPath := fmt.Sprintf("%s/sub/%s", baseOrigin, url.PathEscape(token))
	clients := make([]ClientImportItem, 0, len(importTargets))
	for _, t := range importTargets {
		q := "?target=" + encQ(t.Target)
		if t.View != "" {
			q += "&view=" + encQ(t.View)
		}
		clientSubURL := subPath + q
		clients = append(clients, ClientImportItem{
			ID:       t.ID,
			Name:     t.Name,
			Platform: t.Platform,
			Scheme:   t.Scheme,
			Kind:     t.Kind,
			DeepLink: t.Build(clientSubURL, displayName),
			SubURL:   clientSubURL,
		})
	}
	return ImportLinksResult{
		Origin:          baseOrigin,
		SubscriptionURL: subPath,
		Clients:         clients,
	}, true
}

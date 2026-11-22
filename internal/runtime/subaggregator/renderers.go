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

type RelayEndpoint struct {
	Host     string
	Port     int
	Username string
	Password string
	UDP      bool
}

var (
	multiSpacePattern = regexp.MustCompile(`\s+`)
	surgeNameBadChars = strings.NewReplacer(",", " ", "=", " ")
)

func SanitizeSurgeName(name string) string {
	cleaned := surgeNameBadChars.Replace(name)
	cleaned = multiSpacePattern.ReplaceAllString(cleaned, " ")
	return strings.TrimSpace(cleaned)
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

// NormalizeTarget 将格式别名归一为稳定 ID（clash/meta -> mihomo 等）。
func NormalizeTarget(target string) string {
	id := strings.ToLower(strings.TrimSpace(target))
	if alias, ok := targetAliases[id]; ok {
		return alias
	}
	return id
}

package subaggregator

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"net"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

const (
	PolicyProxy  = "proxy"
	PolicyAuto   = "auto"
	PolicyDirect = "direct"
	PolicyReject = "reject"

	DefaultUserAgent      = "clash.meta"
	DefaultExcludePattern = `剩余|到期|重置|流量|官网|过期|套餐|Expire|Traffic|\d+(?:\.\d+)?\s*(?:GB|MB|TB|PB)\b`
	DefaultTestURL        = "https://www.gstatic.com/generate_204"
)

var (
	BuiltinPolicies = []string{PolicyProxy, PolicyAuto, PolicyDirect, PolicyReject}

	GroupNames = map[string]string{
		"proxy": "🚀 节点选择",
		"auto":  "♻️ 自动选择",
		"final": "🐟 漏网之鱼",
	}

	CustomRuleTypes       = []string{"DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD", "IP-CIDR", "GEOSITE", "GEOIP"}
	CustomGroupTypes      = []string{"select", "url-test", "fallback", "load-balance"}
	LoadBalanceStrategies = []string{"consistent-hashing", "round-robin"}

	PrivateRuleSets = []RuleSetRef{
		{Kind: "geosite", Name: "private"},
		{Kind: "geoip", Name: "private", NoResolve: true},
	}

	RulePresets = []RulePresetDef{
		{ID: "ads", Name: "🛑 广告拦截", Description: "常见广告与追踪域名", DefaultPolicy: PolicyReject, EnabledByDefault: false, RuleSets: []RuleSetRef{{Kind: "geosite", Name: "category-ads-all"}}},
		{ID: "ai", Name: "🤖 AI 服务", Description: "OpenAI、Anthropic、Gemini 等海外 AI 服务", DefaultPolicy: PolicyProxy, EnabledByDefault: true, RuleSets: []RuleSetRef{{Kind: "geosite", Name: "category-ai-!cn"}}},
		{ID: "github", Name: "🐙 GitHub", Description: "GitHub 及其静态资源", DefaultPolicy: PolicyProxy, EnabledByDefault: true, RuleSets: []RuleSetRef{{Kind: "geosite", Name: "github"}}},
		{ID: "youtube", Name: "📹 YouTube", Description: "YouTube 视频", DefaultPolicy: PolicyProxy, EnabledByDefault: true, RuleSets: []RuleSetRef{{Kind: "geosite", Name: "youtube"}}},
		{ID: "google", Name: "🔍 Google", Description: "Google 搜索与服务", DefaultPolicy: PolicyProxy, EnabledByDefault: true, RuleSets: []RuleSetRef{{Kind: "geosite", Name: "google"}, {Kind: "geoip", Name: "google", NoResolve: true}}},
		{ID: "telegram", Name: "✈️ Telegram", Description: "Telegram 域名与 IP 段", DefaultPolicy: PolicyProxy, EnabledByDefault: true, RuleSets: []RuleSetRef{{Kind: "geosite", Name: "telegram"}, {Kind: "geoip", Name: "telegram", NoResolve: true}}},
		{ID: "netflix", Name: "🎬 Netflix", Description: "Netflix 域名与 IP 段", DefaultPolicy: PolicyProxy, EnabledByDefault: false, RuleSets: []RuleSetRef{{Kind: "geosite", Name: "netflix"}, {Kind: "geoip", Name: "netflix", NoResolve: true}}},
		{ID: "microsoft", Name: "Ⓜ️ 微软服务", Description: "Microsoft / Office / OneDrive", DefaultPolicy: PolicyDirect, EnabledByDefault: true, RuleSets: []RuleSetRef{{Kind: "geosite", Name: "microsoft"}}},
		{ID: "apple", Name: "🍎 苹果服务", Description: "Apple 服务与 CDN", DefaultPolicy: PolicyDirect, EnabledByDefault: true, RuleSets: []RuleSetRef{{Kind: "geosite", Name: "apple"}}},
		{ID: "global", Name: "🌍 国外网站", Description: "非中国大陆域名（geolocation-!cn）", DefaultPolicy: PolicyProxy, EnabledByDefault: true, RuleSets: []RuleSetRef{{Kind: "geosite", Name: "geolocation-!cn"}}},
		{ID: "cn", Name: "🎯 国内直连", Description: "中国大陆域名与 IP", DefaultPolicy: PolicyDirect, EnabledByDefault: true, RuleSets: []RuleSetRef{{Kind: "geosite", Name: "cn"}, {Kind: "geoip", Name: "cn", NoResolve: true}}},
	}

	Regions = []RegionDef{
		{ID: "hk", Code: "HK", Name: "香港", Flag: "🇭🇰"},
		{ID: "tw", Code: "TW", Name: "中国台湾", Flag: "🇨🇳"},
		{ID: "jp", Code: "JP", Name: "日本", Flag: "🇯🇵"},
		{ID: "sg", Code: "SG", Name: "新加坡", Flag: "🇸🇬"},
		{ID: "us", Code: "US", Name: "美国", Flag: "🇺🇸"},
		{ID: "kr", Code: "KR", Name: "韩国", Flag: "🇰🇷"},
		{ID: "gb", Code: "GB", Name: "英国", Flag: "🇬🇧"},
		{ID: "de", Code: "DE", Name: "德国", Flag: "🇩🇪"},
	}

	Formats = []FormatDef{
		{ID: "mihomo", Name: "Clash Meta / mihomo", Extension: "yaml", Groups: true},
		{ID: "clash-classic", Name: "Clash（YAML 规则集 · 全协议）", Extension: "yaml", Groups: true, Note: "输出全部协议；VLESS / Hysteria2 / TUIC / WireGuard 等需 Meta 系内核（Clash Verge Rev、mihomo、FlClash）"},
		{ID: "stash", Name: "Stash", Extension: "yaml", Groups: true},
		{ID: "sing-box", Name: "sing-box", Extension: "json", Groups: true},
		{ID: "surge", Name: "Surge", Extension: "conf", Groups: true},
		{ID: "surfboard", Name: "Surfboard", Extension: "conf", Groups: true},
		{ID: "loon", Name: "Loon", Extension: "conf", Groups: true},
		{ID: "quantumult-x", Name: "Quantumult X", Extension: "conf", Groups: true},
		{ID: "egern", Name: "Egern（实验）", Extension: "yaml", Groups: true},
		{ID: "base64", Name: "通用 Base64", Extension: "txt", Groups: false},
		{ID: "uri", Name: "分享链接列表", Extension: "txt", Groups: false},
		{ID: "json", Name: "JSON（节点数据）", Extension: "json", Groups: false},
	}

	Clients = []ClientDef{
		{ID: "stash", Name: "Stash", Format: "stash"},
		{ID: "hiddify-xray", Name: "Hiddify（Xray 内核）", Format: "base64"},
		{ID: "hiddify", Name: "Hiddify", Format: "sing-box"},
		{ID: "karing", Name: "Karing", Format: "sing-box"},
		{ID: "nekobox", Name: "NekoBox", Format: "mihomo"},
		{ID: "husi", Name: "Husi", Format: "sing-box"},
		{ID: "sing-box", Name: "sing-box（SFA / SFI / SFM / SFT）", Format: "sing-box"},
		{ID: "flclash", Name: "FlClash", Format: "mihomo"},
		{ID: "clash-verge", Name: "Clash Verge Rev", Format: "mihomo"},
		{ID: "clash-meta-android", Name: "Clash Meta for Android", Format: "mihomo"},
		{ID: "clash-party", Name: "Clash Party（Mihomo Party）", Format: "mihomo"},
		{ID: "clash-nyanpasu", Name: "Clash Nyanpasu", Format: "mihomo"},
		{ID: "clashx-meta", Name: "ClashX Meta", Format: "mihomo"},
		{ID: "clash-premium", Name: "ClashX / Clash for Windows / Clash for Android", Format: "clash-classic"},
		{ID: "surfboard", Name: "Surfboard", Format: "surfboard"},
		{ID: "surge", Name: "Surge", Format: "surge"},
		{ID: "loon", Name: "Loon", Format: "loon"},
		{ID: "quantumult-x", Name: "Quantumult X", Format: "quantumult-x"},
		{ID: "egern", Name: "Egern", Format: "egern"},
		{ID: "shadowrocket", Name: "Shadowrocket", Format: "base64"},
		{ID: "v2rayng", Name: "v2rayNG", Format: "base64"},
		{ID: "v2rayn", Name: "v2rayN", Format: "base64"},
		{ID: "v2raya", Name: "v2rayA", Format: "base64"},
		{ID: "streisand", Name: "Streisand", Format: "base64"},
		{ID: "v2box", Name: "V2Box", Format: "base64"},
		{ID: "foxray", Name: "FoXray", Format: "base64"},
		{ID: "happ", Name: "Happ", Format: "base64"},
		{ID: "passwall", Name: "PassWall / SSR Plus", Format: "base64"},
	}

	GroupTypeInfo = []GroupTypeDef{
		{ID: "select", Name: "手动选择", Description: "在客户端里手动挑一个成员"},
		{ID: "url-test", Name: "延迟最低", Description: "定时测速，自动用延迟最低的成员"},
		{ID: "fallback", Name: "故障转移", Description: "按顺序用第一个可用的成员"},
		{ID: "load-balance", Name: "负载均衡", Description: "把连接分散到各个成员"},
	}

	LoadBalanceStrategyInfo = []LoadBalanceStrategyDef{
		{ID: "consistent-hashing", Name: "同一网站固定走同一节点（一致性哈希）"},
		{ID: "round-robin", Name: "轮流使用（轮询）"},
	}
)

const (
	limitPattern        = 500
	limitCustomRules    = 500
	limitCustomGroups   = 50
	limitGroupMembers   = 100
	limitGroupNodeNames = 500
	limitRenames        = 50
	limitName           = 64
)

// ReservedGroupNames 返回保留策略组名称列表。
func ReservedGroupNames() []string {
	out := []string{GroupNames["proxy"], GroupNames["auto"], GroupNames["final"]}
	for _, p := range RulePresets {
		out = append(out, p.Name)
	}
	for _, r := range Regions {
		out = append(out, fmt.Sprintf("%s %s节点", r.Flag, r.Name))
	}
	return out
}

func RegionGroupName(r RegionDef) string {
	return fmt.Sprintf("%s %s节点", r.Flag, r.Name)
}

func FindRegionByID(id string) (RegionDef, bool) {
	for _, r := range Regions {
		if r.ID == id {
			return r, true
		}
	}
	return RegionDef{}, false
}

func FindRulePresetByID(id string) (RulePresetDef, bool) {
	for _, p := range RulePresets {
		if p.ID == id {
			return p, true
		}
	}
	return RulePresetDef{}, false
}

func FindFormatByID(id string) (FormatDef, bool) {
	for _, f := range Formats {
		if f.ID == id {
			return f, true
		}
	}
	return FormatDef{}, false
}

func FindClientByID(id string) (ClientDef, bool) {
	for _, c := range Clients {
		if c.ID == id {
			return c, true
		}
	}
	return ClientDef{}, false
}

// RuleSetTag 返回规范化后的规则集标识（将 `!` 替换为 `-not-`）。
func RuleSetTag(rs RuleSetRef) string {
	clean := strings.ReplaceAll(rs.Name, "!", "not-")
	return fmt.Sprintf("%s-%s", rs.Kind, clean)
}

// RuleSetURL 返回指定格式对应的 CDN 规则集链接。
func RuleSetURL(rs RuleSetRef, ext string) string {
	branch := "meta"
	if ext == "srs" {
		branch = "sing"
	}
	return fmt.Sprintf("https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@%s/geo/%s/%s.%s",
		branch, rs.Kind, url.PathEscape(rs.Name), ext)
}

func isASCIILetter(b byte) bool {
	return (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z')
}

// matchesASCIIWord 等价于 JS `(?<![A-Za-z])TOKEN(?![A-Za-z])`（不区分大小写）。
func matchesASCIIWord(text string, tokens ...string) bool {
	upper := strings.ToUpper(text)
	for _, tok := range tokens {
		tokUpper := strings.ToUpper(tok)
		idx := 0
		for {
			pos := strings.Index(upper[idx:], tokUpper)
			if pos < 0 {
				break
			}
			absStart := idx + pos
			absEnd := absStart + len(tokUpper)
			leftOK := absStart == 0 || !isASCIILetter(upper[absStart-1])
			rightOK := absEnd == len(upper) || !isASCIILetter(upper[absEnd])
			if leftOK && rightOK {
				return true
			}
			idx = absStart + 1
		}
	}
	return false
}

var (
	reHongKong = regexp.MustCompile(`(?i)Hong\s*Kong`)
	reUS       = regexp.MustCompile(`(?i)United\s*States`)
	reUK       = regexp.MustCompile(`(?i)United\s*Kingdom`)
)

// DetectRegion 根据节点名称识别归属地区，无匹配时返回空。
func DetectRegion(nodeName string) (RegionDef, bool) {
	if nodeName == "" {
		return RegionDef{}, false
	}
	lower := strings.ToLower(nodeName)
	for _, r := range Regions {
		switch r.ID {
		case "hk":
			if strings.Contains(nodeName, "香港") || strings.Contains(nodeName, "港") || matchesASCIIWord(nodeName, "HK") || reHongKong.MatchString(nodeName) {
				return r, true
			}
		case "tw":
			if strings.Contains(nodeName, "台湾") || strings.Contains(nodeName, "台灣") || strings.Contains(nodeName, "台北") || matchesASCIIWord(nodeName, "TW") || strings.Contains(lower, "taiwan") {
				return r, true
			}
		case "jp":
			if strings.Contains(nodeName, "日本") || strings.Contains(nodeName, "东京") || strings.Contains(nodeName, "大阪") || matchesASCIIWord(nodeName, "JP") || strings.Contains(lower, "japan") || strings.Contains(lower, "tokyo") || strings.Contains(lower, "osaka") {
				return r, true
			}
		case "sg":
			if strings.Contains(nodeName, "新加坡") || strings.Contains(nodeName, "狮城") || matchesASCIIWord(nodeName, "SG") || strings.Contains(lower, "singapore") {
				return r, true
			}
		case "us":
			if strings.Contains(nodeName, "美国") || strings.Contains(nodeName, "美國") || strings.Contains(nodeName, "洛杉矶") || strings.Contains(nodeName, "硅谷") || strings.Contains(nodeName, "纽约") || strings.Contains(nodeName, "西雅图") || matchesASCIIWord(nodeName, "USA", "US") || reUS.MatchString(nodeName) || strings.Contains(lower, "america") {
				return r, true
			}
		case "kr":
			if strings.Contains(nodeName, "韩国") || strings.Contains(nodeName, "韓國") || strings.Contains(nodeName, "首尔") || matchesASCIIWord(nodeName, "KR") || strings.Contains(lower, "korea") || strings.Contains(lower, "seoul") {
				return r, true
			}
		case "gb":
			if strings.Contains(nodeName, "英国") || strings.Contains(nodeName, "伦敦") || matchesASCIIWord(nodeName, "UK", "GB") || reUK.MatchString(nodeName) || strings.Contains(lower, "london") {
				return r, true
			}
		case "de":
			if strings.Contains(nodeName, "德国") || strings.Contains(nodeName, "法兰克福") || matchesASCIIWord(nodeName, "DE") || strings.Contains(lower, "germany") || strings.Contains(lower, "frankfurt") {
				return r, true
			}
		}
	}
	return RegionDef{}, false
}

// DetectFlag 返回节点展示旗帜（已知地区旗帜，默认 🏳️）。
func DetectFlag(nodeName string) string {
	if r, ok := DetectRegion(nodeName); ok {
		return r.Flag
	}
	return ""
}

// ParseSubscriptionUserInfo 解析 Subscription-Userinfo 响应头。
func ParseSubscriptionUserInfo(header string) *SubscriptionUserInfo {
	if strings.TrimSpace(header) == "" {
		return nil
	}
	out := &SubscriptionUserInfo{}
	hasAny := false
	for _, part := range strings.Split(header, ";") {
		kv := strings.SplitN(strings.TrimSpace(part), "=", 2)
		if len(kv) != 2 {
			continue
		}
		k := strings.ToLower(strings.TrimSpace(kv[0]))
		v, ok := toFloat(strings.TrimSpace(kv[1]))
		if !ok || v < 0 {
			continue
		}
		val := v
		switch k {
		case "upload":
			out.Upload = &val
			hasAny = true
		case "download":
			out.Download = &val
			hasAny = true
		case "total":
			out.Total = &val
			hasAny = true
		case "expire":
			out.Expire = &val
			hasAny = true
		}
	}
	if !hasAny {
		return nil
	}
	return out
}

// FormatSubscriptionUserInfoHeader 将汇总流量信息序列化为标准 HTTP 响应头。
func FormatSubscriptionUserInfoHeader(info *SubscriptionUserInfo) string {
	if info == nil {
		return ""
	}
	var parts []string
	if info.Upload != nil {
		parts = append(parts, fmt.Sprintf("upload=%.0f", *info.Upload))
	}
	if info.Download != nil {
		parts = append(parts, fmt.Sprintf("download=%.0f", *info.Download))
	}
	if info.Total != nil {
		parts = append(parts, fmt.Sprintf("total=%.0f", *info.Total))
	}
	if info.Expire != nil {
		parts = append(parts, fmt.Sprintf("expire=%.0f", *info.Expire))
	}
	return strings.Join(parts, "; ")
}

func defaultPresetRules() []PresetRule {
	out := make([]PresetRule, 0, len(RulePresets))
	for _, p := range RulePresets {
		out = append(out, PresetRule{ID: p.ID, Enabled: p.EnabledByDefault, Policy: p.DefaultPolicy})
	}
	return out
}

func DefaultProfileTemplateValue() DefaultProfileTemplate {
	regionIDs := make([]string, 0, len(Regions))
	for _, r := range Regions {
		regionIDs = append(regionIDs, r.ID)
	}
	return DefaultProfileTemplate{
		Name: "聚合订阅",
		Sources: ProfileSources{
			All:                true,
			SubscriptionIds:    []string{},
			IncludeManualNodes: false,
		},
		Filter: ProfileFilter{
			Include:   "",
			Exclude:   DefaultExcludePattern,
			Protocols: []string{},
		},
		Naming: ProfileNaming{
			SourcePrefix: false,
			Renames:      []RenameRule{},
		},
		Dedupe: true,
		Groups: ProfileGroups{
			Regions:         regionIDs,
			PerSource:       false,
			TestURL:         DefaultTestURL,
			TestIntervalSec: 300,
			Custom:          []CustomGroup{},
		},
		Rules: ProfileRules{
			Presets:     defaultPresetRules(),
			Custom:      []CustomRule{},
			FinalPolicy: PolicyProxy,
		},
		RefreshHours: 12,
	}
}

var (
	groupIDPattern      = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	groupNameForbidden  = regexp.MustCompile("[,=\x00-\x1f\x7f]")
	domainValuePattern  = regexp.MustCompile(`^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$`)
	ruleSetValuePattern = regexp.MustCompile(`^[a-z0-9!@._-]+$`)
)

func normalizePolicy(raw string, fallback string, allowPreset bool) (string, error) {
	p := strings.TrimSpace(raw)
	if p == "" {
		return fallback, nil
	}
	for _, bp := range BuiltinPolicies {
		if p == bp {
			return p, nil
		}
	}
	if colon := strings.IndexByte(p, ':'); colon > 0 {
		kind := p[:colon]
		id := p[colon+1:]
		switch kind {
		case "region":
			if _, ok := FindRegionByID(id); ok {
				return p, nil
			}
		case "preset":
			if allowPreset {
				if _, ok := FindRulePresetByID(id); ok {
					return p, nil
				}
			}
		case "source", "group":
			if groupIDPattern.MatchString(id) {
				return p, nil
			}
		}
	}
	return "", errInvalid("invalid_aggregator_policy", "invalid_aggregator_policy_"+p)
}

func validateRegexPattern(pattern, errCode string) (string, error) {
	p := strings.TrimSpace(pattern)
	if p == "" {
		return "", nil
	}
	if len([]rune(p)) > limitPattern {
		return "", errInvalid("invalid_aggregator_pattern", errCode)
	}
	if _, err := regexp.Compile("(?i:" + p + ")"); err != nil {
		return "", errInvalid("invalid_aggregator_pattern", errCode)
	}
	return p, nil
}

func normalizeRuleValue(ruleType, rawValue string) (string, error) {
	v := strings.TrimSpace(rawValue)
	bad := func() error { return errInvalid("invalid_aggregator_rule", "invalid_aggregator_rule_"+ruleType) }
	if v == "" || len([]rune(v)) > 253 || strings.ContainsAny(v, " \t\r\n,") {
		return "", bad()
	}
	switch ruleType {
	case "DOMAIN", "DOMAIN-SUFFIX":
		dom := strings.TrimPrefix(strings.ToLower(v), ".")
		if !domainValuePattern.MatchString(dom) {
			return "", bad()
		}
		return dom, nil
	case "DOMAIN-KEYWORD":
		return strings.ToLower(v), nil
	case "IP-CIDR":
		addrStr, prefixStr, hasSlash := strings.Cut(v, "/")
		if hasSlash && strings.Contains(prefixStr, "/") {
			return "", bad()
		}
		if strings.Contains(prefixStr, "/") {
			return "", bad()
		}
		ip := net.ParseIP(addrStr)
		if ip == nil {
			return "", bad()
		}
		bits := 32
		if ip.To4() == nil {
			bits = 128
		}
		if !hasSlash {
			return fmt.Sprintf("%s/%d", addrStr, bits), nil
		}
		n, err := strconv.Atoi(prefixStr)
		if err != nil || n < 0 || n > bits || len(prefixStr) == 0 || len(prefixStr) > 3 {
			return "", bad()
		}
		return v, nil
	default:
		if !ruleSetValuePattern.MatchString(strings.ToLower(v)) {
			return "", bad()
		}
		return strings.ToLower(v), nil
	}
}

func normalizeTestURLValue(raw string) (string, error) {
	t := strings.TrimSpace(raw)
	if t == "" {
		return DefaultTestURL, nil
	}
	u, err := url.Parse(t)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", errInvalid("invalid_aggregator_test_url")
	}
	return u.String(), nil
}

func newCustomGroupID(taken map[string]bool) string {
	var b [4]byte
	for {
		_, _ = rand.Read(b[:])
		id := "grp_" + hex.EncodeToString(b[:])
		if !taken[id] {
			return id
		}
	}
}

func assertCustomGroupsAcyclic(groups []CustomGroup) error {
	byID := make(map[string]CustomGroup, len(groups))
	for _, g := range groups {
		byID[g.ID] = g
	}
	state := make(map[string]string, len(groups))
	var visit func(CustomGroup, []string) error
	visit = func(g CustomGroup, trail []string) error {
		if state[g.ID] == "done" {
			return nil
		}
		if state[g.ID] == "visiting" {
			cycle := append(append([]string(nil), trail...), g.Name)
			return errInvalid("invalid_aggregator_group_cycle", "invalid_aggregator_group_cycle_"+strings.Join(cycle, ">"))
		}
		state[g.ID] = "visiting"
		for _, m := range g.Members {
			if !strings.HasPrefix(m, "group:") {
				continue
			}
			target, ok := byID[strings.TrimPrefix(m, "group:")]
			if !ok {
				return errInvalid("invalid_aggregator_group_member", "invalid_aggregator_group_member_"+m)
			}
			if err := visit(target, append(trail, g.Name)); err != nil {
				return err
			}
		}
		state[g.ID] = "done"
		return nil
	}
	for _, g := range groups {
		if err := visit(g, nil); err != nil {
			return err
		}
	}
	return nil
}

func clampIntVal(v, minV, maxV int) int {
	if v < minV {
		return minV
	}
	if v > maxV {
		return maxV
	}
	return v
}

func clampFloatAsInt(v any, hasVal bool, fallback, minV, maxV int) int {
	if !hasVal || v == nil {
		return fallback
	}
	var f float64
	switch t := v.(type) {
	case float64:
		f = t
	case int:
		f = float64(t)
	case int64:
		f = float64(t)
	case string:
		var err error
		f, err = strconv.ParseFloat(strings.TrimSpace(t), 64)
		if err != nil {
			return fallback
		}
	default:
		return fallback
	}
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return fallback
	}
	n := int(math.Round(f))
	return clampIntVal(n, minV, maxV)
}

func truncateRunes(s string, maxLen int) string {
	r := []rune(s)
	if len(r) <= maxLen {
		return s
	}
	return string(r[:maxLen])
}

func uniqueNonEmpty(vals []string) []string {
	out := make([]string, 0, len(vals))
	seen := map[string]bool{}
	for _, v := range vals {
		v = strings.TrimSpace(v)
		if v != "" && !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	return out
}

// NormalizeProfileFromMap 校验并补全聚合配置文件（完整保留 JSON 缺省值语义）。
func NormalizeProfileFromMap(raw map[string]any, existing *AggregatorProfile, nowMs int64) (AggregatorProfile, error) {
	if raw == nil {
		raw = map[string]any{}
	}
	fbName := "聚合订阅"
	if existing != nil && existing.Name != "" {
		fbName = existing.Name
	}
	name := ""
	if v, ok := raw["name"]; ok && v != nil {
		name = truncateRunes(strings.TrimSpace(fmt.Sprint(v)), limitName)
	}
	if name == "" {
		name = fbName
	}

	sourcesMap, _ := raw["sources"].(map[string]any)
	sourcesAll := true
	if sourcesMap != nil {
		if b, ok := sourcesMap["all"].(bool); ok {
			sourcesAll = b
		}
	}
	subIDs := extractStringSlice(sourcesMap, "subscriptionIds")
	includeManual := boolField(sourcesMap, "includeManualNodes", false)

	filterMap, _ := raw["filter"].(map[string]any)
	includePat, err := validateRegexPattern(stringField(filterMap, "include"), "invalid_aggregator_pattern_include")
	if err != nil {
		return AggregatorProfile{}, err
	}
	excludeRaw := DefaultExcludePattern
	if filterMap != nil {
		if ev, exists := filterMap["exclude"]; exists {
			if ev == nil {
				excludeRaw = ""
			} else {
				excludeRaw = fmt.Sprint(ev)
			}
		}
	}
	excludePat, err := validateRegexPattern(excludeRaw, "invalid_aggregator_pattern_exclude")
	if err != nil {
		return AggregatorProfile{}, err
	}
	rawProtos := extractStringSlice(filterMap, "protocols")
	protocols := make([]string, 0, len(rawProtos))
	seenProto := map[string]bool{}
	for _, p := range rawProtos {
		p = strings.ToLower(strings.TrimSpace(p))
		if p != "" && !seenProto[p] {
			seenProto[p] = true
			protocols = append(protocols, p)
		}
	}

	namingMap, _ := raw["naming"].(map[string]any)
	sourcePrefix := boolField(namingMap, "sourcePrefix", false)
	renames := []RenameRule{}
	if namingMap != nil {
		if rawRenames, ok := namingMap["renames"].([]any); ok {
			if len(rawRenames) > limitRenames {
				return AggregatorProfile{}, errInvalid("too_many_aggregator_renames")
			}
			for _, item := range rawRenames {
				m, _ := item.(map[string]any)
				pat, err := validateRegexPattern(stringField(m, "pattern"), "invalid_aggregator_pattern_rename")
				if err != nil {
					return AggregatorProfile{}, err
				}
				if pat == "" {
					continue
				}
				rep := stringField(m, "replace")
				if rep == "" {
					rep = stringField(m, "replacement")
				}
				renames = append(renames, RenameRule{Pattern: pat, Replace: truncateRunes(rep, limitName)})
			}
		}
	}

	dedupe := true
	if b, ok := raw["dedupe"].(bool); ok {
		dedupe = b
	}

	groupsMap, _ := raw["groups"].(map[string]any)
	regionIDs := make([]string, 0, len(Regions))
	if groupsMap != nil {
		if rawRegions, ok := groupsMap["regions"].([]any); ok {
			seenReg := map[string]bool{}
			for _, rv := range rawRegions {
				id := strings.TrimSpace(fmt.Sprint(rv))
				if _, exists := FindRegionByID(id); exists && !seenReg[id] {
					seenReg[id] = true
					regionIDs = append(regionIDs, id)
				}
			}
		} else {
			for _, r := range Regions {
				regionIDs = append(regionIDs, r.ID)
			}
		}
	} else {
		for _, r := range Regions {
			regionIDs = append(regionIDs, r.ID)
		}
	}
	perSource := boolField(groupsMap, "perSource", false)
	testURL, err := normalizeTestURLValue(stringField(groupsMap, "testUrl"))
	if err != nil {
		return AggregatorProfile{}, err
	}
	tivVal, tivOk := any(nil), false
	if groupsMap != nil {
		tivVal, tivOk = groupsMap["testIntervalSec"]
	}
	testIntervalSec := clampFloatAsInt(tivVal, tivOk, 300, 30, 86400)

	customGroups, err := normalizeCustomGroupsFromMapSlice(groupsMap)
	if err != nil {
		return AggregatorProfile{}, err
	}

	rulesMap, _ := raw["rules"].(map[string]any)
	presetOverride := map[string]map[string]any{}
	if rulesMap != nil {
		if rawPresets, ok := rulesMap["presets"].([]any); ok {
			for _, rp := range rawPresets {
				if pm, ok := rp.(map[string]any); ok {
					id := strings.TrimSpace(fmt.Sprint(pm["id"]))
					if _, valid := FindRulePresetByID(id); valid {
						presetOverride[id] = pm
					}
				}
			}
		}
	}
	presets := make([]PresetRule, 0, len(RulePresets))
	for _, def := range RulePresets {
		pm, has := presetOverride[def.ID]
		if !has {
			presets = append(presets, PresetRule{ID: def.ID, Enabled: def.EnabledByDefault, Policy: def.DefaultPolicy})
			continue
		}
		enabled, _ := pm["enabled"].(bool)
		pol, err := normalizePolicy(stringField(pm, "policy"), def.DefaultPolicy, true)
		if err != nil {
			return AggregatorProfile{}, err
		}
		presets = append(presets, PresetRule{ID: def.ID, Enabled: enabled, Policy: pol})
	}

	customRules := []CustomRule{}
	if rulesMap != nil {
		if rawCustom, ok := rulesMap["custom"].([]any); ok {
			if len(rawCustom) > limitCustomRules {
				return AggregatorProfile{}, errInvalid("too_many_aggregator_rules")
			}
			ruleTypeSet := map[string]bool{}
			for _, rt := range CustomRuleTypes {
				ruleTypeSet[rt] = true
			}
			for _, item := range rawCustom {
				cm, _ := item.(map[string]any)
				rType := strings.ToUpper(strings.TrimSpace(stringField(cm, "type")))
				if !ruleTypeSet[rType] {
					rLbl := rType
					if rLbl == "" {
						rLbl = "empty"
					}
					return AggregatorProfile{}, errInvalid("invalid_aggregator_rule", "invalid_aggregator_rule_type_"+rLbl)
				}
				val, err := normalizeRuleValue(rType, stringField(cm, "value"))
				if err != nil {
					return AggregatorProfile{}, err
				}
				pol, err := normalizePolicy(stringField(cm, "policy"), PolicyProxy, true)
				if err != nil {
					return AggregatorProfile{}, err
				}
				customRules = append(customRules, CustomRule{Type: rType, Value: val, Policy: pol})
			}
		}
	}

	finalPol, err := normalizePolicy(stringField(rulesMap, "finalPolicy"), PolicyProxy, true)
	if err != nil {
		return AggregatorProfile{}, err
	}

	rhVal, rhOk := raw["refreshHours"]
	refreshHours := clampFloatAsInt(rhVal, rhOk, 12, 0, 720)

	id := strings.TrimSpace(stringField(raw, "id"))
	token := ""
	createdAt := nowMs
	if existing != nil {
		id = existing.ID
		token = existing.Token
		createdAt = existing.CreatedAt
	}
	if createdAt == 0 {
		createdAt = nowMs
	}

	return AggregatorProfile{
		ID:    id,
		Name:  name,
		Token: token,
		Sources: ProfileSources{
			All:                sourcesAll,
			SubscriptionIds:    subIDs,
			IncludeManualNodes: includeManual,
		},
		Filter: ProfileFilter{
			Include:   includePat,
			Exclude:   excludePat,
			Protocols: protocols,
		},
		Naming: ProfileNaming{
			SourcePrefix: sourcePrefix,
			Renames:      renames,
		},
		Dedupe: dedupe,
		Groups: ProfileGroups{
			Regions:         regionIDs,
			PerSource:       perSource,
			TestURL:         testURL,
			TestIntervalSec: testIntervalSec,
			Custom:          customGroups,
		},
		Rules: ProfileRules{
			Presets:     presets,
			Custom:      customRules,
			FinalPolicy: finalPol,
		},
		RefreshHours: refreshHours,
		CreatedAt:    createdAt,
		UpdatedAt:    nowMs,
	}, nil
}

func stringField(m map[string]any, k string) string {
	if m == nil {
		return ""
	}
	v, ok := m[k]
	if !ok || v == nil {
		return ""
	}
	return fmt.Sprint(v)
}

func boolField(m map[string]any, k string, fallback bool) bool {
	if m == nil {
		return fallback
	}
	v, ok := m[k].(bool)
	if !ok {
		return fallback
	}
	return v
}

func extractStringSlice(m map[string]any, k string) []string {
	if m == nil {
		return []string{}
	}
	arr, ok := m[k].([]any)
	if !ok {
		return []string{}
	}
	raw := make([]string, 0, len(arr))
	for _, item := range arr {
		if item != nil {
			raw = append(raw, fmt.Sprint(item))
		}
	}
	return uniqueNonEmpty(raw)
}

func normalizeCustomGroupsFromMapSlice(groupsMap map[string]any) ([]CustomGroup, error) {
	if groupsMap == nil {
		return []CustomGroup{}, nil
	}
	rawGroups, ok := groupsMap["custom"].([]any)
	if !ok {
		return []CustomGroup{}, nil
	}
	if len(rawGroups) > limitCustomGroups {
		return nil, errInvalid("too_many_aggregator_groups")
	}
	reserved := map[string]bool{}
	for _, rn := range ReservedGroupNames() {
		reserved[rn] = true
	}
	groupTypeSet := map[string]bool{}
	for _, gt := range CustomGroupTypes {
		groupTypeSet[gt] = true
	}
	lbSet := map[string]bool{}
	for _, lb := range LoadBalanceStrategies {
		lbSet[lb] = true
	}
	ids := map[string]bool{}
	names := map[string]bool{}
	out := make([]CustomGroup, 0, len(rawGroups))
	for idx, item := range rawGroups {
		gm, _ := item.(map[string]any)
		reqID := strings.TrimSpace(stringField(gm, "id"))
		id := reqID
		if !groupIDPattern.MatchString(reqID) || ids[reqID] {
			id = newCustomGroupID(ids)
		}
		ids[id] = true

		gName := truncateRunes(strings.TrimSpace(stringField(gm, "name")), limitName)
		if gName == "" {
			gName = fmt.Sprintf("策略组 %d", idx+1)
		}
		if groupNameForbidden.MatchString(gName) {
			return nil, errInvalid("invalid_aggregator_group_name", "invalid_aggregator_group_name_"+gName)
		}
		if names[gName] || reserved[gName] {
			return nil, errInvalid("duplicate_aggregator_group_name", "duplicate_aggregator_group_name_"+gName)
		}
		names[gName] = true

		gType := strings.TrimSpace(stringField(gm, "type"))
		if !groupTypeSet[gType] {
			gType = "select"
		}
		rawMembers := extractStringSlice(gm, "members")
		nodesMap, _ := gm["nodes"].(map[string]any)
		rawNodeNames := extractStringSlice(nodesMap, "names")
		if len(rawNodeNames) == 0 {
			rawNodeNames = extractStringSlice(gm, "nodeNames")
		}
		if len(rawMembers) > limitGroupMembers || len(rawNodeNames) > limitGroupNodeNames {
			return nil, errInvalid("too_many_aggregator_group_members")
		}
		members := make([]string, 0, len(rawMembers))
		for _, m := range rawMembers {
			pol, err := normalizePolicy(m, PolicyProxy, false)
			if err != nil {
				return nil, err
			}
			members = append(members, pol)
		}
		nInc, err := validateRegexPattern(stringField(nodesMap, "include"), "invalid_aggregator_pattern_group_include")
		if err != nil {
			return nil, err
		}
		nExc, err := validateRegexPattern(stringField(nodesMap, "exclude"), "invalid_aggregator_pattern_group_exclude")
		if err != nil {
			return nil, err
		}
		namesTrunc := make([]string, 0, len(rawNodeNames))
		for _, nn := range rawNodeNames {
			namesTrunc = append(namesTrunc, truncateRunes(nn, 256))
		}

		cg := CustomGroup{
			ID:      id,
			Name:    gName,
			Type:    gType,
			Members: members,
			Nodes: CustomGroupNodes{
				Include: nInc,
				Exclude: nExc,
				Names:   namesTrunc,
			},
		}
		if gType != "select" {
			if rawURL := strings.TrimSpace(stringField(gm, "testUrl")); rawURL != "" {
				u, err := normalizeTestURLValue(rawURL)
				if err != nil {
					return nil, err
				}
				cg.TestURL = u
			}
			iv := clampFloatAsInt(gm["interval"], gm != nil && gm["interval"] != nil, 0, 30, 86400)
			if gm != nil && gm["interval"] != nil {
				if rawIv, _ := gm["interval"].(float64); rawIv <= 0 {
					iv = 0
				}
			} else if gm != nil && gm["testIntervalSec"] != nil {
				iv = clampFloatAsInt(gm["testIntervalSec"], true, 0, 30, 86400)
			}
			cg.Interval = iv
		}
		if gType == "url-test" {
			var tv any
			hasT := false
			if gm != nil {
				tv, hasT = gm["tolerance"]
			}
			tol := clampFloatAsInt(tv, hasT, 50, 0, 5000)
			cg.Tolerance = &tol
		}
		if gType == "load-balance" {
			st := strings.TrimSpace(stringField(gm, "strategy"))
			if !lbSet[st] {
				st = LoadBalanceStrategies[0]
			}
			cg.Strategy = st
		}
		out = append(out, cg)
	}
	if err := assertCustomGroupsAcyclic(out); err != nil {
		return nil, err
	}
	return out, nil
}

// NormalizeProfile 校验并补全聚合配置文件（保持与 Node `normalizeProfile` 一致）。
func NormalizeProfile(input AggregatorProfile, existing *AggregatorProfile, nowMs int64) (AggregatorProfile, error) {
	rawBytes, err := json.Marshal(input)
	if err != nil {
		return AggregatorProfile{}, err
	}
	var rawMap map[string]any
	if err := json.Unmarshal(rawBytes, &rawMap); err != nil {
		return AggregatorProfile{}, err
	}
	// 若由强类型 AggregatorProfile 构造且 ZeroValue 未填 Sources.All/Dedupe 等，尽量保留传入意图：
	if input.ID == "" && input.CreatedAt == 0 && len(input.Rules.Presets) == 0 && input.Groups.TestURL == "" && input.Groups.TestIntervalSec == 0 {
		if input.Filter.Exclude == "" {
			if fm, ok := rawMap["filter"].(map[string]any); ok {
				delete(fm, "exclude")
			}
		}
		if !input.Sources.All && len(input.Sources.SubscriptionIds) == 0 {
			if sm, ok := rawMap["sources"].(map[string]any); ok {
				delete(sm, "all")
			}
		}
		if !input.Dedupe {
			delete(rawMap, "dedupe")
		}
		if len(input.Groups.Regions) == 0 {
			if gm, ok := rawMap["groups"].(map[string]any); ok {
				delete(gm, "regions")
			}
		}
		if input.RefreshHours == 0 {
			delete(rawMap, "refreshHours")
		}
	}
	return NormalizeProfileFromMap(rawMap, existing, nowMs)
}

// NormalizeProfileJSON 从原始 JSON 对象字节流校验并规范化配置（完整保留省略字段的默认行为）。
func NormalizeProfileJSON(rawJSON []byte, existing *AggregatorProfile, nowMs int64) (AggregatorProfile, error) {
	var rawMap map[string]any
	if len(strings.TrimSpace(string(rawJSON))) > 0 {
		if err := json.Unmarshal(rawJSON, &rawMap); err != nil {
			return AggregatorProfile{}, errInvalid("invalid_json")
		}
	}
	return NormalizeProfileFromMap(rawMap, existing, nowMs)
}

// PublicProfile 为对外返回补充 subscriptionPath。
func PublicProfile(p AggregatorProfile) AggregatorProfile {
	p.SubscriptionPath = "/sub/" + p.Token
	return p
}

// BuildCatalog 返回目录结构（供 Overview 与独立查询复用）。
func BuildCatalog(forms []ProtocolFormDef) Catalog {
	presets := make([]RulePresetDef, 0, len(RulePresets))
	for _, p := range RulePresets {
		presets = append(presets, RulePresetDef{
			ID:               p.ID,
			Name:             p.Name,
			Description:      p.Description,
			DefaultPolicy:    p.DefaultPolicy,
			EnabledByDefault: p.EnabledByDefault,
		})
	}
	return Catalog{
		Presets:               presets,
		Regions:               Regions,
		Formats:               Formats,
		Clients:               Clients,
		Protocols:             AllSupportedProtocols,
		DefaultUserAgent:      DefaultUserAgent,
		RuleTypes:             CustomRuleTypes,
		GroupTypes:            GroupTypeInfo,
		LoadBalanceStrategies: LoadBalanceStrategyInfo,
		ReservedGroupNames:    ReservedGroupNames(),
		ProtocolForms:         forms,
		DefaultProfile:        DefaultProfileTemplateValue(),
	}
}

package egress

import (
	"context"
	"fmt"
	"math"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

const (
	upstreamPolicyKeyPrefix   = "egress:upstream-policy:"
	upstreamEvidenceKeyPrefix = "egress:upstream-evidence:"
	// DefaultEvidenceTTLMS 为上游地区实测的默认有效期（7 天）。
	DefaultEvidenceTTLMS  int64 = 7 * 24 * 60 * 60 * 1000
	maxUpstreamRules            = 100
	maxEvidencePerUpstream      = 2000
	defaultRegionPresetDate     = "2026-10-19"
)

// Scopes 与 Node lib/server/egress-evidence-scope.js 对齐。
const (
	ScopeProviderExit    = "provider_upstream_exit"
	ScopeAccountUpstream = "account_upstream_exit"
	ScopeLegacy          = "legacy_unscoped_evidence"
)

// GenericDenySignatures 为任何上游均适用的通用地区拒绝文本特征（HTTP 451 另行直接判定）。
var GenericDenySignatures = []string{
	"unavailable for legal reasons",
	"not available in your region",
	"not available in your country",
}

var officialUpstreamHosts = map[string][]string{
	"codex":       {"api.openai.com"},
	"claude":      {"api.anthropic.com"},
	"gemini":      {"generativelanguage.googleapis.com"},
	"agy":         {"daily-cloudcode-pa.googleapis.com", "cloudcode-pa.googleapis.com"},
	"opencode":    {"opencode.ai"},
	"grok":        {"api.x.ai"},
	"kiro":        {"q.us-east-1.amazonaws.com"},
	"cline":       {"api.cline.bot"},
	"zcode":       {"open.bigmodel.cn", "api.z.ai", "zcode.z.ai"},
	"kimi":        {"api.kimi.com", "api.moonshot.cn", "api.moonshot.ai"},
	"codebuddy":   {"codebuddy.ai"},
	"workbuddy":   {"workbuddy.ai"},
	"codebuddycn": {"copilot.tencent.com"},
	"workbuddycn": {"copilot.tencent.com"},
}

type regionPolicyPreset struct {
	hints          []UpstreamRule
	denySignatures []string
}

var deniedRegionsDefault = []string{"CN", "HK", "MO", "RU", "BY", "IR", "KP", "SY", "CU"}

var regionPolicyPresets = map[string]regionPolicyPreset{
	"claude": {
		hints: []UpstreamRule{{
			Effect: "deny",
			Match:  RuleMatch{Country: append([]string(nil), deniedRegionsDefault...)},
			Note:   "Anthropic 支持地区列表不含这些地区",
			Source: "https://www.anthropic.com/supported-countries",
			AsOf:   defaultRegionPresetDate,
		}},
		denySignatures: []string{
			"request not allowed",
			"unsupported_country",
			"not available in your country",
			"not available in your region",
		},
	},
	"codex": {
		hints: []UpstreamRule{{
			Effect: "deny",
			Match:  RuleMatch{Country: append([]string(nil), deniedRegionsDefault...)},
			Note:   "OpenAI 支持地区列表不含这些地区",
			Source: "https://platform.openai.com/docs/supported-countries",
			AsOf:   defaultRegionPresetDate,
		}},
		denySignatures: []string{
			"unsupported_country_region_territory",
			"country, region, or territory not supported",
			"not available in your country",
		},
	},
	"gemini": {
		hints: []UpstreamRule{{
			Effect: "deny",
			Match:  RuleMatch{Country: append([]string(nil), deniedRegionsDefault...)},
			Note:   "Gemini API 可用地区列表不含这些地区",
			Source: "https://ai.google.dev/gemini-api/docs/available-regions",
			AsOf:   defaultRegionPresetDate,
		}},
		denySignatures: []string{
			"user location is not supported",
			"location is not supported for the api use",
			"not available in your country",
		},
	},
	"agy": {
		hints: []UpstreamRule{{
			Effect: "deny",
			Match:  RuleMatch{Country: append([]string(nil), deniedRegionsDefault...)},
			Note:   "Gemini API 可用地区列表不含这些地区",
			Source: "https://ai.google.dev/gemini-api/docs/available-regions",
			AsOf:   defaultRegionPresetDate,
		}},
		denySignatures: []string{
			"user location is not supported",
			"location is not supported for the api use",
			"not available in your country",
		},
	},
}

var (
	schemePrefixPattern = regexp.MustCompile(`(?i)^[a-z][a-z0-9+.-]*://`)
	upstreamIDStrip     = regexp.MustCompile(`[^a-z0-9.:-]`)
	countryCodePattern  = regexp.MustCompile(`^[A-Z]{2}$`)
	asnRulePattern      = regexp.MustCompile(`^AS\d+$`)
	digitsOnlyPattern   = regexp.MustCompile(`^\d+$`)
)

// ServerUpstreamOverrides 描述 config:server 中可选的上游端点覆盖。
type ServerUpstreamOverrides struct {
	GeminiBaseURL string
	AgyBaseURL    string
	ClaudeBaseURL string
	CodexBaseURL  string
}

// ReadServerUpstreamOverrides 读取 config:server 中各核心 provider 的全局覆盖基址。
func ReadServerUpstreamOverrides(ctx context.Context, aiHomeDir string) ServerUpstreamOverrides {
	var raw struct {
		GeminiBaseURL string `json:"geminiBaseUrl"`
		AgyBaseURL    string `json:"agyBaseUrl"`
		ClaudeBaseURL string `json:"claudeBaseUrl"`
		CodexBaseURL  string `json:"codexBaseUrl"`
	}
	if _, err := readJSONKV(ctx, aiHomeDir, serverConfigKey, &raw); err != nil {
		return ServerUpstreamOverrides{}
	}
	return ServerUpstreamOverrides{
		GeminiBaseURL: strings.TrimSpace(raw.GeminiBaseURL),
		AgyBaseURL:    strings.TrimSpace(raw.AgyBaseURL),
		ClaudeBaseURL: strings.TrimSpace(raw.ClaudeBaseURL),
		CodexBaseURL:  strings.TrimSpace(raw.CodexBaseURL),
	}
}

// UpstreamInfo 描述从账号推导出的上游主机目标。
type UpstreamInfo struct {
	ID        string   `json:"id"`
	Host      string   `json:"host"`
	BaseURL   string   `json:"baseUrl"`
	Provider  string   `json:"provider"`
	Official  bool     `json:"official"`
	Providers []string `json:"providers,omitempty"`
	Accounts  []string `json:"accounts,omitempty"`
}

// ReadUpstreamHost 从用户填写的 base URL 提取小写主机名（允许省略协议）。
func ReadUpstreamHost(baseURL string) string {
	trimmed := strings.TrimSpace(baseURL)
	if trimmed == "" {
		return ""
	}
	withScheme := trimmed
	if !schemePrefixPattern.MatchString(withScheme) {
		withScheme = "https://" + withScheme
	}
	parsed, err := url.Parse(withScheme)
	if err != nil {
		return ""
	}
	return strings.ToLower(strings.TrimSpace(parsed.Hostname()))
}

// ListOfficialUpstreamHosts 返回某 provider 的官方主机清单。
func ListOfficialUpstreamHosts(provider string) []string {
	return officialUpstreamHosts[strings.ToLower(strings.TrimSpace(provider))]
}

// IsOfficialUpstreamHost 判断主机名是否命中官方主机或其子域。
func IsOfficialUpstreamHost(provider string, host string) bool {
	normalized := strings.ToLower(strings.TrimSpace(host))
	if normalized == "" {
		return false
	}
	for _, official := range ListOfficialUpstreamHosts(provider) {
		if normalized == official || strings.HasSuffix(normalized, "."+official) {
			return true
		}
	}
	return false
}

// ResolveProviderUpstreamBaseURL 与 Node resolveProviderUpstream 同口径解析账号上游基址。
func ResolveProviderUpstreamBaseURL(overrides ServerUpstreamOverrides, provider string, account AccountRecord) string {
	p := strings.ToLower(strings.TrimSpace(provider))
	fromAccount := strings.TrimSpace(account.BaseURL)
	switch p {
	case "gemini":
		return strings.TrimRight(overrides.GeminiBaseURL, "/")
	case "agy":
		return strings.TrimRight(firstNonEmpty(fromAccount, overrides.AgyBaseURL), "/")
	case "claude":
		return strings.TrimRight(firstNonEmpty(fromAccount, overrides.ClaudeBaseURL), "/")
	case "codex":
		if !(account.APIKeyMode || account.AuthType == "api-key") {
			fromAccount = ""
		}
		return strings.TrimRight(firstNonEmpty(fromAccount, overrides.CodexBaseURL), "/")
	case "grok":
		return strings.TrimRight(firstNonEmpty(fromAccount, "https://api.x.ai/v1"), "/")
	case "kimi":
		if fromAccount != "" {
			return strings.TrimRight(fromAccount, "/")
		}
		if account.APIKeyMode || account.AuthType == "api-key" {
			return "https://api.moonshot.cn/v1"
		}
		return "https://api.kimi.com/coding/v1"
	case "kiro":
		return strings.TrimRight(firstNonEmpty(fromAccount, "https://q.us-east-1.amazonaws.com"), "/")
	case "zcode":
		return strings.TrimRight(firstNonEmpty(fromAccount, "https://open.bigmodel.cn/api/anthropic"), "/")
	case "cline":
		return strings.TrimRight(firstNonEmpty(fromAccount, "https://api.cline.bot/api/v1"), "/")
	case "codebuddy":
		return strings.TrimRight(firstNonEmpty(fromAccount, "https://www.codebuddy.ai"), "/")
	case "workbuddy":
		return strings.TrimRight(firstNonEmpty(fromAccount, "https://www.workbuddy.ai"), "/")
	case "codebuddycn", "workbuddycn":
		return strings.TrimRight(firstNonEmpty(fromAccount, "https://copilot.tencent.com"), "/")
	default:
		return ""
	}
}

// ResolveAccountUpstream 由账号推导目标上游（id=host）。
func ResolveAccountUpstream(overrides ServerUpstreamOverrides, account AccountRecord) *UpstreamInfo {
	p := strings.ToLower(strings.TrimSpace(account.Provider))
	if p == "" {
		return nil
	}
	baseURL := ResolveProviderUpstreamBaseURL(overrides, p, account)
	host := ReadUpstreamHost(baseURL)
	if host == "" {
		officials := ListOfficialUpstreamHosts(p)
		if len(officials) > 0 {
			host = officials[0]
		}
	}
	if host == "" {
		return nil
	}
	if baseURL == "" {
		baseURL = "https://" + host
	}
	apiKeyMode := account.APIKeyMode || account.AuthType == "api-key"
	official := !apiKeyMode || IsOfficialUpstreamHost(p, host) || ReadUpstreamHost(baseURL) == ""
	return &UpstreamInfo{
		ID:       host,
		Host:     host,
		BaseURL:  baseURL,
		Provider: p,
		Official: official,
	}
}

// ListUpstreams 将已知账号按上游聚合、去重并按账号数降序排列。
func ListUpstreams(overrides ServerUpstreamOverrides, accounts []AccountRecord) []*UpstreamInfo {
	type accEntry struct {
		info      UpstreamInfo
		providers map[string]struct{}
		accounts  []string
		acctSeen  map[string]struct{}
	}
	byID := make(map[string]*accEntry)
	for _, acc := range accounts {
		u := ResolveAccountUpstream(overrides, acc)
		if u == nil {
			continue
		}
		item, exists := byID[u.ID]
		if !exists {
			item = &accEntry{
				info:      *u,
				providers: make(map[string]struct{}),
				acctSeen:  make(map[string]struct{}),
			}
			byID[u.ID] = item
		}
		item.providers[u.Provider] = struct{}{}
		item.info.Official = item.info.Official || u.Official
		if ref := strings.TrimSpace(acc.AccountRef); ref != "" {
			if _, seen := item.acctSeen[ref]; !seen {
				item.acctSeen[ref] = struct{}{}
				item.accounts = append(item.accounts, ref)
			}
		}
	}
	out := make([]*UpstreamInfo, 0, len(byID))
	for _, item := range byID {
		provs := make([]string, 0, len(item.providers))
		for p := range item.providers {
			provs = append(provs, p)
		}
		sort.Strings(provs)
		item.info.Providers = provs
		if item.accounts == nil {
			item.accounts = []string{}
		}
		item.info.Accounts = item.accounts
		copied := item.info
		out = append(out, &copied)
	}
	sort.Slice(out, func(i, j int) bool {
		if len(out[i].Accounts) != len(out[j].Accounts) {
			return len(out[i].Accounts) > len(out[j].Accounts)
		}
		return out[i].ID < out[j].ID
	})
	return out
}

// NormalizeUpstreamID 归一化上游标识（小写主机名，剔除非法字符）。
func NormalizeUpstreamID(value string) string {
	lower := strings.ToLower(strings.TrimSpace(value))
	return upstreamIDStrip.ReplaceAllString(lower, "")
}

// RuleMatch 描述单条上游地区规则的匹配条件（字段内「或」，跨字段「且」）。
type RuleMatch struct {
	Country []string `json:"country"`
	Region  []string `json:"region"`
	City    []string `json:"city"`
	ASN     []string `json:"asn"`
	CIDR    []string `json:"cidr"`
	Nodes   []string `json:"nodes"`
	Groups  []string `json:"groups"`
}

// UpstreamRule 描述一条用户配置或官方预置的地区策略规则。
type UpstreamRule struct {
	ID     string    `json:"id"`
	Effect string    `json:"effect"`
	Match  RuleMatch `json:"match"`
	Note   string    `json:"note"`
	Source string    `json:"source,omitempty"`
	AsOf   string    `json:"asOf,omitempty"`
}

// UpstreamPolicy 存储于 app_kv egress:upstream-policy:<id> 中的上游策略配置。
type UpstreamPolicy struct {
	Rules             []UpstreamRule `json:"rules"`
	EvidenceTTLMS     int64          `json:"evidenceTtlMs"`
	CredentialedProbe bool           `json:"credentialedProbe"`
	UpdatedAt         int64          `json:"updatedAt"`
}

// UpstreamEvidenceEntry 描述单条出口 × 上游实测证据（含历史与带作用域兼容字段）。
type UpstreamEvidenceEntry struct {
	Status               string `json:"status"`
	Reason               string `json:"reason"`
	Source               string `json:"source"`
	At                   int64  `json:"at"`
	Timestamp            int64  `json:"timestamp,omitempty"`
	AccountRef           string `json:"accountRef"`
	Scope                string `json:"scope,omitempty"`
	Provider             string `json:"provider,omitempty"`
	UpstreamID           string `json:"upstreamId,omitempty"`
	NodeID               string `json:"nodeId,omitempty"`
	ExitIP               string `json:"exitIp,omitempty"`
	ModelFamily          string `json:"modelFamily,omitempty"`
	CredentialGeneration string `json:"credentialGeneration,omitempty"`
	Confidence           any    `json:"confidence,omitempty"`
	UsableForBlocking    bool   `json:"usableForBlocking"`
	Expired              bool   `json:"expired,omitempty"`
	ExitKey              string `json:"exitKey,omitempty"`
	Node                 string `json:"node,omitempty"`
}

// ExitVerdict 表示某出口或节点针对某上游的地区放行结论。
type ExitVerdict struct {
	Status     string                 `json:"status"`
	Source     string                 `json:"source"`
	Detail     string                 `json:"detail"`
	RuleID     string                 `json:"ruleId,omitempty"`
	Evidence   *UpstreamEvidenceEntry `json:"evidence,omitempty"`
	Soft       bool                   `json:"soft,omitempty"`
	GeoPending bool                   `json:"geoPending,omitempty"`
}

// ParseCIDR 解析 IPv4 无类别域间路由（或单 IP 默认 /32），返回闭区间 [start, end]。
func ParseCIDR(text string) (uint32, uint32, bool) {
	ipStr, bitsStr, hasSlash := strings.Cut(strings.TrimSpace(text), "/")
	base, ok := ipv4ToUint32(ipStr)
	if !ok {
		return 0, 0, false
	}
	bits := 32
	if hasSlash {
		parsed, err := strconv.Atoi(strings.TrimSpace(bitsStr))
		if err != nil || parsed < 0 || parsed > 32 {
			return 0, 0, false
		}
		bits = parsed
	}
	if bits == 0 {
		return 0, math.MaxUint32, true
	}
	mask := uint32(math.MaxUint32) << uint(32-bits)
	start := base & mask
	end := start | ^mask
	return start, end, true
}

// CIDRContains 判断 IPv4 地址是否落入 CIDR 区间。
func CIDRContains(cidr string, ip string) bool {
	start, end, ok := ParseCIDR(cidr)
	if !ok {
		return false
	}
	val, ok := ipv4ToUint32(strings.TrimSpace(ip))
	if !ok {
		return false
	}
	return val >= start && val <= end
}

func ipv4ToUint32(ip string) (uint32, bool) {
	parts := strings.Split(strings.TrimSpace(ip), ".")
	if len(parts) != 4 {
		return 0, false
	}
	var out uint32
	for _, part := range parts {
		if part == "" || len(part) > 3 {
			return 0, false
		}
		n, err := strconv.Atoi(part)
		if err != nil || n < 0 || n > 255 {
			return 0, false
		}
		out = (out << 8) | uint32(n)
	}
	return out, true
}

func uniqueClean(items []string, transform func(string) string) []string {
	seen := make(map[string]struct{}, len(items))
	out := make([]string, 0, len(items))
	for _, item := range items {
		trimmed := strings.TrimSpace(item)
		if trimmed == "" {
			continue
		}
		val := trimmed
		if transform != nil {
			val = transform(trimmed)
		}
		if val == "" {
			continue
		}
		if _, dup := seen[val]; dup {
			continue
		}
		seen[val] = struct{}{}
		out = append(out, val)
	}
	return out
}

// NormalizeUpstreamRule 校验并归一化单条规则；没有任何匹配字段时返回 nil。
func NormalizeUpstreamRule(raw UpstreamRule, index int) *UpstreamRule {
	effect := strings.ToLower(strings.TrimSpace(raw.Effect))
	if effect != "deny" && effect != "allow" {
		effect = "deny"
	}
	match := RuleMatch{
		Country: uniqueClean(raw.Match.Country, func(v string) string {
			up := strings.ToUpper(v)
			if countryCodePattern.MatchString(up) {
				return up
			}
			return ""
		}),
		Region: uniqueClean(raw.Match.Region, strings.ToLower),
		City:   uniqueClean(raw.Match.City, strings.ToLower),
		ASN: uniqueClean(raw.Match.ASN, func(v string) string {
			up := strings.ToUpper(v)
			if asnRulePattern.MatchString(up) {
				return up
			}
			if digitsOnlyPattern.MatchString(up) {
				return "AS" + up
			}
			return ""
		}),
		CIDR: uniqueClean(raw.Match.CIDR, func(v string) string {
			if _, _, ok := ParseCIDR(v); ok {
				return v
			}
			return ""
		}),
		Nodes:  uniqueClean(raw.Match.Nodes, nil),
		Groups: uniqueClean(raw.Match.Groups, nil),
	}
	if len(match.Country) == 0 && len(match.Region) == 0 && len(match.City) == 0 &&
		len(match.ASN) == 0 && len(match.CIDR) == 0 && len(match.Nodes) == 0 && len(match.Groups) == 0 {
		return nil
	}
	id := strings.TrimSpace(raw.ID)
	if id == "" {
		id = fmt.Sprintf("rule_%d", index+1)
	}
	return &UpstreamRule{
		ID:     id,
		Effect: effect,
		Match:  match,
		Note:   truncateString(strings.TrimSpace(raw.Note), 200),
		Source: strings.TrimSpace(raw.Source),
		AsOf:   strings.TrimSpace(raw.AsOf),
	}
}

// ExitDescriptor 描述待判定的出口属性（身份、地理位置、自建分组）。
type ExitDescriptor struct {
	Identity string
	NodeID   string
	Geo      *GeoLocation
	Groups   map[string]bool
}

// RuleMatchesExit 判断规则是否命中给定出口（字段内「或」、跨字段「且」）。
func RuleMatchesExit(rule UpstreamRule, exit ExitDescriptor) bool {
	m := rule.Match
	checks := make([]bool, 0, 7)

	geoCountry := ""
	geoRegion := ""
	geoCity := ""
	geoASN := ""
	geoIP := ""
	if exit.Geo != nil {
		geoCountry = strings.ToUpper(strings.TrimSpace(exit.Geo.Country))
		geoRegion = strings.ToLower(strings.TrimSpace(exit.Geo.Region))
		geoCity = strings.ToLower(strings.TrimSpace(exit.Geo.City))
		geoASN = strings.ToUpper(strings.TrimSpace(exit.Geo.ASN))
		geoIP = strings.TrimSpace(exit.Geo.IP)
	}

	if len(m.Country) > 0 {
		checks = append(checks, geoCountry != "" && containsExact(m.Country, geoCountry))
	}
	if len(m.Region) > 0 {
		checks = append(checks, geoRegion != "" && containsExact(m.Region, geoRegion))
	}
	if len(m.City) > 0 {
		checks = append(checks, geoCity != "" && containsExact(m.City, geoCity))
	}
	if len(m.ASN) > 0 {
		checks = append(checks, geoASN != "" && containsExact(m.ASN, geoASN))
	}
	if len(m.CIDR) > 0 {
		matched := false
		if geoIP != "" {
			for _, cidr := range m.CIDR {
				if CIDRContains(cidr, geoIP) {
					matched = true
					break
				}
			}
		}
		checks = append(checks, matched)
	}
	if len(m.Nodes) > 0 {
		checks = append(checks, exit.Identity != "" && containsExact(m.Nodes, exit.Identity))
	}
	if len(m.Groups) > 0 {
		matched := false
		for _, grp := range m.Groups {
			if exit.Groups != nil && exit.Groups[grp] {
				matched = true
				break
			}
		}
		checks = append(checks, matched)
	}
	if len(checks) == 0 {
		return false
	}
	for _, ok := range checks {
		if !ok {
			return false
		}
	}
	return true
}

func containsExact(list []string, target string) bool {
	for _, item := range list {
		if item == target {
			return true
		}
	}
	return false
}

// ExitEvaluationInput 聚合判定所需的策略规则、提示与证据。
type ExitEvaluationInput struct {
	Exit                 ExitDescriptor
	Rules                []UpstreamRule
	Hints                []UpstreamRule
	EvidenceMap          map[string]UpstreamEvidenceEntry
	ScopedEvidence       []UpstreamEvidenceEntry
	Provider             string
	UpstreamID           string
	AccountRef           string
	CredentialGeneration string
	NodeID               string
	ExitIP               string
	ExitKey              string
	ModelFamily          string
	EvidenceTTLMS        int64
	NowMS                int64
}

// EvaluateExit 按优先级判定某出口对上游的可用性：
// 用户规则 > 有效期内实测（含 scoped 与兼容 legacy 隔离）> 官方预置提示 > 可连通弱证据 > 未知。
func EvaluateExit(input ExitEvaluationInput) ExitVerdict {
	nowMS := input.NowMS
	if nowMS <= 0 {
		nowMS = currentUnixMS()
	}
	ttlMS := input.EvidenceTTLMS
	if ttlMS <= 0 {
		ttlMS = DefaultEvidenceTTLMS
	}

	for _, rule := range input.Rules {
		if RuleMatchesExit(rule, input.Exit) {
			status := "allowed"
			detail := rule.Note
			if rule.Effect == "deny" {
				status = "denied"
				if detail == "" {
					detail = "命中拒绝规则"
				}
			} else if detail == "" {
				detail = "命中允许规则"
			}
			return ExitVerdict{
				Status: status,
				Source: "rule",
				RuleID: rule.ID,
				Detail: detail,
			}
		}
	}

	provider := strings.ToLower(strings.TrimSpace(input.Provider))
	upstreamID := NormalizeUpstreamID(input.UpstreamID)
	accountRef := strings.TrimSpace(input.AccountRef)
	credGen := strings.TrimSpace(input.CredentialGeneration)
	nodeID := strings.TrimSpace(input.NodeID)
	if nodeID == "" {
		nodeID = firstNonEmpty(input.Exit.NodeID, input.Exit.Identity)
	}
	exitIP := strings.TrimSpace(input.ExitIP)
	if exitIP == "" && input.Exit.Geo != nil {
		exitIP = strings.TrimSpace(input.Exit.Geo.IP)
	}
	modelFamily := strings.ToLower(strings.TrimSpace(input.ModelFamily))

	var matching []UpstreamEvidenceEntry
	for _, raw := range input.ScopedEvidence {
		entry, ok := normalizeScopedEvidenceEntry(raw)
		if !ok || !entry.UsableForBlocking {
			continue
		}
		if provider != "" && entry.Provider != provider {
			continue
		}
		if upstreamID != "" && entry.UpstreamID != upstreamID {
			continue
		}
		if accountRef != "" && entry.Scope == ScopeAccountUpstream && entry.AccountRef != accountRef {
			continue
		}
		if entry.Scope == ScopeAccountUpstream && entry.CredentialGeneration != "" && (credGen == "" || entry.CredentialGeneration != credGen) {
			continue
		}
		if nodeID != "" && entry.NodeID != "" && entry.NodeID != nodeID {
			continue
		}
		if exitIP != "" && entry.ExitIP != "" && entry.ExitIP != exitIP {
			continue
		}
		if modelFamily != "" && entry.ModelFamily != "" && entry.ModelFamily != modelFamily {
			continue
		}
		matching = append(matching, entry)
	}
	sort.Slice(matching, func(i, j int) bool {
		return matching[i].At > matching[j].At
	})

	var selected *UpstreamEvidenceEntry
	if len(matching) > 0 {
		item := matching[0]
		selected = &item
	} else if input.EvidenceMap != nil && input.ExitKey != "" {
		if found, ok := input.EvidenceMap[input.ExitKey]; ok {
			copied := found
			selected = &copied
		}
	}

	var candidate *UpstreamEvidenceEntry
	if selected != nil {
		hasScope := selected.Scope != "" && selected.Scope != ScopeLegacy
		scopedContextMissing := hasScope && (provider == "" || upstreamID == "" || (selected.Scope == ScopeAccountUpstream && accountRef == ""))
		if !hasScope || scopedContextMissing {
			leg := classifyLegacyEvidenceEntry(*selected)
			candidate = &leg
		} else {
			candidate = selected
		}
	}

	var fresh *UpstreamEvidenceEntry
	if candidate != nil && candidate.At+ttlMS > nowMS {
		fresh = candidate
	}
	if fresh != nil && fresh.UsableForBlocking && (fresh.Status == "blocked" || fresh.Status == "ok") {
		status := "allowed"
		detail := fresh.Reason
		if fresh.Status == "blocked" {
			status = "denied"
			if detail == "" {
				detail = "实测被拒"
			}
		} else if detail == "" {
			detail = "实测可用"
		}
		return ExitVerdict{
			Status:   status,
			Source:   "evidence",
			Evidence: fresh,
			Detail:   detail,
		}
	}

	for _, hint := range input.Hints {
		if RuleMatchesExit(hint, input.Exit) {
			status := "allowed"
			if hint.Effect == "deny" {
				status = "denied"
			}
			detail := hint.Note
			if detail == "" {
				detail = "预置地区提示"
			}
			return ExitVerdict{
				Status: status,
				Source: "hint",
				Soft:   true,
				Detail: detail,
			}
		}
	}

	if candidate != nil && candidate.Scope == ScopeLegacy {
		detail := candidate.Reason
		if detail == "" {
			detail = "旧版未限定范围的实测，仅作提示"
		}
		return ExitVerdict{
			Status:   "unknown",
			Source:   "legacy",
			Soft:     true,
			Evidence: candidate,
			Detail:   detail,
		}
	}

	if fresh != nil && fresh.Status == "reachable" {
		detail := fresh.Reason
		if detail == "" {
			detail = "可连通（未验证认证阶段）"
		}
		return ExitVerdict{
			Status:   "allowed",
			Source:   "evidence",
			Evidence: fresh,
			Detail:   detail,
		}
	}

	return ExitVerdict{Status: "unknown", Source: "none", Detail: "尚未测试"}
}

// UpstreamHints 返回官方上游的规范化预置地区提示。
func UpstreamHints(upstream *UpstreamInfo) []UpstreamRule {
	if upstream == nil || !upstream.Official {
		return []UpstreamRule{}
	}
	preset, ok := regionPolicyPresets[upstream.Provider]
	if !ok {
		return []UpstreamRule{}
	}
	out := make([]UpstreamRule, 0, len(preset.hints))
	for i, raw := range preset.hints {
		raw.ID = fmt.Sprintf("hint_%d", i+1)
		if rule := NormalizeUpstreamRule(raw, i); rule != nil {
			out = append(out, *rule)
		}
	}
	return out
}

// UpstreamDenySignatures 返回通用与官方上游声明合并后的地区拒绝文本特征列表。
func UpstreamDenySignatures(upstream *UpstreamInfo) []string {
	seen := make(map[string]struct{})
	out := make([]string, 0, len(GenericDenySignatures)+4)
	for _, s := range GenericDenySignatures {
		seen[s] = struct{}{}
		out = append(out, s)
	}
	if upstream != nil && upstream.Official {
		if preset, ok := regionPolicyPresets[upstream.Provider]; ok {
			for _, s := range preset.denySignatures {
				if _, dup := seen[s]; !dup {
					seen[s] = struct{}{}
					out = append(out, s)
				}
			}
		}
	}
	return out
}

// IsRegionDenied 检查响应状态码与正文是否命中地区封锁信号（451 或拒绝特征串）。
func IsRegionDenied(upstream *UpstreamInfo, statusCode int, bodyText string) string {
	if statusCode == 451 {
		return "http_451"
	}
	haystack := strings.ToLower(bodyText)
	if haystack == "" {
		return ""
	}
	for _, sig := range UpstreamDenySignatures(upstream) {
		if strings.Contains(haystack, sig) {
			return sig
		}
	}
	return ""
}

// NormalizeUpstreamPolicy 归一化整份上游策略。
func NormalizeUpstreamPolicy(raw UpstreamPolicy) UpstreamPolicy {
	rules := make([]UpstreamRule, 0, len(raw.Rules))
	limit := len(raw.Rules)
	if limit > maxUpstreamRules {
		limit = maxUpstreamRules
	}
	for i := 0; i < limit; i++ {
		if r := NormalizeUpstreamRule(raw.Rules[i], i); r != nil {
			rules = append(rules, *r)
		}
	}
	ttl := raw.EvidenceTTLMS
	if ttl >= 60000 {
		maxTTL := int64(365) * 24 * 60 * 60 * 1000
		if ttl > maxTTL {
			ttl = maxTTL
		}
	} else {
		ttl = 0
	}
	return UpstreamPolicy{
		Rules:             rules,
		EvidenceTTLMS:     ttl,
		CredentialedProbe: raw.CredentialedProbe,
		UpdatedAt:         maxInt64(0, raw.UpdatedAt),
	}
}

// ReadUpstreamPolicy 从 app_kv 读取指定上游策略；缺失时返回默认空策略。
func ReadUpstreamPolicy(ctx context.Context, aiHomeDir string, upstreamID string) UpstreamPolicy {
	id := NormalizeUpstreamID(upstreamID)
	if id == "" {
		return NormalizeUpstreamPolicy(UpstreamPolicy{})
	}
	var raw UpstreamPolicy
	found, err := readJSONKV(ctx, aiHomeDir, upstreamPolicyKeyPrefix+id, &raw)
	if err != nil || !found {
		return NormalizeUpstreamPolicy(UpstreamPolicy{})
	}
	return NormalizeUpstreamPolicy(raw)
}

// WriteUpstreamPolicy 校验、归一化并持久化上游策略。
func WriteUpstreamPolicy(ctx context.Context, aiHomeDir string, upstreamID string, policy UpstreamPolicy, nowMS int64) (UpstreamPolicy, error) {
	id := NormalizeUpstreamID(upstreamID)
	if id == "" {
		return UpstreamPolicy{}, fmt.Errorf("invalid_upstream_id")
	}
	normalized := NormalizeUpstreamPolicy(policy)
	normalized.UpdatedAt = nowMS
	if err := writeJSONKV(ctx, aiHomeDir, upstreamPolicyKeyPrefix+id, normalized, nowMS); err != nil {
		return UpstreamPolicy{}, fmt.Errorf("upstream_policy_write_failed: %w", err)
	}
	return normalized, nil
}

// ReadUpstreamEvidence 读取上游维度下的实测缓存表（按 exitKey）。
func ReadUpstreamEvidence(ctx context.Context, aiHomeDir string, upstreamID string) map[string]UpstreamEvidenceEntry {
	id := NormalizeUpstreamID(upstreamID)
	if id == "" {
		return map[string]UpstreamEvidenceEntry{}
	}
	var rawMap map[string]UpstreamEvidenceEntry
	found, err := readJSONKV(ctx, aiHomeDir, upstreamEvidenceKeyPrefix+id, &rawMap)
	if err != nil || !found {
		return map[string]UpstreamEvidenceEntry{}
	}
	out := make(map[string]UpstreamEvidenceEntry, len(rawMap))
	for k, entry := range rawMap {
		if strings.TrimSpace(k) == "" {
			continue
		}
		if norm, ok := normalizeUpstreamEvidenceEntry(entry); ok {
			out[k] = norm
		}
	}
	return out
}

// RecordUpstreamEvidence 写入或覆盖单条 exitKey 实测，超出 2000 条时淘汰最旧记录。
func RecordUpstreamEvidence(ctx context.Context, aiHomeDir string, upstreamID string, exitKey string, entry UpstreamEvidenceEntry, nowMS int64) bool {
	id := NormalizeUpstreamID(upstreamID)
	key := strings.TrimSpace(exitKey)
	if id == "" || key == "" {
		return false
	}
	if entry.At <= 0 {
		entry.At = nowMS
	}
	norm, ok := normalizeUpstreamEvidenceEntry(entry)
	if !ok {
		return false
	}
	current := ReadUpstreamEvidence(ctx, aiHomeDir, id)
	current[key] = norm
	if len(current) > maxEvidencePerUpstream {
		type item struct {
			key string
			at  int64
		}
		items := make([]item, 0, len(current))
		for k, v := range current {
			items = append(items, item{key: k, at: v.At})
		}
		sort.Slice(items, func(i, j int) bool { return items[i].at < items[j].at })
		for _, victim := range items[:len(current)-maxEvidencePerUpstream] {
			delete(current, victim.key)
		}
	}
	return writeJSONKV(ctx, aiHomeDir, upstreamEvidenceKeyPrefix+id, current, nowMS) == nil
}

// ResetUpstreamEvidence 清空指定 exitKeys（为空时删除整个上游实测缓存）。
func ResetUpstreamEvidence(ctx context.Context, aiHomeDir string, upstreamID string, exitKeys []string, nowMS int64) int {
	id := NormalizeUpstreamID(upstreamID)
	if id == "" {
		return 0
	}
	var cleaned []string
	for _, k := range exitKeys {
		if trimmed := strings.TrimSpace(k); trimmed != "" {
			cleaned = append(cleaned, trimmed)
		}
	}
	current := ReadUpstreamEvidence(ctx, aiHomeDir, id)
	if len(cleaned) == 0 {
		count := len(current)
		_ = deleteKV(ctx, aiHomeDir, upstreamEvidenceKeyPrefix+id)
		return count
	}
	removed := 0
	for _, k := range cleaned {
		if _, exists := current[k]; exists {
			delete(current, k)
			removed++
		}
	}
	_ = writeJSONKV(ctx, aiHomeDir, upstreamEvidenceKeyPrefix+id, current, nowMS)
	return removed
}

func normalizeUpstreamEvidenceEntry(raw UpstreamEvidenceEntry) (UpstreamEvidenceEntry, bool) {
	if raw.Status != "ok" && raw.Status != "blocked" && raw.Status != "reachable" {
		return UpstreamEvidenceEntry{}, false
	}
	src := strings.TrimSpace(raw.Source)
	switch src {
	case "probe", "traffic", "credentialed", "manual", "legacy":
	default:
		src = "probe"
	}
	scoped, scopedOK := normalizeScopedEvidenceEntry(raw)
	out := UpstreamEvidenceEntry{
		Status:               raw.Status,
		Reason:               truncateString(strings.TrimSpace(raw.Reason), 200),
		Source:               src,
		At:                   maxInt64(0, raw.At),
		AccountRef:           strings.TrimSpace(raw.AccountRef),
		Scope:                strings.TrimSpace(raw.Scope),
		Provider:             strings.ToLower(strings.TrimSpace(raw.Provider)),
		UpstreamID:           NormalizeUpstreamID(raw.UpstreamID),
		NodeID:               strings.TrimSpace(raw.NodeID),
		ExitIP:               strings.TrimSpace(raw.ExitIP),
		ModelFamily:          strings.ToLower(strings.TrimSpace(raw.ModelFamily)),
		CredentialGeneration: strings.TrimSpace(raw.CredentialGeneration),
	}
	if scopedOK && scoped.Scope != ScopeLegacy {
		out.Timestamp = scoped.Timestamp
		out.Confidence = scoped.Confidence
		out.UsableForBlocking = scoped.UsableForBlocking
	}
	return out, true
}

func normalizeScopedEvidenceEntry(raw UpstreamEvidenceEntry) (UpstreamEvidenceEntry, bool) {
	scopeNorm := strings.ToLower(strings.TrimSpace(raw.Scope))
	switch scopeNorm {
	case ScopeProviderExit, "provider_exit":
		scopeNorm = ScopeProviderExit
	case ScopeAccountUpstream, "account_upstream":
		scopeNorm = ScopeAccountUpstream
	default:
		scopeNorm = ScopeLegacy
	}
	at := raw.At
	if at <= 0 {
		at = raw.Timestamp
	}
	if at <= 0 {
		at = currentUnixMS()
	}
	out := raw
	out.Scope = scopeNorm
	out.Provider = strings.ToLower(strings.TrimSpace(raw.Provider))
	out.UpstreamID = NormalizeUpstreamID(raw.UpstreamID)
	out.NodeID = strings.TrimSpace(raw.NodeID)
	out.ExitIP = strings.TrimSpace(raw.ExitIP)
	out.ModelFamily = strings.ToLower(strings.TrimSpace(raw.ModelFamily))
	out.AccountRef = strings.TrimSpace(raw.AccountRef)
	out.At = at
	out.Timestamp = at
	out.UsableForBlocking = scopeNorm != ScopeLegacy
	if scopeNorm == ScopeLegacy {
		return classifyLegacyEvidenceEntry(out), true
	}
	if out.Provider == "" || out.UpstreamID == "" || out.Status == "" {
		return UpstreamEvidenceEntry{}, false
	}
	if scopeNorm == ScopeAccountUpstream && out.AccountRef == "" {
		return UpstreamEvidenceEntry{}, false
	}
	return out, true
}

func classifyLegacyEvidenceEntry(raw UpstreamEvidenceEntry) UpstreamEvidenceEntry {
	out := raw
	out.Scope = ScopeLegacy
	if out.Source == "" {
		out.Source = "legacy"
	}
	out.UsableForBlocking = false
	if strings.TrimSpace(out.Reason) == "" {
		out.Reason = ScopeLegacy
	}
	return out
}

// NodeExitKey 构造按出口身份索引的实测键。
func NodeExitKey(identity string) string {
	trimmed := strings.TrimSpace(identity)
	if trimmed == "" {
		return ""
	}
	return "node:" + trimmed
}

// IPExitKey 构造按公网 IP 索引的实测键。
func IPExitKey(ip string) string {
	trimmed := strings.TrimSpace(ip)
	if trimmed == "" {
		return ""
	}
	return "ip:" + trimmed
}

// UpstreamDecisionContext 汇聚单个上游的全部判定依据（策略 + 实测 + 提示 + scoped 证据 + 有效期）。
type UpstreamDecisionContext struct {
	Upstream       *UpstreamInfo
	Policy         UpstreamPolicy
	Evidence       map[string]UpstreamEvidenceEntry
	ScopedEvidence []UpstreamEvidenceEntry
	Hints          []UpstreamRule
	TTLMS          int64
}

// ReadUpstreamDecisionContext 读取与构建指定上游的完整判定上下文。
func ReadUpstreamDecisionContext(ctx context.Context, aiHomeDir string, upstream *UpstreamInfo) *UpstreamDecisionContext {
	if upstream == nil {
		return nil
	}
	policy := ReadUpstreamPolicy(ctx, aiHomeDir, upstream.ID)
	globalCFG := ReadServerConfigEgress(ctx, aiHomeDir)
	ttlMS := policy.EvidenceTTLMS
	if ttlMS <= 0 {
		ttlMS = globalCFG.EgressEvidenceTTLMS
	}
	return &UpstreamDecisionContext{
		Upstream: upstream,
		Policy:   policy,
		Evidence: ReadUpstreamEvidence(ctx, aiHomeDir, upstream.ID),
		Hints:    UpstreamHints(upstream),
		TTLMS:    ttlMS,
	}
}

// NetworkExitVerdict 描述非出口池账号在当前出口位置对上游的判定结果。
type NetworkExitVerdict struct {
	ExitVerdict
	Geo     *GeoLocation `json:"geo"`
	GeoText string       `json:"geoText"`
	ExitKey string       `json:"exitKey"`
}

// EvaluateNetworkExit 判定当前非池网络出口对上游是否被拒；无任何规则/提示时返回 nil。
func EvaluateNetworkExit(context *UpstreamDecisionContext, geoEntry *NetworkGeoEntry, nowMS int64) *NetworkExitVerdict {
	if context == nil {
		return nil
	}
	rules := context.Policy.Rules
	hints := context.Hints
	if len(rules) == 0 && len(hints) == 0 {
		return nil
	}
	var geo *GeoLocation
	if geoEntry != nil && geoEntry.Geo.Country != "" {
		copied := geoEntry.Geo
		geo = &copied
	}
	exitKey := ""
	if geo != nil && geo.IP != "" {
		exitKey = IPExitKey(geo.IP)
	}
	var verdict ExitVerdict
	if geo != nil {
		verdict = EvaluateExit(ExitEvaluationInput{
			Exit:          ExitDescriptor{Geo: geo},
			Rules:         rules,
			Hints:         hints,
			EvidenceMap:   context.Evidence,
			ExitKey:       exitKey,
			EvidenceTTLMS: context.TTLMS,
			NowMS:         nowMS,
		})
	} else {
		verdict = ExitVerdict{Status: "unknown", Source: "none", Detail: "出口位置未知"}
	}
	return &NetworkExitVerdict{
		ExitVerdict: verdict,
		Geo:         geo,
		GeoText:     DescribeGeo(geo),
		ExitKey:     exitKey,
	}
}

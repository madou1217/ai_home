package egress

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// ProxySubscription 描述 proxy-pool.json 中的订阅源条目。
type ProxySubscription struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Enabled *bool  `json:"enabled,omitempty"`
}

// IsEnabled 返回订阅源是否启用（缺省视作 true）。
func (sub ProxySubscription) IsEnabled() bool {
	if sub.Enabled == nil {
		return true
	}
	return *sub.Enabled
}

// ProxyNode 表示 proxy-pool.json 里的原始代理节点，不向外暴露敏感凭据。
type ProxyNode struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	Protocol       string `json:"protocol"`
	Server         string `json:"server"`
	Port           int    `json:"port"`
	CountryCode    string `json:"countryCode"`
	CountryName    string `json:"countryName"`
	CountryFlag    string `json:"countryFlag"`
	SubscriptionID string `json:"subscriptionId"`
	LatencyMS      int64  `json:"latencyMs"`
	LastChecked    int64  `json:"lastChecked"`
	UUID           string `json:"uuid,omitempty"`
	Password       string `json:"password,omitempty"`
	Username       string `json:"username,omitempty"`
}

// EnabledFlag 判断该节点所属订阅是否启用（由订阅列表推导，单测也可直接构造）。
func (node ProxyNode) CredentialTag() string {
	if strings.TrimSpace(node.UUID) != "" {
		return strings.TrimSpace(node.UUID)
	}
	if strings.TrimSpace(node.Password) != "" {
		return strings.TrimSpace(node.Password)
	}
	return strings.TrimSpace(node.Username)
}

type proxyPoolStoreDoc struct {
	Version       int                 `json:"version"`
	Nodes         []json.RawMessage   `json:"nodes"`
	Subscriptions []ProxySubscription `json:"subscriptions"`
}

// ProxyPoolData 汇总节点库读取结果。
type ProxyPoolData struct {
	Nodes         []ProxyNode
	Subscriptions []ProxySubscription
	DisabledSubs  map[string]bool
}

// ReadProxyPoolData 读取 <aiHomeDir>/proxy-pool.json。不存在返回空数据，格式错误返回错误。
func ReadProxyPoolData(aiHomeDir string) (ProxyPoolData, error) {
	trimmedHome := strings.TrimSpace(aiHomeDir)
	if trimmedHome == "" {
		return ProxyPoolData{}, errors.New("egress_pool_ai_home_missing")
	}
	filePath := filepath.Join(trimmedHome, "proxy-pool.json")
	raw, err := os.ReadFile(filePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return ProxyPoolData{DisabledSubs: map[string]bool{}}, nil
		}
		return ProxyPoolData{}, fmt.Errorf("egress_pool_store_unavailable:%w", err)
	}
	var doc proxyPoolStoreDoc
	if err := json.Unmarshal(raw, &doc); err != nil {
		return ProxyPoolData{}, fmt.Errorf("egress_pool_nodes_read_failed:%w", err)
	}
	disabled := make(map[string]bool)
	for _, sub := range doc.Subscriptions {
		if sub.ID != "" && !sub.IsEnabled() {
			disabled[sub.ID] = true
		}
	}
	nodes := make([]ProxyNode, 0, len(doc.Nodes))
	for _, item := range doc.Nodes {
		node, ok := decodeProxyNode(item)
		if ok {
			nodes = append(nodes, node)
		}
	}
	return ProxyPoolData{
		Nodes:         nodes,
		Subscriptions: doc.Subscriptions,
		DisabledSubs:  disabled,
	}, nil
}

func decodeProxyNode(raw json.RawMessage) (ProxyNode, bool) {
	var fields map[string]any
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return ProxyNode{}, false
	}
	node := ProxyNode{
		ID:             stringField(fields["id"]),
		Name:           stringField(fields["name"]),
		Protocol:       NormalizeProtocol(stringField(fields["protocol"])),
		Server:         stringField(fields["server"]),
		Port:           ParsePortAny(fields["port"]),
		CountryCode:    strings.ToUpper(stringField(fields["countryCode"])),
		CountryName:    stringField(fields["countryName"]),
		CountryFlag:    stringField(fields["countryFlag"]),
		SubscriptionID: stringField(fields["subscriptionId"]),
		LatencyMS:      int64Field(fields["latencyMs"]),
		LastChecked:    int64Field(fields["lastChecked"]),
		UUID:           stringField(fields["uuid"]),
		Password:       stringField(fields["password"]),
		Username:       stringField(fields["username"]),
	}
	return node, true
}

func stringField(value any) string {
	s, ok := value.(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(s)
}

func int64Field(value any) int64 {
	switch typed := value.(type) {
	case int64:
		return typed
	case int:
		return int64(typed)
	case float64:
		return int64(typed)
	case json.Number:
		n, _ := strconv.ParseInt(typed.String(), 10, 64)
		return n
	default:
		return 0
	}
}

// IsUsableNode 校验节点至少具备可路由主机与合法端口。
func IsUsableNode(node ProxyNode) bool {
	return IsRoutableServer(node.Server) && NormalizePort(node.Port) > 0
}

func dedupeByExit(nodes []ProxyNode) []ProxyNode {
	ordered := append([]ProxyNode(nil), nodes...)
	sort.SliceStable(ordered, func(i, j int) bool {
		infoI := IsInformationalNode(ordered[i].Name)
		infoJ := IsInformationalNode(ordered[j].Name)
		return !infoI && infoJ
	})
	seen := make(map[string]struct{}, len(ordered))
	result := make([]ProxyNode, 0, len(ordered))
	for _, node := range ordered {
		key := fmt.Sprintf("%s|%s|%d|%s",
			NormalizeProtocol(node.Protocol),
			strings.ToLower(strings.TrimSpace(node.Server)),
			node.Port,
			node.CredentialTag(),
		)
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, node)
	}
	return result
}

// ReadProxyPoolNodes 返回启用订阅下可出网、去重后的可用节点列表。
func ReadProxyPoolNodes(aiHomeDir string) ([]ProxyNode, error) {
	data, err := ReadProxyPoolData(aiHomeDir)
	if err != nil {
		return nil, err
	}
	filtered := make([]ProxyNode, 0, len(data.Nodes))
	for _, node := range data.Nodes {
		if data.DisabledSubs[node.SubscriptionID] {
			continue
		}
		if !IsUsableNode(node) || IsInformationalNode(node.Name) {
			continue
		}
		filtered = append(filtered, node)
	}
	usable := dedupeByExit(filtered)
	if len(usable) == 0 {
		return nil, errors.New("egress_pool_no_nodes")
	}
	return usable, nil
}

// CatalogGroup 描述订阅聚合器中的一个自建分组（供 scope.kind=groups 展开成出口身份集合）。
type CatalogGroup struct {
	ID          string   `json:"id"`
	ProfileID   string   `json:"profileId"`
	ProfileName string   `json:"profileName"`
	GroupID     string   `json:"groupId"`
	Name        string   `json:"name"`
	Identities  []string `json:"-"`
}

// CatalogResult 汇总节点与自建分组目录。
type CatalogResult struct {
	Nodes  []ProxyNode
	Groups []CatalogGroup
}

// ReadEgressPoolCatalog 读取可用节点与订阅聚合自建分组（分组读失败不阻断节点目录）。
func ReadEgressPoolCatalog(aiHomeDir string) (CatalogResult, error) {
	nodes, err := ReadProxyPoolNodes(aiHomeDir)
	if err != nil {
		return CatalogResult{}, err
	}
	data, dataErr := ReadProxyPoolData(aiHomeDir)
	if dataErr != nil {
		return CatalogResult{Nodes: nodes}, nil
	}
	groups := readAggregatorCatalogGroups(aiHomeDir, data)
	return CatalogResult{
		Nodes:  nodes,
		Groups: groups,
	}, nil
}

// --- 订阅聚合器自建分组展开 ---

type aggregatorStoreDoc struct {
	Version  int                 `json:"version"`
	Profiles []aggregatorProfile `json:"profiles"`
}

type aggregatorProfile struct {
	ID      string                  `json:"id"`
	Name    string                  `json:"name"`
	Sources aggregatorSourcesConfig `json:"sources"`
	Filter  aggregatorFilterConfig  `json:"filter"`
	Naming  aggregatorNamingConfig  `json:"naming"`
	Dedupe  *bool                   `json:"dedupe,omitempty"`
	Groups  aggregatorGroupsConfig  `json:"groups"`
}

type aggregatorSourcesConfig struct {
	All                *bool    `json:"all,omitempty"`
	SubscriptionIDs    []string `json:"subscriptionIds"`
	IncludeManualNodes bool     `json:"includeManualNodes"`
}

type aggregatorFilterConfig struct {
	Include   string   `json:"include"`
	Exclude   string   `json:"exclude"`
	Protocols []string `json:"protocols"`
}

type aggregatorNamingConfig struct {
	SourcePrefix bool                     `json:"sourcePrefix"`
	Renames      []aggregatorRenameConfig `json:"renames"`
}

type aggregatorRenameConfig struct {
	Pattern string `json:"pattern"`
	Replace string `json:"replace"`
}

type aggregatorGroupsConfig struct {
	Custom []aggregatorCustomGroup `json:"custom"`
}

type aggregatorCustomGroup struct {
	ID      string                     `json:"id"`
	Name    string                     `json:"name"`
	Members []string                   `json:"members"`
	Nodes   aggregatorCustomGroupNodes `json:"nodes"`
}

type aggregatorCustomGroupNodes struct {
	Names   []string `json:"names"`
	Include string   `json:"include"`
	Exclude string   `json:"exclude"`
}

func readAggregatorCatalogGroups(aiHomeDir string, data ProxyPoolData) []CatalogGroup {
	raw, err := os.ReadFile(filepath.Join(strings.TrimSpace(aiHomeDir), "subscription-aggregator.json"))
	if err != nil {
		return nil
	}
	var doc aggregatorStoreDoc
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil
	}
	sources := make(map[string]ProxySubscription, len(data.Subscriptions))
	for _, sub := range data.Subscriptions {
		if sub.ID != "" {
			sources[sub.ID] = sub
		}
	}
	var groups []CatalogGroup
	for _, profile := range doc.Profiles {
		if len(profile.Groups.Custom) == 0 {
			continue
		}
		entries := selectAggregatedEntries(profile, sources, data.Nodes)
		byID := make(map[string]aggregatorCustomGroup, len(profile.Groups.Custom))
		for _, g := range profile.Groups.Custom {
			byID[g.ID] = g
		}
		for _, group := range profile.Groups.Custom {
			seenGroups := make(map[string]bool)
			matched := expandCustomGroup(group, byID, entries, seenGroups)
			idSet := make(map[string]struct{}, len(matched))
			identities := make([]string, 0, len(matched))
			for _, entry := range matched {
				identity := BuildExitIdentity(entry.node.Protocol, entry.node.Server, entry.node.Port)
				if identity == "" {
					continue
				}
				if _, ok := idSet[identity]; !ok {
					idSet[identity] = struct{}{}
					identities = append(identities, identity)
				}
			}
			groups = append(groups, CatalogGroup{
				ID:          profile.ID + ":" + group.ID,
				ProfileID:   profile.ID,
				ProfileName: profile.Name,
				GroupID:     group.ID,
				Name:        group.Name,
				Identities:  identities,
			})
		}
	}
	return groups
}

type aggregatedEntry struct {
	node     ProxyNode
	name     string
	sourceID string
	regionID string
}

func compileIgnoreCaseRegex(pattern string) *regexp.Regexp {
	p := strings.TrimSpace(pattern)
	if p == "" {
		return nil
	}
	re, err := regexp.Compile("(?i)" + p)
	if err != nil {
		return nil
	}
	return re
}

func selectAggregatedEntries(profile aggregatorProfile, sources map[string]ProxySubscription, nodes []ProxyNode) []aggregatedEntry {
	allSources := profile.Sources.All == nil || *profile.Sources.All
	selected := make(map[string]bool, len(sources))
	if allSources {
		for id := range sources {
			selected[id] = true
		}
	} else {
		for _, id := range profile.Sources.SubscriptionIDs {
			if _, ok := sources[id]; ok {
				selected[id] = true
			}
		}
	}

	includeRe := compileIgnoreCaseRegex(profile.Filter.Include)
	excludeRe := compileIgnoreCaseRegex(profile.Filter.Exclude)
	protoSet := make(map[string]bool, len(profile.Filter.Protocols))
	for _, p := range profile.Filter.Protocols {
		if trimmed := strings.ToLower(strings.TrimSpace(p)); trimmed != "" {
			protoSet[trimmed] = true
		}
	}
	type compiledRename struct {
		re      *regexp.Regexp
		replace string
	}
	renames := make([]compiledRename, 0, len(profile.Naming.Renames))
	for _, rn := range profile.Naming.Renames {
		if re := compileIgnoreCaseRegex(rn.Pattern); re != nil {
			renames = append(renames, compiledRename{re: re, replace: rn.Replace})
		}
	}

	dedupe := profile.Dedupe == nil || *profile.Dedupe
	seenConnections := make(map[string]bool)
	usedNames := make(map[string]bool)
	entries := make([]aggregatedEntry, 0, len(nodes))

	for _, node := range nodes {
		sub, inSub := sources[node.SubscriptionID]
		if inSub {
			if !selected[node.SubscriptionID] {
				continue
			}
		} else if !profile.Sources.IncludeManualNodes {
			continue
		}
		origName := strings.TrimSpace(node.Name)
		if len(protoSet) > 0 && !protoSet[strings.ToLower(node.Protocol)] {
			continue
		}
		if includeRe != nil && !includeRe.MatchString(origName) {
			continue
		}
		if excludeRe != nil && excludeRe.MatchString(origName) {
			continue
		}
		if dedupe {
			connKey := nodeConnectionDigest(node)
			if seenConnections[connKey] {
				continue
			}
			seenConnections[connKey] = true
		}
		srcID := "manual"
		srcName := "手动节点"
		if inSub {
			srcID = sub.ID
			srcName = sub.Name
		}
		baseName := origName
		for _, rn := range renames {
			baseName = rn.re.ReplaceAllString(baseName, rn.replace)
		}
		baseName = strings.TrimSpace(baseName)
		if baseName == "" {
			proto := node.Protocol
			if proto == "" {
				proto = "proxy"
			}
			srv := node.Server
			if srv == "" {
				srv = "node"
			}
			baseName = proto + "-" + srv
		}
		if profile.Naming.SourcePrefix {
			baseName = "[" + srcName + "] " + baseName
		}
		name := baseName
		if usedNames[name] && !profile.Naming.SourcePrefix {
			name = baseName + " · " + srcName
		}
		for counter := 2; usedNames[name]; counter++ {
			name = fmt.Sprintf("%s %d", baseName, counter)
		}
		usedNames[name] = true
		entries = append(entries, aggregatedEntry{
			node:     node,
			name:     name,
			sourceID: srcID,
			regionID: detectRegionID(origName, name),
		})
	}
	return entries
}

func nodeConnectionDigest(node ProxyNode) string {
	seed := fmt.Sprintf("%s|%s|%d|%s", node.Protocol, NormalizeServer(node.Server), node.Port, node.CredentialTag())
	sum := sha256.Sum256([]byte(seed))
	return hex.EncodeToString(sum[:])[:16]
}

func expandCustomGroup(group aggregatorCustomGroup, byID map[string]aggregatorCustomGroup, entries []aggregatedEntry, seen map[string]bool) []aggregatedEntry {
	if seen[group.ID] {
		return nil
	}
	seen[group.ID] = true
	picked := make(map[string]bool, len(group.Nodes.Names))
	for _, n := range group.Nodes.Names {
		picked[n] = true
	}
	includeRe := compileIgnoreCaseRegex(group.Nodes.Include)
	excludeRe := compileIgnoreCaseRegex(group.Nodes.Exclude)
	var out []aggregatedEntry
	for _, entry := range entries {
		matched := picked[entry.name] || (includeRe != nil && includeRe.MatchString(entry.name))
		excluded := excludeRe != nil && excludeRe.MatchString(entry.name)
		if matched && !excluded {
			out = append(out, entry)
		}
	}
	for _, member := range group.Members {
		idx := strings.IndexByte(member, ':')
		if idx <= 0 {
			continue
		}
		kind := member[:idx]
		id := member[idx+1:]
		switch kind {
		case "group":
			if child, ok := byID[id]; ok {
				out = append(out, expandCustomGroup(child, byID, entries, seen)...)
			}
		case "region":
			for _, entry := range entries {
				if entry.regionID == id {
					out = append(out, entry)
				}
			}
		case "source":
			for _, entry := range entries {
				if entry.sourceID == id {
					out = append(out, entry)
				}
			}
		}
	}
	return out
}

type regionRule struct {
	id       string
	code     string
	words    []string
	abbrs    []string
}

var catalogRegions = []regionRule{
	{id: "hk", code: "HK", words: []string{"香港", "港", "hong kong", "hongkong"}, abbrs: []string{"HK"}},
	{id: "tw", code: "TW", words: []string{"台湾", "台灣", "台北", "taiwan"}, abbrs: []string{"TW"}},
	{id: "jp", code: "JP", words: []string{"日本", "东京", "大阪", "japan", "tokyo", "osaka"}, abbrs: []string{"JP"}},
	{id: "sg", code: "SG", words: []string{"新加坡", "狮城", "singapore"}, abbrs: []string{"SG"}},
	{id: "us", code: "US", words: []string{"美国", "美國", "洛杉矶", "硅谷", "纽约", "西雅图", "united states", "america"}, abbrs: []string{"US", "USA"}},
	{id: "kr", code: "KR", words: []string{"韩国", "韓國", "首尔", "korea", "seoul"}, abbrs: []string{"KR"}},
	{id: "gb", code: "GB", words: []string{"英国", "伦敦", "united kingdom", "london"}, abbrs: []string{"UK", "GB"}},
	{id: "de", code: "DE", words: []string{"德国", "法兰克福", "germany", "frankfurt"}, abbrs: []string{"DE"}},
}

func detectRegionID(names ...string) string {
	for _, name := range names {
		code := flagCodeFromText(name)
		if code != "" {
			for _, reg := range catalogRegions {
				if reg.code == code {
					return reg.id
				}
			}
		}
	}
	for _, name := range names {
		lower := strings.ToLower(name)
		for _, reg := range catalogRegions {
			for _, word := range reg.words {
				if strings.Contains(lower, word) {
					return reg.id
				}
			}
			for _, abbr := range reg.abbrs {
				if containsBoundedASCII(name, abbr) {
					return reg.id
				}
			}
		}
	}
	return ""
}

func flagCodeFromText(text string) string {
	runes := []rune(text)
	for i := 0; i < len(runes)-1; i++ {
		if runes[i] >= 0x1f1e6 && runes[i] <= 0x1f1ff && runes[i+1] >= 0x1f1e6 && runes[i+1] <= 0x1f1ff {
			return string([]rune{rune('A' + (runes[i] - 0x1f1e6)), rune('A' + (runes[i+1] - 0x1f1e6))})
		}
	}
	return ""
}

func containsBoundedASCII(text string, token string) bool {
	upperText := strings.ToUpper(text)
	upperToken := strings.ToUpper(token)
	start := 0
	for {
		idx := strings.Index(upperText[start:], upperToken)
		if idx < 0 {
			return false
		}
		abs := start + idx
		leftOK := abs == 0 || !isASCIILetter(upperText[abs-1])
		rightIdx := abs + len(upperToken)
		rightOK := rightIdx >= len(upperText) || !isASCIILetter(upperText[rightIdx])
		if leftOK && rightOK {
			return true
		}
		start = abs + len(upperToken)
	}
}

func isASCIILetter(b byte) bool {
	return b >= 'A' && b <= 'Z'
}

package subaggregator

import (
	"context"
	"net/netip"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	RuleListCDN            = "https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@meta/geo"
	ruleSetCacheTTL        = 12 * time.Hour
	ruleSetMaxCacheEntries = 64
	ruleSetMaxListBytes    = 16 * 1024 * 1024
)

var (
	ruleListCIDRPattern   = regexp.MustCompile(`^[0-9A-Fa-f:.]+/\d{1,3}$`)
	ruleListDomainPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]+$`)
)

// RuleSetEntry 表示从 .list 文本解析出的一条规则条目。
type RuleSetEntry struct {
	Type  string // suffix | domain | ip4 | ip6
	Value string
}

// RuleSetIndex 为一条缓存的规则集保存原始条目及预处理好的查找索引。
type RuleSetIndex struct {
	Entries  []RuleSetEntry
	Exact    map[string]bool
	Suffixes map[string]bool
	Prefixes []netip.Prefix
}

type ruleSetCacheItem struct {
	key       string
	fetchedAt time.Time
	index     *RuleSetIndex
}

type ruleSetInFlight struct {
	done  chan struct{}
	index *RuleSetIndex
	err   error
}

// RuleSetConverter 拉取 MetaCubeX .list 规则集，带 12h LRU 缓存与单飞并发合并，并按格式转换输出。
type RuleSetConverter struct {
	fetcher  *Fetcher
	now      func() time.Time
	mu       sync.Mutex
	cache    map[string]*ruleSetCacheItem
	order    []string
	inFlight map[string]*ruleSetInFlight
}

// NewRuleSetConverter 构造带 LRU 缓存的规则集转换器。
func NewRuleSetConverter(fetcher *Fetcher) *RuleSetConverter {
	if fetcher == nil {
		fetcher = NewFetcher()
		fetcher.MaxResponseBytes = ruleSetMaxListBytes
	}
	return &RuleSetConverter{
		fetcher:  fetcher,
		now:      time.Now,
		cache:    make(map[string]*ruleSetCacheItem),
		inFlight: make(map[string]*ruleSetInFlight),
	}
}

// RuleListURL 生成 MetaCubeX .list 源文件地址。
func RuleListURL(rs RuleSetRef) string {
	return RuleListCDN + "/" + rs.Kind + "/" + url.PathEscape(rs.Name) + ".list"
}

// ParseRuleList 解析 .list 文本为条目切片与预构建索引。
func ParseRuleList(text, kind string) *RuleSetIndex {
	idx := &RuleSetIndex{
		Exact:    make(map[string]bool),
		Suffixes: make(map[string]bool),
	}
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	for _, raw := range lines {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if kind == "geoip" {
			if ruleListCIDRPattern.MatchString(line) {
				t := "ip4"
				if strings.Contains(line, ":") {
					t = "ip6"
				}
				if p, err := netip.ParsePrefix(line); err == nil {
					idx.Prefixes = append(idx.Prefixes, p.Masked())
					idx.Entries = append(idx.Entries, RuleSetEntry{Type: t, Value: line})
				}
			}
			continue
		}
		if strings.HasPrefix(line, "+.") && ruleListDomainPattern.MatchString(line[2:]) {
			val := line[2:]
			idx.Suffixes[strings.ToLower(val)] = true
			idx.Entries = append(idx.Entries, RuleSetEntry{Type: "suffix", Value: val})
		} else if ruleListDomainPattern.MatchString(line) {
			idx.Exact[strings.ToLower(line)] = true
			idx.Entries = append(idx.Entries, RuleSetEntry{Type: "domain", Value: line})
		}
	}
	return idx
}

// LoadEntries 加载规则集（命中 12h 缓存直接返回，并发请求合并为一次上游拉取）。
func (c *RuleSetConverter) LoadEntries(ctx context.Context, rs RuleSetRef) (*RuleSetIndex, error) {
	key := rs.Kind + ":" + rs.Name
	now := c.now()

	c.mu.Lock()
	if item, ok := c.cache[key]; ok && now.Sub(item.fetchedAt) < ruleSetCacheTTL {
		c.touchLRU(key)
		idx := item.index
		c.mu.Unlock()
		return idx, nil
	}
	if flight, ok := c.inFlight[key]; ok {
		c.mu.Unlock()
		select {
		case <-flight.done:
			return flight.index, flight.err
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	flight := &ruleSetInFlight{done: make(chan struct{})}
	c.inFlight[key] = flight
	c.mu.Unlock()

	res, err := c.fetcher.Fetch(ctx, RuleListURL(rs), DefaultUserAgent)
	var parsed *RuleSetIndex
	if err == nil {
		parsed = ParseRuleList(res.Content, rs.Kind)
	}

	c.mu.Lock()
	delete(c.inFlight, key)
	if err == nil {
		c.putLRU(key, c.now(), parsed)
	}
	flight.index = parsed
	flight.err = err
	close(flight.done)
	c.mu.Unlock()

	return parsed, err
}

func (c *RuleSetConverter) touchLRU(key string) {
	for i, k := range c.order {
		if k == key {
			c.order = append(c.order[:i], c.order[i+1:]...)
			break
		}
	}
	c.order = append(c.order, key)
}

func (c *RuleSetConverter) putLRU(key string, fetchedAt time.Time, idx *RuleSetIndex) {
	c.cache[key] = &ruleSetCacheItem{key: key, fetchedAt: fetchedAt, index: idx}
	c.touchLRU(key)
	for len(c.cache) > ruleSetMaxCacheEntries && len(c.order) > 0 {
		oldest := c.order[0]
		c.order = c.order[1:]
		delete(c.cache, oldest)
	}
}

// FormatRuleSet 将规则集条目渲染为客户端语法（domain-set / rule-set / quantumult-x / egern）。
func FormatRuleSet(entries []RuleSetEntry, kind, format string) (string, error) {
	switch format {
	case "domain-set":
		lines := make([]string, 0, len(entries))
		for _, e := range entries {
			if kind == "geoip" {
				lines = append(lines, surgeIPLine(e))
			} else if e.Type == "suffix" {
				lines = append(lines, "."+e.Value)
			} else {
				lines = append(lines, e.Value)
			}
		}
		if len(lines) == 0 {
			return "", nil
		}
		return strings.Join(lines, "\n") + "\n", nil
	case "rule-set":
		lines := make([]string, 0, len(entries))
		for _, e := range entries {
			if kind == "geoip" {
				lines = append(lines, surgeIPLine(e))
			} else if e.Type == "suffix" {
				lines = append(lines, "DOMAIN-SUFFIX,"+e.Value)
			} else {
				lines = append(lines, "DOMAIN,"+e.Value)
			}
		}
		if len(lines) == 0 {
			return "", nil
		}
		return strings.Join(lines, "\n") + "\n", nil
	case "quantumult-x":
		lines := make([]string, 0, len(entries))
		for _, e := range entries {
			if kind == "geoip" {
				kw := "ip-cidr"
				if e.Type == "ip6" {
					kw = "ip6-cidr"
				}
				lines = append(lines, kw+", "+e.Value+", proxy, no-resolve")
			} else if e.Type == "suffix" {
				lines = append(lines, "host-suffix, "+e.Value+", proxy")
			} else {
				lines = append(lines, "host, "+e.Value+", proxy")
			}
		}
		if len(lines) == 0 {
			return "", nil
		}
		return strings.Join(lines, "\n") + "\n", nil
	case "egern":
		doc := &YAMLMap{}
		if kind == "geoip" {
			doc.Set("no_resolve", true)
		}
		var domainSet, domainSuffixSet, ip4Set, ip6Set []string
		for _, e := range entries {
			switch e.Type {
			case "domain":
				domainSet = append(domainSet, e.Value)
			case "suffix":
				domainSuffixSet = append(domainSuffixSet, e.Value)
			case "ip4":
				ip4Set = append(ip4Set, e.Value)
			case "ip6":
				ip6Set = append(ip6Set, e.Value)
			}
		}
		if len(domainSet) > 0 {
			doc.Set("domain_set", domainSet)
		}
		if len(domainSuffixSet) > 0 {
			doc.Set("domain_suffix_set", domainSuffixSet)
		}
		if len(ip4Set) > 0 {
			doc.Set("ip_cidr_set", ip4Set)
		}
		if len(ip6Set) > 0 {
			doc.Set("ip_cidr6_set", ip6Set)
		}
		return EmitYAML(doc) + "\n", nil
	default:
		return "", errInvalid("unsupported_rule_set_format")
	}
}

func surgeIPLine(e RuleSetEntry) string {
	kw := "IP-CIDR"
	if e.Type == "ip6" {
		kw = "IP-CIDR6"
	}
	return kw + "," + e.Value + ",no-resolve"
}

// Render 将规则集拉取并格式化为指定目标语法。
func (c *RuleSetConverter) Render(ctx context.Context, rs RuleSetRef, format string) (string, error) {
	idx, err := c.LoadEntries(ctx, rs)
	if err != nil {
		return "", err
	}
	return FormatRuleSet(idx.Entries, rs.Kind, format)
}

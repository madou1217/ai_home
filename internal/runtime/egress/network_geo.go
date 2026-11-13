package egress

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	runtimegeo "github.com/madou1217/ai_home/internal/runtime/geo"
)

const (
	networkGeoCacheFileName = "egress-network-geo.json"
	// LocalGeoTTLMS 对应 Node EGRESS_LOCAL_GEO_TTL_MS（5 分钟）。
	LocalGeoTTLMS int64 = 5 * 60 * 1000
	// NodeGeoTTLMS 对应 Node EGRESS_POOL_NODE_GEO_TTL_MS（24 小时）。
	NodeGeoTTLMS      int64 = 24 * 60 * 60 * 1000
	ipLookupTimeout         = 3500 * time.Millisecond
	geoLookupTimeout        = 8000 * time.Millisecond
	maxGeoCacheEntries      = 32
	defaultColdWaitMS int64 = 4000
)

var (
	asnExtractPattern = regexp.MustCompile(`(?i)\bAS(\d{1,10})\b`)
	asnPrefixPattern  = regexp.MustCompile(`(?i)^AS\d+\s*`)
)

// GeoLocation 描述出口真实地理位置归属（对应 Node egress-geo / node-health.geo）。
type GeoLocation struct {
	Country string `json:"country"`
	Region  string `json:"region"`
	City    string `json:"city"`
	ASN     string `json:"asn"`
	Org     string `json:"org"`
	IP      string `json:"ip"`
	Source  string `json:"source"`
	At      int64  `json:"at"`
}

// NetworkGeoEntry 表示按出口键缓存的网络位置记录。
type NetworkGeoEntry struct {
	Geo    GeoLocation `json:"geo"`
	At     int64       `json:"at"`
	Source string      `json:"source"`
	Stale  bool        `json:"stale,omitempty"`
}

// DescribeGeo 将地理归属格式化为可读短串：「🇺🇸 US · California · Los Angeles · AS13335」。
func DescribeGeo(geo *GeoLocation) string {
	if geo == nil {
		return ""
	}
	country := strings.ToUpper(strings.TrimSpace(geo.Country))
	if country == "" {
		return ""
	}
	flag := countryFlagEmoji(country)
	head := country
	if flag != "" {
		head = flag + " " + country
	}
	parts := []string{head}
	region := strings.TrimSpace(geo.Region)
	if region != "" {
		parts = append(parts, region)
	}
	city := strings.TrimSpace(geo.City)
	if city != "" && city != region {
		parts = append(parts, city)
	}
	if asn := strings.TrimSpace(geo.ASN); asn != "" {
		parts = append(parts, asn)
	}
	return strings.Join(parts, " · ")
}

func countryFlagEmoji(country string) string {
	upper := strings.ToUpper(strings.TrimSpace(country))
	if len(upper) != 2 {
		return ""
	}
	r0, r1 := rune(upper[0]), rune(upper[1])
	if r0 < 'A' || r0 > 'Z' || r1 < 'A' || r1 > 'Z' {
		return ""
	}
	return string([]rune{0x1F1E6 + (r0 - 'A'), 0x1F1E6 + (r1 - 'A')})
}

func parseASN(text string) string {
	match := asnExtractPattern.FindStringSubmatch(text)
	if len(match) < 2 {
		return ""
	}
	return "AS" + match[1]
}

func normalizeIPLiteral(value string) string {
	text := strings.TrimSpace(value)
	if text == "" || len(text) > 45 || strings.ContainsAny(text, " \t\r\n<>") {
		return ""
	}
	if net.ParseIP(text) == nil {
		return ""
	}
	return text
}

// LookupExitIP 经给定 HTTP 客户端按轻量端点链获取当前出口的公网 IP。
func LookupExitIP(ctx context.Context, client *http.Client) (string, string, error) {
	if client == nil {
		return "", "", errors.New("http_client_required")
	}
	type endpointSpec struct {
		id    string
		url   string
		parse func(string) string
	}
	endpoints := []endpointSpec{
		{
			id:  "ipify",
			url: "https://api.ipify.org?format=json",
			parse: func(text string) string {
				var doc struct {
					IP string `json:"ip"`
				}
				if json.Unmarshal([]byte(text), &doc) != nil {
					return ""
				}
				return normalizeIPLiteral(doc.IP)
			},
		},
		{
			id:    "ifconfig",
			url:   "https://ifconfig.me/ip",
			parse: normalizeIPLiteral,
		},
		{
			id:    "ipinfo-ip",
			url:   "https://ipinfo.io/ip",
			parse: normalizeIPLiteral,
		},
		{
			id:  "cloudflare",
			url: "https://www.cloudflare.com/cdn-cgi/trace",
			parse: func(text string) string {
				for _, line := range strings.Split(text, "\n") {
					key, val, ok := strings.Cut(line, "=")
					if ok && key == "ip" {
						return normalizeIPLiteral(val)
					}
				}
				return ""
			},
		},
	}

	var errs []string
	for _, ep := range endpoints {
		reqCtx, cancel := context.WithTimeout(ctx, ipLookupTimeout)
		req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, ep.url, nil)
		if err != nil {
			cancel()
			errs = append(errs, ep.id+":req_err")
			continue
		}
		req.Header.Set("Accept", "application/json, text/plain")
		req.Header.Set("Connection", "close")
		resp, err := client.Do(req)
		if err != nil {
			cancel()
			errs = append(errs, ep.id+":net_err")
			continue
		}
		raw, readErr := io.ReadAll(io.LimitReader(resp.Body, 16*1024))
		_ = resp.Body.Close()
		cancel()
		if resp.StatusCode < 200 || resp.StatusCode >= 300 || readErr != nil {
			errs = append(errs, fmt.Sprintf("%s:http_%d", ep.id, resp.StatusCode))
			continue
		}
		if ip := ep.parse(string(raw)); ip != "" {
			return ip, ep.id, nil
		}
		errs = append(errs, ep.id+":no_ip")
	}
	return "", "", errors.New(strings.Join(errs, ","))
}

// LookupExitGeoOnline 通过在线 Geo 服务（ipinfo -> ip-api）查询出口位置（本地 mmdb 不可用时兜底）。
func LookupExitGeoOnline(ctx context.Context, client *http.Client, nowMS int64) (GeoLocation, error) {
	if client == nil {
		return GeoLocation{}, errors.New("http_client_required")
	}
	if nowMS <= 0 {
		nowMS = currentUnixMS()
	}
	type sourceSpec struct {
		id    string
		url   string
		parse func([]byte) (GeoLocation, bool)
	}
	sources := []sourceSpec{
		{
			id:  "ipinfo",
			url: "https://ipinfo.io/json",
			parse: func(raw []byte) (GeoLocation, bool) {
				var doc struct {
					IP      string `json:"ip"`
					Country string `json:"country"`
					Region  string `json:"region"`
					City    string `json:"city"`
					Org     string `json:"org"`
				}
				if json.Unmarshal(raw, &doc) != nil {
					return GeoLocation{}, false
				}
				country := strings.ToUpper(strings.TrimSpace(doc.Country))
				if country == "" {
					return GeoLocation{}, false
				}
				orgClean := strings.TrimSpace(asnPrefixPattern.ReplaceAllString(strings.TrimSpace(doc.Org), ""))
				return GeoLocation{
					IP:      strings.TrimSpace(doc.IP),
					Country: country,
					Region:  strings.TrimSpace(doc.Region),
					City:    strings.TrimSpace(doc.City),
					ASN:     parseASN(doc.Org),
					Org:     orgClean,
					Source:  "ipinfo",
					At:      nowMS,
				}, true
			},
		},
		{
			id:  "ip-api",
			url: "http://ip-api.com/json/?fields=status,countryCode,regionName,city,as,isp,query",
			parse: func(raw []byte) (GeoLocation, bool) {
				var doc struct {
					Status      string `json:"status"`
					CountryCode string `json:"countryCode"`
					RegionName  string `json:"regionName"`
					City        string `json:"city"`
					AS          string `json:"as"`
					ISP         string `json:"isp"`
					Query       string `json:"query"`
				}
				if json.Unmarshal(raw, &doc) != nil || doc.Status != "success" {
					return GeoLocation{}, false
				}
				country := strings.ToUpper(strings.TrimSpace(doc.CountryCode))
				if country == "" {
					return GeoLocation{}, false
				}
				return GeoLocation{
					IP:      strings.TrimSpace(doc.Query),
					Country: country,
					Region:  strings.TrimSpace(doc.RegionName),
					City:    strings.TrimSpace(doc.City),
					ASN:     parseASN(doc.AS),
					Org:     strings.TrimSpace(doc.ISP),
					Source:  "ip-api",
					At:      nowMS,
				}, true
			},
		},
	}

	var errs []string
	for _, src := range sources {
		reqCtx, cancel := context.WithTimeout(ctx, geoLookupTimeout)
		req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, src.url, nil)
		if err != nil {
			cancel()
			errs = append(errs, src.id+":req_err")
			continue
		}
		req.Header.Set("Accept", "application/json")
		req.Header.Set("Connection", "close")
		resp, err := client.Do(req)
		if err != nil {
			cancel()
			errs = append(errs, src.id+":net_err")
			continue
		}
		raw, readErr := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
		_ = resp.Body.Close()
		cancel()
		if resp.StatusCode < 200 || resp.StatusCode >= 300 || readErr != nil {
			errs = append(errs, fmt.Sprintf("%s:http_%d", src.id, resp.StatusCode))
			continue
		}
		if loc, ok := src.parse(raw); ok {
			return loc, nil
		}
		errs = append(errs, src.id+":no_country")
	}
	return GeoLocation{}, errors.New(strings.Join(errs, ","))
}

// LookupIPGeoWithFallback 优先通过「轻量查出口 IP + 本地 MMDB」解析归属地，本地库缺省或未命中时回退在线查询。
func LookupIPGeoWithFallback(
	ctx context.Context,
	aiHomeDir string,
	homeDir string,
	proxyURL string,
	client *http.Client,
	nowMS int64,
) (GeoLocation, error) {
	if nowMS <= 0 {
		nowMS = currentUnixMS()
	}
	if client == nil {
		created, err := NewDirectOrProxiedHTTPClient(proxyURL, geoLookupTimeout)
		if err != nil {
			return GeoLocation{}, err
		}
		client = created
	}
	ip, _, ipErr := LookupExitIP(ctx, client)
	if ipErr == nil && ip != "" {
		localRes := runtimegeo.LookupIP(aiHomeDir, homeDir, ip)
		if localRes.OK && strings.TrimSpace(localRes.Record.Country) != "" {
			return GeoLocation{
				Country: strings.ToUpper(strings.TrimSpace(localRes.Record.Country)),
				Region:  strings.TrimSpace(localRes.Record.Region),
				City:    strings.TrimSpace(localRes.Record.City),
				ASN:     strings.TrimSpace(localRes.Record.ASN),
				Org:     strings.TrimSpace(localRes.Record.Org),
				IP:      ip,
				Source:  "local:" + strings.Join(localRes.Providers, "+"),
				At:      nowMS,
			}, nil
		}
	}
	return LookupExitGeoOnline(ctx, client, nowMS)
}

// NetworkGeoCache 管理本机及代理出口位置的内存/磁盘双层缓存与单飞去重（<aiHomeDir>/run/egress-network-geo.json）。
type NetworkGeoCache struct {
	mu        sync.Mutex
	aiHomeDir string
	homeDir   string
	now       func() int64
	memory    map[string]NetworkGeoEntry
	inflight  map[string]*inflightGeoCall
	lookupFn  func(ctx context.Context, proxyURL string, nowMS int64) (GeoLocation, error)
}

type inflightGeoCall struct {
	done  chan struct{}
	entry *NetworkGeoEntry
	err   error
}

// NewNetworkGeoCache 构造出口位置缓存实例。
func NewNetworkGeoCache(aiHomeDir string, homeDir string, nowFn func() int64) *NetworkGeoCache {
	if nowFn == nil {
		nowFn = currentUnixMS
	}
	return &NetworkGeoCache{
		aiHomeDir: strings.TrimSpace(aiHomeDir),
		homeDir:   strings.TrimSpace(homeDir),
		now:       nowFn,
		memory:    make(map[string]NetworkGeoEntry),
		inflight:  make(map[string]*inflightGeoCall),
	}
}

func (c *NetworkGeoCache) cacheFilePath() string {
	if c.aiHomeDir == "" {
		return ""
	}
	return filepath.Join(c.aiHomeDir, "run", networkGeoCacheFileName)
}

func (c *NetworkGeoCache) readCacheFile() map[string]NetworkGeoEntry {
	path := c.cacheFilePath()
	if path == "" {
		return map[string]NetworkGeoEntry{}
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return map[string]NetworkGeoEntry{}
	}
	var doc struct {
		Entries map[string]NetworkGeoEntry `json:"entries"`
	}
	if json.Unmarshal(raw, &doc) != nil || doc.Entries == nil {
		return map[string]NetworkGeoEntry{}
	}
	return doc.Entries
}

func (c *NetworkGeoCache) writeCacheEntry(key string, entry NetworkGeoEntry) {
	c.mu.Lock()
	c.memory[key] = entry
	c.mu.Unlock()

	path := c.cacheFilePath()
	if path == "" {
		return
	}
	entries := c.readCacheFile()
	entries[key] = entry
	type kv struct {
		key   string
		entry NetworkGeoEntry
	}
	items := make([]kv, 0, len(entries))
	for k, v := range entries {
		items = append(items, kv{key: k, entry: v})
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].entry.At != items[j].entry.At {
			return items[i].entry.At > items[j].entry.At
		}
		return items[i].key < items[j].key
	})
	if len(items) > maxGeoCacheEntries {
		items = items[:maxGeoCacheEntries]
	}
	trimmed := make(map[string]NetworkGeoEntry, len(items))
	for _, it := range items {
		trimmed[it.key] = it.entry
	}
	payload, err := json.Marshal(map[string]any{"entries": trimmed})
	if err != nil {
		return
	}
	dir := filepath.Dir(path)
	if os.MkdirAll(dir, 0o700) != nil {
		return
	}
	tmpPath := fmt.Sprintf("%s.%d.tmp", path, os.Getpid())
	if os.WriteFile(tmpPath, payload, 0o600) != nil {
		return
	}
	_ = os.Rename(tmpPath, path)
}

func (c *NetworkGeoCache) readCached(key string) (NetworkGeoEntry, bool) {
	c.mu.Lock()
	memEntry, hasMem := c.memory[key]
	c.mu.Unlock()

	fileEntries := c.readCacheFile()
	fileEntry, hasFile := fileEntries[key]

	switch {
	case hasMem && memEntry.Geo.Country != "" && hasFile && fileEntry.Geo.Country != "":
		if memEntry.At >= fileEntry.At {
			return memEntry, true
		}
		return fileEntry, true
	case hasMem && memEntry.Geo.Country != "":
		return memEntry, true
	case hasFile && fileEntry.Geo.Country != "":
		return fileEntry, true
	default:
		return NetworkGeoEntry{}, false
	}
}

// PeekExitGeo 只读缓存（不发任何网络请求），过期也返回并标注 stale=true。
func (c *NetworkGeoCache) PeekExitGeo(proxyURL string) *NetworkGeoEntry {
	key := ExitKeyOfProxyURL(proxyURL)
	entry, ok := c.readCached(key)
	if !ok {
		return nil
	}
	copied := entry
	copied.Stale = copied.At+LocalGeoTTLMS <= c.now()
	return &copied
}

// RefreshExitGeo 按出口键并发去重刷新出口位置，并写回缓存文件。
func (c *NetworkGeoCache) RefreshExitGeo(ctx context.Context, proxyURL string) (*NetworkGeoEntry, error) {
	key := ExitKeyOfProxyURL(proxyURL)

	c.mu.Lock()
	if existing, ok := c.inflight[key]; ok {
		c.mu.Unlock()
		select {
		case <-existing.done:
			return existing.entry, existing.err
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	call := &inflightGeoCall{done: make(chan struct{})}
	c.inflight[key] = call
	lookup := c.lookupFn
	c.mu.Unlock()

	var (
		loc GeoLocation
		err error
	)
	nowMS := c.now()
	if lookup != nil {
		loc, err = lookup(ctx, proxyURL, nowMS)
	} else {
		loc, err = LookupIPGeoWithFallback(ctx, c.aiHomeDir, c.homeDir, proxyURL, nil, nowMS)
	}
	if err == nil && strings.TrimSpace(loc.Country) != "" {
		entry := NetworkGeoEntry{
			Geo:    loc,
			At:     nowMS,
			Source: loc.Source,
			Stale:  false,
		}
		c.writeCacheEntry(key, entry)
		call.entry = &entry
	} else if err != nil {
		call.err = err
	} else {
		call.err = errors.New("geo_lookup_failed")
	}

	close(call.done)
	c.mu.Lock()
	delete(c.inflight, key)
	c.mu.Unlock()
	return call.entry, call.err
}

// GetExitGeo 在 ttlMS 有效期内返回缓存；冷缓存最多等待 coldWaitMS，过期则返回旧值并后台刷新。
func (c *NetworkGeoCache) GetExitGeo(ctx context.Context, proxyURL string, ttlMS int64, coldWaitMS int64) *NetworkGeoEntry {
	if ttlMS <= 0 {
		ttlMS = LocalGeoTTLMS
	}
	if coldWaitMS <= 0 {
		coldWaitMS = defaultColdWaitMS
	}
	key := ExitKeyOfProxyURL(proxyURL)
	cached, found := c.readCached(key)
	nowMS := c.now()
	if found && cached.At+ttlMS > nowMS {
		copied := cached
		return &copied
	}
	if found {
		go func() {
			bgCtx, cancel := context.WithTimeout(context.Background(), geoLookupTimeout+ipLookupTimeout)
			defer cancel()
			_, _ = c.RefreshExitGeo(bgCtx, proxyURL)
		}()
		copied := cached
		copied.Stale = true
		return &copied
	}

	waitCtx, cancel := context.WithTimeout(ctx, time.Duration(coldWaitMS)*time.Millisecond)
	defer cancel()
	entry, err := c.RefreshExitGeo(waitCtx, proxyURL)
	if err != nil {
		return nil
	}
	return entry
}

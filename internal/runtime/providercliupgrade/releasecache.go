package providercliupgrade

import (
	"sync"
	"time"
)

// DefaultReleaseCacheMaxAge 是 npm 发布时间表的最大缓存寿命（6 小时）。
const DefaultReleaseCacheMaxAge = 6 * time.Hour

// ReleaseTime 记录单个版本的发布毫秒时间戳。
type ReleaseTime struct {
	Version     string `json:"version"`
	PublishedAt int64  `json:"publishedAt"`
}

type cachedReleaseEntry struct {
	latestVersion string
	releases      []ReleaseTime
	publishedAt   int64
	storedAt      time.Time
}

// ReleaseTimeCache 是进程内线程安全的 npm 发布时间表缓存，键为 (packageName, latestVersion)。
type ReleaseTimeCache struct {
	mu      sync.Mutex
	maxAge  time.Duration
	now     func() time.Time
	entries map[string]cachedReleaseEntry
}

// NewReleaseTimeCache 创建发布时间表缓存。
func NewReleaseTimeCache(maxAge time.Duration, now func() time.Time) *ReleaseTimeCache {
	if maxAge <= 0 {
		maxAge = DefaultReleaseCacheMaxAge
	}
	if now == nil {
		now = time.Now
	}
	return &ReleaseTimeCache{
		maxAge:  maxAge,
		now:     now,
		entries: make(map[string]cachedReleaseEntry),
	}
}

// Get 读取未过期且最新版本一致的缓存条目。
func (cache *ReleaseTimeCache) Get(packageName string, latestVersion string) ([]ReleaseTime, int64, bool) {
	if cache == nil || packageName == "" || latestVersion == "" {
		return nil, 0, false
	}
	cache.mu.Lock()
	defer cache.mu.Unlock()
	entry, ok := cache.entries[packageName]
	if !ok || entry.latestVersion != latestVersion {
		return nil, 0, false
	}
	if cache.now().Sub(entry.storedAt) >= cache.maxAge {
		delete(cache.entries, packageName)
		return nil, 0, false
	}
	copied := make([]ReleaseTime, len(entry.releases))
	copy(copied, entry.releases)
	return copied, entry.publishedAt, true
}

// Set 写入完整查询结果。
func (cache *ReleaseTimeCache) Set(packageName string, latestVersion string, releases []ReleaseTime, publishedAt int64) {
	if cache == nil || packageName == "" || latestVersion == "" {
		return
	}
	copied := make([]ReleaseTime, len(releases))
	copy(copied, releases)
	cache.mu.Lock()
	defer cache.mu.Unlock()
	cache.entries[packageName] = cachedReleaseEntry{
		latestVersion: latestVersion,
		releases:      copied,
		publishedAt:   publishedAt,
		storedAt:      cache.now(),
	}
}

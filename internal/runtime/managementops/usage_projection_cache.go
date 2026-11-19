package managementops

import (
	"fmt"
	"sync"
	"time"
)

// projectionCacheTTL 是归因投影的复用窗口。归因只依赖查询窗口内的扫描行，
// 30 秒的滞后对看板统计没有可见影响，但能把重复查询从秒级降到毫秒级。
const projectionCacheTTL = 30 * time.Second

type cachedProjectionEntry struct {
	ctx  *UsageProjectionContext
	seen time.Time
}

var projectionCache = struct {
	mu      sync.Mutex
	entries map[string]cachedProjectionEntry
}{entries: make(map[string]cachedProjectionEntry, 8)}

func projectionCacheKey(query UsageQuery) string {
	return fmt.Sprintf("%d:%d:%s:%s:%s:%d:%t",
		query.FromMS, query.ToMS, query.Provider, query.Model, query.SessionID, query.Limit, query.Scan)
}

func loadProjectionCache(query UsageQuery) (*UsageProjectionContext, bool) {
	projectionCache.mu.Lock()
	defer projectionCache.mu.Unlock()
	entry, ok := projectionCache.entries[projectionCacheKey(query)]
	if !ok || time.Since(entry.seen) > projectionCacheTTL {
		return nil, false
	}
	return entry.ctx, true
}

func storeProjectionCache(query UsageQuery, ctx *UsageProjectionContext) {
	if ctx == nil {
		return
	}
	projectionCache.mu.Lock()
	defer projectionCache.mu.Unlock()
	if len(projectionCache.entries) >= 8 {
		for key := range projectionCache.entries {
			delete(projectionCache.entries, key)
		}
	}
	projectionCache.entries[projectionCacheKey(query)] = cachedProjectionEntry{ctx: ctx, seen: time.Now()}
}

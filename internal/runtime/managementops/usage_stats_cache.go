package managementops

import (
	"context"
)

// ---------- Store-Isolated Data-Revision-Keyed Stats Cache ----------

type statsCacheKey struct {
	StoreID      uint64
	MemEpoch     uint64
	DBEpoch      int64
	RecordsRev   int64
	PromptsRev   int64
	FileStateRev int64
	PricingRev   int64
	FromMS       int64
	ToMS         int64
	Provider     string
	Model        string
	SessionID    string
	Limit        int
}

func makeStatsCacheKey(storeID uint64, rev UsageProjectionRevision, query UsageQuery) statsCacheKey {
	return statsCacheKey{
		StoreID:      storeID,
		MemEpoch:     rev.MemEpoch,
		DBEpoch:      rev.DBEpoch,
		RecordsRev:   rev.RecordsRev,
		PromptsRev:   rev.PromptsRev,
		FileStateRev: rev.FileStateRev,
		PricingRev:   rev.PricingRev,
		FromMS:       query.FromMS,
		ToMS:         query.ToMS,
		Provider:     query.Provider,
		Model:        query.Model,
		SessionID:    query.SessionID,
		Limit:        query.Limit,
	}
}

type statsCacheLRUItem struct {
	key   statsCacheKey
	rev   UsageProjectionRevision
	value UsageStatsSummary
}

func (c *usageProjectionCache) lookupStats(storeID uint64, rev UsageProjectionRevision, query UsageQuery) (UsageStatsSummary, bool) {
	if c == nil || !rev.Cacheable || !rev.TriggerBacked {
		return UsageStatsSummary{}, false
	}
	key := makeStatsCacheKey(storeID, rev, query)
	c.statsMu.Lock()
	defer c.statsMu.Unlock()
	if elem, ok := c.statsEntries[key]; ok {
		c.statsLRU.MoveToFront(elem)
		return elem.Value.(*statsCacheLRUItem).value, true
	}
	return UsageStatsSummary{}, false
}

func (c *usageProjectionCache) putStatsIfFresh(storeID uint64, rev UsageProjectionRevision, query UsageQuery, stats UsageStatsSummary) {
	if c == nil || !rev.Cacheable || !rev.TriggerBacked {
		return
	}
	key := makeStatsCacheKey(storeID, rev, query)

	c.statsMu.Lock()
	defer c.statsMu.Unlock()
	curEpoch := c.memRev.Load()
	if rev.MemEpoch != curEpoch || key.MemEpoch != curEpoch {
		return
	}
	if c.hasStatsRev {
		if rev.DBEpoch < c.latestStatsRev.DBEpoch {
			return
		}
		if rev.DBEpoch == c.latestStatsRev.DBEpoch &&
			(rev.RecordsRev < c.latestStatsRev.RecordsRev ||
				rev.PromptsRev < c.latestStatsRev.PromptsRev ||
				rev.FileStateRev < c.latestStatsRev.FileStateRev ||
				rev.PricingRev < c.latestStatsRev.PricingRev) {
			return
		}
		if rev.DBEpoch != c.latestStatsRev.DBEpoch || !sameDataRevision(rev, c.latestStatsRev) {
			c.latestStatsRev = rev
			for e := c.statsLRU.Back(); e != nil; {
				prev := e.Prev()
				item := e.Value.(*statsCacheLRUItem)
				if item.key.MemEpoch != curEpoch || item.rev.DBEpoch != rev.DBEpoch || !sameDataRevision(item.rev, rev) {
					c.statsLRU.Remove(e)
					delete(c.statsEntries, item.key)
				}
				e = prev
			}
		}
	} else {
		c.hasStatsRev = true
		c.latestStatsRev = rev
	}
	if elem, ok := c.statsEntries[key]; ok {
		item := elem.Value.(*statsCacheLRUItem)
		item.rev = rev
		item.value = stats
		c.statsLRU.MoveToFront(elem)
		return
	}
	capLimit := c.statsCapacity
	if capLimit <= 0 {
		capLimit = maxStatsCacheEntries
	}
	for c.statsLRU.Len() >= capLimit {
		tail := c.statsLRU.Back()
		if tail == nil {
			break
		}
		evicted := c.statsLRU.Remove(tail).(*statsCacheLRUItem)
		delete(c.statsEntries, evicted.key)
	}
	elem := c.statsLRU.PushFront(&statsCacheLRUItem{
		key:   key,
		rev:   rev,
		value: stats,
	})
	c.statsEntries[key] = elem
}

func (s *UsageStore) lookupStatsRevisionCache(ctx context.Context, normalized UsageQuery) (UsageProjectionRevision, bool, UsageStatsSummary, bool, error) {
	if s == nil || s.projCache == nil {
		return UsageProjectionRevision{}, false, UsageStatsSummary{}, false, nil
	}
	rev, err := s.ProjectionRevision(ctx)
	if err != nil {
		return UsageProjectionRevision{}, false, UsageStatsSummary{}, false, err
	}
	if !rev.Cacheable || !rev.TriggerBacked {
		return UsageProjectionRevision{}, false, UsageStatsSummary{}, false, nil
	}
	val, hit := s.projCache.lookupStats(s.cacheStoreID(), rev, normalized)
	return rev, true, val, hit, nil
}

func (s *UsageStore) storeStatsRevisionCacheIfFresh(ctx context.Context, startRev UsageProjectionRevision, hasStartRev bool, normalized UsageQuery, stats UsageStatsSummary) {
	if !hasStartRev || s == nil || s.projCache == nil || !startRev.Cacheable || !startRev.TriggerBacked {
		return
	}
	if ctx != nil && ctx.Err() != nil {
		return
	}
	endRev, err := s.ProjectionRevision(ctx)
	if err != nil || !sameDataRevision(startRev, endRev) {
		return
	}
	s.projCache.putStatsIfFresh(s.cacheStoreID(), startRev, normalized, stats)
}

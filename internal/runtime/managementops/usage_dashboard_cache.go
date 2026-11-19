package managementops

import (
	"container/list"
	"context"
	"sync"
)

// ---------- Per-Manager Revision-Keyed Dashboard Cache ----------

type dashboardCacheKey struct {
	StoreID      uint64
	MemEpoch     uint64
	DBEpoch      int64
	GlobalRev    int64
	RecordsRev   int64
	PromptsRev   int64
	SessionsRev  int64
	FileStateRev int64
	PricingRev   int64
	FromMS       int64
	ToMS         int64
	Provider     string
	Model        string
	SessionID    string
	Limit        int
}

func makeDashboardCacheKey(storeID uint64, rev UsageProjectionRevision, query UsageQuery) dashboardCacheKey {
	return dashboardCacheKey{
		StoreID:      storeID,
		MemEpoch:     rev.MemEpoch,
		DBEpoch:      rev.DBEpoch,
		GlobalRev:    rev.GlobalRev,
		RecordsRev:   rev.RecordsRev,
		PromptsRev:   rev.PromptsRev,
		SessionsRev:  rev.SessionsRev,
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

type cachedDashboardLRUItem struct {
	key         dashboardCacheKey
	rev         UsageProjectionRevision
	payload     UsageDashboardPayload
	totalShards int
}

type dashboardStoreWatermark struct {
	has        bool
	dbEpoch    int64
	triggerRev int64
}

type usageDashboardCache struct {
	mu            sync.Mutex
	capacity      int
	lru           *list.List
	entries       map[dashboardCacheKey]*list.Element
	latestByStore map[uint64]dashboardStoreWatermark
}

func newUsageDashboardCache(capacity int) *usageDashboardCache {
	if capacity <= 0 {
		capacity = defaultDashboardCacheCapacity
	}
	return &usageDashboardCache{
		capacity:      capacity,
		lru:           list.New(),
		entries:       make(map[dashboardCacheKey]*list.Element, capacity),
		latestByStore: make(map[uint64]dashboardStoreWatermark),
	}
}

func (c *usageDashboardCache) lookup(storeID uint64, rev UsageProjectionRevision, query UsageQuery) (UsageDashboardPayload, int, bool) {
	if c == nil || !rev.Cacheable || !rev.TriggerBacked {
		return UsageDashboardPayload{}, 0, false
	}
	key := makeDashboardCacheKey(storeID, rev, query)
	c.mu.Lock()
	defer c.mu.Unlock()
	elem, ok := c.entries[key]
	if !ok {
		return UsageDashboardPayload{}, 0, false
	}
	c.lru.MoveToFront(elem)
	item := elem.Value.(*cachedDashboardLRUItem)
	return cloneDashboardPayload(item.payload), item.totalShards, true
}

func (c *usageDashboardCache) storeIfFresh(
	store *UsageStore,
	startRev UsageProjectionRevision,
	query UsageQuery,
	payload UsageDashboardPayload,
	totalShards int,
) {
	if c == nil || store == nil || !startRev.Cacheable || !startRev.TriggerBacked {
		return
	}
	endRev, err := store.ProjectionRevision(context.Background())
	if err != nil || !endRev.Cacheable || !endRev.TriggerBacked || endRev != startRev {
		return
	}
	storeID := store.cacheStoreID()
	key := makeDashboardCacheKey(storeID, startRev, query)
	cloned := cloneDashboardPayload(payload)

	c.mu.Lock()
	defer c.mu.Unlock()
	if store.currentMemEpoch() != startRev.MemEpoch {
		return
	}
	wm := c.latestByStore[storeID]
	if wm.has {
		if startRev.DBEpoch < wm.dbEpoch {
			return
		}
		if startRev.DBEpoch == wm.dbEpoch && startRev.GlobalRev < wm.triggerRev {
			return
		}
		if startRev.DBEpoch > wm.dbEpoch || startRev.GlobalRev > wm.triggerRev {
			c.latestByStore[storeID] = dashboardStoreWatermark{
				has:        true,
				dbEpoch:    startRev.DBEpoch,
				triggerRev: startRev.GlobalRev,
			}
			c.pruneObsoleteLocked(storeID, startRev.DBEpoch, startRev.GlobalRev, startRev.MemEpoch)
		}
	} else {
		c.latestByStore[storeID] = dashboardStoreWatermark{
			has:        true,
			dbEpoch:    startRev.DBEpoch,
			triggerRev: startRev.GlobalRev,
		}
		c.pruneObsoleteLocked(storeID, startRev.DBEpoch, startRev.GlobalRev, startRev.MemEpoch)
	}
	if elem, ok := c.entries[key]; ok {
		item := elem.Value.(*cachedDashboardLRUItem)
		item.rev = startRev
		item.payload = cloned
		item.totalShards = totalShards
		c.lru.MoveToFront(elem)
		return
	}
	for c.lru.Len() >= c.capacity {
		tail := c.lru.Back()
		if tail == nil {
			break
		}
		evicted := c.lru.Remove(tail).(*cachedDashboardLRUItem)
		delete(c.entries, evicted.key)
	}
	elem := c.lru.PushFront(&cachedDashboardLRUItem{
		key:         key,
		rev:         startRev,
		payload:     cloned,
		totalShards: totalShards,
	})
	c.entries[key] = elem
}

func (c *usageDashboardCache) pruneObsoleteLocked(storeID uint64, dbEpoch, minTriggerRev int64, curEpoch uint64) {
	for e := c.lru.Back(); e != nil; {
		prev := e.Prev()
		item := e.Value.(*cachedDashboardLRUItem)
		if item.key.StoreID == storeID && (item.key.MemEpoch != curEpoch || item.rev.DBEpoch != dbEpoch || item.rev.GlobalRev < minTriggerRev) {
			c.lru.Remove(e)
			delete(c.entries, item.key)
		}
		e = prev
	}
}

func cloneDashboardPayload(src UsageDashboardPayload) UsageDashboardPayload {
	out := src
	if src.Models != nil {
		out.Models = make([]UsageModelItem, len(src.Models))
		for i, m := range src.Models {
			if m.AccountRefs != nil {
				m.AccountRefs = append([]string(nil), m.AccountRefs...)
			}
			out.Models[i] = m
		}
	}
	if src.Sessions != nil {
		out.Sessions = append([]UsageSessionItem(nil), src.Sessions...)
	}
	if src.ModelOptions != nil {
		out.ModelOptions = make([]UsageModelItem, len(src.ModelOptions))
		for i, m := range src.ModelOptions {
			if m.AccountRefs != nil {
				m.AccountRefs = append([]string(nil), m.AccountRefs...)
			}
			out.ModelOptions[i] = m
		}
	}
	if src.Trend.Points != nil {
		out.Trend.Points = append([]UsageTrendPoint(nil), src.Trend.Points...)
	}
	return out
}

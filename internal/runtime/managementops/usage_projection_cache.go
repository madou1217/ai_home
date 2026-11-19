package managementops

import (
	"container/list"
	"context"
	"sync"
	"sync/atomic"
	"time"
)

const (
	defaultProjectionCacheCapacity = 32
	defaultDashboardCacheCapacity  = 32
	revisionInitMinBackoff         = 100 * time.Millisecond
	revisionInitMaxBackoff         = 5 * time.Second
)

var nextUsageStoreID atomic.Uint64

type projectionCacheKey struct {
	MemEpoch     uint64
	DBEpoch      int64
	RecordsRev   int64
	PromptsRev   int64
	FileStateRev int64
	PricingRev   int64
	FromMS       int64
	ToMS         int64
}

func makeProjectionCacheKey(rev UsageProjectionRevision, fromMS, toMS int64) projectionCacheKey {
	return projectionCacheKey{
		MemEpoch:     rev.MemEpoch,
		DBEpoch:      rev.DBEpoch,
		RecordsRev:   rev.RecordsRev,
		PromptsRev:   rev.PromptsRev,
		FileStateRev: rev.FileStateRev,
		PricingRev:   rev.PricingRev,
		FromMS:       fromMS,
		ToMS:         toMS,
	}
}

type projectionLRUItem struct {
	key projectionCacheKey
	rev UsageProjectionRevision
	ctx *UsageProjectionContext
}

type projectionFlight struct {
	done    chan struct{}
	cancel  context.CancelFunc
	waiters int
	val     *UsageProjectionContext
	err     error
}

type usageProjectionCache struct {
	storeID uint64
	memRev  atomic.Uint64

	revInitMu        sync.Mutex
	revInitDone      bool
	revInitInFlight  bool
	revInitDoneCh    chan struct{}
	revInitFailures  int
	revInitNextRetry time.Time

	mu               sync.Mutex
	capacity         int
	lru              *list.List
	entries          map[projectionCacheKey]*list.Element
	inFlight         map[projectionCacheKey]*projectionFlight
	hasLatestRev     bool
	latestDBEpoch    int64
	latestTriggerRev int64

	statsMu        sync.Mutex
	statsCapacity  int
	statsLRU       *list.List
	statsEntries   map[statsCacheKey]*list.Element
	hasStatsRev    bool
	latestStatsRev UsageProjectionRevision

	pricingRefreshMu   sync.Mutex
	pricingInitialized bool
	lastPricingEpoch   int64
	lastPricingRev     int64
}

func newUsageProjectionCache(capacity int) *usageProjectionCache {
	if capacity <= 0 {
		capacity = defaultProjectionCacheCapacity
	}
	c := &usageProjectionCache{
		storeID:       nextUsageStoreID.Add(1),
		capacity:      capacity,
		lru:           list.New(),
		entries:       make(map[projectionCacheKey]*list.Element, capacity),
		inFlight:      make(map[projectionCacheKey]*projectionFlight),
		statsCapacity: maxStatsCacheEntries,
		statsLRU:      list.New(),
		statsEntries:  make(map[statsCacheKey]*list.Element, maxStatsCacheEntries),
	}
	c.memRev.Store(1)
	return c
}

func (c *usageProjectionCache) get(key projectionCacheKey) (*UsageProjectionContext, bool) {
	if c == nil {
		return nil, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	elem, ok := c.entries[key]
	if !ok {
		return nil, false
	}
	c.lru.MoveToFront(elem)
	item := elem.Value.(*projectionLRUItem)
	return cloneImmutableProjectionContext(item.ctx), true
}

func (c *usageProjectionCache) put(key projectionCacheKey, pCtx *UsageProjectionContext, rev UsageProjectionRevision) {
	if c == nil || pCtx == nil || !rev.Cacheable || !rev.TriggerBacked {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.putLocked(key, pCtx, rev)
}

func (c *usageProjectionCache) putLocked(key projectionCacheKey, pCtx *UsageProjectionContext, rev UsageProjectionRevision) {
	if pCtx == nil || !rev.Cacheable || !rev.TriggerBacked {
		return
	}
	curEpoch := c.memRev.Load()
	if rev.MemEpoch != curEpoch || key.MemEpoch != curEpoch {
		return
	}
	if c.hasLatestRev {
		if rev.DBEpoch < c.latestDBEpoch {
			return
		}
		if rev.DBEpoch == c.latestDBEpoch && rev.GlobalRev < c.latestTriggerRev {
			return
		}
		if rev.DBEpoch > c.latestDBEpoch || rev.GlobalRev > c.latestTriggerRev {
			c.latestDBEpoch = rev.DBEpoch
			c.latestTriggerRev = rev.GlobalRev
			c.pruneObsoleteLocked(rev.DBEpoch, rev.GlobalRev, curEpoch)
		}
	} else {
		c.hasLatestRev = true
		c.latestDBEpoch = rev.DBEpoch
		c.latestTriggerRev = rev.GlobalRev
		c.pruneObsoleteLocked(rev.DBEpoch, rev.GlobalRev, curEpoch)
	}
	frozen := cloneImmutableProjectionContext(pCtx)
	if elem, ok := c.entries[key]; ok {
		item := elem.Value.(*projectionLRUItem)
		item.rev = rev
		item.ctx = frozen
		c.lru.MoveToFront(elem)
		return
	}
	for c.lru.Len() >= c.capacity {
		tail := c.lru.Back()
		if tail == nil {
			break
		}
		evicted := c.lru.Remove(tail).(*projectionLRUItem)
		delete(c.entries, evicted.key)
	}
	elem := c.lru.PushFront(&projectionLRUItem{key: key, rev: rev, ctx: frozen})
	c.entries[key] = elem
}

func (c *usageProjectionCache) pruneObsoleteLocked(dbEpoch, minTriggerRev int64, curEpoch uint64) {
	for e := c.lru.Back(); e != nil; {
		prev := e.Prev()
		item := e.Value.(*projectionLRUItem)
		if item.key.MemEpoch != curEpoch || item.rev.DBEpoch != dbEpoch || item.rev.GlobalRev < minTriggerRev {
			c.lru.Remove(e)
			delete(c.entries, item.key)
		}
		e = prev
	}
}

func (c *usageProjectionCache) getOrCompute(
	ctx context.Context,
	key projectionCacheKey,
	compute func(context.Context) (*UsageProjectionContext, UsageProjectionRevision, error),
) (*UsageProjectionContext, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	c.mu.Lock()
	if elem, ok := c.entries[key]; ok {
		c.lru.MoveToFront(elem)
		item := elem.Value.(*projectionLRUItem)
		res := cloneImmutableProjectionContext(item.ctx)
		c.mu.Unlock()
		return res, nil
	}
	flight, exists := c.inFlight[key]
	if !exists {
		flightCtx, cancel := context.WithCancel(context.Background())
		flight = &projectionFlight{
			done:   make(chan struct{}),
			cancel: cancel,
		}
		c.inFlight[key] = flight
		go func(f *projectionFlight, fCtx context.Context, k projectionCacheKey) {
			val, actualRev, err := compute(fCtx)
			c.mu.Lock()
			if cur, ok := c.inFlight[k]; ok && cur == f {
				delete(c.inFlight, k)
			}
			if err == nil && val != nil && actualRev.Cacheable && actualRev.TriggerBacked {
				actualKey := makeProjectionCacheKey(actualRev, k.FromMS, k.ToMS)
				c.putLocked(actualKey, val, actualRev)
			}
			f.val = val
			f.err = err
			close(f.done)
			c.mu.Unlock()
		}(flight, flightCtx, key)
	}
	flight.waiters++
	c.mu.Unlock()

	select {
	case <-flight.done:
		c.mu.Lock()
		flight.waiters--
		val, err := flight.val, flight.err
		c.mu.Unlock()
		if err != nil {
			return nil, err
		}
		return cloneImmutableProjectionContext(val), nil
	case <-ctx.Done():
		c.mu.Lock()
		flight.waiters--
		var cancel context.CancelFunc
		if flight.waiters == 0 {
			if cur, ok := c.inFlight[key]; ok && cur == flight {
				delete(c.inFlight, key)
			}
			cancel = flight.cancel
		}
		c.mu.Unlock()
		if cancel != nil {
			cancel()
		}
		return nil, ctx.Err()
	}
}

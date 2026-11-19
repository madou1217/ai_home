package managementops

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

func (c *usageProjectionCache) tryBeginRevisionInit(ctx context.Context, nowFn func() time.Time) bool {
	if c == nil {
		return false
	}
	if nowFn == nil {
		nowFn = time.Now
	}
	for {
		c.revInitMu.Lock()
		if c.revInitDone {
			c.revInitMu.Unlock()
			return false
		}
		if c.revInitInFlight {
			waitCh := c.revInitDoneCh
			c.revInitMu.Unlock()
			if waitCh == nil {
				return false
			}
			select {
			case <-waitCh:
				continue
			case <-ctx.Done():
				return false
			}
		}
		now := nowFn()
		if !c.revInitNextRetry.IsZero() && now.Before(c.revInitNextRetry) {
			c.revInitMu.Unlock()
			return false
		}
		c.revInitInFlight = true
		c.revInitDoneCh = make(chan struct{})
		c.revInitMu.Unlock()
		return true
	}
}

func (c *usageProjectionCache) finishRevisionInitResult(err error, ctxErr error, now time.Time, repaired bool) {
	if c == nil {
		return
	}
	// If schema triggers/counter were just repaired, invalidate and reseed MemEpoch
	// before unblocking waiters so no pre-gap keys or stale generation snapshots survive.
	if err == nil && repaired {
		c.invalidate()
	}
	c.revInitMu.Lock()
	doneCh := c.revInitDoneCh
	c.revInitDoneCh = nil
	c.revInitInFlight = false
	if err == nil {
		c.revInitDone = true
		c.revInitFailures = 0
		c.revInitNextRetry = time.Time{}
	} else {
		c.revInitDone = false
		if ctxErr == nil && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
			c.revInitFailures++
			shift := c.revInitFailures - 1
			if shift > 6 {
				shift = 6
			}
			backoff := revisionInitMinBackoff << shift
			if backoff > revisionInitMaxBackoff || backoff <= 0 {
				backoff = revisionInitMaxBackoff
			}
			c.revInitNextRetry = now.Add(backoff)
		}
	}
	c.revInitMu.Unlock()
	if doneCh != nil {
		close(doneCh)
	}
}

func (c *usageProjectionCache) onRevisionGapDetected() {
	if c == nil {
		return
	}
	c.revInitMu.Lock()
	wasDone := c.revInitDone
	c.revInitDone = false
	if wasDone {
		c.revInitFailures = 0
		c.revInitNextRetry = time.Time{}
	}
	c.revInitMu.Unlock()
	c.invalidate()
}

func (c *usageProjectionCache) currentMemEpoch() uint64 {
	if c == nil {
		return 0
	}
	return c.memRev.Load()
}

func (c *usageProjectionCache) invalidate() {
	if c == nil {
		return
	}
	c.memRev.Add(1)
	c.mu.Lock()
	c.lru.Init()
	clear(c.entries)
	c.hasLatestRev = false
	c.latestDBEpoch = 0
	c.latestTriggerRev = 0
	c.mu.Unlock()

	c.statsMu.Lock()
	c.statsLRU.Init()
	clear(c.statsEntries)
	c.hasStatsRev = false
	c.latestStatsRev = UsageProjectionRevision{}
	c.statsMu.Unlock()

	c.pricingRefreshMu.Lock()
	c.pricingInitialized = false
	c.lastPricingEpoch = 0
	c.lastPricingRev = 0
	c.pricingRefreshMu.Unlock()
}

func (c *usageProjectionCache) loadPricingForRevision(
	ctx context.Context,
	s *UsageStore,
	conn *sql.Conn,
	rev UsageProjectionRevision,
) (pricingResolverSnapshot, error) {
	if c == nil {
		return s.loadPricingSnapshot(ctx, conn)
	}
	c.pricingRefreshMu.Lock()
	defer c.pricingRefreshMu.Unlock()

	// Fail closed when trigger-backed revision is unavailable so pricing changes
	// are never hidden behind the 3s pricingCustomRefreshWindow TTL.
	stale := !rev.Cacheable ||
		!rev.TriggerBacked ||
		!c.pricingInitialized ||
		c.lastPricingEpoch != rev.DBEpoch ||
		c.lastPricingRev != rev.PricingRev
	if stale {
		s.pricingMu.Lock()
		s.pricingCache = nil
		s.pricingMu.Unlock()
	}
	snap, err := s.loadPricingSnapshot(ctx, conn)
	if err != nil {
		return pricingResolverSnapshot{}, err
	}
	if rev.Cacheable && rev.TriggerBacked {
		c.pricingInitialized = true
		c.lastPricingEpoch = rev.DBEpoch
		c.lastPricingRev = rev.PricingRev
	} else {
		c.pricingInitialized = false
	}
	return snap, nil
}

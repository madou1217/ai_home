package managementops

import (
	"context"
	"database/sql"
)

type rollupPricingSnapshotKey struct {
	db                   *sql.DB
	dbEpoch              int64
	projectionPricingRev int64
	rollupPricingRev     int64
}

// rollupSyncPricingCache belongs only to one serial ensure operation. It never
// escapes to a store, coordinator or goroutine, and has no expiry or TTL.
type rollupSyncPricingCache struct {
	valid        bool
	key          rollupPricingSnapshotKey
	snapshot     pricingResolverSnapshot
	customDigest int64
}

// loadConn verifies both trigger-backed data revisions in the caller's current
// read snapshot before reusing an immutable catalog across bootstrap chunks.
func (c *rollupSyncPricingCache) loadConn(
	ctx context.Context,
	s *UsageStore,
	conn *sql.Conn,
	capReport rollupCapabilityReport,
) (snap pricingResolverSnapshot, digest int64, err error) {
	if ctx == nil {
		ctx = context.Background()
	}
	defer func() {
		if err != nil && c != nil {
			c.valid = false
		}
	}()
	if err = ctx.Err(); err != nil {
		return
	}
	if s == nil || conn == nil {
		return pricingResolverSnapshot{}, 0, ErrUsageUnavailable
	}
	revision, revErr := s.readProjectionRevisionQuerier(ctx, conn)
	if revErr != nil {
		return pricingResolverSnapshot{}, 0, revErr
	}
	cacheable := c != nil && capReport.allReady &&
		capReport.meta.triggersReady && capReport.meta.hasPricingRev &&
		capReport.meta.pricingRev > 0 && revision.Cacheable &&
		revision.TriggerBacked && revision.DBEpoch > 0
	key := rollupPricingSnapshotKey{
		db:                   s.db,
		dbEpoch:              revision.DBEpoch,
		projectionPricingRev: revision.PricingRev,
		rollupPricingRev:     capReport.meta.pricingRev,
	}
	if cacheable && c.valid && c.key == key {
		if err = ctx.Err(); err != nil {
			return
		}
		return c.snapshot, c.customDigest, nil
	}
	if c != nil {
		c.valid = false
	}
	snap, err = loadStrictPricingSnapshotConn(ctx, conn)
	if err != nil {
		return
	}
	if err = ctx.Err(); err != nil {
		return
	}
	digest = computeCustomPricingDigest(snap.customIndex)
	if cacheable {
		c.key = key
		c.snapshot = snap
		c.customDigest = digest
		c.valid = true
	}
	return
}

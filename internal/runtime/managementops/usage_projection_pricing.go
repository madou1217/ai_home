package managementops

import (
	"context"
	"database/sql"
)

// loadPricingSnapshotFreshConn reads custom pricing overrides using the
// database's persistent revision counter when available so pricing mutations in
// another store or process invalidate the in-memory pricing snapshot
// immediately instead of waiting for a wall-clock TTL.
func (s *UsageStore) loadPricingSnapshotFreshConn(ctx context.Context, conn *sql.Conn) (pricingResolverSnapshot, error) {
	if s == nil || s.db == nil {
		return pricingResolverSnapshot{}, nil
	}
	if s.projCache == nil {
		return s.loadPricingSnapshot(ctx, conn)
	}
	var q sqlQuerier = s.db
	if conn != nil {
		q = conn
	}
	rev, revErr := s.readProjectionRevisionQuerier(ctx, q)
	if revErr != nil {
		return s.projCache.loadPricingForRevision(ctx, s, conn, UsageProjectionRevision{})
	}
	return s.projCache.loadPricingForRevision(ctx, s, conn, rev)
}

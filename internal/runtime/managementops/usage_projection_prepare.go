package managementops

import (
	"context"
	"database/sql"
)

func cloneImmutableProjectionContext(src *UsageProjectionContext) *UsageProjectionContext {
	if src == nil {
		return nil
	}
	var forks []forkDescriptor
	if src.ForkDescriptors != nil {
		forks = make([]forkDescriptor, len(src.ForkDescriptors))
		copy(forks, src.ForkDescriptors)
	}
	var attrs []usageAttribution
	if src.Attributions != nil {
		attrs = make([]usageAttribution, len(src.Attributions))
		copy(attrs, src.Attributions)
	}
	return &UsageProjectionContext{
		ForkDescriptors:      forks,
		Attributions:         attrs,
		RecordHighWaterID:    src.RecordHighWaterID,
		PromptHighWaterRowID: src.PromptHighWaterRowID,
	}
}

func (s *UsageStore) cacheStoreID() uint64 {
	if s == nil || s.projCache == nil {
		return 0
	}
	return s.projCache.storeID
}

func (s *UsageStore) currentMemEpoch() uint64 {
	if s == nil || s.projCache == nil {
		return 0
	}
	return s.projCache.currentMemEpoch()
}

// InvalidateProjectionCache clears this store's projection cache and advances its
// in-memory invalidation epoch.
func (s *UsageStore) InvalidateProjectionCache() {
	if s == nil || s.projCache == nil {
		return
	}
	s.projCache.invalidate()
}

func (s *UsageStore) prepareDashboardProjectionCached(ctx context.Context, normalized UsageQuery) (*UsageProjectionContext, error) {
	if s.projCache == nil {
		return s.computeProjectionDirect(ctx, normalized)
	}
	rev, err := s.ProjectionRevision(ctx)
	if err != nil {
		return nil, err
	}
	if !rev.Cacheable || !rev.TriggerBacked {
		// Fail closed: without trigger-backed revision, never serve or store cached projections.
		return s.computeProjectionDirect(ctx, normalized)
	}
	key := makeProjectionCacheKey(rev, normalized.FromMS, normalized.ToMS)
	return s.projCache.getOrCompute(ctx, key, func(flightCtx context.Context) (*UsageProjectionContext, UsageProjectionRevision, error) {
		if err := s.EnsureUsageRollupSynced(flightCtx, normalized); err != nil {
			return nil, UsageProjectionRevision{}, err
		}
		conn, connErr := s.db.Conn(flightCtx)
		if connErr != nil {
			return nil, UsageProjectionRevision{}, connErr
		}
		defer func() { _ = conn.Close() }()
		return s.computeProjectionContextSnapshotConn(flightCtx, conn, normalized)
	})
}

func (s *UsageStore) computeProjectionDirect(ctx context.Context, normalized UsageQuery) (*UsageProjectionContext, error) {
	if err := s.EnsureUsageRollupSynced(ctx, normalized); err != nil {
		return nil, err
	}
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = conn.Close() }()
	pCtx, _, compErr := s.computeProjectionContextSnapshotConn(ctx, conn, normalized)
	return pCtx, compErr
}

func (s *UsageStore) prepareProjectionContextSnapshotConn(ctx context.Context, conn *sql.Conn, normalized UsageQuery) (*UsageProjectionContext, error) {
	if conn == nil {
		return nil, ErrUsageUnavailable
	}
	snap, err := beginProjectionReadSavepoint(ctx, conn)
	if err != nil {
		return nil, err
	}
	defer snap.close()

	rev, err := s.readProjectionRevisionQuerier(ctx, conn)
	if err != nil {
		return nil, err
	}
	var key projectionCacheKey
	if rev.Cacheable && rev.TriggerBacked && s.projCache != nil {
		key = makeProjectionCacheKey(rev, normalized.FromMS, normalized.ToMS)
		if hit, ok := s.projCache.get(key); ok {
			return hit, nil
		}
	}
	pCtx, err := s.buildProjectionContextBodyConn(ctx, conn, normalized)
	if err != nil {
		return nil, err
	}
	if rev.Cacheable && rev.TriggerBacked && s.projCache != nil {
		s.projCache.put(key, pCtx, rev)
	}
	return cloneImmutableProjectionContext(pCtx), nil
}

func (s *UsageStore) computeProjectionContextSnapshotConn(ctx context.Context, conn *sql.Conn, normalized UsageQuery) (*UsageProjectionContext, UsageProjectionRevision, error) {
	if conn == nil {
		return nil, UsageProjectionRevision{}, ErrUsageUnavailable
	}
	snap, err := beginProjectionReadSnapshot(ctx, conn)
	if err != nil {
		return nil, UsageProjectionRevision{}, err
	}
	defer snap.close()

	rev, err := s.readProjectionRevisionQuerier(ctx, conn)
	if err != nil {
		return nil, UsageProjectionRevision{}, err
	}
	pCtx, err := s.buildProjectionContextBodyConn(ctx, conn, normalized)
	if err != nil {
		return nil, UsageProjectionRevision{}, err
	}
	return pCtx, rev, nil
}

func (s *UsageStore) buildProjectionContextBodyConn(ctx context.Context, conn *sql.Conn, query UsageQuery) (*UsageProjectionContext, error) {
	return s.PrepareRollupProjectionContextConn(ctx, conn, query)
}

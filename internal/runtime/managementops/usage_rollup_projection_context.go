package managementops

import (
	"context"
	"database/sql"
	"fmt"
)

// PrepareRollupProjectionContextConn 利用持久化汇总归因快速构造等价的 UsageProjectionContext。
// 供父集成在 prepareProjectionContextConn 中复用，避免 30d 冷查询重复全表扫描构造归因。
func (s *UsageStore) PrepareRollupProjectionContextConn(
	ctx context.Context,
	conn *sql.Conn,
	query UsageQuery,
) (*UsageProjectionContext, error) {
	// 使用 SAVEPOINT 隔离读快照：调用方若已在外部事务（如 D 层外层 snapshot）内则完全保留外层事务，
	// 独立调用时同样享有原子快照与取消安全清理（不留下脏事务）。
	snap, snapErr := beginProjectionReadSavepoint(ctx, conn)
	if snapErr != nil {
		return nil, snapErr
	}
	defer snap.close()

	var recordHW, promptHW sql.NullInt64
	if err := conn.QueryRowContext(ctx, `
		SELECT
			(SELECT COALESCE(MAX(id), 0) FROM model_usage_records),
			(SELECT COALESCE(MAX(rowid), 0) FROM model_usage_prompt_events)`).Scan(&recordHW, &promptHW); err != nil {
		return nil, fmt.Errorf("读取用量高水位线失败: %w", err)
	}
	capReport, capErr := inspectRollupCapabilitiesQueryer(ctx, conn)
	if capErr != nil {
		return nil, capErr
	}
	var forks []forkDescriptor
	var err error
	if capReport.allReady {
		forks, _, err = s.getCachedForkDescriptorsConn(ctx, conn, capReport.meta.forkRev)
	} else {
		forks, err = readForkDescriptorsConn(ctx, conn)
	}
	if err != nil {
		return nil, err
	}
	forksCopy := append([]forkDescriptor(nil), forks...)
	hw := maxInt64(0, recordHW.Int64)
	pHW := maxInt64(0, promptHW.Int64)

	q := normalizeUsageQueryBounds(query)
	attrFrom, attrTo := queryAttributionBounds(q)

	forksByHash := make(map[string]forkDescriptor, len(forksCopy))
	for _, f := range forksCopy {
		forksByHash[f.SourceHash] = f
	}
	pricingSnap, err := loadStrictPricingSnapshotConn(ctx, conn)
	if err != nil {
		return nil, err
	}

	plan, planErr := planRollupReadConn(ctx, conn, q, nil, forksCopy, pricingSnap, 0, 0, &capReport)
	if planErr != nil {
		return nil, planErr
	}

	res, err := s.resolvePartitionedAttributionsConn(ctx, conn, q, plan, hw, forksByHash, pricingSnap)
	if err != nil {
		return nil, err
	}

	buildGlobal := func() (*UsageProjectionContext, error) {
		attrs, gErr := computeAttributionsRangeConn(ctx, conn, attrFrom, attrTo, hw, forksByHash, pricingSnap, s.attribution)
		if gErr != nil {
			return nil, gErr
		}
		sortUsageAttributions(attrs)
		return &UsageProjectionContext{
			ForkDescriptors:      forksCopy,
			Attributions:         attrs,
			RecordHighWaterID:    hw,
			PromptHighWaterRowID: pHW,
		}, nil
	}

	if res.usedGlobalFallback {
		sortUsageAttributions(res.liveAttrs)
		return &UsageProjectionContext{
			ForkDescriptors:      forksCopy,
			Attributions:         res.liveAttrs,
			RecordHighWaterID:    hw,
			PromptHighWaterRowID: pHW,
		}, nil
	}

	persistedAttrs, persistedOK, err := loadValidatedPersistedAttributionsForRangesConn(
		ctx, conn, res.plan.rollupRanges, res.plan.rollupRanges, attrFrom, attrTo, hw,
	)
	if err != nil {
		return nil, err
	}
	if !persistedOK {
		return buildGlobal()
	}

	mergedAttrs, disjointOK := mergeDisjointAttributions(persistedAttrs, res.liveAttrs)
	if !disjointOK {
		return buildGlobal()
	}

	return &UsageProjectionContext{
		ForkDescriptors:      forksCopy,
		Attributions:         mergedAttrs,
		RecordHighWaterID:    hw,
		PromptHighWaterRowID: pHW,
	}, nil
}

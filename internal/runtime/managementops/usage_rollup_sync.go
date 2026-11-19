package managementops

import (
	"context"
	"errors"
	"sort"
)

func isRecoverableRollupSyncErr(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, errRollupCapabilitiesNotReady) || isSQLiteMissingTable(err) {
		return true
	}
	ro, busy := isSQLiteReadOnlyOrBusy(err)
	return ro || busy
}

// ensureRollupSyncedForRange 增量同步 [startHour, endHour) 内的缺失或脏小时。
// 必须在不持有任何 *sql.Conn 时调用，以保持 coord.sem -> s.writeMu -> s.db 严格锁序。
func (s *UsageStore) ensureRollupSyncedForRange(ctx context.Context, startHour, endHour int64) error {
	if s == nil || s.db == nil || endHour <= startHour {
		return nil
	}
	ready, writable, err := s.ensureRollupSchema(ctx)
	if err != nil {
		return err
	}
	if !ready || !writable {
		return nil
	}

	// 无锁快路径：大多数查询命中的窗口已完全同步且无脏小时，直接零锁返回。
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return err
	}
	fastInspect, ok, inspectErr := s.inspectRollupNeedsConn(ctx, conn, startHour, endHour)
	_ = conn.Close()
	if inspectErr != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if isRecoverableRollupSyncErr(inspectErr) {
			return nil
		}
		return inspectErr
	}
	if !ok {
		return nil
	}
	if len(fastInspect.gaps) == 0 && len(fastInspect.dirtyHours) == 0 {
		return nil
	}

	coord := getRollupCoordinator(s)
	if err := coord.acquireSync(ctx); err != nil {
		return err
	}
	defer coord.releaseSync()

	if coord.isReadOnly() {
		return nil
	}

	conn, err = s.db.Conn(ctx)
	if err != nil {
		return err
	}
	inspect, ok, inspectErr := s.inspectRollupNeedsConn(ctx, conn, startHour, endHour)
	_ = conn.Close()
	if inspectErr != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if isRecoverableRollupSyncErr(inspectErr) {
			return nil
		}
		return inspectErr
	}
	if !ok || (len(inspect.gaps) == 0 && len(inspect.dirtyHours) == 0) {
		return nil
	}

	var pricingCache rollupSyncPricingCache
	invalidatedExtSet := make(map[int64]struct{})

	// 1. 补齐未覆盖区间（按实际数据范围裁剪并分块提交，支持中途取消保留已提交进度）。
	for _, gap := range inspect.gaps {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		extHours, err := s.syncUncoveredGap(ctx, gap, &pricingCache)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if isRecoverableRollupSyncErr(err) {
				return nil
			}
			return err
		}
		for _, h := range extHours {
			invalidatedExtSet[h] = struct{}{}
		}
	}

	// 2. 重建已覆盖区间内的脏小时或因分叉/定价变化而失效的小时。
	if len(inspect.dirtyHours) > 0 {
		for _, batch := range groupDirtyHoursIntoBatches(inspect.dirtyHours, rollupAttributedChunkHours, inspect.connectedRight) {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			targetSet := make(map[int64]bool, len(batch))
			for _, h := range batch {
				targetSet[h] = true
			}
			cStart := batch[0]
			cEnd := batch[len(batch)-1] + rollupHourMS
			extHours, err := s.materializeHourRange(ctx, cStart, cEnd, targetSet, false, &pricingCache)
			if err != nil {
				if ctx.Err() != nil {
					return ctx.Err()
				}
				if isRecoverableRollupSyncErr(err) {
					return nil
				}
				return err
			}
			for _, h := range extHours {
				invalidatedExtSet[h] = struct{}{}
			}
		}
	}

	// 3. 若跨小时归因变更使先前已物化的相邻外部小时失效，执行单次有界补建，保证落盘聚合与归因一致。
	if len(invalidatedExtSet) > 0 {
		extList := make([]int64, 0, len(invalidatedExtSet))
		for h := range invalidatedExtSet {
			extList = append(extList, h)
		}
		sort.Slice(extList, func(i, j int) bool { return extList[i] < extList[j] })
		for _, batch := range groupDirtyHoursIntoBatches(extList, rollupAttributedChunkHours, nil) {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			targetSet := make(map[int64]bool, len(batch))
			for _, h := range batch {
				targetSet[h] = true
			}
			cStart := batch[0]
			cEnd := batch[len(batch)-1] + rollupHourMS
			if _, err := s.materializeHourRange(ctx, cStart, cEnd, targetSet, false, &pricingCache); err != nil {
				if ctx.Err() != nil {
					return ctx.Err()
				}
				if isRecoverableRollupSyncErr(err) {
					return nil
				}
				return err
			}
		}
	}
	return nil
}

func groupDirtyHoursIntoBatches(hours []int64, maxSpanHours int64, connectedRight map[int64]bool) [][]int64 {
	if len(hours) == 0 {
		return nil
	}
	maxSpanMS := maxSpanHours * rollupHourMS
	hardCapMS := maxSpanMS * 2
	var batches [][]int64
	cur := []int64{hours[0]}
	for i := 1; i < len(hours); i++ {
		prev := cur[len(cur)-1]
		span := hours[i] - cur[0]
		keepConnected := hours[i] == prev+rollupHourMS && connectedRight[prev] && span < hardCapMS
		if span < maxSpanMS || keepConnected {
			cur = append(cur, hours[i])
		} else {
			batches = append(batches, cur)
			cur = []int64{hours[i]}
		}
	}
	batches = append(batches, cur)
	return batches
}

func (s *UsageStore) syncUncoveredGap(ctx context.Context, gap hourRange, pricingCache *rollupSyncPricingCache) ([]int64, error) {
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return nil, err
	}
	minTS, maxTS, hasData, hasScanner, snapRev, err := probeGapDataBoundsConn(ctx, conn, gap.StartHour, gap.EndHour)
	_ = conn.Close()
	if err != nil {
		return nil, err
	}
	if !hasData {
		return nil, s.commitEmptyCoverage(ctx, gap, snapRev)
	}

	activeStart := hourFloorMS(minTS)
	if activeStart < gap.StartHour {
		activeStart = gap.StartHour
	}
	activeEnd := hourFloorMS(maxTS) + rollupHourMS
	if activeEnd > gap.EndHour {
		activeEnd = gap.EndHour
	}

	if activeStart > gap.StartHour {
		if err := s.commitEmptyCoverage(ctx, hourRange{StartHour: gap.StartHour, EndHour: activeStart}, snapRev); err != nil {
			return nil, err
		}
	}

	chunkHours := rollupStreamingChunkHours
	if hasScanner {
		chunkHours = rollupAttributedChunkHours
	}
	chunkMS := chunkHours * rollupHourMS
	invalidatedExt, err := s.materializeGapChunks(ctx, activeStart, activeEnd, chunkMS)
	if err != nil {
		return invalidatedExt, err
	}

	if activeEnd < gap.EndHour {
		if err := s.commitEmptyCoverage(ctx, hourRange{StartHour: activeEnd, EndHour: gap.EndHour}, snapRev); err != nil {
			return invalidatedExt, err
		}
	}
	return invalidatedExt, nil
}

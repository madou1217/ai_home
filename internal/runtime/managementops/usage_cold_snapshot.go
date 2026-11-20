package managementops

import (
	"context"
	"database/sql"
	"errors"
	"math"
	"runtime"
	"sort"
	"strings"
	"sync"
	"weak"
)

const (
	// coldDashboardMinSpanMS 仅对 >=30 天（含全历史 FromMS=0）且尚无完整有效汇总的冷看板启用无写请求内计算，
	// 保持 today/7d 走原有快路径。
	coldDashboardMinSpanMS int64 = 30 * 24 * rollupHourMS
	coldSnapshotMaxWorkers int   = 8
	sqliteInterruptCode    int   = 9
)

func coldCohortWorkerCount(db *sql.DB) int {
	if db == nil {
		return 0
	}
	maxOpen := db.Stats().MaxOpenConnections
	if maxOpen <= 0 {
		return coldSnapshotMaxWorkers
	}
	if maxOpen <= 1 {
		return 0
	}
	return min(coldSnapshotMaxWorkers, maxOpen-1)
}

var (
	errColdInternalFallback = errors.New("cold_internal_fallback")
	errColdSiblingFailed    = errors.New("cold_sibling_failed")

	coldPoolAdmissionRegistry = struct {
		mu    sync.Mutex
		items map[weak.Pointer[sql.DB]]chan struct{}
	}{
		items: make(map[weak.Pointer[sql.DB]]chan struct{}),
	}
)

func getColdPoolAdmission(db *sql.DB) chan struct{} {
	wp := weak.Make(db)
	coldPoolAdmissionRegistry.mu.Lock()
	if sem, ok := coldPoolAdmissionRegistry.items[wp]; ok {
		coldPoolAdmissionRegistry.mu.Unlock()
		return sem
	}
	sem := make(chan struct{}, 1)
	coldPoolAdmissionRegistry.items[wp] = sem
	coldPoolAdmissionRegistry.mu.Unlock()

	runtime.AddCleanup(db, func(k weak.Pointer[sql.DB]) {
		coldPoolAdmissionRegistry.mu.Lock()
		delete(coldPoolAdmissionRegistry.items, k)
		coldPoolAdmissionRegistry.mu.Unlock()
	}, wp)
	return sem
}

func acquireColdPoolAdmission(ctx context.Context, db *sql.DB) (func(), error) {
	if db == nil {
		return nil, ErrUsageUnavailable
	}
	if ctx != nil && ctx.Err() != nil {
		return nil, ctx.Err()
	}
	sem := getColdPoolAdmission(db)
	if ctx == nil {
		sem <- struct{}{}
	} else {
		select {
		case sem <- struct{}{}:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	var once sync.Once
	return func() {
		once.Do(func() { <-sem })
	}, nil
}

func isInternalWorkerCancelErr(parentCtx, workerCtx context.Context, err error) bool {
	if err == nil || parentCtx.Err() != nil || workerCtx.Err() == nil {
		return false
	}
	cause := context.Cause(workerCtx)
	if cause != errColdInternalFallback && cause != errColdSiblingFailed {
		return false
	}
	if errors.Is(err, context.Canceled) {
		return true
	}
	var sqlErr interface{ Code() int }
	if errors.As(err, &sqlErr) && sqlErr.Code() == sqliteInterruptCode {
		return true
	}
	return strings.Contains(strings.ToLower(err.Error()), "sqlite_interrupt")
}

type coldCohortSlot struct {
	conn         *sql.Conn
	snap         projectionReadSnapshot
	rev          UsageProjectionRevision
	capReport    rollupCapabilityReport
	pricingCache rollupSyncPricingCache
}

type coldSnapshotCohort struct {
	slots        []*coldCohortSlot
	releaseCoord func()
	releasePool  func()
}

func (c *coldSnapshotCohort) close() {
	if c == nil {
		return
	}
	for _, slot := range c.slots {
		if slot == nil {
			continue
		}
		slot.snap.close()
		if slot.conn != nil {
			_ = slot.conn.Close()
		}
	}
	c.slots = nil
	if c.releaseCoord != nil {
		c.releaseCoord()
		c.releaseCoord = nil
	}
	if c.releasePool != nil {
		c.releasePool()
		c.releasePool = nil
	}
}

type coldComputedWindow struct {
	byHour         map[int64]*rollupHourBuild
	sortedHours    []int64
	rollupRanges   []hourRange
	liveRanges     []timeRange
	fullQueryAttrs []usageAttribution
	forks          []forkDescriptor
}

// isColdDashboardTrendSupported 在执行任何计算前校验趋势分桶约束：
// 允许 originMS <= 0（如 FromMS=0 全历史），或整小时对齐，或 bucketMS >= 6h（与持久化路径一致，仅少量跨桶小时按原始时间戳补算趋势）；
// 未对齐且 bucketMS < 6h 的短桶直接返回 false 交由现有路径处理。
func isColdDashboardTrendSupported(firstFull, lastFullEnd, originMS, bucketMS int64) bool {
	if firstFull >= lastFullEnd {
		return false
	}
	if originMS <= 0 || bucketMS <= 0 {
		return true
	}
	if originMS%rollupHourMS == 0 && bucketMS%rollupHourMS == 0 && firstFull >= originMS {
		return true
	}
	return bucketMS >= 6*rollupHourMS && firstFull >= originMS
}

// openColdSnapshotCohort 在不持连接也不持准入信号量前提下先完成轻量能力自检/修复（绝不触发 rollup 持久化写），
// 随后按固定锁序 coldPoolSem(s.db) -> coord.sem(s) 取得可取消准入（等待期间零连接占用，始终为池预留至少 1 条连接），
// 再串行签出 min(8, maxOpen-1)（无上限池取 8）条只读连接并分别钉住 WAL 快照，校验完整 UsageProjectionRevision（含 GlobalRev 与 SessionsRev）
// 及 rollupCapabilityReport.meta 完全一致。任何失败或取消路径均通过 cohort.close 按“先关快照与连接、再精确释放一次信号量”回收。
func (s *UsageStore) openColdSnapshotCohort(ctx context.Context) (*coldSnapshotCohort, bool, error) {
	if s == nil || s.db == nil {
		return nil, false, ErrUsageUnavailable
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	if coldCohortWorkerCount(s.db) <= 0 {
		return nil, false, nil
	}
	s.ensureProjectionRevisionSchemaOnce(ctx)
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	ready, _, err := s.ensureRollupSchema(ctx)
	if err != nil || !ready {
		return nil, false, err
	}

	releasePool, err := acquireColdPoolAdmission(ctx, s.db)
	if err != nil {
		return nil, false, err
	}
	if err := ctx.Err(); err != nil {
		releasePool()
		return nil, false, err
	}
	coord := getRollupCoordinator(s)
	if err := coord.acquireSync(ctx); err != nil {
		releasePool()
		return nil, false, err
	}
	workerCount := coldCohortWorkerCount(s.db)
	if workerCount <= 0 {
		coord.releaseSync()
		releasePool()
		return nil, false, nil
	}
	var releaseCoordOnce sync.Once
	cohort := &coldSnapshotCohort{
		slots:        make([]*coldCohortSlot, 0, workerCount),
		releaseCoord: func() { releaseCoordOnce.Do(coord.releaseSync) },
		releasePool:  releasePool,
	}
	for i := 0; i < workerCount; i++ {
		if err := ctx.Err(); err != nil {
			cohort.close()
			return nil, false, err
		}
		conn, connErr := s.db.Conn(ctx)
		if connErr != nil {
			cohort.close()
			return nil, false, connErr
		}
		snap, snapErr := beginProjectionReadSnapshot(ctx, conn)
		if snapErr != nil {
			_ = conn.Close()
			cohort.close()
			return nil, false, snapErr
		}
		slot := &coldCohortSlot{conn: conn, snap: snap}
		cohort.slots = append(cohort.slots, slot)

		rev, revErr := s.readProjectionRevisionQuerier(ctx, conn)
		if revErr != nil {
			cohort.close()
			return nil, false, revErr
		}
		if !rev.Cacheable || !rev.TriggerBacked || rev.DBEpoch <= 0 {
			cohort.close()
			return nil, false, nil
		}
		capReport, capErr := inspectRollupCapabilitiesQueryer(ctx, conn)
		if capErr != nil {
			cohort.close()
			return nil, false, capErr
		}
		if !capReport.allReady {
			cohort.close()
			return nil, false, nil
		}
		slot.rev = rev
		slot.capReport = capReport
		if i > 0 && (slot.rev != cohort.slots[0].rev || slot.capReport.meta != cohort.slots[0].capReport.meta) {
			cohort.close()
			return nil, false, nil
		}
	}
	return cohort, true, nil
}

// needsColdComputeConn 在已钉住的队列只读快照内判断是否尚无完整有效覆盖。
// 若未覆盖小时与失效小时合计不足一个 24h 分块，返回 false 以直接命中增量同步+持久化汇总快路径。
func needsColdComputeConn(ctx context.Context, conn *sql.Conn, firstFull, lastFullEnd int64, capReport rollupCapabilityReport, forkDigest, customPricingDigest int64) (bool, error) {
	covered, err := readCoverageRangesConn(ctx, conn, firstFull, lastFullEnd)
	if err != nil {
		return false, err
	}
	var missingHours int64
	for _, g := range findUncoveredHourRanges(firstFull, lastFullEnd, covered) {
		missingHours += (g.EndHour - g.StartHour) / rollupHourMS
		if missingHours >= rollupAttributedChunkHours {
			return true, nil
		}
	}
	var invalidCount int64
	if err := conn.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM (
			SELECT hour_ms FROM model_usage_rollup_dirty_hours
			WHERE hour_ms >= ? AND hour_ms < ?
			UNION
			SELECT hour_ms FROM model_usage_rollup_hours
			WHERE hour_ms >= ? AND hour_ms < ?
				AND (fork_digest != ? OR (attr_count > 0 AND (pricing_rev != ? OR pricing_custom_digest != ?)))
		)`,
		firstFull, lastFullEnd, firstFull, lastFullEnd, forkDigest, capReport.meta.pricingRev, customPricingDigest,
	).Scan(&invalidCount); err != nil {
		return false, err
	}
	return missingHours+invalidCount >= rollupAttributedChunkHours, nil
}

// probeColdActiveBoundsConn 在调用方已持有的只读快照连接上探测 [startHour, endHour) 的真实数据边界，
// 避免 FromMS=0 时遍历 1970~2026 的大量空小时。
func probeColdActiveBoundsConn(
	ctx context.Context,
	conn *sql.Conn,
	startHour, endHour int64,
) (minTS, maxTS int64, hasData, hasScanner bool, err error) {
	if endHour <= startHour {
		return 0, 0, false, false, nil
	}
	endInclusive := endHour - 1
	var rMin, rMax, pMin, pMax sql.NullInt64
	if err = conn.QueryRowContext(ctx, `
		SELECT
			(SELECT timestamp_ms FROM model_usage_records WHERE timestamp_ms BETWEEN ? AND ? ORDER BY timestamp_ms ASC LIMIT 1),
			(SELECT timestamp_ms FROM model_usage_records WHERE timestamp_ms BETWEEN ? AND ? ORDER BY timestamp_ms DESC LIMIT 1),
			(SELECT timestamp_ms FROM model_usage_prompt_events WHERE timestamp_ms BETWEEN ? AND ? ORDER BY timestamp_ms ASC LIMIT 1),
			(SELECT timestamp_ms FROM model_usage_prompt_events WHERE timestamp_ms BETWEEN ? AND ? ORDER BY timestamp_ms DESC LIMIT 1)`,
		startHour, endInclusive, startHour, endInclusive,
		startHour, endInclusive, startHour, endInclusive,
	).Scan(&rMin, &rMax, &pMin, &pMax); err != nil {
		return 0, 0, false, false, err
	}
	if rMin.Valid {
		hasData, minTS, maxTS = true, rMin.Int64, rMax.Int64
	}
	if pMin.Valid {
		if !hasData || pMin.Int64 < minTS {
			minTS = pMin.Int64
		}
		if !hasData || pMax.Int64 > maxTS {
			maxTS = pMax.Int64
		}
		hasData = true
	}
	if !hasData {
		return 0, 0, false, false, nil
	}
	padFrom := maxInt64(0, startHour-scannerAfterProxyWindowMS)
	padTo := endInclusive + scannerAfterProxyWindowMS
	if padTo < endInclusive {
		padTo = math.MaxInt64
	}
	var scanFlag int
	scanErr := conn.QueryRowContext(ctx, `
		SELECT 1 FROM model_usage_records INDEXED BY idx_model_usage_timestamp
		WHERE timestamp_ms BETWEEN ? AND ? AND source_kind IN ('session_jsonl', 'session_json') AND model != ''
		LIMIT 1`, padFrom, padTo).Scan(&scanFlag)
	if scanErr == nil {
		hasScanner = true
	} else if scanErr != sql.ErrNoRows {
		return 0, 0, false, false, scanErr
	}
	return minTS, maxTS, true, hasScanner, nil
}

// scanColdChunksParallel 使用同版本队列的只读连接并行调用 scanRollupHourRangeConn，
// 在返回前强制 join 全部 worker；使用 WithCancelCause 显式区分内部回退取消、兄弟错误取消与独立 SQL 错误：
// 优先尊重父 ctx 取消，保留真实独立 SQL 错误，对 unclosedHours / capability-not-ready 及其引发的兄弟内部取消返回 (nil, false, nil)。
func (s *UsageStore) scanColdChunksParallel(
	ctx context.Context,
	cohort *coldSnapshotCohort,
	activeStart, activeEnd, chunkMS int64,
) (map[int64]*rollupHourBuild, bool, error) {
	byHour := make(map[int64]*rollupHourBuild)
	if activeEnd <= activeStart || chunkMS <= 0 {
		return byHour, true, nil
	}
	var spans []hourRange
	for h := activeStart; h < activeEnd; h += chunkMS {
		next := h + chunkMS
		if next < h || next > activeEnd {
			next = activeEnd
		}
		spans = append(spans, hourRange{StartHour: h, EndHour: next})
	}
	workerCount := min(len(cohort.slots), len(spans))
	workerCtx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)

	tasks := make(chan hourRange, len(spans))
	for _, sp := range spans {
		tasks <- sp
	}
	close(tasks)

	outs := make([]rollupScanResult, 0, len(spans))
	var outMu sync.Mutex
	var firstRealErr error
	var sawFallback bool
	var wg sync.WaitGroup
	for w := 0; w < workerCount; w++ {
		slot := cohort.slots[w]
		wg.Add(1)
		go func() {
			defer wg.Done()
			var (
				inputs      rollupScanInputs
				inputsReady bool
				scratch     rollupScanScratch
			)
			for sp := range tasks {
				if workerCtx.Err() != nil {
					return
				}
				var (
					res rollupScanResult
					err error
				)
				if !inputsReady {
					inputs, err = s.prepareRollupScanInputsConn(workerCtx, slot.conn, slot.capReport, &slot.pricingCache)
					if err == nil {
						inputsReady = true
					}
				}
				if err == nil {
					res, err = s.scanRollupHourRangeWithInputsConn(workerCtx, slot.conn, sp.StartHour, sp.EndHour, nil, inputs, &scratch)
				}
				if err != nil {
					if errors.Is(err, errRollupCapabilitiesNotReady) {
						outMu.Lock()
						sawFallback = true
						outMu.Unlock()
						cancel(errColdInternalFallback)
						return
					}
					if isInternalWorkerCancelErr(ctx, workerCtx, err) {
						return
					}
					outMu.Lock()
					if firstRealErr == nil {
						firstRealErr = err
					}
					outMu.Unlock()
					cancel(errColdSiblingFailed)
					return
				}
				if len(res.unclosedHours) > 0 {
					outMu.Lock()
					sawFallback = true
					outMu.Unlock()
					cancel(errColdInternalFallback)
					return
				}
				outMu.Lock()
				outs = append(outs, res)
				outMu.Unlock()
			}
		}()
	}
	wg.Wait()

	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	if firstRealErr != nil {
		return nil, false, firstRealErr
	}
	if sawFallback || len(outs) != len(spans) {
		return nil, false, nil
	}
	for _, res := range outs {
		for h, hb := range res.byHour {
			if _, dup := byHour[h]; dup {
				return nil, false, nil
			}
			byHour[h] = hb
		}
	}
	return byHour, true, nil
}

func precheckColdBoundaryOverflow(rollupRanges []hourRange, liveRanges []timeRange, matByHour map[int64]rollupHourMetaRow) bool {
	if len(liveRanges) == 0 {
		return false
	}
	curRollup := append([]hourRange(nil), rollupRanges...)
	curLive := append([]timeRange(nil), liveRanges...)
	absorbed := 0
	for {
		toAbsorb := make(map[int64]bool)
		for _, lr := range curLive {
			if lr.FromMS >= rollupHourMS && lr.FromMS%rollupHourMS == 0 {
				if leftH := lr.FromMS - rollupHourMS; isHourInRanges(leftH, curRollup) && matByHour[leftH].hasRightBoundaryAttr {
					toAbsorb[leftH] = true
				}
			}
			if lr.ToMS < math.MaxInt64 && (lr.ToMS+1)%rollupHourMS == 0 {
				if rightH := lr.ToMS + 1; isHourInRanges(rightH, curRollup) && matByHour[rightH].hasLeftBoundaryAttr {
					toAbsorb[rightH] = true
				}
			}
		}
		if len(toAbsorb) == 0 {
			return false
		}
		var removed []hourRange
		curRollup, removed = subtractHoursFromRanges(curRollup, toAbsorb)
		for _, rem := range removed {
			curLive = append(curLive, timeRange{FromMS: rem.StartHour, ToMS: rem.EndHour - 1})
		}
		curLive = mergeTimeRanges(curLive)
		absorbed += len(removed)
		if len(curRollup) == 0 || absorbed > maxPartitionBoundaryExpandHours {
			return true
		}
	}
}

func collectValidatedColdRollupAttrs(
	byHour map[int64]*rollupHourBuild,
	sortedHours []int64,
	rollupRanges []hourRange,
	attrFrom, attrTo int64,
) ([]usageAttribution, bool) {
	byScanner := make(map[int64]usageAttribution)
	byProxy := make(map[int64]int64)
	for _, rr := range rollupRanges {
		idx := sort.Search(len(sortedHours), func(i int) bool { return sortedHours[i] >= rr.StartHour })
		for i := idx; i < len(sortedHours) && sortedHours[i] < rr.EndHour; i++ {
			for _, a := range byHour[sortedHours[i]].attrs {
				if a.ScannerTimestampMS < attrFrom || a.ScannerTimestampMS > attrTo ||
					a.ProxyTimestampMS < attrFrom || a.ProxyTimestampMS > attrTo ||
					!isHourInRanges(hourFloorMS(a.ScannerTimestampMS), rollupRanges) ||
					!isHourInRanges(hourFloorMS(a.ProxyTimestampMS), rollupRanges) {
					return nil, false
				}
				if prev, dupS := byScanner[a.ScannerID]; dupS {
					if prev.ProxyID != a.ProxyID || prev.ScannerTimestampMS != a.ScannerTimestampMS ||
						prev.ProxyTimestampMS != a.ProxyTimestampMS || prev.Model != a.Model ||
						prev.AccountProvider != a.AccountProvider || prev.AccountRef != a.AccountRef ||
						math.Float64bits(prev.CostUSD) != math.Float64bits(a.CostUSD) {
						return nil, false
					}
					continue
				}
				if prevScanner, dupP := byProxy[a.ProxyID]; dupP && prevScanner != a.ScannerID {
					return nil, false
				}
				byScanner[a.ScannerID] = a
				byProxy[a.ProxyID] = a.ScannerID
			}
		}
	}
	out := make([]usageAttribution, 0, len(byScanner))
	for _, a := range byScanner {
		out = append(out, a)
	}
	return out, true
}

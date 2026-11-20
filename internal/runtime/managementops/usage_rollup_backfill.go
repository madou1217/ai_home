package managementops

import (
	"context"
	"database/sql"
	"sync"
	"time"
)

const (
	// rollupBackfillTotalBudget 限制一次历史回填的最长占用；只影响后台预热，不影响请求。
	rollupBackfillTotalBudget = 10 * time.Minute
	// rollupOnDemandBudget 限制单个按需窗口的后台物化时长。
	rollupOnDemandBudget = 5 * time.Minute
	// rollupBackfillPaceDelay 让出调度，避免回填块连续占满写锁与磁盘。
	rollupBackfillPaceDelay = 20 * time.Millisecond
	// rollupBackfillStartDelay 等服务完成启动后再开始后台回填，避免与启动装配争抢 IO。
	rollupBackfillStartDelay = 2 * time.Second
	// rollupBackfillMaxConsecutiveErrs 连续失败达到上限即停止，避免库已关闭时空转。
	rollupBackfillMaxConsecutiveErrs = 3
)

// rollupBackfillCoordinator 让历史回填与按需物化共享同一去重/单飞状态。
// 真正的写串行化由 rollupCoordinator 的 sem 保证，这里只避免重复排队。
type rollupBackfillCoordinator struct {
	once    sync.Once
	mu      sync.Mutex
	pending map[hourRange]struct{}
	running bool
	closed  bool
}

// StartRollupBackfill 启动一次后台历史汇总回填：从最新完整小时向最旧数据按
// rollupStreamingChunkHours 分块调用既有 ensureRollupSyncedForRange，使长窗查询
// 之后直接命中持久 rollup，而不是每次重扫原始记录。
//
// 该方法幂等（Once）、非阻塞；ctx 仅控制后台任务生命周期。
func (s *UsageStore) StartRollupBackfill(ctx context.Context) {
	if s == nil || s.db == nil {
		return
	}
	if ctx == nil {
		ctx = context.Background()
	}
	s.backfill.once.Do(func() {
		runCtx, cancel := context.WithTimeout(ctx, rollupBackfillTotalBudget)
		go func() {
			defer cancel()
			s.runRollupBackfill(runCtx)
		}()
	})
}

func (s *UsageStore) runRollupBackfill(ctx context.Context) {
	ready, writable, err := s.ensureRollupSchema(ctx)
	if err != nil || !ready || !writable {
		return
	}
	minHour, maxHour, ok, err := s.readRollupBackfillBounds(ctx)
	if err != nil || !ok {
		return
	}
	select {
	case <-ctx.Done():
		return
	case <-time.After(rollupBackfillStartDelay):
	}
	consecutiveErrs := 0
	for end := maxHour; end > minHour; {
		if ctx.Err() != nil || s.backfillStopped() {
			return
		}
		start := maxInt64(minHour, end-rollupStreamingChunkHours*rollupHourMS)
		if syncErr := s.ensureRollupSyncedForRange(ctx, start, end); syncErr != nil {
			if ctx.Err() != nil {
				return
			}
			consecutiveErrs++
			if consecutiveErrs >= rollupBackfillMaxConsecutiveErrs {
				return
			}
		} else {
			consecutiveErrs = 0
		}
		end = start
		select {
		case <-ctx.Done():
			return
		case <-time.After(rollupBackfillPaceDelay):
		}
	}
}

// readRollupBackfillBounds 以原始记录与提示词事件的实际范围裁剪回填边界，
// 避免 FromMS=0 场景遍历 1970 年起的空小时。
func (s *UsageStore) readRollupBackfillBounds(ctx context.Context) (int64, int64, bool, error) {
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return 0, 0, false, err
	}
	defer func() { _ = conn.Close() }()

	var minTS, maxTS, pMin, pMax sql.NullInt64
	if err := conn.QueryRowContext(ctx, `
		SELECT
			(SELECT MIN(timestamp_ms) FROM model_usage_records),
			(SELECT MAX(timestamp_ms) FROM model_usage_records),
			(SELECT MIN(timestamp_ms) FROM model_usage_prompt_events),
			(SELECT MAX(timestamp_ms) FROM model_usage_prompt_events)`).Scan(&minTS, &maxTS, &pMin, &pMax); err != nil {
		if isSQLiteMissingTable(err) {
			return 0, 0, false, nil
		}
		return 0, 0, false, err
	}
	if pMin.Valid && (!minTS.Valid || pMin.Int64 < minTS.Int64) {
		minTS = pMin
	}
	if pMax.Valid && (!maxTS.Valid || pMax.Int64 > maxTS.Int64) {
		maxTS = pMax
	}
	if !minTS.Valid || !maxTS.Valid || maxTS.Int64 < minTS.Int64 {
		return 0, 0, false, nil
	}
	startHour := hourFloorMS(minTS.Int64)
	endHour := hourFloorMS(maxTS.Int64) + rollupHourMS
	if endHour <= startHour {
		return 0, 0, false, nil
	}
	return startHour, endHour, true, nil
}

// scheduleRollupMaterialization 在冷查询完成后把该窗口排队为后台 rollup 物化，
// 使同一长窗的后续请求走持久汇总。同一范围去重；单次只物化一个分块上限，
// 更早的缺口由历史回填负责补齐。
func (s *UsageStore) scheduleRollupMaterialization(startHour, endHour int64) {
	if s == nil || s.db == nil || endHour <= startHour {
		return
	}
	if maxSpan := rollupStreamingChunkHours * rollupHourMS; endHour-startHour > maxSpan {
		endHour = startHour + maxSpan
	}
	r := hourRange{StartHour: startHour, EndHour: endHour}

	c := &s.backfill
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	if c.pending == nil {
		c.pending = make(map[hourRange]struct{})
	}
	c.pending[r] = struct{}{}
	if c.running {
		c.mu.Unlock()
		return
	}
	c.running = true
	c.mu.Unlock()

	go s.runRollupMaterializationWorker()
}

func (s *UsageStore) runRollupMaterializationWorker() {
	c := &s.backfill
	for {
		c.mu.Lock()
		var next hourRange
		found := false
		for r := range c.pending {
			next = r
			delete(c.pending, r)
			found = true
			break
		}
		if !found {
			c.running = false
			c.mu.Unlock()
			return
		}
		c.mu.Unlock()

		ctx, cancel := context.WithTimeout(context.Background(), rollupOnDemandBudget)
		_ = s.ensureRollupSyncedForRange(ctx, next.StartHour, next.EndHour)
		cancel()
	}
}

// stopRollupBackground 在释放数据库连接前终止后台回填/物化排队。
func (s *UsageStore) stopRollupBackground() {
	if s == nil {
		return
	}
	s.backfill.mu.Lock()
	s.backfill.closed = true
	s.backfill.pending = nil
	s.backfill.mu.Unlock()
}

func (s *UsageStore) backfillStopped() bool {
	s.backfill.mu.Lock()
	defer s.backfill.mu.Unlock()
	return s.backfill.closed
}

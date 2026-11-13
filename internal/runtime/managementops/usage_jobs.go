package managementops

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
)

const (
	maxUsageJobs            = 20
	maxDashboardShards      = 16
	dashboardShardDayMS     = int64(86400000)
	dashboardShardWorkers   = 4
	watcherChannelBuffer    = 32
)

type jsonSSEHub struct {
	mu          sync.Mutex
	subscribers map[*watchSubscriber]struct{}
}

func newJSONSSEHub() *jsonSSEHub {
	return &jsonSSEHub{
		subscribers: make(map[*watchSubscriber]struct{}),
	}
}

func (h *jsonSSEHub) subscribe(ctx context.Context, initialPayloads []any) (<-chan []byte, func()) {
	sub := newWatchSubscriber()
	var initial [][]byte
	for _, p := range initialPayloads {
		if raw, err := json.Marshal(p); err == nil {
			initial = append(initial, raw)
		}
	}

	h.mu.Lock()
	h.subscribers[sub] = struct{}{}
	h.mu.Unlock()

	for _, raw := range initial {
		select {
		case <-sub.done:
		case sub.events <- raw:
		default:
		}
	}

	var once sync.Once
	cancel := func() {
		once.Do(func() {
			h.mu.Lock()
			delete(h.subscribers, sub)
			h.mu.Unlock()
			sub.close()
		})
	}
	if ctx != nil {
		go func() {
			<-ctx.Done()
			cancel()
		}()
	}
	return sub.events, cancel
}

func (h *jsonSSEHub) broadcast(payload any) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return
	}
	h.mu.Lock()
	subs := make([]*watchSubscriber, 0, len(h.subscribers))
	for sub := range h.subscribers {
		subs = append(subs, sub)
	}
	h.mu.Unlock()

	for _, sub := range subs {
		select {
		case <-sub.done:
			continue
		case sub.events <- raw:
		default:
			// 消费慢的订阅者仅丢弃最旧一条待投递帧，避免阻塞持锁线程。
			select {
			case <-sub.events:
			default:
			}
			select {
			case <-sub.done:
			case sub.events <- raw:
			default:
			}
		}
	}
}

type managedDashboardQueryJob struct {
	job    UsageDashboardQueryJob
	cancel context.CancelFunc
}

// UsageJobManager 管理异步本地会话扫描作业与渐进式看板查询作业，并提供 SSE 订阅分发。
type UsageJobManager struct {
	service *ManagementService

	scanMu      sync.Mutex
	scanSeq     atomic.Int64
	scanJobs    map[string]*UsageScanJob
	scanOrder   []string
	scanHub     *jsonSSEHub

	queryMu    sync.Mutex
	querySeq   atomic.Int64
	queryJobs  map[string]*managedDashboardQueryJob
	queryOrder []string
	queryHub   *jsonSSEHub
}

// NewUsageJobManager 创建关联到 ManagementService 的用量异步作业管理器。
func NewUsageJobManager(service *ManagementService) *UsageJobManager {
	return &UsageJobManager{
		service:   service,
		scanJobs:  make(map[string]*UsageScanJob),
		scanHub:   newJSONSSEHub(),
		queryJobs: make(map[string]*managedDashboardQueryJob),
		queryHub:  newJSONSSEHub(),
	}
}

// ---------- 本地会话扫描作业 ----------

// ScanSync 执行一次同步本地会话扫描并返回标准 `usage.scan` 结果。
func (m *UsageJobManager) ScanSync(ctx context.Context, provider string) (UsageScanResult, error) {
	if m == nil || m.service == nil || m.service.usageStore == nil {
		return UsageScanResult{}, ErrUsageUnavailable
	}
	var providersFilter []string
	if norm := strings.ToLower(strings.TrimSpace(provider)); norm != "" {
		providersFilter = []string{norm}
	}
	return ScanModelUsageSources(ctx, ScanUsageOptions{
		AIHomeDir:    m.service.AIHomeDir(),
		HostHomeDir:  m.service.HostHomeDir(),
		Store:        m.service.usageStore,
		AccountStore: m.service.store,
		Catalog:      m.service.catalog,
		Providers:    providersFilter,
		ProviderIDs:  m.service.ProviderIDs(),
		Now:          m.service.now,
	})
}

// StartScanJob 启动（或复用正在进行的同 provider）异步本地用量扫描作业。
func (m *UsageJobManager) StartScanJob(ctx context.Context, provider string) (UsageScanStartResult, error) {
	if m == nil || m.service == nil || m.service.usageStore == nil {
		return UsageScanStartResult{}, ErrUsageUnavailable
	}
	normProv := strings.ToLower(strings.TrimSpace(provider))

	m.scanMu.Lock()
	for _, id := range m.scanOrder {
		if j := m.scanJobs[id]; j != nil && (j.Status == "queued" || j.Status == "running") && j.Provider == normProv {
			snap := cloneScanJob(*j)
			m.scanMu.Unlock()
			return UsageScanStartResult{
				Accepted:       false,
				AlreadyRunning: true,
				Job:            snap,
			}, nil
		}
	}

	seq := m.scanSeq.Add(1)
	nowMS := m.service.now().UnixMilli()
	jobID := fmt.Sprintf("usage-scan-%d-%d", nowMS, seq)
	job := &UsageScanJob{
		ID:       jobID,
		Status:   "queued",
		Provider: normProv,
	}
	m.scanJobs[jobID] = job
	m.scanOrder = append(m.scanOrder, jobID)
	snap := cloneScanJob(*job)
	m.scanMu.Unlock()

	m.broadcastScanJob(snap)
	go m.runScanJob(jobID)

	_ = ctx
	return UsageScanStartResult{
		Accepted:       true,
		AlreadyRunning: false,
		Job:            snap,
	}, nil
}

func (m *UsageJobManager) runScanJob(jobID string) {
	m.scanMu.Lock()
	job := m.scanJobs[jobID]
	if job == nil {
		m.scanMu.Unlock()
		return
	}
	job.Status = "running"
	job.StartedAt = m.service.now().UnixMilli()
	prov := job.Provider
	snap := cloneScanJob(*job)
	m.scanMu.Unlock()

	m.broadcastScanJob(snap)

	res, err := m.ScanSync(context.Background(), prov)

	m.scanMu.Lock()
	if job = m.scanJobs[jobID]; job != nil {
		if err != nil {
			job.Status = "failed"
			job.Error = err.Error()
		} else {
			resCopy := res
			job.Result = &resCopy
			job.Status = "succeeded"
		}
		job.FinishedAt = m.service.now().UnixMilli()
		snap = cloneScanJob(*job)
		m.trimScanJobsLocked()
	}
	m.scanMu.Unlock()

	m.broadcastScanJob(snap)
}

func (m *UsageJobManager) trimScanJobsLocked() {
	if len(m.scanOrder) <= maxUsageJobs {
		return
	}
	type candidate struct {
		id  string
		ts  int64
	}
	var finished []candidate
	for _, id := range m.scanOrder {
		j := m.scanJobs[id]
		if j == nil || j.Status == "queued" || j.Status == "running" {
			continue
		}
		ts := j.FinishedAt
		if ts == 0 {
			ts = j.StartedAt
		}
		finished = append(finished, candidate{id: id, ts: ts})
	}
	sort.Slice(finished, func(i, j int) bool { return finished[i].ts < finished[j].ts })
	excess := len(m.scanOrder) - maxUsageJobs
	if excess > len(finished) {
		excess = len(finished)
	}
	toDelete := make(map[string]struct{}, excess)
	for i := 0; i < excess; i++ {
		toDelete[finished[i].id] = struct{}{}
		delete(m.scanJobs, finished[i].id)
	}
	kept := make([]string, 0, len(m.scanOrder)-len(toDelete))
	for _, id := range m.scanOrder {
		if _, gone := toDelete[id]; !gone {
			kept = append(kept, id)
		}
	}
	m.scanOrder = kept
}

func (m *UsageJobManager) broadcastScanJob(job UsageScanJob) {
	m.scanHub.broadcast(map[string]any{
		"type": "usage-scan-job",
		"job":  job,
	})
}

// ScanSnapshot 返回当前所有保留的扫描作业快照。
func (m *UsageJobManager) ScanSnapshot() []UsageScanJob {
	if m == nil {
		return nil
	}
	m.scanMu.Lock()
	defer m.scanMu.Unlock()
	out := make([]UsageScanJob, 0, len(m.scanOrder))
	for _, id := range m.scanOrder {
		if j := m.scanJobs[id]; j != nil {
			out = append(out, cloneScanJob(*j))
		}
	}
	return out
}

// SubscribeScan 订阅扫描作业 SSE 事件（首帧即推送 connected 与 usage-scan-snapshot）。
func (m *UsageJobManager) SubscribeScan(ctx context.Context) (<-chan []byte, func()) {
	if m == nil {
		ch := make(chan []byte)
		close(ch)
		return ch, func() {}
	}
	snapshot := m.ScanSnapshot()
	if snapshot == nil {
		snapshot = []UsageScanJob{}
	}
	return m.scanHub.subscribe(ctx, []any{
		map[string]any{"type": "connected"},
		map[string]any{"type": "usage-scan-snapshot", "jobs": snapshot},
	})
}

func cloneScanJob(j UsageScanJob) UsageScanJob {
	if j.Result != nil {
		resCopy := *j.Result
		resCopy.RequestedProviders = append([]string(nil), j.Result.RequestedProviders...)
		resCopy.Attempts = append([]UsageScanAttempt(nil), j.Result.Attempts...)
		resCopy.Warnings = append([]UsageScanWarning(nil), j.Result.Warnings...)
		if j.Result.Providers != nil {
			pm := make(map[string]UsageScanProviderResult, len(j.Result.Providers))
			for k, v := range j.Result.Providers {
				pm[k] = v
			}
			resCopy.Providers = pm
		}
		j.Result = &resCopy
	}
	return j
}

// ---------- 渐进式看板查询作业 ----------

// StartDashboardQuery 启动一个支持进度推送与取消的渐进式用量看板查询作业。
func (m *UsageJobManager) StartDashboardQuery(ctx context.Context, query UsageQuery) (UsageDashboardQueryJob, error) {
	_ = ctx
	if m == nil || m.service == nil || m.service.usageStore == nil {
		return UsageDashboardQueryJob{}, ErrUsageUnavailable
	}
	normQ := normalizeUsageQueryBounds(query)
	seq := m.querySeq.Add(1)
	nowMS := m.service.now().UnixMilli()
	jobID := fmt.Sprintf("usage-dashboard-query-%d-%d", nowMS, seq)
	jobCtx, cancel := context.WithCancel(context.Background())

	entry := &managedDashboardQueryJob{
		cancel: cancel,
		job: UsageDashboardQueryJob{
			ID:     jobID,
			Status: "queued",
			Query:  normQ,
		},
	}

	m.queryMu.Lock()
	m.queryJobs[jobID] = entry
	m.queryOrder = append(m.queryOrder, jobID)
	snap := cloneDashboardQueryJob(entry.job)
	m.queryMu.Unlock()

	m.broadcastDashboardQueryJob(snap)
	go m.runDashboardQueryJob(jobCtx, jobID, normQ)
	return snap, nil
}

// GetDashboardQuery 查询单个渐进看板查询作业快照。
func (m *UsageJobManager) GetDashboardQuery(jobID string) (UsageDashboardQueryJob, bool) {
	if m == nil {
		return UsageDashboardQueryJob{}, false
	}
	m.queryMu.Lock()
	defer m.queryMu.Unlock()
	entry := m.queryJobs[strings.TrimSpace(jobID)]
	if entry == nil {
		return UsageDashboardQueryJob{}, false
	}
	return cloneDashboardQueryJob(entry.job), true
}

// CancelDashboardQuery 取消指定的渐进看板查询作业。
func (m *UsageJobManager) CancelDashboardQuery(jobID string) (UsageDashboardCancelResult, bool) {
	if m == nil {
		return UsageDashboardCancelResult{}, false
	}
	id := strings.TrimSpace(jobID)
	m.queryMu.Lock()
	entry := m.queryJobs[id]
	if entry == nil {
		m.queryMu.Unlock()
		return UsageDashboardCancelResult{}, false
	}
	active := entry.job.Status == "queued" || entry.job.Status == "preparing" || entry.job.Status == "running"
	if !active {
		snap := cloneDashboardQueryJob(entry.job)
		m.queryMu.Unlock()
		return UsageDashboardCancelResult{Cancelled: false, Job: snap}, true
	}
	entry.job.Status = "cancelled"
	entry.job.FinishedAt = m.service.now().UnixMilli()
	cancelFn := entry.cancel
	snap := cloneDashboardQueryJob(entry.job)
	m.trimQueryJobsLocked()
	m.queryMu.Unlock()

	if cancelFn != nil {
		cancelFn()
	}
	m.broadcastDashboardQueryJob(snap)
	return UsageDashboardCancelResult{Cancelled: true, Job: snap}, true
}

// DashboardQuerySnapshot 返回当前所有保留的看板查询作业快照。
func (m *UsageJobManager) DashboardQuerySnapshot() []UsageDashboardQueryJob {
	if m == nil {
		return nil
	}
	m.queryMu.Lock()
	defer m.queryMu.Unlock()
	out := make([]UsageDashboardQueryJob, 0, len(m.queryOrder))
	for _, id := range m.queryOrder {
		if entry := m.queryJobs[id]; entry != nil {
			out = append(out, cloneDashboardQueryJob(entry.job))
		}
	}
	return out
}

// SubscribeDashboardQuery 订阅渐进看板查询 SSE 事件。
func (m *UsageJobManager) SubscribeDashboardQuery(ctx context.Context) (<-chan []byte, func()) {
	if m == nil {
		ch := make(chan []byte)
		close(ch)
		return ch, func() {}
	}
	snapshot := m.DashboardQuerySnapshot()
	if snapshot == nil {
		snapshot = []UsageDashboardQueryJob{}
	}
	return m.queryHub.subscribe(ctx, []any{
		map[string]any{"type": "connected"},
		map[string]any{"type": "usage-dashboard-query-snapshot", "jobs": snapshot},
	})
}

func (m *UsageJobManager) broadcastDashboardQueryJob(job UsageDashboardQueryJob) {
	m.queryHub.broadcast(map[string]any{
		"type": "usage-dashboard-query-job",
		"job":  job,
	})
}

func (m *UsageJobManager) trimQueryJobsLocked() {
	if len(m.queryOrder) <= maxUsageJobs {
		return
	}
	type candidate struct {
		id string
		ts int64
	}
	var finished []candidate
	for _, id := range m.queryOrder {
		entry := m.queryJobs[id]
		if entry == nil {
			continue
		}
		st := entry.job.Status
		if st == "queued" || st == "preparing" || st == "running" {
			continue
		}
		ts := entry.job.FinishedAt
		if ts == 0 {
			ts = entry.job.StartedAt
		}
		finished = append(finished, candidate{id: id, ts: ts})
	}
	sort.Slice(finished, func(i, j int) bool { return finished[i].ts < finished[j].ts })
	excess := len(m.queryOrder) - maxUsageJobs
	if excess > len(finished) {
		excess = len(finished)
	}
	toDelete := make(map[string]struct{}, excess)
	for i := 0; i < excess; i++ {
		toDelete[finished[i].id] = struct{}{}
		delete(m.queryJobs, finished[i].id)
	}
	kept := make([]string, 0, len(m.queryOrder)-len(toDelete))
	for _, id := range m.queryOrder {
		if _, gone := toDelete[id]; !gone {
			kept = append(kept, id)
		}
	}
	m.queryOrder = kept
}

func (m *UsageJobManager) runDashboardQueryJob(jobCtx context.Context, jobID string, normQ UsageQuery) {
	m.queryMu.Lock()
	entry := m.queryJobs[jobID]
	if entry == nil || entry.job.Status == "cancelled" {
		m.queryMu.Unlock()
		return
	}
	entry.job.Status = "preparing"
	entry.job.StartedAt = m.service.now().UnixMilli()
	snap := cloneDashboardQueryJob(entry.job)
	m.queryMu.Unlock()

	m.broadcastDashboardQueryJob(snap)

	store := m.service.usageStore
	prebuilt, err := store.PrepareDashboardProjection(jobCtx, normQ)
	if err != nil {
		m.finishDashboardQueryFailed(jobCtx, jobID, err)
		return
	}
	if jobCtx.Err() != nil {
		return
	}

	shards := splitDashboardShardsReverseChronological(normQ, m.service.now().UnixMilli())
	totalShards := len(shards)
	originMS, bucketMS, _, _ := ResolveUsageTrend(normQ.FromMS, normQ.ToMS, 0, 0)
	acc := newDashboardProgressiveAccumulator(normQ, originMS, bucketMS)

	type shardResult struct {
		idx   int
		shard UsageDashboardShard
		err   error
	}
	workers := totalShards
	if workers > dashboardShardWorkers {
		workers = dashboardShardWorkers
	}
	if workers < 1 {
		workers = 1
	}

	tasks := make(chan int, totalShards)
	for i := 0; i < totalShards; i++ {
		tasks <- i
	}
	close(tasks)

	results := make(chan shardResult, totalShards)
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for idx := range tasks {
				if jobCtx.Err() != nil {
					return
				}
				sh, shErr := store.QueryDashboardShard(jobCtx, shards[idx], bucketMS, originMS, prebuilt)
				results <- shardResult{idx: idx, shard: sh, err: shErr}
			}
		}()
	}
	go func() {
		wg.Wait()
		close(results)
	}()

	completed := 0
	for res := range results {
		if jobCtx.Err() != nil {
			return
		}
		if res.err != nil {
			m.finishDashboardQueryFailed(jobCtx, jobID, res.err)
			return
		}
		acc.mergeShard(res.shard)
		completed++
		dashSnap := acc.snapshot()

		m.queryMu.Lock()
		entry = m.queryJobs[jobID]
		if entry == nil || entry.job.Status == "cancelled" {
			m.queryMu.Unlock()
			return
		}
		entry.job.Status = "running"
		entry.job.CompletedShards = completed
		entry.job.TotalShards = totalShards
		entry.job.Dashboard = &dashSnap
		snap = cloneDashboardQueryJob(entry.job)
		m.queryMu.Unlock()

		m.broadcastDashboardQueryJob(snap)
	}

	if jobCtx.Err() != nil {
		return
	}
	finalDash := acc.snapshot()
	m.queryMu.Lock()
	entry = m.queryJobs[jobID]
	if entry == nil || entry.job.Status == "cancelled" {
		m.queryMu.Unlock()
		return
	}
	entry.job.Status = "succeeded"
	if entry.job.CompletedShards < totalShards {
		entry.job.CompletedShards = totalShards
	}
	entry.job.TotalShards = totalShards
	entry.job.Dashboard = &finalDash
	entry.job.FinishedAt = m.service.now().UnixMilli()
	snap = cloneDashboardQueryJob(entry.job)
	m.trimQueryJobsLocked()
	m.queryMu.Unlock()

	m.broadcastDashboardQueryJob(snap)
}

func (m *UsageJobManager) finishDashboardQueryFailed(jobCtx context.Context, jobID string, err error) {
	if jobCtx.Err() != nil {
		return
	}
	m.queryMu.Lock()
	entry := m.queryJobs[jobID]
	if entry == nil || entry.job.Status == "cancelled" {
		m.queryMu.Unlock()
		return
	}
	entry.job.Status = "failed"
	entry.job.Error = err.Error()
	entry.job.FinishedAt = m.service.now().UnixMilli()
	snap := cloneDashboardQueryJob(entry.job)
	m.trimQueryJobsLocked()
	m.queryMu.Unlock()

	m.broadcastDashboardQueryJob(snap)
}

func splitDashboardShardsReverseChronological(query UsageQuery, nowMS int64) []UsageQuery {
	fromMS := query.FromMS
	toMS := query.ToMS
	if fromMS <= 0 || toMS <= 0 || toMS < fromMS {
		return []UsageQuery{query}
	}
	effectiveTo := toMS
	if nowMS > 0 && nowMS < effectiveTo && fromMS <= nowMS {
		effectiveTo = nowMS
	}
	span := effectiveTo - fromMS + 1
	if span <= dashboardShardDayMS {
		q := query
		q.FromMS = fromMS
		q.ToMS = toMS
		return []UsageQuery{q}
	}

	numDays := int((span + dashboardShardDayMS - 1) / dashboardShardDayMS)
	shardCount := numDays
	if shardCount > maxDashboardShards {
		shardCount = maxDashboardShards
	}
	if shardCount < 1 {
		shardCount = 1
	}

	type window struct {
		from int64
		to   int64
	}
	windows := make([]window, 0, shardCount)
	cursorEnd := toMS
	// 按逆时间序切分，把最靠近当前的天放在前面优先返回。
	daysPerShard := (numDays + shardCount - 1) / shardCount
	stepMS := int64(daysPerShard) * dashboardShardDayMS
	for cursorEnd >= fromMS {
		wStart := cursorEnd - stepMS + 1
		if wStart < fromMS {
			wStart = fromMS
		}
		if len(windows) == shardCount-1 {
			wStart = fromMS
		}
		windows = append(windows, window{from: wStart, to: cursorEnd})
		if wStart <= fromMS {
			break
		}
		cursorEnd = wStart - 1
	}

	out := make([]UsageQuery, 0, len(windows))
	for _, w := range windows {
		sq := query
		sq.FromMS = w.from
		sq.ToMS = w.to
		out = append(out, sq)
	}
	return out
}

type dashboardProgressiveAccumulator struct {
	query        UsageQuery
	stats        UsageStatsSummary
	models       map[string]*modelBucketAcc
	modelOptions map[string]*modelBucketAcc
	sessions     map[string]*sessionPartAcc
	trendFromMS  int64
	trendToMS    int64
	trendBucket  int64
	trendPoints  map[int64]*UsageTrendPoint
	trendStarts  []int64
}

type modelBucketAcc struct {
	item        UsageModelItem
	accountRefs map[string]struct{}
}

type sessionPartAcc struct {
	part        UsageSessionPart
	accountRefs map[string]struct{}
}

func newDashboardProgressiveAccumulator(q UsageQuery, originMS, bucketMS int64) *dashboardProgressiveAccumulator {
	_, _, clampedFrom, clampedTo := ResolveUsageTrend(q.FromMS, q.ToMS, bucketMS, originMS)
	starts := listTrendBucketStarts(clampedFrom, clampedTo, originMS, bucketMS)
	pts := make(map[int64]*UsageTrendPoint, len(starts))
	for _, st := range starts {
		pts[st] = &UsageTrendPoint{BucketStartMS: st}
	}
	return &dashboardProgressiveAccumulator{
		query:        q,
		models:       make(map[string]*modelBucketAcc),
		modelOptions: make(map[string]*modelBucketAcc),
		sessions:     make(map[string]*sessionPartAcc),
		trendFromMS:  clampedFrom,
		trendToMS:    clampedTo,
		trendBucket:  bucketMS,
		trendPoints:  pts,
		trendStarts:  starts,
	}
}

func (a *dashboardProgressiveAccumulator) mergeShard(shard UsageDashboardShard) {
	a.stats.TotalCalls += shard.Stats.TotalCalls
	a.stats.TotalPrompts += shard.Stats.TotalPrompts
	a.stats.InputTokens += shard.Stats.InputTokens
	a.stats.OutputTokens += shard.Stats.OutputTokens
	a.stats.CacheReadInputTokens += shard.Stats.CacheReadInputTokens
	a.stats.CacheCreationInputTokens += shard.Stats.CacheCreationInputTokens
	a.stats.ReasoningOutputTokens += shard.Stats.ReasoningOutputTokens
	a.stats.TotalTokens += shard.Stats.TotalTokens
	a.stats.TotalCostUSD = NormalizeUsageCostUSD(a.stats.TotalCostUSD + shard.Stats.TotalCostUSD)

	mergeModelSliceInto(a.models, shard.Models)
	mergeModelSliceInto(a.modelOptions, shard.ModelOptions)

	for _, part := range shard.SessionParts {
		key := part.Provider + "\x00" + part.SessionID
		acc := a.sessions[key]
		if acc == nil {
			acc = &sessionPartAcc{
				part:        UsageSessionPart{Provider: part.Provider, SessionID: part.SessionID},
				accountRefs: make(map[string]struct{}),
			}
			a.sessions[key] = acc
		}
		p := &acc.part
		p.UsageProject = firstNonEmpty(p.UsageProject, part.UsageProject)
		p.SessionProject = firstNonEmpty(p.SessionProject, part.SessionProject)
		p.UsageCWD = firstNonEmpty(p.UsageCWD, part.UsageCWD)
		p.SessionCWD = firstNonEmpty(p.SessionCWD, part.SessionCWD)
		p.UsageGitBranch = firstNonEmpty(p.UsageGitBranch, part.UsageGitBranch)
		p.SessionGitBranch = firstNonEmpty(p.SessionGitBranch, part.SessionGitBranch)
		p.SessionStartedAtMS = minPosInt64(p.SessionStartedAtMS, part.SessionStartedAtMS)
		p.UsageStartedAtMS = minPosInt64(p.UsageStartedAtMS, part.UsageStartedAtMS)
		if part.SessionUpdatedAtMS > p.SessionUpdatedAtMS {
			p.SessionUpdatedAtMS = part.SessionUpdatedAtMS
		}
		if part.UsageUpdatedAtMS > p.UsageUpdatedAtMS {
			p.UsageUpdatedAtMS = part.UsageUpdatedAtMS
		}
		p.PromptCount += part.PromptCount
		p.Calls += part.Calls
		p.InputTokens += part.InputTokens
		p.OutputTokens += part.OutputTokens
		p.CacheReadInputTokens += part.CacheReadInputTokens
		p.CacheCreationInputTokens += part.CacheCreationInputTokens
		p.ReasoningOutputTokens += part.ReasoningOutputTokens
		p.TotalTokens += part.TotalTokens
		p.CostUSD += part.CostUSD
		p.UnattributedCalls += part.UnattributedCalls
		for _, ref := range part.AccountRefs {
			if ref != "" {
				acc.accountRefs[ref] = struct{}{}
			}
		}
	}

	for _, tp := range shard.Trend.Points {
		target := a.trendPoints[tp.BucketStartMS]
		if target == nil {
			cp := tp
			a.trendPoints[tp.BucketStartMS] = &cp
			a.trendStarts = append(a.trendStarts, tp.BucketStartMS)
			sort.Slice(a.trendStarts, func(i, j int) bool { return a.trendStarts[i] < a.trendStarts[j] })
			continue
		}
		target.Calls += tp.Calls
		target.InputTokens += tp.InputTokens
		target.OutputTokens += tp.OutputTokens
		target.CacheReadInputTokens += tp.CacheReadInputTokens
		target.CacheCreationInputTokens += tp.CacheCreationInputTokens
		target.ReasoningOutputTokens += tp.ReasoningOutputTokens
		target.TotalTokens += tp.TotalTokens
		target.CostUSD = NormalizeUsageCostUSD(target.CostUSD + tp.CostUSD)
	}
}

func mergeModelSliceInto(dst map[string]*modelBucketAcc, items []UsageModelItem) {
	for _, it := range items {
		key := it.Provider + "\x00" + it.Model
		acc := dst[key]
		if acc == nil {
			acc = &modelBucketAcc{
				item:        UsageModelItem{Provider: it.Provider, Model: it.Model},
				accountRefs: make(map[string]struct{}),
			}
			dst[key] = acc
		}
		acc.item.Calls += it.Calls
		acc.item.InputTokens += it.InputTokens
		acc.item.OutputTokens += it.OutputTokens
		acc.item.CacheReadInputTokens += it.CacheReadInputTokens
		acc.item.CacheCreationInputTokens += it.CacheCreationInputTokens
		acc.item.ReasoningOutputTokens += it.ReasoningOutputTokens
		acc.item.TotalTokens += it.TotalTokens
		acc.item.CostUSD = NormalizeUsageCostUSD(acc.item.CostUSD + it.CostUSD)
		acc.item.UnattributedCalls += it.UnattributedCalls
		for _, ref := range it.AccountRefs {
			if ref != "" {
				acc.accountRefs[ref] = struct{}{}
			}
		}
	}
}

func minPosInt64(a, b int64) int64 {
	if a <= 0 {
		return b
	}
	if b <= 0 {
		return a
	}
	if a < b {
		return a
	}
	return b
}

func materializeModelMap(src map[string]*modelBucketAcc) []UsageModelItem {
	out := make([]UsageModelItem, 0, len(src))
	for _, acc := range src {
		item := acc.item
		item.AccountCount = len(acc.accountRefs)
		item.AccountRefs = nil
		item.CacheHitRate = CalculateCacheHitRate(item.InputTokens, item.CacheReadInputTokens, item.CacheCreationInputTokens)
		out = append(out, item)
	}
	sortUsageModels(out)
	return out
}

func (a *dashboardProgressiveAccumulator) snapshot() UsageDashboardPayload {
	stats := a.stats
	stats.TotalSessions = len(a.sessions)

	models := materializeModelMap(a.models)
	modelOpts := materializeModelMap(a.modelOptions)

	sessions := make([]UsageSessionItem, 0, len(a.sessions))
	for _, acc := range a.sessions {
		p := acc.part
		if len(acc.accountRefs) > 0 {
			p.AccountRefs = make([]string, 0, len(acc.accountRefs))
			for ref := range acc.accountRefs {
				p.AccountRefs = append(p.AccountRefs, ref)
			}
		}
		sessions = append(sessions, materializeSessionFromPart(p))
	}
	sort.Slice(sessions, func(i, j int) bool {
		if sessions[i].UpdatedAtMS != sessions[j].UpdatedAtMS {
			return sessions[i].UpdatedAtMS > sessions[j].UpdatedAtMS
		}
		if sessions[i].Calls != sessions[j].Calls {
			return sessions[i].Calls > sessions[j].Calls
		}
		return sessions[i].SessionID < sessions[j].SessionID
	})
	limit := a.query.Limit
	if limit <= 0 {
		limit = DefaultUsageQueryLimit
	}
	if len(sessions) > limit {
		sessions = sessions[:limit]
	}

	trendPts := make([]UsageTrendPoint, 0, len(a.trendStarts))
	for _, st := range a.trendStarts {
		pt := *a.trendPoints[st]
		pt.CacheHitRate = CalculateCacheHitRate(pt.InputTokens, pt.CacheReadInputTokens, pt.CacheCreationInputTokens)
		trendPts = append(trendPts, pt)
	}

	return UsageDashboardPayload{
		Stats:        stats,
		Models:       models,
		Sessions:     sessions,
		ModelOptions: modelOpts,
		Trend: UsageTrend{
			FromMS:   a.trendFromMS,
			ToMS:     a.trendToMS,
			BucketMS: a.trendBucket,
			Points:   trendPts,
		},
	}
}

func cloneDashboardQueryJob(j UsageDashboardQueryJob) UsageDashboardQueryJob {
	if j.Dashboard != nil {
		d := *j.Dashboard
		d.Models = append([]UsageModelItem(nil), j.Dashboard.Models...)
		d.Sessions = append([]UsageSessionItem(nil), j.Dashboard.Sessions...)
		d.ModelOptions = append([]UsageModelItem(nil), j.Dashboard.ModelOptions...)
		d.Trend.Points = append([]UsageTrendPoint(nil), j.Dashboard.Trend.Points...)
		j.Dashboard = &d
	}
	return j
}

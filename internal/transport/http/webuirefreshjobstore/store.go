// Package webuirefreshjobstore 维护账号刷新作业的内存表。
//
// 契约与 Node 的 accountRefreshJobs 对齐：
//
//	POST /v1/management/webui/accounts/{provider}/{accountRef}/refresh
//	POST /v1/management/webui/accounts/{provider}/{accountRef}/refresh-usage
//	GET  /v1/management/webui/accounts/refresh-jobs/{jobId}
//
// Start 立即返回 queued 快照，Run 在独立 goroutine 里执行；同一
// (provider, accountRef, scope) 的活动作业复用，避免重复打上游。作业表最多保留
// MaxJobs 条，终态作业超过 Retention 后被清理。
//
// 快照 JSON 与 Node 的 serializeAccountRefreshJob 逐字段一致：finishedAt 未完成时
// 是 null，failedBranches/recovered 仅在非空时出现，branches 由 scope=account 的
// Run 结果提供。
package webuirefreshjobstore

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	// JobsPath 是刷新作业查询前缀。
	JobsPath = "/v1/management/webui/accounts/refresh-jobs"
	// JobPath 是单个作业的查询路由模板。
	JobPath = JobsPath + "/{jobId}"

	// 作业状态与 Node 的 accountRefreshJobs 同值。
	StatusQueued    = "queued"
	StatusRunning   = "running"
	StatusSucceeded = "succeeded"
	StatusFailed    = "failed"

	// ScopeAccount 是账号级刷新（带 branches 明细）。
	ScopeAccount = "account"
	// ScopeUsage 是额度刷新；缺省 scope 按 Node 口径视为 usage。
	ScopeUsage = "usage"

	// defaultMaxJobs / defaultRetention 与 Node 的 ACCOUNT_REFRESH_JOB_MAX /
	// ACCOUNT_REFRESH_JOB_RETENTION_MS 同值。
	defaultMaxJobs   = 200
	defaultRetention = 10 * time.Minute

	// maxErrorRunes 与 Node 的 slice(0, 500) 对齐，避免把上游长报文整段带回界面。
	maxErrorRunes = 500
)

// errRunNotConfigured 表示 StartRequest 没有带执行体；作业直接失败而不是空转。
var errRunNotConfigured = errors.New("refresh_run_not_configured")

// Branch 是作业里单段的状态，字段名与 Node 的 serializeAccountRefreshJob 一致。
type Branch struct {
	Status string `json:"status"`
	Error  string `json:"error"`
}

// Snapshot 是作业快照，形状对齐 Node 的 serializeAccountRefreshJob。
//
// FinishedAt 用指针：Node 在未完成时输出 null，用 0 会变成「1970 年已完成」。
// Branches 只由 scope=account 的执行结果填充，usage 作业保持 nil 时 JSON 不含该字段。
type Snapshot struct {
	ID             string            `json:"id"`
	Provider       string            `json:"provider"`
	AccountRef     string            `json:"accountRef"`
	Status         string            `json:"status"`
	CreatedAt      int64             `json:"createdAt"`
	UpdatedAt      int64             `json:"updatedAt"`
	FinishedAt     *int64            `json:"finishedAt"`
	Error          string            `json:"error"`
	FailedBranches []string          `json:"failedBranches,omitempty"`
	Scope          string            `json:"scope"`
	Branches       map[string]Branch `json:"branches,omitempty"`
	Recovered      bool              `json:"recovered,omitempty"`
}

// Options 是作业表的可调参数；零值字段使用默认值。
type Options struct {
	// MaxJobs 是作业表上限；0 表示 200。
	MaxJobs int
	// Retention 是终态作业的保留时长；0 表示 10 分钟。
	Retention time.Duration
	// Now 是时钟；nil 表示 time.Now。
	Now func() time.Time
	// NewID 生成作业 ID；nil 表示与 Node 同前缀的默认生成器。
	NewID func(provider, accountRef string) string
}

// RunFunc 是一次刷新的执行体。ctx 已用 context.WithoutCancel 包过，客户端断开
// 不会中止已经开始的探测。
type RunFunc func(ctx context.Context) (Snapshot, error)

// StartRequest 描述一次作业启动请求。
type StartRequest struct {
	Provider   string
	AccountRef string
	Scope      string
	Run        RunFunc
}

// Store 是并发安全的作业表。零值 Store 可直接使用（按默认参数懒初始化），
// 正常入口仍是 New。
type Store struct {
	mu        sync.Mutex
	jobs      map[string]*Snapshot
	maxJobs   int
	retention time.Duration
	now       func() time.Time
	newID     func(provider, accountRef string) string
}

// New 创建作业表；Options 的零值字段使用默认值。
func New(options Options) *Store {
	store := &Store{
		jobs:      make(map[string]*Snapshot),
		maxJobs:   options.MaxJobs,
		retention: options.Retention,
		now:       options.Now,
		newID:     options.NewID,
	}
	store.applyDefaults()
	return store
}

// applyDefaults 补齐零值字段。调用方要么持有 store.mu，要么在发布前独占调用（New）。
func (store *Store) applyDefaults() {
	if store.jobs == nil {
		store.jobs = make(map[string]*Snapshot)
	}
	if store.maxJobs <= 0 {
		store.maxJobs = defaultMaxJobs
	}
	if store.retention <= 0 {
		store.retention = defaultRetention
	}
	if store.now == nil {
		store.now = time.Now
	}
	if store.newID == nil {
		store.newID = defaultNewID
	}
}

// Start 登记并启动一次刷新，立即返回 queued 快照，不等待 Run 完成。
//
// 同一 (provider, accountRef, scope) 已有 queued/running 作业时直接复用并返回
// alreadyRunning=true；provider 与 accountRef 的归一化口径与 Node 一致
// （provider 去空格转小写，accountRef 去空格），scope 缺省为 usage。
func (store *Store) Start(ctx context.Context, request StartRequest) (Snapshot, bool) {
	if store == nil {
		return Snapshot{}, false
	}
	if ctx == nil {
		ctx = context.Background()
	}

	store.mu.Lock()
	store.applyDefaults()
	now := store.now()
	store.pruneLocked(now)

	provider := normalizeProvider(request.Provider)
	accountRef := strings.TrimSpace(request.AccountRef)
	scope := normalizeScope(request.Scope)

	if active := store.findActiveLocked(provider, accountRef, scope); active != nil {
		snapshot := cloneSnapshot(*active)
		store.mu.Unlock()
		return snapshot, true
	}

	nowMS := now.UnixMilli()
	snapshot := &Snapshot{
		ID:         store.nextIDLocked(provider, accountRef),
		Provider:   provider,
		AccountRef: accountRef,
		Status:     StatusQueued,
		CreatedAt:  nowMS,
		UpdatedAt:  nowMS,
		Scope:      scope,
	}
	store.jobs[snapshot.ID] = snapshot
	// 插入后再收紧一次上限：新作业是活动状态不会被删，超限时淘汰最旧的终态作业。
	store.pruneLocked(now)
	jobID := snapshot.ID
	queued := cloneSnapshot(*snapshot)
	store.mu.Unlock()

	// Run 必须脱离请求上下文：客户端断开不能中止已经开始的刷新。
	go store.run(context.WithoutCancel(ctx), jobID, request.Run)
	return queued, false
}

// Get 按 ID 返回作业副本；不存在时返回 false。调用方修改返回值不会影响表内状态。
func (store *Store) Get(jobID string) (Snapshot, bool) {
	if store == nil {
		return Snapshot{}, false
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.jobs == nil {
		return Snapshot{}, false
	}
	snapshot, exists := store.jobs[strings.TrimSpace(jobID)]
	if !exists {
		return Snapshot{}, false
	}
	return cloneSnapshot(*snapshot), true
}

// Len 返回当前作业条数（含活动作业）。
func (store *Store) Len() int {
	if store == nil {
		return 0
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	return len(store.jobs)
}

// run 在独立 goroutine 里推进作业：先标 running，执行 Run，再把终态合并回表。
func (store *Store) run(ctx context.Context, jobID string, run RunFunc) {
	store.mu.Lock()
	snapshot, exists := store.jobs[jobID]
	if !exists {
		store.mu.Unlock()
		return
	}
	snapshot.Status = StatusRunning
	snapshot.UpdatedAt = store.now().UnixMilli()
	store.mu.Unlock()

	result, err := invokeRun(ctx, run)

	store.mu.Lock()
	defer store.mu.Unlock()
	snapshot, exists = store.jobs[jobID]
	if !exists {
		return
	}
	// Run 的结果只补执行面字段；身份、CreatedAt、Scope 始终以 Start 时为准。
	snapshot.Branches = cloneBranches(result.Branches)
	snapshot.FailedBranches = cloneStrings(result.FailedBranches)
	snapshot.Recovered = result.Recovered
	nowMS := store.now().UnixMilli()
	snapshot.UpdatedAt = nowMS

	if err != nil {
		snapshot.Status = StatusFailed
		snapshot.Error = truncateRunes(err.Error(), maxErrorRunes)
		snapshot.FinishedAt = int64Pointer(nowMS)
		return
	}

	snapshot.Status = terminalStatus(result.Status)
	snapshot.Error = result.Error
	finishedAt := nowMS
	if result.FinishedAt != nil && *result.FinishedAt > 0 {
		finishedAt = *result.FinishedAt
	}
	snapshot.FinishedAt = int64Pointer(finishedAt)
}

// invokeRun 执行 Run 并把 panic 收敛成错误，避免后台 goroutine 崩掉整个进程。
func invokeRun(ctx context.Context, run RunFunc) (snapshot Snapshot, err error) {
	if run == nil {
		return Snapshot{}, errRunNotConfigured
	}
	defer func() {
		if recovered := recover(); recovered != nil {
			snapshot = Snapshot{}
			err = fmt.Errorf("refresh_panic: %v", recovered)
		}
	}()
	return run(ctx)
}

// terminalStatus 把 Run 返回的状态收敛成终态：空值与非终态（queued/running）
// 都按 succeeded 收尾，避免作业永远停在活动状态。
func terminalStatus(status string) string {
	trimmed := strings.TrimSpace(status)
	switch trimmed {
	case "", StatusQueued, StatusRunning:
		return StatusSucceeded
	default:
		return trimmed
	}
}

// findActiveLocked 查找同一刷新目标的活动作业；调用方必须持有 store.mu。
func (store *Store) findActiveLocked(provider string, accountRef string, scope string) *Snapshot {
	for _, snapshot := range store.jobs {
		if !isActive(snapshot.Status) {
			continue
		}
		if snapshot.Provider == provider &&
			snapshot.AccountRef == accountRef &&
			snapshot.Scope == scope {
			return snapshot
		}
	}
	return nil
}

// pruneLocked 先按保留期删除过期终态作业，再按 updatedAt 最旧优先收紧上限。
// 活动作业永远不删；上限无法满足时宁可超限也不丢正在跑的作业。
func (store *Store) pruneLocked(now time.Time) {
	if store.jobs == nil {
		return
	}
	if store.retention > 0 {
		for jobID, snapshot := range store.jobs {
			if isActive(snapshot.Status) {
				continue
			}
			if now.Sub(time.UnixMilli(snapshot.UpdatedAt)) > store.retention {
				delete(store.jobs, jobID)
			}
		}
	}
	if store.maxJobs <= 0 || len(store.jobs) <= store.maxJobs {
		return
	}
	removable := make([]*Snapshot, 0, len(store.jobs))
	for _, snapshot := range store.jobs {
		if isActive(snapshot.Status) {
			continue
		}
		removable = append(removable, snapshot)
	}
	sort.Slice(removable, func(left, right int) bool {
		if removable[left].UpdatedAt != removable[right].UpdatedAt {
			return removable[left].UpdatedAt < removable[right].UpdatedAt
		}
		return removable[left].ID < removable[right].ID
	})
	for _, snapshot := range removable {
		if len(store.jobs) <= store.maxJobs {
			break
		}
		delete(store.jobs, snapshot.ID)
	}
}

// nextIDLocked 生成表内唯一的作业 ID；自定义生成器返回空值或撞车时退回默认生成器。
func (store *Store) nextIDLocked(provider string, accountRef string) string {
	if jobID := strings.TrimSpace(store.newID(provider, accountRef)); jobID != "" {
		if _, exists := store.jobs[jobID]; !exists {
			return jobID
		}
	}
	base := defaultNewID(provider, accountRef)
	if _, exists := store.jobs[base]; !exists {
		return base
	}
	// 随机源不可用等极端情况下追加序号；表容量有限，循环一定终止。
	for suffix := 1; ; suffix++ {
		candidate := base + "-" + strconv.Itoa(suffix)
		if _, exists := store.jobs[candidate]; !exists {
			return candidate
		}
	}
}

// defaultNewID 生成与 Node makeAccountRefreshJobId 同前缀的作业标识：
// acct-refresh-<provider>-<accountRef>-<base36 毫秒>-<8 位随机 hex>。
func defaultNewID(provider string, accountRef string) string {
	parts := []string{
		"acct-refresh",
		strings.TrimSpace(provider),
		strings.TrimSpace(accountRef),
		strconv.FormatInt(time.Now().UnixMilli(), 36),
		randomHex(4),
	}
	filtered := make([]string, 0, len(parts))
	for _, part := range parts {
		if part != "" {
			filtered = append(filtered, part)
		}
	}
	return strings.Join(filtered, "-")
}

// randomHex 生成 byteCount 字节的随机十六进制串；随机源不可用时退化为纳秒时间戳。
func randomHex(byteCount int) string {
	buffer := make([]byte, byteCount)
	if _, err := rand.Read(buffer); err == nil {
		return fmt.Sprintf("%x", buffer)
	}
	value := uint64(time.Now().UnixNano())
	for index := range buffer {
		buffer[index] = byte(value >> (8 * (index % 8)))
	}
	return fmt.Sprintf("%x", buffer)
}

// cloneSnapshot 深拷贝快照，保证 Get/Start 的调用方改不动表内状态。
func cloneSnapshot(snapshot Snapshot) Snapshot {
	clone := snapshot
	if snapshot.FinishedAt != nil {
		finishedAt := *snapshot.FinishedAt
		clone.FinishedAt = &finishedAt
	}
	clone.FailedBranches = cloneStrings(snapshot.FailedBranches)
	clone.Branches = cloneBranches(snapshot.Branches)
	return clone
}

// cloneStrings 复制字符串切片；空值保持 nil，让 JSON 的 omitempty 生效。
func cloneStrings(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	return append([]string(nil), values...)
}

// cloneBranches 复制分支表；空值保持 nil，让 JSON 的 omitempty 生效。
func cloneBranches(branches map[string]Branch) map[string]Branch {
	if len(branches) == 0 {
		return nil
	}
	clone := make(map[string]Branch, len(branches))
	for name, branch := range branches {
		clone[name] = branch
	}
	return clone
}

// isActive 判断作业是否仍在排队或执行。
func isActive(status string) bool {
	return status == StatusQueued || status == StatusRunning
}

// normalizeProvider 与 Node 的口径一致：去空格转小写。
func normalizeProvider(provider string) string {
	return strings.ToLower(strings.TrimSpace(provider))
}

// normalizeScope 去空格；缺省按 Node 口径视为 usage。
func normalizeScope(scope string) string {
	trimmed := strings.TrimSpace(scope)
	if trimmed == "" {
		return ScopeUsage
	}
	return trimmed
}

// truncateRunes 按 rune 截断错误摘要，避免切断多字节字符；不追加省略号，
// 与 Node 的 slice(0, 500) 保持同样的长度口径。
func truncateRunes(text string, limit int) string {
	if limit <= 0 {
		return ""
	}
	runes := []rune(text)
	if len(runes) <= limit {
		return text
	}
	return string(runes[:limit])
}

// int64Pointer 返回毫秒时间戳的指针，供 JSON 的 null/数字语义使用。
func int64Pointer(value int64) *int64 {
	return &value
}

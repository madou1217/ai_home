// Package accountoutcomes 按时间桶聚合每个账号的请求结果，供账号页状态条使用。
//
// 设计：热路径（每次上游尝试结束）只在内存里计数，Recorder 定时批量写入持久化层，
// 关闭时再写一次；从不向调用方返回错误——状态统计是观测数据，绝不能把一次成功的
// 上游调用变成客户端失败。只保存计数（success 或 FailureKind），不保存请求内容。
package accountoutcomes

import (
	"context"
	"errors"
	"sync"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// Granularity 是时间桶粒度。
type Granularity string

const (
	// Day 是按本地自然日聚合（账号页 90 天条）。
	Day Granularity = "day"
	// Hour 是按小时聚合（最近 24 小时条）。
	Hour Granularity = "hour"
	// OutcomeSuccess 是成功结果的计数键；失败使用 accountruntime.FailureKind。
	OutcomeSuccess = "success"
	// DayRetention 与 HourRetention 是各粒度的保留期。
	DayRetention  = 90 * 24 * time.Hour
	HourRetention = 48 * time.Hour
)

var (
	// ErrInvalidRecorder 表示 Recorder 缺少持久化端口、时钟或刷新间隔。
	ErrInvalidRecorder = errors.New("账号结果记录器配置无效")
	// ErrInvalidQuery 表示查询粒度或起点无效。
	ErrInvalidQuery = errors.New("账号结果查询无效")
)

// IsValid 判断粒度是否受支持。
func (granularity Granularity) IsValid() bool {
	return granularity == Day || granularity == Hour
}

// Delta 是一次批量写入中的单个计数增量。
type Delta struct {
	AccountRef    accountcore.AccountRef
	Granularity   Granularity
	BucketStartMS int64
	Outcome       string
	Count         int64
}

// Bucket 是查询返回的单个计数行。
type Bucket struct {
	AccountRef    accountcore.AccountRef
	BucketStartMS int64
	Outcome       string
	Count         int64
}

// Store 是 Recorder 与查询所需的持久化端口。
type Store interface {
	AddAccountOutcomes(ctx context.Context, deltas []Delta) error
	ListAccountOutcomes(ctx context.Context, granularity Granularity, fromMS int64) ([]Bucket, error)
	PruneAccountOutcomes(ctx context.Context, granularity Granularity, beforeMS int64) error
}

// BucketStart 返回时间点所在桶的起点（本地时区，毫秒）。
func BucketStart(at time.Time, granularity Granularity, location *time.Location) int64 {
	local := at.In(location)
	switch granularity {
	case Day:
		return time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, location).UnixMilli()
	default:
		return time.Date(local.Year(), local.Month(), local.Day(), local.Hour(), 0, 0, 0, location).UnixMilli()
	}
}

// RecorderOptions 显式声明刷新节奏与时区。
type RecorderOptions struct {
	Store         Store
	Clock         func() time.Time
	FlushInterval time.Duration
	Location      *time.Location
	// OnError 接收写入失败；为空时静默（下次刷新会重试未写入的计数）。
	OnError func(error)
}

type pendingKey struct {
	accountRef  accountcore.AccountRef
	granularity Granularity
	bucket      int64
	outcome     string
}

// Recorder 在内存中聚合结果并周期性批量写入。
type Recorder struct {
	store    Store
	clock    func() time.Time
	interval time.Duration
	location *time.Location
	onError  func(error)

	mu       sync.Mutex
	pending  map[pendingKey]int64
	activity map[accountcore.AccountRef]Activity

	cancel    context.CancelFunc
	done      chan struct{}
	lastPrune time.Time
}

// NewRecorder 创建记录器；调用 Start 后开始周期刷新。
func NewRecorder(options RecorderOptions) (*Recorder, error) {
	if options.Store == nil || options.Clock == nil || options.FlushInterval <= 0 {
		return nil, ErrInvalidRecorder
	}
	location := options.Location
	if location == nil {
		location = time.Local
	}
	return &Recorder{
		store:    options.Store,
		clock:    options.Clock,
		interval: options.FlushInterval,
		location: location,
		onError:  options.OnError,
		pending:  make(map[pendingKey]int64),
		activity: make(map[accountcore.AccountRef]Activity),
	}, nil
}

// Activity 是账号最近一次上游尝试结果（本进程内存，重启后从空开始）。
// 账号页「上次成功使用」据此实时更新，不必等时间桶落库。
type Activity struct {
	LastSuccessAt   time.Time
	LastFailureAt   time.Time
	LastFailureKind string
}

// LastActivity 返回每个账号最近一次成功 / 失败的副本。
func (recorder *Recorder) LastActivity() map[accountcore.AccountRef]Activity {
	if recorder == nil {
		return nil
	}
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	result := make(map[accountcore.AccountRef]Activity, len(recorder.activity))
	for accountRef, activity := range recorder.activity {
		result[accountRef] = activity
	}
	return result
}

// Record 在内存中为账号的日桶与小时桶各记一次结果；非法输入静默忽略。
func (recorder *Recorder) Record(accountRef accountcore.AccountRef, outcome string) {
	if recorder == nil || !accountRef.IsValid() || outcome == "" {
		return
	}
	now := recorder.clock()
	recorder.mu.Lock()
	for _, granularity := range []Granularity{Day, Hour} {
		recorder.pending[pendingKey{
			accountRef:  accountRef,
			granularity: granularity,
			bucket:      BucketStart(now, granularity, recorder.location),
			outcome:     outcome,
		}]++
	}
	activity := recorder.activity[accountRef]
	if outcome == OutcomeSuccess {
		activity.LastSuccessAt = now
	} else {
		activity.LastFailureAt = now
		activity.LastFailureKind = outcome
	}
	recorder.activity[accountRef] = activity
	recorder.mu.Unlock()
}

// Flush 立即把内存计数写入持久化层；失败的计数合并回内存等待下次刷新。
func (recorder *Recorder) Flush(ctx context.Context) error {
	if recorder == nil {
		return nil
	}
	recorder.mu.Lock()
	if len(recorder.pending) == 0 {
		recorder.mu.Unlock()
		return nil
	}
	batch := recorder.pending
	recorder.pending = make(map[pendingKey]int64)
	recorder.mu.Unlock()

	deltas := make([]Delta, 0, len(batch))
	for key, count := range batch {
		deltas = append(deltas, Delta{
			AccountRef:    key.accountRef,
			Granularity:   key.granularity,
			BucketStartMS: key.bucket,
			Outcome:       key.outcome,
			Count:         count,
		})
	}
	if err := recorder.store.AddAccountOutcomes(ctx, deltas); err != nil {
		recorder.mu.Lock()
		for key, count := range batch {
			recorder.pending[key] += count
		}
		recorder.mu.Unlock()
		return err
	}
	return nil
}

// Start 启动周期刷新与每日一次的保留期清理。
func (recorder *Recorder) Start(parent context.Context) {
	if recorder == nil || recorder.cancel != nil {
		return
	}
	ctx, cancel := context.WithCancel(parent)
	recorder.cancel = cancel
	recorder.done = make(chan struct{})
	go func() {
		defer close(recorder.done)
		ticker := time.NewTicker(recorder.interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				recorder.report(recorder.Flush(ctx))
				recorder.pruneDaily(ctx)
			}
		}
	}()
}

// Close 停止周期刷新并写入剩余计数。
func (recorder *Recorder) Close() error {
	if recorder == nil {
		return nil
	}
	if recorder.cancel != nil {
		recorder.cancel()
		<-recorder.done
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return recorder.Flush(ctx)
}

// pruneDaily 每天最多清理一次超出保留期的桶。
func (recorder *Recorder) pruneDaily(ctx context.Context) {
	now := recorder.clock()
	if !recorder.lastPrune.IsZero() && now.Sub(recorder.lastPrune) < 24*time.Hour {
		return
	}
	recorder.lastPrune = now
	recorder.report(recorder.store.PruneAccountOutcomes(ctx, Day, now.Add(-DayRetention-24*time.Hour).UnixMilli()))
	recorder.report(recorder.store.PruneAccountOutcomes(ctx, Hour, now.Add(-HourRetention).UnixMilli()))
}

func (recorder *Recorder) report(err error) {
	if err != nil && recorder.onError != nil && !errors.Is(err, context.Canceled) {
		recorder.onError(err)
	}
}

// Reader 是只读查询端口。
type Reader interface {
	ListAccountOutcomes(ctx context.Context, granularity Granularity, fromMS int64) ([]Bucket, error)
}

// Query 返回指定粒度自 fromMS 起的全部计数行。
func Query(ctx context.Context, reader Reader, granularity Granularity, fromMS int64) ([]Bucket, error) {
	if reader == nil || ctx == nil || !granularity.IsValid() || fromMS < 0 {
		return nil, ErrInvalidQuery
	}
	return reader.ListAccountOutcomes(ctx, granularity, fromMS)
}

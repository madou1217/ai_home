package clientkeystats

// 本文件提供请求上下文辅助与统计查询。
//
// 终态汇点（account_outcomes）没有 RequestScope 引用，因此用进程级 Tracker
// 安装一次；有 scope 的入口优先用 scope，避免重复计数。

import (
	"context"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	coreclientkeys "github.com/madou1217/ai_home/core/clientkeys"
	"github.com/madou1217/ai_home/core/inference"
)

type scopeContextKey struct{}

// WithScope 把请求作用域写入上下文。
func WithScope(ctx context.Context, scope *RequestScope) context.Context {
	if ctx == nil || scope == nil {
		return ctx
	}
	return context.WithValue(ctx, scopeContextKey{}, scope)
}

// ScopeFromContext 读取请求作用域。
func ScopeFromContext(ctx context.Context) (*RequestScope, bool) {
	if ctx == nil {
		return nil, false
	}
	scope, ok := ctx.Value(scopeContextKey{}).(*RequestScope)
	return scope, ok && scope != nil
}

// AttemptBegin 优先使用请求作用域，其次使用进程级 Tracker。
func AttemptBegin(ctx context.Context, provider, accountRef, model string) *AttemptScope {
	if scope, ok := ScopeFromContext(ctx); ok {
		return scope.BeginAttempt(provider, accountRef, model)
	}
	if tracker := currentTracker(); tracker != nil {
		return tracker.BeginAttempt(ctx, provider, accountRef, model)
	}
	return nil
}

// RecordUsage 记录 token 用量；没有安装 Tracker 时为空操作。
func RecordUsage(ctx context.Context, provider, accountRef, model string, usage inference.Usage) {
	if tracker := currentTracker(); tracker != nil {
		tracker.RecordUsage(ctx, provider, accountRef, model, usage)
	}
}

// RecordAttempt 记录尝试级成功/失败；没有安装 Tracker 时为空操作。
func RecordAttempt(ctx context.Context, provider, accountRef, model string, outcome Outcome) {
	if tracker := currentTracker(); tracker != nil {
		tracker.RecordAttempt(ctx, provider, accountRef, model, outcome)
	}
}

var (
	globalTrackerMu sync.RWMutex
	globalTracker   *Tracker
	installedOnce   atomic.Bool
)

// Install 安装进程级 Tracker（组合根调用一次）。
func Install(tracker *Tracker) {
	globalTrackerMu.Lock()
	globalTracker = tracker
	globalTrackerMu.Unlock()
	installedOnce.Store(tracker != nil)
}

func currentTracker() *Tracker {
	globalTrackerMu.RLock()
	tracker := globalTracker
	globalTrackerMu.RUnlock()
	return tracker
}

// Query 是一次统计查询。
type Query struct {
	Granularity string
	From        time.Time
	To          time.Time
	KeyID       string
	ProviderID  string
	ModelID     string
	AccountRef  string
}

// Row 是尝试级聚合行。
type Row struct {
	KeyID                 string
	ProviderID            string
	ModelID               string
	AccountRef            string
	Attempts              int64
	Successes             int64
	Failures              int64
	Aborted               int64
	InputTokens           int64
	OutputTokens          int64
	CachedInputTokens     int64
	CacheWriteInputTokens int64
	ReasoningTokens       int64
	TotalTokens           int64
}

// RequestRow 是请求级聚合行。
type RequestRow struct {
	KeyID    string
	Surface  string
	Requests int64
	Aborted  int64
}

// QueryAttempts 读取并聚合指定窗口的尝试统计。
func (tracker *Tracker) QueryAttempts(ctx context.Context, query Query) ([]Row, error) {
	if tracker == nil || tracker.store == nil {
		return nil, ErrUnavailable
	}
	buckets, err := tracker.store.QueryClientKeyAttempts(ctx, statsQuery(query))
	if err != nil {
		return nil, err
	}
	aggregated := map[string]*Row{}
	for _, bucket := range buckets {
		key := bucket.KeyID + "\x00" + bucket.ProviderID + "\x00" + bucket.ModelID + "\x00" + bucket.AccountRef
		row := aggregated[key]
		if row == nil {
			row = &Row{KeyID: bucket.KeyID, ProviderID: bucket.ProviderID, ModelID: bucket.ModelID, AccountRef: bucket.AccountRef}
			aggregated[key] = row
		}
		row.Attempts += bucket.Attempts
		row.Successes += bucket.Successes
		row.Failures += bucket.Failures
		row.Aborted += bucket.Aborted
		row.InputTokens += bucket.InputTokens
		row.OutputTokens += bucket.OutputTokens
		row.CachedInputTokens += bucket.CachedInputTokens
		row.CacheWriteInputTokens += bucket.CacheWriteInputTokens
		row.ReasoningTokens += bucket.ReasoningTokens
		row.TotalTokens += bucket.TotalTokens
	}
	rows := make([]Row, 0, len(aggregated))
	for _, row := range aggregated {
		rows = append(rows, *row)
	}
	sort.Slice(rows, func(left, right int) bool {
		if rows[left].KeyID != rows[right].KeyID {
			return rows[left].KeyID < rows[right].KeyID
		}
		if rows[left].ProviderID != rows[right].ProviderID {
			return rows[left].ProviderID < rows[right].ProviderID
		}
		if rows[left].ModelID != rows[right].ModelID {
			return rows[left].ModelID < rows[right].ModelID
		}
		return rows[left].AccountRef < rows[right].AccountRef
	})
	return rows, nil
}

// QueryRequests 读取并聚合指定窗口的请求统计。
//
// 请求表没有 provider/model/account 维度：带这些过滤条件时由调用方改用
// QueryAttempts，避免把全局请求数误当成过滤后的结果。
func (tracker *Tracker) QueryRequests(ctx context.Context, query Query) ([]RequestRow, error) {
	if tracker == nil || tracker.store == nil {
		return nil, ErrUnavailable
	}
	buckets, err := tracker.store.QueryClientKeyRequests(ctx, statsQuery(query))
	if err != nil {
		return nil, err
	}
	aggregated := map[string]*RequestRow{}
	for _, bucket := range buckets {
		key := bucket.KeyID + "\x00" + bucket.Surface
		row := aggregated[key]
		if row == nil {
			row = &RequestRow{KeyID: bucket.KeyID, Surface: bucket.Surface}
			aggregated[key] = row
		}
		row.Requests += bucket.Requests
		row.Aborted += bucket.Aborted
	}
	rows := make([]RequestRow, 0, len(aggregated))
	for _, row := range aggregated {
		rows = append(rows, *row)
	}
	sort.Slice(rows, func(left, right int) bool {
		if rows[left].KeyID != rows[right].KeyID {
			return rows[left].KeyID < rows[right].KeyID
		}
		return rows[left].Surface < rows[right].Surface
	})
	return rows, nil
}

func statsQuery(query Query) coreclientkeys.StatsQuery {
	granularity := query.Granularity
	if granularity == "" {
		granularity = coreclientkeys.GranularityMinute
	}
	to := query.To
	if to.IsZero() {
		to = time.Now()
	}
	from := query.From
	if from.IsZero() {
		from = to.Add(-24 * time.Hour)
	}
	return coreclientkeys.StatsQuery{
		Granularity: granularity,
		FromMS:      from.UnixMilli(),
		ToMS:        to.UnixMilli(),
		KeyID:       query.KeyID,
		ProviderID:  query.ProviderID,
		ModelID:     query.ModelID,
		AccountRef:  query.AccountRef,
	}
}

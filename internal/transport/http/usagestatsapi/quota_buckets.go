package usagestatsapi

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/core/usageledger"
)

// QuotaBucketsPath 是按额度档位聚合的 token 用量接口。
const QuotaBucketsPath = "/v1/management/usage/quota-buckets"

// 档位聚合要扫整段时间的账本（覆盖索引下 90 天约 70ms，纯 Go 驱动）。
// 同一个页面的连续加载不该每次都重扫：10s 内直接复用结果，过期后先回旧值并
// 在后台单飞刷新，避免把重算成本落到某一次页面请求上。
const (
	quotaBucketsCacheTTL   = 10 * time.Second
	quotaBucketsCacheStale = 5 * time.Minute
	quotaBucketsCacheMax   = 64
)

// QuotaBucketsSource 是档位聚合端口。
type QuotaBucketsSource interface {
	QueryUsageQuotaBuckets(context.Context, usageledger.Query) ([]usageledger.QuotaBucketStats, error)
}

// QuotaBucketsHandler 暴露按 (provider, 档位) 聚合的用量。
type QuotaBucketsHandler struct {
	authorizer Authorizer
	source     QuotaBucketsSource
}

// NewQuotaBucketsHandler 创建档位用量接口。
func NewQuotaBucketsHandler(authorizer Authorizer, source QuotaBucketsSource) (*QuotaBucketsHandler, error) {
	if authorizer == nil || source == nil {
		return nil, usageledger.ErrInvalidQuery
	}
	return &QuotaBucketsHandler{authorizer: authorizer, source: newCachedQuotaBucketsSource(source)}, nil
}

// ServeHTTP 返回按额度档位聚合的用量行。
func (handler *QuotaBucketsHandler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	serveUsageQuery(
		response,
		request,
		handler.authorizer,
		"usage_quota_buckets_failed",
		"额度档位用量统计不可用",
		func(ctx context.Context, query usageledger.Query) (map[string]any, error) {
			rows, err := handler.source.QueryUsageQuotaBuckets(ctx, query)
			if err != nil {
				return nil, err
			}
			return map[string]any{"quota_buckets": rows}, nil
		},
	)
}

// quotaBucketsCacheEntry 是一次查询的缓存项。rows 写入后不再修改，
// 读侧只把它序列化成 JSON，因此可以跨请求共享。
type quotaBucketsCacheEntry struct {
	rows       []usageledger.QuotaBucketStats
	fetchedAt  time.Time
	refreshing bool
}

// cachedQuotaBucketsSource 给档位聚合加短缓存 + 单飞后台刷新。
type cachedQuotaBucketsSource struct {
	source  QuotaBucketsSource
	now     func() time.Time
	mu      sync.Mutex
	entries map[string]*quotaBucketsCacheEntry
}

func newCachedQuotaBucketsSource(source QuotaBucketsSource) *cachedQuotaBucketsSource {
	return &cachedQuotaBucketsSource{
		source:  source,
		now:     time.Now,
		entries: make(map[string]*quotaBucketsCacheEntry, 8),
	}
}

func (cached *cachedQuotaBucketsSource) QueryUsageQuotaBuckets(
	ctx context.Context,
	query usageledger.Query,
) ([]usageledger.QuotaBucketStats, error) {
	key := quotaBucketsCacheKey(query)
	now := cached.now()

	cached.mu.Lock()
	entry := cached.entries[key]
	// 只有拿过真实结果才允许走"缓存/旧值"分支：首次就失败时不能把
	// 空结果当成命中返回 200，必须让调用方看到错误。
	if entry != nil && entry.rows != nil {
		age := now.Sub(entry.fetchedAt)
		if age <= quotaBucketsCacheTTL {
			rows := entry.rows
			cached.mu.Unlock()
			return rows, nil
		}
		if age <= quotaBucketsCacheStale {
			if !entry.refreshing {
				entry.refreshing = true
				go cached.refresh(key, query)
			}
			rows := entry.rows
			cached.mu.Unlock()
			return rows, nil
		}
	} else {
		entry = &quotaBucketsCacheEntry{}
		cached.entries[key] = entry
		cached.evictLocked()
	}
	entry.refreshing = true
	cached.mu.Unlock()

	rows, err := cached.source.QueryUsageQuotaBuckets(ctx, query)
	cached.store(key, rows, err)
	return rows, err
}

// refresh 在后台重算一次缓存。刷新失败时保留旧值并退避一个 TTL，
// 避免源端持续报错时每个请求都重新发起刷新。
func (cached *cachedQuotaBucketsSource) refresh(key string, query usageledger.Query) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	rows, err := cached.source.QueryUsageQuotaBuckets(ctx, query)
	cached.store(key, rows, err)
}

func (cached *cachedQuotaBucketsSource) store(key string, rows []usageledger.QuotaBucketStats, err error) {
	cached.mu.Lock()
	defer cached.mu.Unlock()
	entry := cached.entries[key]
	if entry == nil {
		entry = &quotaBucketsCacheEntry{}
		cached.entries[key] = entry
		cached.evictLocked()
	}
	entry.refreshing = false
	if err != nil {
		if entry.rows != nil {
			// 有旧值就继续用，下一次 TTL 到期后再试，别让持续失败变成忙等。
			entry.fetchedAt = cached.now()
			return
		}
		// 没有可用数据：清零时间戳，下一次请求走同步重试而不是命中空缓存。
		entry.fetchedAt = time.Time{}
		return
	}
	entry.rows = rows
	entry.fetchedAt = cached.now()
}

// evictLocked 控制条目上限：超限时丢掉最旧的一条（调用方持锁）。
func (cached *cachedQuotaBucketsSource) evictLocked() {
	if len(cached.entries) <= quotaBucketsCacheMax {
		return
	}
	oldestKey := ""
	var oldest time.Time
	for key, entry := range cached.entries {
		if entry.refreshing || entry.rows == nil {
			continue
		}
		if oldestKey == "" || entry.fetchedAt.Before(oldest) {
			oldestKey, oldest = key, entry.fetchedAt
		}
	}
	if oldestKey != "" {
		delete(cached.entries, oldestKey)
	}
}

// quotaBucketsCacheKey 用查询的全部维度做键：不同窗口/过滤条件不能互相复用。
func quotaBucketsCacheKey(query usageledger.Query) string {
	return strings.Join([]string{
		query.From.UTC().Format(time.RFC3339Nano),
		query.To.UTC().Format(time.RFC3339Nano),
		strings.ToLower(strings.TrimSpace(query.Provider)),
		strings.TrimSpace(query.Model),
		query.AccountRef.String(),
	}, "\x00")
}

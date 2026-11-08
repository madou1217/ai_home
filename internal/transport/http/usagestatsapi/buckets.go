package usagestatsapi

import (
	"context"
	"net/http"
	"strings"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/usageledger"
)

// BucketsPath 是 token 用量按时间桶聚合的只读接口（额度统计页图表）。
const BucketsPath = "/v1/management/usage/buckets"

// maxBucketRows 是补零后单次返回的桶数上限。90 天范围最多 90 个日桶 / 14 个周桶，
// 这个上限只防查询区间被手写成几年后把响应撑爆。
const maxBucketRows = 400

// BucketsSource 是桶聚合端口。
type BucketsSource interface {
	QueryUsageBuckets(context.Context, usageledger.Query, string) ([]usageledger.BucketStats, error)
}

type BucketsHandler struct {
	authorizer Authorizer
	source     BucketsSource
}

// bucketRow 是图表契约的桶行：在账本聚合结果上补序号与桶起点。
//
// 为什么需要这两列：页面用 index 做行 key、用 bucket_start_ms 画横轴与区间；
// 只有 start_ms 时，被区间裁剪过的首尾桶会把横轴标签带到半天中间。
type bucketRow struct {
	Index         int    `json:"index"`
	StartMS       int64  `json:"start_ms"`
	EndMS         int64  `json:"end_ms"`
	BucketStartMS int64  `json:"bucket_start_ms"`
	Tokens        uint64 `json:"tokens"`
	RequestCount  uint64 `json:"request_count"`
}

func NewBucketsHandler(authorizer Authorizer, source BucketsSource) (*BucketsHandler, error) {
	if authorizer == nil || source == nil {
		return nil, usageledger.ErrInvalidQuery
	}
	return &BucketsHandler{authorizer: authorizer, source: source}, nil
}

func (handler *BucketsHandler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	granularity := usageledger.NormalizeBucketGranularity(request.URL.Query().Get("granularity"))
	if granularity == "" {
		granularity = usageledger.BucketGranularityDay
	}
	serveUsageQuery(
		response,
		request,
		handler.authorizer,
		"invalid_usage_query",
		"用量查询参数无效",
		func(ctx context.Context, query usageledger.Query) (map[string]any, error) {
			// account_ref 可选：额度统计页按账号看，传了就只统计该账号。
			if raw := strings.TrimSpace(request.URL.Query().Get("account_ref")); raw != "" {
				ref, err := accountcore.ParseAccountRef(raw)
				if err != nil {
					return nil, usageledger.ErrInvalidQuery
				}
				query.AccountRef = ref
			}
			buckets, err := handler.source.QueryUsageBuckets(ctx, query, granularity)
			if err != nil {
				return nil, err
			}
			return map[string]any{
				"granularity": granularity,
				"from":        query.From.Format(timeFormat),
				"to":          query.To.Format(timeFormat),
				"buckets":     fillBuckets(buckets, query.From, query.To, granularity),
			}, nil
		},
	)
}

// fillBuckets 按查询区间把聚合结果补齐成连续桶。
//
// 为什么在这里补零：core 的 AggregateBuckets 只返回「有记录的桶」，补零被明确
// 留给调用方（窗口跨度可能是 90 天）。额度统计页按桶数量和位置画柱状图，
// 缺桶会让 30 天视图只剩几根柱子、行 key 也随之重复，所以由本层负责补齐。
func fillBuckets(
	buckets []usageledger.BucketStats,
	from time.Time,
	to time.Time,
	granularity string,
) []bucketRow {
	byStart := make(map[int64]usageledger.BucketStats, len(buckets))
	for _, bucket := range buckets {
		byStart[bucket.StartMS] = bucket
	}
	fromUTC := from.UTC()
	toUTC := to.UTC()
	cursor := usageledger.BucketStart(fromUTC, granularity)
	rows := make([]bucketRow, 0, 32)
	for index := 0; cursor.Before(toUTC) && index < maxBucketRows; index++ {
		next := usageledger.BucketEnd(cursor, granularity)
		row := bucketRow{
			Index:         index,
			StartMS:       cursor.UnixMilli(),
			EndMS:         next.UnixMilli(),
			BucketStartMS: cursor.UnixMilli(),
		}
		// 首尾桶按查询区间裁剪：页面画的是「范围内」的桶，不是完整自然日。
		if fromUTC.After(cursor) {
			row.StartMS = fromUTC.UnixMilli()
		}
		if next.After(toUTC) {
			row.EndMS = toUTC.UnixMilli()
		}
		if bucket, exists := byStart[row.BucketStartMS]; exists {
			row.Tokens = bucket.Tokens
			row.RequestCount = bucket.RequestCount
		}
		rows = append(rows, row)
		cursor = next
	}
	return rows
}

const timeFormat = "2006-01-02T15:04:05.000Z07:00"

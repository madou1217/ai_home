package usageledger

import (
	"sort"
	"strings"
	"time"
)

// BucketStats 是按时间桶聚合的 token 事实（额度统计页的图表数据）。
//
// 与 ModelStats 的分工：模型维度回答「谁用得多」，时间桶回答「什么时候用的」，
// 两者共用同一份 usage_ledger 记录，避免再为图表单独维护一套数据源。
type BucketStats struct {
	StartMS      int64  `json:"start_ms"`
	EndMS        int64  `json:"end_ms"`
	Tokens       uint64 `json:"tokens"`
	RequestCount uint64 `json:"request_count"`
}

const (
	// BucketGranularityDay 按 UTC 自然日切桶。
	BucketGranularityDay = "day"
	// BucketGranularityWeek 按 UTC 周一切桶。
	BucketGranularityWeek = "week"
)

// NormalizeBucketGranularity 只接受 day/week，其余返回空串（调用方据此报 400）。
func NormalizeBucketGranularity(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case BucketGranularityDay:
		return BucketGranularityDay
	case BucketGranularityWeek:
		return BucketGranularityWeek
	default:
		return ""
	}
}

// BucketStart 返回某时刻所属桶的起点（UTC）。
func BucketStart(occurredAt time.Time, granularity string) time.Time {
	utc := occurredAt.UTC()
	day := time.Date(utc.Year(), utc.Month(), utc.Day(), 0, 0, 0, 0, time.UTC)
	if granularity != BucketGranularityWeek {
		return day
	}
	// time.Weekday: Sunday=0；转成「距离本周一几天」。
	offset := (int(day.Weekday()) + 6) % 7
	return day.AddDate(0, 0, -offset)
}

// BucketEnd 返回桶的右端点（下一个桶起点），便于前端直接画区间。
func BucketEnd(start time.Time, granularity string) time.Time {
	if granularity == BucketGranularityWeek {
		return start.AddDate(0, 0, 7)
	}
	return start.AddDate(0, 0, 1)
}

// AggregateBuckets 把记录按时间桶汇总。
//
// 只返回有数据的桶：补零是展示决策（窗口跨度可能有 90 天），由调用方按自身粒度决定，
// 这里不替它造空桶。provider/model 过滤与 AggregateModels 同口径。
func AggregateBuckets(records []Record, query Query, granularity string) []BucketStats {
	if query.Validate() != nil {
		return nil
	}
	normalized := NormalizeBucketGranularity(granularity)
	if normalized == "" {
		return nil
	}
	provider := strings.TrimSpace(strings.ToLower(query.Provider))
	model := strings.TrimSpace(query.Model)
	buckets := make(map[int64]*BucketStats)
	for _, record := range records {
		if !record.IsValid() || record.OccurredAt().Before(query.From) || record.OccurredAt().After(query.To) {
			continue
		}
		if provider != "" && record.Provider() != provider || model != "" && record.Model() != model {
			continue
		}
		start := BucketStart(record.OccurredAt(), normalized)
		key := start.UnixMilli()
		bucket := buckets[key]
		if bucket == nil {
			bucket = &BucketStats{
				StartMS: key,
				EndMS:   BucketEnd(start, normalized).UnixMilli(),
			}
			buckets[key] = bucket
		}
		bucket.Tokens += record.Usage().TotalTokens()
		bucket.RequestCount++
	}
	result := make([]BucketStats, 0, len(buckets))
	for _, bucket := range buckets {
		result = append(result, *bucket)
	}
	sort.Slice(result, func(left, right int) bool { return result[left].StartMS < result[right].StartMS })
	return result
}

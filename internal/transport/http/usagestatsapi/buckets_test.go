package usagestatsapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/madou1217/ai_home/core/usageledger"
)

type bucketSource struct {
	buckets     []usageledger.BucketStats
	granularity string
	query       usageledger.Query
}

func (source *bucketSource) QueryUsageBuckets(
	_ context.Context,
	query usageledger.Query,
	granularity string,
) ([]usageledger.BucketStats, error) {
	source.query = query
	source.granularity = granularity
	return source.buckets, nil
}

type bucketsPayload struct {
	OK          bool   `json:"ok"`
	Granularity string `json:"granularity"`
	Buckets     []struct {
		Index         int    `json:"index"`
		StartMS       int64  `json:"start_ms"`
		EndMS         int64  `json:"end_ms"`
		BucketStartMS int64  `json:"bucket_start_ms"`
		Tokens        uint64 `json:"tokens"`
		RequestCount  uint64 `json:"request_count"`
	} `json:"buckets"`
}

func serveBuckets(t *testing.T, source *bucketSource, rawQuery string) bucketsPayload {
	t.Helper()
	handler, err := NewBucketsHandler(testAuthorizer(true), source)
	if err != nil {
		t.Fatalf("NewBucketsHandler() error = %v", err)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, BucketsPath+rawQuery, nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var payload bucketsPayload
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode body: %v (%s)", err, recorder.Body.String())
	}
	return payload
}

func utcMS(year int, month time.Month, day, hour int) int64 {
	return time.Date(year, month, day, hour, 0, 0, 0, time.UTC).UnixMilli()
}

// 缺口必须补成 0 桶：页面按桶数量与位置画图，缺天会让 30 天视图只剩几根柱子。
func TestBucketsHandlerFillsGapsAndIndexesRows(t *testing.T) {
	source := &bucketSource{buckets: []usageledger.BucketStats{
		{StartMS: utcMS(2026, 10, 1, 0), EndMS: utcMS(2026, 10, 2, 0), Tokens: 100, RequestCount: 2},
		{StartMS: utcMS(2026, 10, 3, 0), EndMS: utcMS(2026, 10, 4, 0), Tokens: 50, RequestCount: 1},
	}}
	payload := serveBuckets(t, source, "?from=2026-10-01&to=2026-10-03&granularity=day&account_ref=acct_0123456789abcdef0123")
	if !payload.OK || payload.Granularity != "day" {
		t.Fatalf("payload = %#v", payload)
	}
	if len(payload.Buckets) != 3 {
		t.Fatalf("buckets = %d, want 3", len(payload.Buckets))
	}
	wantTokens := []uint64{100, 0, 50}
	for index, row := range payload.Buckets {
		if row.Index != index {
			t.Fatalf("bucket[%d].index = %d", index, row.Index)
		}
		if row.BucketStartMS != utcMS(2026, 10, 1+index, 0) {
			t.Fatalf("bucket[%d].bucket_start_ms = %d", index, row.BucketStartMS)
		}
		if row.Tokens != wantTokens[index] {
			t.Fatalf("bucket[%d].tokens = %d, want %d", index, row.Tokens, wantTokens[index])
		}
	}
	if source.query.AccountRef.String() != "acct_0123456789abcdef0123" || source.granularity != "day" {
		t.Fatalf("query = %#v granularity = %q", source.query, source.granularity)
	}
}

// 首尾桶按查询区间裁剪，但 bucket_start_ms 保留自然日边界：横轴标签不能用半天位置。
func TestBucketsHandlerClipsEdgesButKeepsBucketStart(t *testing.T) {
	source := &bucketSource{}
	payload := serveBuckets(t, source, "?from=2026-10-01T12:00:00Z&to=2026-10-02T06:00:00Z")
	if len(payload.Buckets) != 2 {
		t.Fatalf("buckets = %d, want 2", len(payload.Buckets))
	}
	first := payload.Buckets[0]
	if first.StartMS != time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC).UnixMilli() {
		t.Fatalf("first.start_ms = %d", first.StartMS)
	}
	if first.BucketStartMS != utcMS(2026, 10, 1, 0) {
		t.Fatalf("first.bucket_start_ms = %d", first.BucketStartMS)
	}
	last := payload.Buckets[1]
	if last.EndMS != time.Date(2026, 10, 2, 6, 0, 0, 0, time.UTC).UnixMilli() {
		t.Fatalf("last.end_ms = %d", last.EndMS)
	}
	if last.BucketStartMS != utcMS(2026, 10, 2, 0) {
		t.Fatalf("last.bucket_start_ms = %d", last.BucketStartMS)
	}
}

// 周桶必须从 UTC 周一零点开始，与账本 AggregateBuckets 的切桶口径一致。
func TestBucketsHandlerWeekBucketsStartOnMonday(t *testing.T) {
	source := &bucketSource{}
	payload := serveBuckets(t, source, "?from=2026-10-01&to=2026-10-15&granularity=week")
	if payload.Granularity != "week" {
		t.Fatalf("granularity = %q", payload.Granularity)
	}
	if len(payload.Buckets) != 3 {
		t.Fatalf("buckets = %d, want 3", len(payload.Buckets))
	}
	for index, row := range payload.Buckets {
		if row.BucketStartMS != utcMS(2026, 9, 28+7*index, 0) {
			t.Fatalf("bucket[%d].bucket_start_ms = %d", index, row.BucketStartMS)
		}
	}
}

// 没有用量也返回区间内的空桶：页面据此显示 0 而不是「暂无数据」错位。
func TestBucketsHandlerEmptyRangeStillReturnsZeroRows(t *testing.T) {
	source := &bucketSource{}
	payload := serveBuckets(t, source, "?from=2026-10-01&to=2026-10-02")
	if len(payload.Buckets) != 2 {
		t.Fatalf("buckets = %d, want 2", len(payload.Buckets))
	}
	for _, row := range payload.Buckets {
		if row.Tokens != 0 || row.RequestCount != 0 {
			t.Fatalf("row = %#v", row)
		}
	}
}

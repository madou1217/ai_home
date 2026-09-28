package accountusageeventsapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountusagefeed"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/inference"
)

type allowAll bool

func (allowed allowAll) Authorized(*http.Request) bool { return bool(allowed) }

type feedSource struct{ feed *accountusagefeed.Feed }

func (source feedSource) UsageEventsSince(after uint64) ([]accountusagefeed.Event, uint64, bool) {
	return source.feed.Since(after)
}

func (source feedSource) UsageBootID() string { return source.feed.BootID() }

// TestHandlerServesUsageEventsAfterCursor 验证鉴权、游标与 JSON 投影。
func TestHandlerServesUsageEventsAfterCursor(t *testing.T) {
	t.Parallel()

	now := time.UnixMilli(1_790_000_000_000)
	feed := accountusagefeed.NewFeed(8, now)
	ref, _ := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	for _, output := range []uint64{5, 9} {
		usage, _ := inference.NewUsage(inference.UsageInput{InputTokens: 100, OutputTokens: output, CachedInputTokens: 60})
		feed.Append(ref, "gpt-5.5", now, usage)
	}
	handler, err := NewHandler(allowAll(true), feedSource{feed: feed})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	denied, _ := NewHandler(allowAll(false), feedSource{feed: feed})
	recorder := httptest.NewRecorder()
	denied.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path, nil))
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status = %d", recorder.Code)
	}
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path+"?after_seq=x", nil))
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("bad cursor status = %d", recorder.Code)
	}

	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path+"?after_seq=1", nil))
	var body struct {
		BootID    string      `json:"boot_id"`
		LatestSeq uint64      `json:"latest_seq"`
		Truncated bool        `json:"truncated"`
		Data      []eventView `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.BootID != feed.BootID() || body.LatestSeq != 2 || body.Truncated || len(body.Data) != 1 {
		t.Fatalf("body = %+v", body)
	}
	got := body.Data[0]
	if got.Seq != 2 || got.AccountRef != ref.String() || got.Model != "gpt-5.5" || got.AtMS != now.UnixMilli() ||
		got.InputTokens != 100 || got.CachedInputTokens != 60 || got.OutputTokens != 9 || got.TotalTokens != 109 {
		t.Fatalf("event = %+v", got)
	}
}

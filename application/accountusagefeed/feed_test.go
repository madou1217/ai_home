package accountusagefeed

import (
	"testing"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/inference"
)

func mustUsage(t *testing.T, input, output uint64) inference.Usage {
	t.Helper()
	usage, err := inference.NewUsage(inference.UsageInput{InputTokens: input, OutputTokens: output})
	if err != nil {
		t.Fatalf("NewUsage() error = %v", err)
	}
	return usage
}

// TestFeedResumesBySequenceAndReportsOverflow 验证游标续读、空用量丢弃与环溢出标记。
func TestFeedResumesBySequenceAndReportsOverflow(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 9, 29, 10, 0, 0, 0, time.UTC)
	feed := NewFeed(3, now)
	ref, _ := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	feed.Append(ref, "gpt-5.5", now, mustUsage(t, 10, 5))
	feed.Append(ref, "gpt-5.5", now, mustUsage(t, 0, 0))
	feed.Append("", "gpt-5.5", now, mustUsage(t, 10, 5))
	feed.Append(ref, "gpt-5.5", now, mustUsage(t, 20, 1))

	events, latest, truncated := feed.Since(0)
	if len(events) != 2 || latest != 2 || truncated || events[0].Seq != 1 || events[1].Usage.TotalTokens() != 21 {
		t.Fatalf("Since(0) = %+v latest=%d truncated=%v", events, latest, truncated)
	}
	if events, _, _ := feed.Since(2); len(events) != 0 {
		t.Fatalf("Since(latest) = %+v, want none", events)
	}

	for index := 0; index < 3; index++ {
		feed.Append(ref, "gpt-5.5", now, mustUsage(t, 1, 1))
	}
	events, latest, truncated = feed.Since(1)
	if latest != 5 || !truncated || len(events) != 3 || events[0].Seq != 3 {
		t.Fatalf("after overflow Since(1) = %+v latest=%d truncated=%v", events, latest, truncated)
	}
	if feed.BootID() == "" {
		t.Fatal("boot id missing")
	}
}

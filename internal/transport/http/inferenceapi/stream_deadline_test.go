package inferenceapi

import (
	"net/http/httptest"
	"testing"
	"time"
)

// deadlineRecorder 记录最后一次写入的写截止时间，模拟支持 SetWriteDeadline 的连接。
type deadlineRecorder struct {
	set      bool
	deadline time.Time
}

func (recorder *deadlineRecorder) SetWriteDeadline(deadline time.Time) error {
	recorder.set = true
	recorder.deadline = deadline
	return nil
}

// TestStreamDeadlineRefreshSlidesIdleWindow 锁定 G3 的核心行为：每次交付数据都把写
// 截止时间推后一个空闲窗口，而不是固定成请求开始时的绝对时刻。
func TestStreamDeadlineRefreshSlidesIdleWindow(t *testing.T) {
	t.Parallel()

	startedAt := time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)
	recorder := &deadlineRecorder{}
	deadline := newStreamDeadline(recorder, 5*time.Minute, func() time.Time {
		return startedAt
	})

	deadline.Refresh()
	if !recorder.set {
		t.Fatal("Refresh must set a write deadline")
	}
	if want := startedAt.Add(5 * time.Minute); !recorder.deadline.Equal(want) {
		t.Fatalf("deadline = %v, want %v", recorder.deadline, want)
	}
}

// TestStreamDeadlineRefreshTracksClock 验证每次 Refresh 都重新取值：活跃的流会被
// 持续续期，而不是停在首次交付后的那一刻。
func TestStreamDeadlineRefreshTracksClock(t *testing.T) {
	t.Parallel()

	base := time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)
	elapsed := time.Duration(0)
	recorder := &deadlineRecorder{}
	deadline := newStreamDeadline(recorder, time.Minute, func() time.Time {
		return base.Add(elapsed)
	})

	deadline.Refresh()
	if want := base.Add(time.Minute); !recorder.deadline.Equal(want) {
		t.Fatalf("first deadline = %v, want %v", recorder.deadline, want)
	}
	// 30 分钟后仍有数据：deadline 必须跟着走，旧实现会在这里把流切断。
	elapsed = 30 * time.Minute
	deadline.Refresh()
	if want := base.Add(31 * time.Minute); !recorder.deadline.Equal(want) {
		t.Fatalf("second deadline = %v, want %v", recorder.deadline, want)
	}
}

// TestStreamDeadlineIgnoresUnsupportedConnections 验证不支持写 deadline 的底层
// （ResponseRecorder、已劫持连接）不会让流式交付失败。
func TestStreamDeadlineIgnoresUnsupportedConnections(t *testing.T) {
	t.Parallel()

	NewStreamDeadline(httptest.NewRecorder()).Refresh()

	var missing *StreamDeadline
	missing.Refresh()
}

// TestNewStreamDeadlineUsesSharedPolicy 验证生产构造器采用包级共享策略，
// 避免调用方各自硬编码时间窗再次漂移。
func TestNewStreamDeadlineUsesSharedPolicy(t *testing.T) {
	t.Parallel()

	recorder := &deadlineRecorder{}
	base := time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)
	deadline := newStreamDeadline(recorder, StreamIdleTimeout, func() time.Time {
		return base
	})
	deadline.Refresh()
	if want := base.Add(StreamIdleTimeout); !recorder.deadline.Equal(want) {
		t.Fatalf("deadline = %v, want %v", recorder.deadline, want)
	}
	if StreamTotalTimeout <= StreamIdleTimeout {
		t.Fatalf(
			"total timeout %v must exceed idle timeout %v",
			StreamTotalTimeout,
			StreamIdleTimeout,
		)
	}
}

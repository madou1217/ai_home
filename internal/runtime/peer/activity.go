package peer

import (
	"context"
	"crypto/sha256"
	"errors"
	"sync"
	"time"
)

// errPaneProbeUnavailable 表示探测会话内容所需的 tmux 不可用。
var errPaneProbeUnavailable = errors.New("tmux_unavailable")

// PaneActivityTracker 用 pane 可见内容的指纹判断会话是否真的在产出新内容。
//
// tmux 的 #{window_activity} 会把 TUI 的光标闪烁也算作输出：实测 agy/Gemini 空闲时
// 该时间戳仍然逐秒推进，但 capture-pane 的内容完全不变。用它判定“回合是否在跑”
// 会让空闲会话永久显示 target_busy，补投队列只能等到 24h 过期。内容指纹不受光标
// 闪烁影响：没有真实输出就是安静。
type PaneActivityTracker struct {
	mu       sync.Mutex
	entries  map[string]paneActivityEntry
	now      func() time.Time
	runner   TmuxCommandRunner
	tmuxPath string
}

type paneActivityEntry struct {
	digest [sha256.Size]byte
	since  int64
}

// NewPaneActivityTracker 创建内容指纹活动追踪器；now 为空时使用 time.Now。
// runner/tmuxPath 与投递共用同一套 tmux 入口，未注入时按默认探测。
func NewPaneActivityTracker(now func() time.Time, runner TmuxCommandRunner, tmuxPath string) *PaneActivityTracker {
	if now == nil {
		now = time.Now
	}
	return &PaneActivityTracker{
		entries:  make(map[string]paneActivityEntry),
		now:      now,
		runner:   runner,
		tmuxPath: tmuxPath,
	}
}

// ReadActivityAt 返回该会话最近一次“可见内容发生变化”的时刻。
//
// 首次观测按“刚刚有活动”处理，保证补投不会在未确认空闲前抢跑；之后只有内容
// 变化才推后时间戳，与光标闪烁无关。
func (t *PaneActivityTracker) ReadActivityAt(ctx context.Context, target DeliveryTarget) (int64, error) {
	socket, err := DeriveSocket(target.CLIName, target.RuntimeScope)
	if err != nil {
		return 0, err
	}
	runner := t.runner
	tmuxCmd := t.tmuxPath
	if runner == nil {
		if tmuxCmd == "" {
			tmuxCmd = detectTmuxCommand()
		}
		if tmuxCmd == "" {
			return 0, errPaneProbeUnavailable
		}
		runner = defaultTmuxRunner
	} else if tmuxCmd == "" {
		tmuxCmd = "tmux"
	}

	probeCtx, cancel := context.WithTimeout(ctx, ActivityProbeTimeout)
	defer cancel()
	stdout, code, err := runner(probeCtx, tmuxCmd, []string{"-u", "-L", socket, "capture-pane", "-p", "-t", target.SessionName})
	if err != nil || code != 0 {
		return 0, err
	}
	digest := sha256.Sum256([]byte(stdout))
	nowMs := t.now().UnixMilli()
	key := socket + "\x00" + target.SessionName

	t.mu.Lock()
	defer t.mu.Unlock()
	prev, seen := t.entries[key]
	if !seen || prev.digest != digest {
		t.entries[key] = paneActivityEntry{digest: digest, since: nowMs}
		return nowMs, nil
	}
	return prev.since, nil
}

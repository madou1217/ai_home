package accountusage

import "strings"

// 窗口账本：把一次用量快照翻成「当时有没有活跃窗口」，并维护一份
// 「锚点 / 关窗时刻」记录，让统计页不必依赖快照的新鲜度。
//
// 事实与判据与 Node lib/server/window-activation/window-ledger.js 完全一致：
//
//	F1 窗口由「关闭后的第一个真实请求」锚定，reset = 锚点 + 窗口时长；
//	F2 窗口期内的请求不移动锚点 → 同一个 reset 值就是同一个窗口；
//	F3 窗口关闭且空闲时，上游报「读取时刻 + 窗口时长」（幻影），必须剔除；
//	F4 只有真实请求会开窗，纯只读不会。
//
// 账本只有一份（与 Node 相同）：先挑一个窗口条目，再按幻影判据决定
// live / absent。Node 用 probe spec 的 windowMatch 挑条目；Go 没有 probe spec，
// 用「最短窗口优先」表达同一意图 —— 5h 滚动窗口才是激活调度关心的那个，
// 周/月窗口是它的超集。
const (
	// QuotaLedgerSourceSnapshot 表示这条账本事实来自一次用量快照观察。
	QuotaLedgerSourceSnapshot = "snapshot"
	// QuotaLedgerSourceProbe 表示来自一次成功的窗口探测（Go 目前不产生）。
	QuotaLedgerSourceProbe = "probe"
	// QuotaLedgerSourceActivity 表示来自关窗后的真实请求活动（Go 目前不产生）。
	QuotaLedgerSourceActivity = "activity"
)

// QuotaWindowLedger 是「当前窗口」的持久事实；零值等价于「窗口状态未知」。
type QuotaWindowLedger struct {
	WindowMinutes int64
	AnchorAtMS    int64
	CloseAtMS     int64
	Source        string
	ObservedAtMS  int64
}

// QuotaWindowObservation 是一次快照观察的结论。
type QuotaWindowObservation struct {
	// Kind 是 live / absent / unknown。
	Kind string
	// Reason 是可观测的原因，便于诊断「为什么没写账本」。
	Reason        string
	ObservedAtMS  int64
	AnchorAtMS    int64
	CloseAtMS     int64
	WindowMinutes int64
}

// NormalizeQuotaWindowLedger 把坏值读成「没有这条事实」，与 Node normalizeLedger 同口径。
func NormalizeQuotaWindowLedger(ledger QuotaWindowLedger) QuotaWindowLedger {
	normalized := QuotaWindowLedger{
		WindowMinutes: nonNegative(ledger.WindowMinutes),
		AnchorAtMS:    nonNegative(ledger.AnchorAtMS),
		CloseAtMS:     nonNegative(ledger.CloseAtMS),
		ObservedAtMS:  nonNegative(ledger.ObservedAtMS),
	}
	switch strings.TrimSpace(ledger.Source) {
	case QuotaLedgerSourceSnapshot, QuotaLedgerSourceProbe, QuotaLedgerSourceActivity:
		normalized.Source = strings.TrimSpace(ledger.Source)
	}
	return normalized
}

// HasQuotaWindowLedger 判断账本是否记录了可用的关窗时刻。
func (ledger QuotaWindowLedger) HasQuotaWindowLedger() bool {
	normalized := NormalizeQuotaWindowLedger(ledger)
	return normalized.CloseAtMS > 0 && normalized.WindowMinutes > 0
}

// ObserveQuotaWindow 观察快照：capturedAt 时刻到底有没有活跃窗口。
//
// 挑条目规则：最短窗口优先（见文件头注释），同长度取快照顺序里的第一条。
// 没有可用条目 / 缺采集时刻 → unknown；锚点≈读取时刻 → absent（F3）；
// 其余 → live。
func ObserveQuotaWindow(snapshot Snapshot) QuotaWindowObservation {
	capturedAtMS := snapshot.CapturedAt().UnixMilli()
	observation := QuotaWindowObservation{
		Kind:         "unknown",
		Reason:       "window_entry_missing",
		ObservedAtMS: capturedAtMS,
	}
	var selected *Entry
	var selectedMinutes int64
	for _, entry := range snapshot.Entries() {
		if entry.Kind() != KindWindow {
			continue
		}
		windowMinutes := entry.WindowSeconds() / 60
		if windowMinutes <= 0 || entry.ResetAt().IsZero() {
			continue
		}
		if selected == nil || windowMinutes < selectedMinutes {
			copied := entry
			selected = &copied
			selectedMinutes = windowMinutes
		}
	}
	if selected == nil {
		return observation
	}
	observation.WindowMinutes = selectedMinutes
	if capturedAtMS <= 0 {
		// 没有读取时刻就无法区分幻影；宁可不写账本，也不要把假窗口写进去。
		observation.Reason = "capture_time_missing"
		return observation
	}
	resetAtMS := selected.ResetAt().UnixMilli()
	if IsPhantomSample(capturedAtMS, resetAtMS, selectedMinutes) {
		observation.Kind = "absent"
		observation.Reason = "phantom_reset"
		return observation
	}
	observation.Kind = "live"
	observation.Reason = "live_anchor"
	observation.AnchorAtMS = resetAtMS - selectedMinutes*MS_PER_MINUTE
	observation.CloseAtMS = resetAtMS
	return observation
}

// ReconcileQuotaWindowLedger 把观察合并进账本，绝不倒退：
// 只有比账本已记录更新的观察才能覆盖，旧快照与观察不出来的快照一律原样返回。
func ReconcileQuotaWindowLedger(
	ledger QuotaWindowLedger,
	observation QuotaWindowObservation,
) QuotaWindowLedger {
	current := NormalizeQuotaWindowLedger(ledger)
	if observation.Kind != "live" && observation.Kind != "absent" {
		return current
	}
	observedAtMS := observation.ObservedAtMS
	if observedAtMS <= 0 || observedAtMS <= current.ObservedAtMS {
		return current
	}
	if observation.Kind == "live" {
		return QuotaWindowLedger{
			WindowMinutes: positiveOr(observation.WindowMinutes, current.WindowMinutes),
			AnchorAtMS:    nonNegative(observation.AnchorAtMS),
			CloseAtMS:     nonNegative(observation.CloseAtMS),
			Source:        QuotaLedgerSourceSnapshot,
			ObservedAtMS:  observedAtMS,
		}
	}
	// absent：只有「观察到无窗口的时刻」晚于已知关窗时刻才覆盖 —— 否则这条快照
	// 与账本说的是同一件事（当时窗口本来就关着），不该把账本往回推。
	if current.CloseAtMS > 0 && observedAtMS <= current.CloseAtMS {
		return current
	}
	return QuotaWindowLedger{
		WindowMinutes: positiveOr(observation.WindowMinutes, current.WindowMinutes),
		Source:        QuotaLedgerSourceSnapshot,
		ObservedAtMS:  observedAtMS,
	}
}

func positiveOr(value int64, fallback int64) int64 {
	if value > 0 {
		return value
	}
	return fallback
}

func nonNegative(value int64) int64 {
	if value > 0 {
		return value
	}
	return 0
}

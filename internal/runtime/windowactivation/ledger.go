package windowactivation

import (
	"math"
	"strings"
	"time"
)

const (
	// PhantomToleranceMs 判断「锚点 ≈ 读取时刻」的容差（F3 幻影检测）。
	PhantomToleranceMs = 90 * 1000
	// ProbeGraceMs 关窗后等待时间余量，避免卡在关窗临界点前探进旧窗口。
	ProbeGraceMs = 60 * 1000
	// ProbeRetryBackoffMs 普通探测失败的基础退避步长。
	ProbeRetryBackoffMs = 10 * 60 * 1000
	// ActivityEpsMs 区分「自家探测」与「关窗后用户流量」的时间余量。
	ActivityEpsMs = 15 * 1000
	// MsPerMinute 每分钟毫秒数。
	MsPerMinute = 60 * 1000
	// FixedWindowMatchSlackMs 固定窗口模式识别 5h 条目的时钟余量。
	FixedWindowMatchSlackMs = 10 * MsPerMinute
	// MaxProbeFailureCount 探测失败退避计数上限。
	MaxProbeFailureCount = 32
)

// UsageEntry 表示快照中单条窗口或模型配额记录。
type UsageEntry struct {
	WindowMinutes int64
	ResetAtMs     int64
	ResetIn       string
}

// UsageSnapshot 表示窗口账本观测所需的最小快照视图。
type UsageSnapshot struct {
	CapturedAtMs int64
	Entries      []UsageEntry
	Models       []UsageEntry
}

// Ledger 保存单个账号当前活跃窗口锚点与失败退避计数。
type Ledger struct {
	WindowAnchorAtMs   int64
	WindowMinutes      int64
	WindowCloseAtMs    int64
	WindowSource       string
	WindowObservedAtMs int64
	ProbeFailureCount  int64
}

// Observation 描述一次快照观察的窗口真假结论。
type Observation struct {
	Kind          string
	Reason        string
	ObservedAtMs  int64
	AnchorAtMs    int64
	CloseAtMs     int64
	WindowMinutes int64
	Entry         *UsageEntry
}

// WindowView 供调度决策和 WebUI 展示共用的窗口视图。
type WindowView struct {
	Kind           string `json:"kind"`
	AnchorAtMs     int64  `json:"anchorAtMs"`
	CloseAtMs      int64  `json:"closeAtMs"`
	WindowMinutes  int64  `json:"windowMinutes"`
	RemainingMs    int64  `json:"remainingMs"`
	Source         string `json:"source"`
	ObservedAtMs   int64  `json:"observedAtMs"`
	NextActionAtMs int64  `json:"nextActionAtMs"`
}

// ListSnapshotEntries 优先取 snapshot.Entries；若为空（如 agy）则取 snapshot.Models。
func ListSnapshotEntries(snapshot *UsageSnapshot) []UsageEntry {
	if snapshot == nil {
		return nil
	}
	if len(snapshot.Entries) > 0 {
		return snapshot.Entries
	}
	if len(snapshot.Models) > 0 {
		return snapshot.Models
	}
	return nil
}

// FindWindowEntry 从快照条目中按 windowMinutes / fixed 模式 / resetIn 标签匹配滚动窗口项。
func FindWindowEntry(snapshot *UsageSnapshot, match WindowMatch, windowMode string) (UsageEntry, bool) {
	if snapshot == nil {
		return UsageEntry{}, false
	}
	target := match.WindowMinutes
	label := strings.ToLower(strings.TrimSpace(match.ResetInLabel))
	mode := strings.ToLower(strings.TrimSpace(windowMode))
	capturedAt := nonNegMs(snapshot.CapturedAtMs)
	fixedWindowMs := int64(0)
	if target > 0 {
		fixedWindowMs = target * MsPerMinute
	}
	fixedMode := mode == "fixed" && fixedWindowMs > 0
	if target <= 0 && label == "" && !fixedMode {
		return UsageEntry{}, false
	}

	for _, entry := range ListSnapshotEntries(snapshot) {
		if fixedMode && capturedAt > 0 {
			if entry.ResetAtMs > 0 && entry.ResetAtMs-capturedAt <= fixedWindowMs+FixedWindowMatchSlackMs {
				return entry, true
			}
			continue
		}
		if target > 0 && entry.WindowMinutes > 0 && math.Abs(float64(entry.WindowMinutes-target)) < 1 {
			return entry, true
		}
		if label != "" && strings.ToLower(strings.TrimSpace(entry.ResetIn)) == label {
			return entry, true
		}
	}
	return UsageEntry{}, false
}

// NormalizeLedger 归一化账本字段并夹紧失败次数。
func NormalizeLedger(raw Ledger) Ledger {
	source := strings.ToLower(strings.TrimSpace(raw.WindowSource))
	if source != "snapshot" && source != "probe" && source != "activity" {
		source = ""
	}
	failCount := nonNegMs(raw.ProbeFailureCount)
	if failCount > MaxProbeFailureCount {
		failCount = MaxProbeFailureCount
	}
	return Ledger{
		WindowAnchorAtMs:   nonNegMs(raw.WindowAnchorAtMs),
		WindowMinutes:      nonNegMs(raw.WindowMinutes),
		WindowCloseAtMs:    nonNegMs(raw.WindowCloseAtMs),
		WindowSource:       source,
		WindowObservedAtMs: nonNegMs(raw.WindowObservedAtMs),
		ProbeFailureCount:  failCount,
	}
}

// IsPhantomSample 按 F3 唯一几何判据判定 resetAtMs 是否属于「读取时刻现算的幻影值」。
func IsPhantomSample(capturedAtMs, resetAtMs, windowMinutes int64) bool {
	if capturedAtMs <= 0 || resetAtMs <= 0 || windowMinutes <= 0 {
		return false
	}
	anchorDiff := capturedAtMs - (resetAtMs - windowMinutes*MsPerMinute)
	if anchorDiff < 0 {
		anchorDiff = -anchorDiff
	}
	return anchorDiff <= PhantomToleranceMs
}

// ObserveWindow 结合上次探测时间对用量快照做 F1-F4 窗口真假观测。
func ObserveWindow(snapshot *UsageSnapshot, spec ProbeSpec, lastProbeAtMs int64) Observation {
	capturedAt := int64(0)
	if snapshot != nil {
		capturedAt = nonNegMs(snapshot.CapturedAtMs)
	}
	base := Observation{
		Kind:         "unknown",
		Reason:       "window_entry_missing",
		ObservedAtMs: capturedAt,
	}
	entry, found := FindWindowEntry(snapshot, spec.WindowMatch, spec.WindowMode)
	if !found {
		return base
	}
	entryCopy := entry

	declaredMinutes := int64(0)
	if strings.EqualFold(strings.TrimSpace(spec.WindowMode), "fixed") && spec.WindowMatch.WindowMinutes > 0 {
		declaredMinutes = spec.WindowMatch.WindowMinutes
	}
	windowMinutes := nonNegMs(entry.WindowMinutes)
	if windowMinutes <= 0 {
		windowMinutes = declaredMinutes
	}
	resetAtMs := nonNegMs(entry.ResetAtMs)
	if windowMinutes <= 0 || resetAtMs <= 0 {
		base.Reason = "window_entry_unusable"
		base.Entry = &entryCopy
		return base
	}
	if capturedAt <= 0 {
		base.Reason = "capture_time_missing"
		base.Entry = &entryCopy
		return base
	}

	anchorAtMs := resetAtMs - windowMinutes*MsPerMinute
	probeNearAnchor := lastProbeAtMs > 0 && absDiff(lastProbeAtMs, anchorAtMs) <= PhantomToleranceMs
	if IsPhantomSample(capturedAt, resetAtMs, windowMinutes) && !probeNearAnchor {
		return Observation{
			Kind:          "absent",
			Reason:        "phantom_reset",
			ObservedAtMs:  capturedAt,
			WindowMinutes: windowMinutes,
			Entry:         &entryCopy,
		}
	}

	reason := "live_anchor"
	if probeNearAnchor {
		reason = "probe_anchor"
	}
	return Observation{
		Kind:          "live",
		Reason:        reason,
		ObservedAtMs:  capturedAt,
		AnchorAtMs:    anchorAtMs,
		CloseAtMs:     resetAtMs,
		WindowMinutes: windowMinutes,
		Entry:         &entryCopy,
	}
}

// ReconcileLedger 单调合并新观测到账本中：旧快照与 unknown 一律不覆盖。
func ReconcileLedger(ledger Ledger, observation Observation) Ledger {
	current := NormalizeLedger(ledger)
	if observation.Kind == "" || observation.Kind == "unknown" {
		return current
	}
	observedAtMs := nonNegMs(observation.ObservedAtMs)
	if observedAtMs <= 0 || observedAtMs <= current.WindowObservedAtMs {
		return current
	}

	if observation.Kind == "live" {
		minutes := nonNegMs(observation.WindowMinutes)
		if minutes <= 0 {
			minutes = current.WindowMinutes
		}
		return Ledger{
			WindowAnchorAtMs:   nonNegMs(observation.AnchorAtMs),
			WindowMinutes:      minutes,
			WindowCloseAtMs:    nonNegMs(observation.CloseAtMs),
			WindowSource:       "snapshot",
			WindowObservedAtMs: observedAtMs,
			ProbeFailureCount:  current.ProbeFailureCount,
		}
	}

	// absent：观察时刻早于已知关窗时刻时，不应回退账本。
	if current.WindowCloseAtMs > 0 && observedAtMs <= current.WindowCloseAtMs {
		return current
	}
	minutes := nonNegMs(observation.WindowMinutes)
	if minutes <= 0 {
		minutes = current.WindowMinutes
	}
	return Ledger{
		WindowAnchorAtMs:   0,
		WindowMinutes:      minutes,
		WindowCloseAtMs:    0,
		WindowSource:       "snapshot",
		WindowObservedAtMs: observedAtMs,
		ProbeFailureCount:  current.ProbeFailureCount,
	}
}

// DescribeWindowView 把账本转换成调度和展示共用的 WindowView。
func DescribeWindowView(ledger Ledger, nowMs int64) WindowView {
	current := NormalizeLedger(ledger)
	if nowMs <= 0 {
		nowMs = time.Now().UnixMilli()
	}
	closeAtMs := current.WindowCloseAtMs
	if closeAtMs > 0 && nowMs < closeAtMs {
		return WindowView{
			Kind:           "open",
			AnchorAtMs:     current.WindowAnchorAtMs,
			CloseAtMs:      closeAtMs,
			WindowMinutes:  current.WindowMinutes,
			RemainingMs:    closeAtMs - nowMs,
			Source:         current.WindowSource,
			ObservedAtMs:   current.WindowObservedAtMs,
			NextActionAtMs: closeAtMs + ProbeGraceMs,
		}
	}
	if closeAtMs > 0 {
		return WindowView{
			Kind:           "closed",
			AnchorAtMs:     current.WindowAnchorAtMs,
			CloseAtMs:      closeAtMs,
			WindowMinutes:  current.WindowMinutes,
			RemainingMs:    0,
			Source:         current.WindowSource,
			ObservedAtMs:   current.WindowObservedAtMs,
			NextActionAtMs: nowMs,
		}
	}
	if current.WindowObservedAtMs > 0 {
		return WindowView{
			Kind:           "absent",
			AnchorAtMs:     0,
			CloseAtMs:      0,
			WindowMinutes:  current.WindowMinutes,
			RemainingMs:    0,
			Source:         current.WindowSource,
			ObservedAtMs:   current.WindowObservedAtMs,
			NextActionAtMs: nowMs,
		}
	}
	return WindowView{
		Kind:           "unknown",
		AnchorAtMs:     0,
		CloseAtMs:      0,
		WindowMinutes:  current.WindowMinutes,
		RemainingMs:    0,
		Source:         "",
		ObservedAtMs:   0,
		NextActionAtMs: 0,
	}
}

// AnchorWindowAt 将账本锚定在已知的开窗时刻（source 为 probe 或 activity）。
func AnchorWindowAt(ledger Ledger, atMs, windowMinutes int64, source string) Ledger {
	current := NormalizeLedger(ledger)
	anchorAtMs := nonNegMs(atMs)
	minutes := nonNegMs(windowMinutes)
	if minutes <= 0 {
		minutes = current.WindowMinutes
	}
	if anchorAtMs <= 0 || minutes <= 0 {
		return current
	}
	normalizedSource := "probe"
	failCount := int64(0)
	if strings.EqualFold(strings.TrimSpace(source), "activity") {
		normalizedSource = "activity"
		failCount = current.ProbeFailureCount
	}
	return Ledger{
		WindowAnchorAtMs:   anchorAtMs,
		WindowMinutes:      minutes,
		WindowCloseAtMs:    anchorAtMs + minutes*MsPerMinute,
		WindowSource:       normalizedSource,
		WindowObservedAtMs: anchorAtMs,
		ProbeFailureCount:  failCount,
	}
}

// MarkProbeFailure 增加退避计数（封顶 MaxProbeFailureCount）。
func MarkProbeFailure(ledger Ledger) Ledger {
	current := NormalizeLedger(ledger)
	if current.ProbeFailureCount < MaxProbeFailureCount {
		current.ProbeFailureCount++
	}
	return current
}

// ClearProbeFailure 探测成功后清零失败计数。
func ClearProbeFailure(ledger Ledger) Ledger {
	current := NormalizeLedger(ledger)
	current.ProbeFailureCount = 0
	return current
}

func nonNegMs(value int64) int64 {
	if value <= 0 {
		return 0
	}
	return value
}

func absDiff(a, b int64) int64 {
	if a >= b {
		return a - b
	}
	return b - a
}

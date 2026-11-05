package accountusage

import (
	"sort"
	"strings"
)

// 额度窗口重建：把采样序列翻成一段连续的窗口列表。
//
// 依据与 Node 侧 window-ledger 相同的 F1–F4：
//
//	F1 窗口由「关闭后的第一个真实请求」锚定，reset = 锚点 + 窗口时长；
//	F2 窗口内的请求不移动锚点 → 同一个 resetAtMs 就代表同一个窗口；
//	F3 窗口关闭且空闲时，上游报 reset ≈ 读取时刻 + 窗口时长（幻影），必须剔除；
//	F4 只有真实请求会开窗。
//
// 所以「一个窗口」的天然主键是 expectedResetAtMs：锚点永远由 reset - 时长反推。
// 本文件是纯函数：不读盘、不发请求、不含 Provider 名。
const (
	// MS_PER_MINUTE 是分钟到毫秒的换算常量。
	MS_PER_MINUTE = int64(60_000)
	// PhantomToleranceMS 是幻影判据的容差：幻影的差值≈0，真实活跃窗口至少是分钟级。
	PhantomToleranceMS = int64(90_000)
	// ResetMatchToleranceMS 用于把当前快照窗口与已有分组对齐。
	ResetMatchToleranceMS = int64(2 * 60_000)
	// StartCoverageToleranceMS 内没有样本时，窗口起点视为估算值。
	StartCoverageToleranceMS = int64(10 * 60_000)
	// EndCoverageToleranceMS 内没有样本时，窗口末端视为估算值。
	EndCoverageToleranceMS = int64(15 * 60_000)
	// MaxQuotaWindows 是单次查询最多返回的窗口数（90 天 / 5h ≈ 432）。
	MaxQuotaWindows = 500
)

// QuotaWindowDimension 是一个统计维度（窗口长度）。
type QuotaWindowDimension struct {
	WindowMinutes int64
	Label         string
}

var quotaWindowDimensions = []QuotaWindowDimension{
	{WindowMinutes: 300, Label: "5h"},
	{WindowMinutes: 10080, Label: "7days"},
	{WindowMinutes: 43200, Label: "30days"},
}

// QuotaWindowDimensions 返回统计维度的副本，避免调用方改到包级变量。
func QuotaWindowDimensions() []QuotaWindowDimension {
	dimensions := make([]QuotaWindowDimension, len(quotaWindowDimensions))
	copy(dimensions, quotaWindowDimensions)
	return dimensions
}

// QuotaWindowSample 是一次额度观测落库后的样本行。
type QuotaWindowSample struct {
	QuotaKey          string
	WindowLabel       string
	WindowMinutes     int64
	RemainingPct      *float64
	ExpectedResetAtMS int64
	CapturedAtMS      int64
	PlanType          string
}

// CurrentQuotaWindow 是当前快照里仍在进行的窗口（可能还没有任何样本）。
type CurrentQuotaWindow struct {
	WindowMinutes int64
	ResetAtMS     int64
	RemainingPct  *float64
	CapturedAtMS  int64
}

// QuotaWindowScope 是一个 (quotaKey, 窗口长度) 组合的采样覆盖情况。
type QuotaWindowScope struct {
	QuotaKey         string
	WindowLabel      string
	WindowMinutes    int64
	SampleCount      int64
	LastCapturedAtMS int64
}

// QuotaWindowRange 是一个待聚合的窗口区间（半开 [StartMS, EndMS)）。
type QuotaWindowRange struct {
	Index   int
	StartMS int64
	EndMS   int64
}

// QuotaWindowUsage 是一个窗口区间内的推理用量。
type QuotaWindowUsage struct {
	Index        int
	Tokens       int64
	RequestCount int64
}

// QuotaWindow 是一个重建出来的真实窗口。
type QuotaWindow struct {
	Index              int      `json:"index"`
	AnchorAtMS         int64    `json:"anchor_at_ms"`
	CloseAtMS          int64    `json:"close_at_ms"`
	ScheduledCloseAtMS int64    `json:"scheduled_close_at_ms"`
	Live               bool     `json:"live"`
	RemainingStartPct  *float64 `json:"remaining_start_pct"`
	RemainingEndPct    *float64 `json:"remaining_end_pct"`
	RemainingMinPct    *float64 `json:"remaining_min_pct"`
	ConsumedPct        *float64 `json:"consumed_pct"`
	PeakConsumedPct    *float64 `json:"peak_consumed_pct"`
	StartEstimated     bool     `json:"start_estimated"`
	SampleCount        int      `json:"sample_count"`
	ObservedFromMS     int64    `json:"observed_from_ms"`
	ObservedToMS       int64    `json:"observed_to_ms"`
	Source             string   `json:"source"`
	Confidence         string   `json:"confidence"`
	PlanType           string   `json:"plan_type"`
	AnchorEstimated    bool     `json:"anchor_estimated"`
}

// IsPhantomSample 判断一条样本是否来自「窗口关闭且空闲」时的幻影 reset。
//
// 判据与 window activation 的调度器完全一致：|采集时刻 - (reset - 窗口时长)| ≤ 90s。
// 两类误判代价不对称：误判成幻影会少一个窗口，误判成真实会造出假窗口。
func IsPhantomSample(capturedAtMS, resetAtMS, windowMinutes int64) bool {
	if capturedAtMS <= 0 || resetAtMS <= 0 || windowMinutes <= 0 {
		return false
	}
	anchorAtMS := resetAtMS - windowMinutes*MS_PER_MINUTE
	delta := capturedAtMS - anchorAtMS
	if delta < 0 {
		delta = -delta
	}
	return delta <= PhantomToleranceMS
}

// BuildQuotaWindowsInput 是窗口重建的全部输入。
type BuildQuotaWindowsInput struct {
	Samples       []QuotaWindowSample
	Current       *CurrentQuotaWindow
	WindowMinutes int64
	QuotaKey      string
	RangeFromMS   int64
	RangeToMS     int64
	NowMS         int64
}

type quotaWindowGroup struct {
	closeAtMS  int64
	anchorAtMS int64
	samples    []QuotaWindowSample
}

// BuildQuotaWindows 按 expectedResetAtMs 分组重建窗口。
//
// 只有真实样本能开窗；整组都是幻影的分组会被丢弃（F3）。
// Current 只用于补一个「仍在进行、还没有样本」的窗口，不会凭空造出已关闭的窗口。
func BuildQuotaWindows(input BuildQuotaWindowsInput) []QuotaWindow {
	windowMinutes := input.WindowMinutes
	if windowMinutes <= 0 {
		return nil
	}
	windowMS := windowMinutes * MS_PER_MINUTE
	quotaKey := strings.TrimSpace(input.QuotaKey)
	nowMS := input.NowMS
	rangeToMS := input.RangeToMS
	if rangeToMS == 0 {
		rangeToMS = nowMS
	}
	rangeFromMS := input.RangeFromMS
	if rangeFromMS == 0 {
		rangeFromMS = rangeToMS - 30*24*60*60*1000
	}

	groups := make(map[int64]*quotaWindowGroup, len(input.Samples))
	for _, sample := range input.Samples {
		if sample.WindowMinutes != windowMinutes {
			continue
		}
		sampleQuotaKey := strings.TrimSpace(sample.QuotaKey)
		if quotaKey != "" && sampleQuotaKey != "" && sampleQuotaKey != quotaKey {
			continue
		}
		if sample.ExpectedResetAtMS <= 0 || sample.CapturedAtMS <= 0 {
			continue
		}
		group := groups[sample.ExpectedResetAtMS]
		if group == nil {
			group = &quotaWindowGroup{
				closeAtMS:  sample.ExpectedResetAtMS,
				anchorAtMS: sample.ExpectedResetAtMS - windowMS,
			}
			groups[sample.ExpectedResetAtMS] = group
		}
		// 幻影样本不参与任何计算：它既不能证明窗口存在，也不能代表额度消耗。
		if IsPhantomSample(sample.CapturedAtMS, sample.ExpectedResetAtMS, windowMinutes) {
			continue
		}
		group.samples = append(group.samples, sample)
	}
	for closeAtMS, group := range groups {
		if len(group.samples) == 0 {
			delete(groups, closeAtMS)
		}
	}

	// 当前快照窗口：能对齐已有分组就标记为 live；对不上且仍在未来，才补一个空窗口。
	if current := input.Current; current != nil &&
		current.WindowMinutes == windowMinutes &&
		current.ResetAtMS > 0 {
		matched := false
		for _, group := range groups {
			if absInt64(group.closeAtMS-current.ResetAtMS) <= ResetMatchToleranceMS {
				matched = true
				break
			}
		}
		if !matched && current.ResetAtMS > nowMS {
			groups[current.ResetAtMS] = &quotaWindowGroup{
				closeAtMS:  current.ResetAtMS,
				anchorAtMS: current.ResetAtMS - windowMS,
			}
		}
	}

	windows := make([]QuotaWindow, 0, len(groups))
	for _, group := range groups {
		windows = append(windows, buildQuotaWindowRow(group, windowMinutes, nowMS))
	}

	clipped := windows[:0]
	for _, window := range windows {
		if window.CloseAtMS > rangeFromMS && window.AnchorAtMS < rangeToMS {
			clipped = append(clipped, window)
		}
	}
	sort.Slice(clipped, func(left, right int) bool {
		return clipped[left].AnchorAtMS < clipped[right].AnchorAtMS
	})
	if len(clipped) > MaxQuotaWindows {
		clipped = clipped[len(clipped)-MaxQuotaWindows:]
	}
	for index := range clipped {
		clipped[index].Index = index
	}
	return clipped
}

func buildQuotaWindowRow(
	group *quotaWindowGroup,
	windowMinutes int64,
	nowMS int64,
) QuotaWindow {
	closeAtMS := group.closeAtMS
	live := closeAtMS > nowMS

	samples := make([]QuotaWindowSample, len(group.samples))
	copy(samples, group.samples)
	sort.Slice(samples, func(left, right int) bool {
		return samples[left].CapturedAtMS < samples[right].CapturedAtMS
	})

	var first, last *QuotaWindowSample
	if len(samples) > 0 {
		first = &samples[0]
		last = &samples[len(samples)-1]
	}

	var remainingStartPct, remainingEndPct, remainingMinPct *float64
	for index := range samples {
		pct := samples[index].RemainingPct
		if pct == nil {
			continue
		}
		value := *pct
		if remainingMinPct == nil || value < *remainingMinPct {
			copied := value
			remainingMinPct = &copied
		}
	}
	if first != nil && first.RemainingPct != nil {
		value := *first.RemainingPct
		remainingStartPct = &value
	}
	if last != nil && last.RemainingPct != nil {
		value := *last.RemainingPct
		remainingEndPct = &value
	}

	// 新窗口的起点必然是满额：消耗 = 100 - 窗口末剩余。
	// 不能拿「第一个观测样本」当起点，否则晚采样会把消耗算少。
	var consumedPct, peakConsumedPct *float64
	if remainingEndPct != nil {
		consumedPct = clampPercent(100 - *remainingEndPct)
	}
	if remainingMinPct != nil {
		peakConsumedPct = clampPercent(100 - *remainingMinPct)
	}

	startEstimated := first == nil ||
		first.CapturedAtMS-group.anchorAtMS > StartCoverageToleranceMS
	var endCovered bool
	if last == nil {
		endCovered = false
	} else if live {
		endCovered = nowMS-last.CapturedAtMS <= EndCoverageToleranceMS
	} else {
		endCovered = absInt64(closeAtMS-last.CapturedAtMS) <= EndCoverageToleranceMS
	}

	source := "sample"
	confidence := "medium"
	switch {
	case len(samples) == 0:
		// 只有当前快照背书、没有任何样本的窗口。
		source = "live"
		confidence = "low"
	case startEstimated || !endCovered:
		source = "reconstructed"
	case len(samples) >= 3:
		confidence = "high"
	}

	planType := ""
	if last != nil {
		planType = strings.TrimSpace(last.PlanType)
	}
	if planType == "" && first != nil {
		planType = strings.TrimSpace(first.PlanType)
	}

	row := QuotaWindow{
		AnchorAtMS:         group.anchorAtMS,
		CloseAtMS:          closeAtMS,
		ScheduledCloseAtMS: group.closeAtMS,
		Live:               live,
		RemainingStartPct:  remainingStartPct,
		RemainingEndPct:    remainingEndPct,
		RemainingMinPct:    remainingMinPct,
		ConsumedPct:        consumedPct,
		PeakConsumedPct:    peakConsumedPct,
		StartEstimated:     startEstimated,
		SampleCount:        len(samples),
		Source:             source,
		Confidence:         confidence,
		PlanType:           planType,
	}
	if first != nil {
		row.ObservedFromMS = first.CapturedAtMS
	}
	if last != nil {
		row.ObservedToMS = last.CapturedAtMS
	}
	return row
}

func clampPercent(value float64) *float64 {
	if value < 0 {
		value = 0
	}
	if value > 100 {
		value = 100
	}
	return &value
}

func absInt64(value int64) int64 {
	if value < 0 {
		return -value
	}
	return value
}

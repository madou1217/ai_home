package accountusage

import (
	"fmt"
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

// QuotaWindowModelUsage 是窗口内某个模型的 token 明细。
//
// 为什么需要按模型拆：成本 = Σ(token × 该模型单价)，没有这个明细就只能给出总额，
// 无法定价。Provider 参与匹配（同一个模型名在不同 Provider 下可能是不同目录键）。
type QuotaWindowModelUsage struct {
	Provider                 string
	Model                    string
	InputTokens              int64
	OutputTokens             int64
	CacheReadInputTokens     int64
	CacheCreationInputTokens int64
	ReasoningOutputTokens    int64
	Tokens                   int64
	RequestCount             int64
}

// QuotaWindowUsage 是一个窗口区间内的推理用量。
type QuotaWindowUsage struct {
	Index        int
	Tokens       int64
	RequestCount int64
	// Models 是按模型拆开的明细；为空表示窗口内没有请求。
	Models []QuotaWindowModelUsage
}

// QuotaWindow 是一个重建出来的真实窗口。
type QuotaWindow struct {
	Index              int      `json:"index"`
	AnchorAtMS         int64    `json:"anchor_at_ms"`
	CloseAtMS          int64    `json:"close_at_ms"`
	ScheduledCloseAtMS int64    `json:"scheduled_close_at_ms"`
	Truncated          bool     `json:"truncated"`
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
	ResetKind          string   `json:"reset_kind"`
	Classification     string   `json:"classification"`
	PlanType           string   `json:"plan_type"`
	ApproximateClose   bool     `json:"approximate_close"`
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
	ResetEvents   []QuotaResetEvent
	Ledger        *QuotaWindowLedger
	Current       *CurrentQuotaWindow
	WindowMinutes int64
	QuotaKey      string
	RangeFromMS   int64
	RangeToMS     int64
	NowMS         int64
}

type quotaWindowGroup struct {
	key                   string
	closeAtMS             int64
	anchorAtMS            int64
	samples               []QuotaWindowSample
	event                 *QuotaResetEvent
	truncated             bool
	anchorEstimated       bool
	approximateClose      bool
	ledgerBacked          bool
	ledgerAnchorEstimated bool
}

// BuildQuotaWindows 按 expectedResetAtMs 分组重建窗口。
//
// 只有真实样本能开窗；整组都是幻影的分组会被丢弃（F3）。
// 重置事件可以把一个窗口截断在回血时刻，也可以在没有任何样本时单独成窗；
// 账本则补一个「仍在进行、还没有样本」的窗口。已关闭的窗口必须有样本或事件
// 背书，不凭空造窗。
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

	groups := make(map[string]*quotaWindowGroup, len(input.Samples))
	// ---- 1. 按 expectedResetAtMs 分组，组内剔除幻影 ----
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
		key := fmt.Sprintf("w:%d", sample.ExpectedResetAtMS)
		group := groups[key]
		if group == nil {
			group = &quotaWindowGroup{
				key:        key,
				closeAtMS:  sample.ExpectedResetAtMS,
				anchorAtMS: sample.ExpectedResetAtMS - windowMS,
			}
			groups[key] = group
		}
		// 幻影样本不参与任何计算：它既不能证明窗口存在，也不能代表额度消耗。
		if IsPhantomSample(sample.CapturedAtMS, sample.ExpectedResetAtMS, windowMinutes) {
			continue
		}
		group.samples = append(group.samples, sample)
	}
	for key, group := range groups {
		if len(group.samples) == 0 {
			delete(groups, key)
		}
	}

	// ---- 2. 挂重置事件 ----
	for index := range input.ResetEvents {
		event := &input.ResetEvents[index]
		if !quotaResetEventMatches(event, windowMinutes, quotaKey) {
			continue
		}
		occurredAtMS := event.OccurredAtMS
		if occurredAtMS <= 0 {
			occurredAtMS = event.DetectedAtMS
		}
		if occurredAtMS <= 0 {
			continue
		}
		exact := findQuotaWindowGroup(groups, func(group *quotaWindowGroup) bool {
			return absInt64(group.closeAtMS-occurredAtMS) <= ResetMatchToleranceMS
		})
		if exact != nil {
			if exact.event == nil {
				exact.event = event
			}
			continue
		}
		containing := findQuotaWindowGroup(groups, func(group *quotaWindowGroup) bool {
			return group.anchorAtMS <= occurredAtMS && occurredAtMS < group.closeAtMS
		})
		if containing != nil {
			if containing.event == nil {
				containing.event = event
			}
			if event.EventKind == QuotaResetKindReplenishment {
				// 提前回血：旧窗口在回血时刻结束，新窗口等下一个真实请求再锚定。
				containing.truncated = true
				containing.approximateClose = true
			}
			continue
		}
		isReplenishment := event.EventKind == QuotaResetKindReplenishment
		key := "e:" + event.EventKey
		groups[key] = &quotaWindowGroup{
			key:        key,
			closeAtMS:  occurredAtMS,
			anchorAtMS: occurredAtMS - windowMS,
			event:      event,
			// replenishment 的 occurredAt 是「发现时刻」，真实关窗可能更早一个采集间隔；
			// cycle_rollover 的 occurredAt 是计划关窗时刻，锚点因此是精确的。
			anchorEstimated:  isReplenishment,
			approximateClose: isReplenishment,
		}
	}

	// ---- 3. 合并当前窗口账本 ----
	// 只合并同一窗口长度的账本：账本只有一份，切到别的维度时必须跳过，
	// 否则会把 5h 的活跃窗口错画进 7 天图。
	if input.Ledger != nil {
		ledger := NormalizeQuotaWindowLedger(*input.Ledger)
		if ledger.WindowMinutes == windowMinutes && ledger.CloseAtMS > 0 {
			match := findQuotaWindowGroup(groups, func(group *quotaWindowGroup) bool {
				return absInt64(group.closeAtMS-ledger.CloseAtMS) <= ResetMatchToleranceMS
			})
			if match != nil {
				match.ledgerBacked = true
				match.ledgerAnchorEstimated = ledger.Source == QuotaLedgerSourceActivity
			} else if ledger.CloseAtMS > nowMS {
				group := &quotaWindowGroup{
					key:                   "l:ledger",
					closeAtMS:             ledger.CloseAtMS,
					anchorAtMS:            ledger.CloseAtMS - windowMS,
					ledgerBacked:          true,
					ledgerAnchorEstimated: ledger.Source == QuotaLedgerSourceActivity,
				}
				if ledger.AnchorAtMS > 0 {
					group.anchorAtMS = ledger.AnchorAtMS
				}
				groups[group.key] = group
			}
		}
	}

	// 当前快照窗口：能对齐已有分组就标记为 live；对不上且仍在未来，才补一个空窗口。
	// 已有活跃账本时不再用快照补窗：账本才是「当前窗口」的权威记录，
	// 否则账本与快照的 reset 相差超过容差时会画出两个同时进行的窗口。
	if current := input.Current; current != nil &&
		current.WindowMinutes == windowMinutes &&
		current.ResetAtMS > 0 {
		matched := findQuotaWindowGroup(groups, func(group *quotaWindowGroup) bool {
			return absInt64(group.closeAtMS-current.ResetAtMS) <= ResetMatchToleranceMS
		})
		if matched == nil && current.ResetAtMS > nowMS &&
			findQuotaWindowGroup(groups, func(group *quotaWindowGroup) bool {
				return group.ledgerBacked && group.closeAtMS > nowMS
			}) == nil {
			key := fmt.Sprintf("w:%d", current.ResetAtMS)
			groups[key] = &quotaWindowGroup{
				key:        key,
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

// quotaResetEventMatches 判断事件能否归到当前维度。
//
// 老事件可能没有 window_minutes：这时只有 quotaKey 也能定位维度（同一个 quotaKey
// 不会同时对应 5h 和 7d）。两者都没有的事件无法归维，宁可少一个窗口，
// 也不要把 5h 的重置画进 7 天图。
func quotaResetEventMatches(
	event *QuotaResetEvent,
	windowMinutes int64,
	quotaKey string,
) bool {
	eventQuotaKey := strings.TrimSpace(event.QuotaKey)
	if quotaKey != "" && eventQuotaKey != "" && eventQuotaKey != quotaKey {
		return false
	}
	if event.WindowMinutes > 0 {
		return event.WindowMinutes == windowMinutes
	}
	return quotaKey != "" && eventQuotaKey == quotaKey
}

func findQuotaWindowGroup(
	groups map[string]*quotaWindowGroup,
	predicate func(group *quotaWindowGroup) bool,
) *quotaWindowGroup {
	for _, group := range groups {
		if predicate(group) {
			return group
		}
	}
	return nil
}

func buildQuotaWindowRow(
	group *quotaWindowGroup,
	windowMinutes int64,
	nowMS int64,
) QuotaWindow {
	scheduledCloseAtMS := group.closeAtMS
	occurredAtMS := int64(0)
	if group.event != nil {
		occurredAtMS = group.event.OccurredAtMS
	}
	closeAtMS := scheduledCloseAtMS
	if group.truncated && occurredAtMS > 0 {
		closeAtMS = occurredAtMS
	}
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

	var eventEndPct *float64
	if group.event != nil {
		eventEndPct = group.event.PreviousRemainingPct
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
	// 事件里的 previousRemainingPct 是重置前最后一次观测，比我们自己的最后一条样本更新。
	if eventEndPct != nil {
		value := *eventEndPct
		remainingEndPct = &value
		if remainingMinPct == nil || value < *remainingMinPct {
			copied := value
			remainingMinPct = &copied
		}
	}
	if remainingEndPct == nil && last != nil && last.RemainingPct != nil {
		value := *last.RemainingPct
		remainingEndPct = &value
	}
	if first != nil && first.RemainingPct != nil {
		value := *first.RemainingPct
		remainingStartPct = &value
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

	startEstimated := group.anchorEstimated ||
		first == nil ||
		first.CapturedAtMS-group.anchorAtMS > StartCoverageToleranceMS
	var endCovered bool
	if group.event != nil {
		endCovered = true
	} else if last == nil {
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
		// 只有事件或当前快照背书、没有任何样本的窗口。
		if live {
			source = "live"
		} else {
			source = "reset"
		}
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
		ScheduledCloseAtMS: scheduledCloseAtMS,
		Truncated:          group.truncated,
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
		ApproximateClose:   group.approximateClose,
		AnchorEstimated:    group.anchorEstimated || group.ledgerAnchorEstimated,
	}
	if group.event != nil {
		row.ResetKind = group.event.EventKind
		row.Classification = group.event.Classification
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

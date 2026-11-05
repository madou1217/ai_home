package accountusage

import (
	"context"
	"errors"
	"math"
	"strings"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
)

const (
	// MinQuotaStatsRangeDays 是统计页允许的最小范围。
	MinQuotaStatsRangeDays = 1
	// MaxQuotaStatsRangeDays 是统计页允许的最大范围（90 天 ≈ 432 个 5h 窗口）。
	MaxQuotaStatsRangeDays = 90
	// DefaultQuotaStatsRangeDays 是未指定范围时的默认值。
	DefaultQuotaStatsRangeDays = 30
	dayMS                      = int64(24 * 60 * 60 * 1000)
)

var (
	// ErrInvalidQuotaStatsQuery 表示账号、窗口长度或范围参数无效。
	ErrInvalidQuotaStatsQuery = errors.New("额度统计查询无效")
	// ErrQuotaStatsUnavailable 表示额度统计缺少采样或用量端口。
	ErrQuotaStatsUnavailable = errors.New("额度统计依赖不可用")
)

// QuotaWindowSampleStore 提供额度窗口采样与覆盖范围。
type QuotaWindowSampleStore interface {
	ListQuotaWindowSamples(
		ctx context.Context,
		accountRef string,
		quotaKey string,
		windowMinutes int64,
		fromMS int64,
		toMS int64,
	) ([]usagecore.QuotaWindowSample, error)
	ListQuotaWindowScopes(
		ctx context.Context,
		accountRef string,
	) ([]usagecore.QuotaWindowScope, error)
}

// QuotaWindowUsageStore 提供按窗口区间聚合的推理用量。
type QuotaWindowUsageStore interface {
	QueryQuotaWindowUsage(
		ctx context.Context,
		accountRef string,
		windows []usagecore.QuotaWindowRange,
	) ([]usagecore.QuotaWindowUsage, error)
}

// QuotaStatsDependencies 是额度统计服务的全部端口。
type QuotaStatsDependencies struct {
	Samples   QuotaWindowSampleStore
	Usage     QuotaWindowUsageStore
	Snapshots SnapshotStore
	Clock     Clock
}

// QuotaStatsService 编排「维度可用性 → 选 scope → 窗口重建 → 用量聚合 → 汇总」。
type QuotaStatsService struct {
	samples   QuotaWindowSampleStore
	usage     QuotaWindowUsageStore
	snapshots SnapshotStore
	clock     Clock
}

// NewQuotaStatsService 创建额度统计服务；任一端口缺失都失败关闭。
func NewQuotaStatsService(dependencies QuotaStatsDependencies) (*QuotaStatsService, error) {
	if dependencies.Samples == nil ||
		dependencies.Usage == nil ||
		dependencies.Snapshots == nil ||
		dependencies.Clock == nil {
		return nil, ErrQuotaStatsUnavailable
	}
	return &QuotaStatsService{
		samples:   dependencies.Samples,
		usage:     dependencies.Usage,
		snapshots: dependencies.Snapshots,
		clock:     dependencies.Clock,
	}, nil
}

// QuotaStatsQuery 是一次额度统计请求。
type QuotaStatsQuery struct {
	AccountRef    accountcore.AccountRef
	WindowMinutes int64
	QuotaKey      string
	RangeDays     int
	Now           time.Time
}

// QuotaStatsRange 是本次统计的时间范围。
type QuotaStatsRange struct {
	FromMS    int64 `json:"from_ms"`
	ToMS      int64 `json:"to_ms"`
	RangeDays int   `json:"range_days"`
}

// QuotaStatsScope 是一个 quotaKey 的采样覆盖情况。
type QuotaStatsScope struct {
	QuotaKey         string `json:"quota_key"`
	Label            string `json:"label"`
	SampleCount      int64  `json:"sample_count"`
	LastCapturedAtMS int64  `json:"last_captured_at_ms"`
}

// QuotaStatsDimension 是一个窗口长度维度的可用性。
type QuotaStatsDimension struct {
	WindowMinutes int64             `json:"window_minutes"`
	Label         string            `json:"label"`
	Available     bool              `json:"available"`
	DataState     string            `json:"data_state"`
	Scopes        []QuotaStatsScope `json:"scopes"`
}

// QuotaStatsCurrent 是当前仍在进行的窗口。
type QuotaStatsCurrent struct {
	RemainingPct *float64 `json:"remaining_pct"`
	ResetAtMS    int64    `json:"reset_at_ms"`
	CapturedAtMS int64    `json:"captured_at_ms"`
}

// QuotaStatsWindow 是一个窗口的额度与用量。
//
// Go 的用量账本不含定价，cost_usd 恒为 null 且 cost_known=false：
// 成本是「不可用」，不是「已知为 0」。
type QuotaStatsWindow struct {
	usagecore.QuotaWindow
	Tokens       int64    `json:"tokens"`
	CostUSD      *float64 `json:"cost_usd"`
	CostKnown    bool     `json:"cost_known"`
	RequestCount int64    `json:"request_count"`
}

// QuotaStatsSummary 是一段范围的汇总。
type QuotaStatsSummary struct {
	WindowCount         int      `json:"window_count"`
	CoveredWindowCount  int      `json:"covered_window_count"`
	TotalTokens         int64    `json:"total_tokens"`
	TotalCostUSD        *float64 `json:"total_cost_usd"`
	CostKnown           bool     `json:"cost_known"`
	RequestCount        int64    `json:"request_count"`
	AvgConsumedPct      *float64 `json:"avg_consumed_pct"`
	MaxConsumedPct      *float64 `json:"max_consumed_pct"`
	MinConsumedPct      *float64 `json:"min_consumed_pct"`
	AvgTokensPerWindow  *int64   `json:"avg_tokens_per_window"`
	AvgCostUSDPerWindow *float64 `json:"avg_cost_usd_per_window"`
	NextCloseAtMS       int64    `json:"next_close_at_ms"`
}

// QuotaStatsResult 是额度统计接口的完整响应。
type QuotaStatsResult struct {
	GeneratedAtMS int64                 `json:"generated_at_ms"`
	Range         QuotaStatsRange       `json:"range"`
	Dimensions    []QuotaStatsDimension `json:"dimensions"`
	WindowMinutes int64                 `json:"window_minutes"`
	Scope         *QuotaStatsScope      `json:"scope"`
	Current       *QuotaStatsCurrent    `json:"current"`
	Summary       QuotaStatsSummary     `json:"summary"`
	Windows       []QuotaStatsWindow    `json:"windows"`
	EmptyReason   string                `json:"empty_reason"`
	// CostSupported 明确告诉调用方「这套统计有没有成本口径」，避免把 null 当成 0。
	CostSupported bool `json:"cost_supported"`
}

// BuildQuotaStats 生成账号的窗口期额度统计。
func (service *QuotaStatsService) BuildQuotaStats(
	ctx context.Context,
	query QuotaStatsQuery,
) (QuotaStatsResult, error) {
	if service == nil || service.samples == nil || service.usage == nil {
		return QuotaStatsResult{}, ErrQuotaStatsUnavailable
	}
	if ctx == nil || !query.AccountRef.IsValid() {
		return QuotaStatsResult{}, ErrInvalidQuotaStatsQuery
	}
	if err := ctx.Err(); err != nil {
		return QuotaStatsResult{}, err
	}
	rangeDays := query.RangeDays
	if rangeDays == 0 {
		rangeDays = DefaultQuotaStatsRangeDays
	}
	if rangeDays < MinQuotaStatsRangeDays || rangeDays > MaxQuotaStatsRangeDays {
		return QuotaStatsResult{}, ErrInvalidQuotaStatsQuery
	}
	now := query.Now
	if now.IsZero() {
		now = service.clock()
	}
	now = now.UTC()
	nowMS := now.UnixMilli()
	rangeFromMS := nowMS - int64(rangeDays)*dayMS

	accountRef := query.AccountRef.String()
	scopes, err := service.samples.ListQuotaWindowScopes(ctx, accountRef)
	if err != nil {
		return QuotaStatsResult{}, err
	}
	dimensions := buildQuotaStatsDimensions(scopes)
	dimension, ok := pickQuotaStatsDimension(dimensions, query.WindowMinutes)
	if !ok {
		return QuotaStatsResult{}, ErrInvalidQuotaStatsQuery
	}

	result := QuotaStatsResult{
		GeneratedAtMS: nowMS,
		Range:         QuotaStatsRange{FromMS: rangeFromMS, ToMS: nowMS, RangeDays: rangeDays},
		Dimensions:    dimensions,
		WindowMinutes: dimension.WindowMinutes,
		Summary:       QuotaStatsSummary{},
		Windows:       []QuotaStatsWindow{},
	}
	if !dimension.Available {
		result.EmptyReason = "dimension_unavailable"
		return result, nil
	}
	scope, ok := pickQuotaStatsScope(dimension, query.QuotaKey)
	if !ok {
		result.EmptyReason = "dimension_unavailable"
		return result, nil
	}
	result.Scope = &scope

	windowMS := dimension.WindowMinutes * usagecore.MS_PER_MINUTE
	// 往前多取一个窗口：跨越范围起点的窗口也要能算出完整边界。
	samples, err := service.samples.ListQuotaWindowSamples(
		ctx,
		accountRef,
		scope.QuotaKey,
		dimension.WindowMinutes,
		rangeFromMS-windowMS,
		nowMS,
	)
	if err != nil {
		return QuotaStatsResult{}, err
	}
	currentWindow, err := service.currentQuotaWindow(ctx, query.AccountRef, scope.QuotaKey, dimension.WindowMinutes)
	if err != nil {
		return QuotaStatsResult{}, err
	}
	if currentWindow != nil {
		result.Current = &QuotaStatsCurrent{
			RemainingPct: currentWindow.RemainingPct,
			ResetAtMS:    currentWindow.ResetAtMS,
			CapturedAtMS: currentWindow.CapturedAtMS,
		}
	}

	windows := usagecore.BuildQuotaWindows(usagecore.BuildQuotaWindowsInput{
		Samples:       samples,
		Current:       currentWindow,
		WindowMinutes: dimension.WindowMinutes,
		QuotaKey:      scope.QuotaKey,
		RangeFromMS:   rangeFromMS,
		RangeToMS:     nowMS,
		NowMS:         nowMS,
	})
	if len(windows) == 0 {
		if len(samples) == 0 {
			result.EmptyReason = "no_samples"
		} else {
			result.EmptyReason = "no_windows_in_range"
		}
		return result, nil
	}

	ranges := make([]usagecore.QuotaWindowRange, 0, len(windows))
	for _, window := range windows {
		endMS := window.CloseAtMS
		if endMS > nowMS {
			endMS = nowMS
		}
		ranges = append(ranges, usagecore.QuotaWindowRange{
			Index:   window.Index,
			StartMS: window.AnchorAtMS,
			EndMS:   endMS,
		})
	}
	usages, err := service.usage.QueryQuotaWindowUsage(ctx, accountRef, ranges)
	if err != nil {
		return QuotaStatsResult{}, err
	}
	usageByIndex := make(map[int]usagecore.QuotaWindowUsage, len(usages))
	for _, usage := range usages {
		usageByIndex[usage.Index] = usage
	}

	rows := make([]QuotaStatsWindow, 0, len(windows))
	for _, window := range windows {
		usage := usageByIndex[window.Index]
		rows = append(rows, QuotaStatsWindow{
			QuotaWindow:  window,
			Tokens:       usage.Tokens,
			CostUSD:      nil,
			CostKnown:    false,
			RequestCount: usage.RequestCount,
		})
	}
	result.Windows = rows
	result.Summary = summarizeQuotaStatsWindows(rows)
	return result, nil
}

func (service *QuotaStatsService) currentQuotaWindow(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	quotaKey string,
	windowMinutes int64,
) (*usagecore.CurrentQuotaWindow, error) {
	snapshot, err := service.snapshots.GetUsageSnapshot(ctx, accountRef)
	if err != nil {
		if errors.Is(err, ErrSnapshotNotFound) {
			return nil, nil
		}
		return nil, err
	}
	capturedAtMS := snapshot.CapturedAt().UnixMilli()
	for _, entry := range snapshot.Entries() {
		if entry.Kind() != usagecore.KindWindow {
			continue
		}
		if entry.WindowSeconds()/60 != windowMinutes {
			continue
		}
		if "rate_limit:"+strings.TrimSpace(entry.Bucket()) != quotaKey {
			continue
		}
		resetAt := entry.ResetAt()
		if resetAt.IsZero() {
			continue
		}
		// 幻影 reset 不能当成当前窗口，否则统计页会把「没有窗口」画成「刚开窗」。
		if usagecore.IsPhantomSample(capturedAtMS, resetAt.UnixMilli(), windowMinutes) {
			continue
		}
		current := &usagecore.CurrentQuotaWindow{
			WindowMinutes: windowMinutes,
			ResetAtMS:     resetAt.UnixMilli(),
			CapturedAtMS:  capturedAtMS,
		}
		if basisPoints, known := entry.RemainingBasisPoints(); known {
			value := float64(basisPoints) / 100
			current.RemainingPct = &value
		}
		return current, nil
	}
	return nil, nil
}

func buildQuotaStatsDimensions(scopes []usagecore.QuotaWindowScope) []QuotaStatsDimension {
	dimensions := make([]QuotaStatsDimension, 0, 3)
	for _, dimension := range usagecore.QuotaWindowDimensions() {
		item := QuotaStatsDimension{
			WindowMinutes: dimension.WindowMinutes,
			Label:         dimension.Label,
			Scopes:        []QuotaStatsScope{},
		}
		hasSamples := false
		for _, scope := range scopes {
			if scope.WindowMinutes != dimension.WindowMinutes {
				continue
			}
			label := strings.TrimSpace(scope.WindowLabel)
			if label == "" {
				label = dimension.Label
			}
			item.Scopes = append(item.Scopes, QuotaStatsScope{
				QuotaKey:         scope.QuotaKey,
				Label:            label,
				SampleCount:      scope.SampleCount,
				LastCapturedAtMS: scope.LastCapturedAtMS,
			})
			if scope.SampleCount > 0 {
				hasSamples = true
			}
		}
		item.Available = len(item.Scopes) > 0
		switch {
		case hasSamples:
			item.DataState = "ready"
		case item.Available:
			item.DataState = "pending"
		default:
			item.DataState = "empty"
		}
		dimensions = append(dimensions, item)
	}
	return dimensions
}

// pickQuotaStatsDimension 在请求维度非法时返回 false（由调用方转 400）；
// 未指定维度时回退到第一个可用维度。
func pickQuotaStatsDimension(
	dimensions []QuotaStatsDimension,
	requestedWindowMinutes int64,
) (QuotaStatsDimension, bool) {
	if requestedWindowMinutes != 0 {
		for _, dimension := range dimensions {
			if dimension.WindowMinutes == requestedWindowMinutes {
				return dimension, true
			}
		}
		return QuotaStatsDimension{}, false
	}
	for _, dimension := range dimensions {
		if dimension.Available {
			return dimension, true
		}
	}
	if len(dimensions) > 0 {
		return dimensions[0], true
	}
	return QuotaStatsDimension{}, false
}

func pickQuotaStatsScope(dimension QuotaStatsDimension, requestedQuotaKey string) (QuotaStatsScope, bool) {
	quotaKey := strings.TrimSpace(requestedQuotaKey)
	if quotaKey != "" {
		for _, scope := range dimension.Scopes {
			if scope.QuotaKey == quotaKey {
				return scope, true
			}
		}
		return QuotaStatsScope{}, false
	}
	if len(dimension.Scopes) == 0 {
		return QuotaStatsScope{}, false
	}
	return dimension.Scopes[0], true
}

func summarizeQuotaStatsWindows(windows []QuotaStatsWindow) QuotaStatsSummary {
	summary := QuotaStatsSummary{WindowCount: len(windows)}
	var consumed []float64
	var totalTokens int64
	var totalRequests int64
	var nextCloseAtMS int64
	for _, window := range windows {
		totalTokens += window.Tokens
		totalRequests += window.RequestCount
		if window.ConsumedPct != nil {
			consumed = append(consumed, *window.ConsumedPct)
		}
		if window.Live && window.CloseAtMS > nextCloseAtMS {
			nextCloseAtMS = window.CloseAtMS
		}
	}
	summary.TotalTokens = totalTokens
	summary.RequestCount = totalRequests
	summary.NextCloseAtMS = nextCloseAtMS
	summary.CoveredWindowCount = len(consumed)
	if len(consumed) > 0 {
		sum := 0.0
		minimum := consumed[0]
		maximum := consumed[0]
		for _, value := range consumed {
			sum += value
			if value < minimum {
				minimum = value
			}
			if value > maximum {
				maximum = value
			}
		}
		summary.AvgConsumedPct = roundOneDecimal(sum / float64(len(consumed)))
		summary.MinConsumedPct = roundOneDecimal(minimum)
		summary.MaxConsumedPct = roundOneDecimal(maximum)
	}
	if len(windows) > 0 {
		average := totalTokens / int64(len(windows))
		summary.AvgTokensPerWindow = &average
	}
	return summary
}

func roundOneDecimal(value float64) *float64 {
	rounded := math.Round(value*10) / 10
	return &rounded
}

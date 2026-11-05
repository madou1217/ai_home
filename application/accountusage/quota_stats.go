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

// QuotaWindowLedgerStore 提供账号级窗口账本（当前窗口的锚点与关窗时刻）。
type QuotaWindowLedgerStore interface {
	GetQuotaWindowLedger(
		ctx context.Context,
		accountRef string,
	) (usagecore.QuotaWindowLedger, bool, error)
}

// QuotaResetEventStore 提供额度重置事件（自然滚动 / 提前回血）。
type QuotaResetEventStore interface {
	ListQuotaResetEvents(
		ctx context.Context,
		accountRef string,
		quotaKey string,
		fromMS int64,
		toMS int64,
	) ([]usagecore.QuotaResetEvent, error)
	ListQuotaResetEventScopes(
		ctx context.Context,
		accountRef string,
	) ([]usagecore.QuotaWindowScope, error)
}

// QuotaStatsDependencies 是额度统计服务的全部端口。
// QuotaWindowPricer 把窗口内某个模型的 token 明细换算成美元成本。
//
// 第二个返回值为 false 表示该模型没有定价：调用方必须把成本标成「未知」，
// 不能当成 0——否则「没查到价格」会显示成「免费」。
type QuotaWindowPricer interface {
	CostFor(
		ctx context.Context,
		provider string,
		model string,
		usage usagecore.QuotaWindowModelUsage,
	) (float64, bool)
}

type QuotaStatsDependencies struct {
	Samples   QuotaWindowSampleStore
	Usage     QuotaWindowUsageStore
	Ledger    QuotaWindowLedgerStore
	Events    QuotaResetEventStore
	Snapshots SnapshotStore
	Clock     Clock
	// Pricer 为空表示没有成本口径，统计仍然可用（cost_supported=false）。
	Pricer QuotaWindowPricer
}

// QuotaStatsService 编排「维度可用性 → 选 scope → 窗口重建 → 用量聚合 → 汇总」。
type QuotaStatsService struct {
	samples   QuotaWindowSampleStore
	usage     QuotaWindowUsageStore
	ledger    QuotaWindowLedgerStore
	events    QuotaResetEventStore
	snapshots SnapshotStore
	clock     Clock
	pricer    QuotaWindowPricer
}

// NewQuotaStatsService 创建额度统计服务；任一端口缺失都失败关闭。
func NewQuotaStatsService(dependencies QuotaStatsDependencies) (*QuotaStatsService, error) {
	if dependencies.Samples == nil ||
		dependencies.Usage == nil ||
		dependencies.Ledger == nil ||
		dependencies.Events == nil ||
		dependencies.Snapshots == nil ||
		dependencies.Clock == nil {
		return nil, ErrQuotaStatsUnavailable
	}
	return &QuotaStatsService{
		samples:   dependencies.Samples,
		usage:     dependencies.Usage,
		ledger:    dependencies.Ledger,
		events:    dependencies.Events,
		snapshots: dependencies.Snapshots,
		clock:     dependencies.Clock,
		pricer:    dependencies.Pricer,
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
	// Synthetic 表示该 scope 只来自当前快照，还没有任何采样。
	Synthetic bool `json:"synthetic"`
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
	LastResetAtMS       int64    `json:"last_reset_at_ms"`
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
	// 维度可用性 = 采样 ∪ 重置事件 ∪ 当前快照：任一出现该窗口长度即可用。
	eventScopes, err := service.events.ListQuotaResetEventScopes(ctx, accountRef)
	if err != nil {
		return QuotaStatsResult{}, err
	}
	snapshot, hasSnapshot, err := service.usageSnapshot(ctx, query.AccountRef)
	if err != nil {
		return QuotaStatsResult{}, err
	}
	dimensions := buildQuotaStatsDimensions(
		scopes,
		eventScopes,
		snapshotQuotaScopes(snapshot, hasSnapshot),
	)
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
	// 事件与样本取同一时间范围；老事件可能没有 window_minutes，重建时按 quotaKey 兜底。
	resetEvents, err := service.events.ListQuotaResetEvents(
		ctx,
		accountRef,
		scope.QuotaKey,
		rangeFromMS-windowMS,
		nowMS,
	)
	if err != nil {
		return QuotaStatsResult{}, err
	}
	ledger, hasLedger, err := service.ledger.GetQuotaWindowLedger(ctx, accountRef)
	if err != nil {
		return QuotaStatsResult{}, err
	}
	// 快照窗口仍用于「补一个还没样本的活跃窗口」；API 的 current 另有优先级。
	currentWindow := currentQuotaWindowFromSnapshot(snapshot, hasSnapshot, scope.QuotaKey, dimension.WindowMinutes)
	// 与 Node 的 pickCurrent 同序：最新样本 → 账本 → 快照。幻影样本不参与（F3），
	// 否则空闲账号会把「读取时刻 + 窗口时长」的幻影 reset 当成当前窗口。
	result.Current = pickQuotaStatsCurrent(
		samples,
		ledger,
		hasLedger,
		currentWindow,
		dimension.WindowMinutes,
	)

	var ledgerInput *usagecore.QuotaWindowLedger
	if hasLedger {
		ledgerInput = &ledger
	}
	windows := usagecore.BuildQuotaWindows(usagecore.BuildQuotaWindowsInput{
		Samples:       samples,
		ResetEvents:   resetEvents,
		Ledger:        ledgerInput,
		Current:       currentWindow,
		WindowMinutes: dimension.WindowMinutes,
		QuotaKey:      scope.QuotaKey,
		RangeFromMS:   rangeFromMS,
		RangeToMS:     nowMS,
		NowMS:         nowMS,
	})
	if len(windows) == 0 {
		if len(samples) == 0 && len(resetEvents) == 0 {
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

	result.CostSupported = service.pricer != nil
	rows := make([]QuotaStatsWindow, 0, len(windows))
	for _, window := range windows {
		usage := usageByIndex[window.Index]
		cost, costKnown := service.priceWindowUsage(ctx, usage)
		rows = append(rows, QuotaStatsWindow{
			QuotaWindow:  window,
			Tokens:       usage.Tokens,
			CostUSD:      cost,
			CostKnown:    costKnown,
			RequestCount: usage.RequestCount,
		})
	}
	result.Windows = rows
	result.Summary = summarizeQuotaStatsWindows(rows)
	if !result.CostSupported {
		// 没有定价口径时，汇总里的 0 会被读成「确实免费」；统一置空。
		result.Summary.CostKnown = false
		result.Summary.TotalCostUSD = nil
		result.Summary.AvgCostUSDPerWindow = nil
	}
	return result, nil
}

// priceWindowUsage 汇总一个窗口内各模型的成本。
//
// 与 Node 同口径：窗口里只要有一个模型没有定价，整个窗口的成本就是「未知」。
// 部分已知的合计会低估成本，比没有数字更危险。
func (service *QuotaStatsService) priceWindowUsage(
	ctx context.Context,
	usage usagecore.QuotaWindowUsage,
) (*float64, bool) {
	if service.pricer == nil {
		return nil, false
	}
	if len(usage.Models) == 0 {
		// 窗口内没有请求：0 元是确定的事实，不是「未知」。
		zero := 0.0
		return &zero, true
	}
	total := 0.0
	for _, model := range usage.Models {
		cost, known := service.pricer.CostFor(ctx, model.Provider, model.Model, model)
		if !known {
			return nil, false
		}
		total += cost
	}
	return &total, true
}

// usageSnapshot 读取当前额度快照；没有快照是正常状态（账号刚接入）。
func (service *QuotaStatsService) usageSnapshot(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) (usagecore.Snapshot, bool, error) {
	snapshot, err := service.snapshots.GetUsageSnapshot(ctx, accountRef)
	if err != nil {
		if errors.Is(err, ErrSnapshotNotFound) {
			return usagecore.Snapshot{}, false, nil
		}
		return usagecore.Snapshot{}, false, err
	}
	return snapshot, true, nil
}

// currentQuotaWindowFromSnapshot 从当前快照里取出仍在进行的窗口（幻影不算）。
func currentQuotaWindowFromSnapshot(
	snapshot usagecore.Snapshot,
	hasSnapshot bool,
	quotaKey string,
	windowMinutes int64,
) *usagecore.CurrentQuotaWindow {
	if !hasSnapshot {
		return nil
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
		return current
	}
	return nil
}

// pickQuotaStatsCurrent 按 Node 的口径选「当前」：最新样本 → 账本 → 当前快照。
//
// 样本比快照更接近真实观测时刻：快照可能落后于最新样本，甚至在账号只由 Node 采集时
// 缺失。幻影样本会被跳过——那只是上游按读取时刻现算出来的假 reset。
// 账本在样本之后、快照之前：它记的是上一次真实观察到的窗口，样本被裁剪后仍能
// 给出「窗口何时关闭」，而快照在空闲期只会报幻影。
func pickQuotaStatsCurrent(
	samples []usagecore.QuotaWindowSample,
	ledger usagecore.QuotaWindowLedger,
	hasLedger bool,
	snapshot *usagecore.CurrentQuotaWindow,
	windowMinutes int64,
) *QuotaStatsCurrent {
	for index := len(samples) - 1; index >= 0; index-- {
		sample := samples[index]
		if sample.ExpectedResetAtMS <= 0 || sample.CapturedAtMS <= 0 {
			continue
		}
		if usagecore.IsPhantomSample(sample.CapturedAtMS, sample.ExpectedResetAtMS, windowMinutes) {
			continue
		}
		return &QuotaStatsCurrent{
			RemainingPct: sample.RemainingPct,
			ResetAtMS:    sample.ExpectedResetAtMS,
			CapturedAtMS: sample.CapturedAtMS,
		}
	}
	if hasLedger {
		normalized := usagecore.NormalizeQuotaWindowLedger(ledger)
		if normalized.WindowMinutes == windowMinutes && normalized.CloseAtMS > 0 {
			// 账本只有锚点与关窗时刻，没有剩余额度：保持未知，不伪造 0%。
			return &QuotaStatsCurrent{
				RemainingPct: nil,
				ResetAtMS:    normalized.CloseAtMS,
				CapturedAtMS: normalized.ObservedAtMS,
			}
		}
	}
	if snapshot == nil {
		return nil
	}
	return &QuotaStatsCurrent{
		RemainingPct: snapshot.RemainingPct,
		ResetAtMS:    snapshot.ResetAtMS,
		CapturedAtMS: snapshot.CapturedAtMS,
	}
}

// snapshotQuotaScopes 把当前快照里的窗口条目投影成「仅用于维度可用性」的 scope。
func snapshotQuotaScopes(
	snapshot usagecore.Snapshot,
	hasSnapshot bool,
) []usagecore.QuotaWindowScope {
	if !hasSnapshot {
		return nil
	}
	type scopeKey struct {
		quotaKey      string
		windowMinutes int64
	}
	seen := make(map[scopeKey]struct{}, 4)
	scopes := make([]usagecore.QuotaWindowScope, 0, 4)
	for _, entry := range snapshot.Entries() {
		if entry.Kind() != usagecore.KindWindow {
			continue
		}
		windowMinutes := entry.WindowSeconds() / 60
		if windowMinutes <= 0 || entry.ResetAt().IsZero() {
			continue
		}
		quotaKey := "rate_limit:" + strings.TrimSpace(entry.Bucket())
		key := scopeKey{quotaKey: quotaKey, windowMinutes: windowMinutes}
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		label := strings.TrimSpace(entry.LimitName())
		if label == "" {
			label = entry.Bucket()
		}
		scopes = append(scopes, usagecore.QuotaWindowScope{
			QuotaKey:      quotaKey,
			WindowLabel:   label,
			WindowMinutes: windowMinutes,
		})
	}
	return scopes
}

func buildQuotaStatsDimensions(
	scopes []usagecore.QuotaWindowScope,
	eventScopes []usagecore.QuotaWindowScope,
	syntheticScopes []usagecore.QuotaWindowScope,
) []QuotaStatsDimension {
	dimensions := make([]QuotaStatsDimension, 0, 3)
	for _, dimension := range usagecore.QuotaWindowDimensions() {
		item := QuotaStatsDimension{
			WindowMinutes: dimension.WindowMinutes,
			Label:         dimension.Label,
			Scopes:        []QuotaStatsScope{},
		}
		hasSamples := false
		seen := make(map[string]struct{}, len(scopes))
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
			seen[scope.QuotaKey] = struct{}{}
			if scope.SampleCount > 0 {
				hasSamples = true
			}
		}
		// 有重置事件、但还没采到样本的窗口：维度同样可用。
		// 老事件缺 window_minutes（0）无法归维，与 Node 一样跳过。
		for _, scope := range eventScopes {
			if scope.WindowMinutes != dimension.WindowMinutes {
				continue
			}
			if _, exists := seen[scope.QuotaKey]; exists {
				continue
			}
			label := strings.TrimSpace(scope.WindowLabel)
			if label == "" {
				label = dimension.Label
			}
			item.Scopes = append(item.Scopes, QuotaStatsScope{
				QuotaKey:         scope.QuotaKey,
				Label:            label,
				LastCapturedAtMS: scope.LastCapturedAtMS,
			})
			seen[scope.QuotaKey] = struct{}{}
		}
		// 当前快照里有、但还没采到样本的窗口：只贡献「维度可用」，
		// 样本数保持 0，前端据此显示「等待采样」而不是「无此维度」。
		for _, scope := range syntheticScopes {
			if scope.WindowMinutes != dimension.WindowMinutes {
				continue
			}
			if _, exists := seen[scope.QuotaKey]; exists {
				continue
			}
			label := strings.TrimSpace(scope.WindowLabel)
			if label == "" {
				label = dimension.Label
			}
			item.Scopes = append(item.Scopes, QuotaStatsScope{
				QuotaKey:  scope.QuotaKey,
				Label:     label,
				Synthetic: true,
			})
			seen[scope.QuotaKey] = struct{}{}
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
	// 最近一次重置 = 最后一个带 resetKind 的窗口的关窗时刻（窗口已按锚点升序）。
	for index := len(windows) - 1; index >= 0; index-- {
		if windows[index].ResetKind != "" {
			summary.LastResetAtMS = windows[index].CloseAtMS
			break
		}
	}
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
	// 成本汇总与 Node 同口径：只有「有请求的窗口」参与已知性判断——
	// 空窗口没有成本事实，不该把整份汇总拖成未知。
	costKnown := true
	for _, window := range windows {
		if window.Tokens > 0 && !window.CostKnown {
			costKnown = false
			break
		}
	}
	summary.CostKnown = costKnown
	if costKnown {
		total := 0.0
		for _, window := range windows {
			if window.CostUSD != nil {
				total += *window.CostUSD
			}
		}
		summary.TotalCostUSD = &total
		if len(windows) > 0 {
			average := total / float64(len(windows))
			summary.AvgCostUSDPerWindow = &average
		}
	}
	return summary
}

func roundOneDecimal(value float64) *float64 {
	rounded := math.Round(value*10) / 10
	return &rounded
}

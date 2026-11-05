package accountusage

import (
	"context"
	"errors"
	"testing"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
)

type fakeQuotaSamples struct {
	scopes  []usagecore.QuotaWindowScope
	samples []usagecore.QuotaWindowSample
}

func (fake *fakeQuotaSamples) ListQuotaWindowScopes(
	context.Context,
	string,
) ([]usagecore.QuotaWindowScope, error) {
	return fake.scopes, nil
}

func (fake *fakeQuotaSamples) ListQuotaWindowSamples(
	context.Context,
	string,
	string,
	int64,
	int64,
	int64,
) ([]usagecore.QuotaWindowSample, error) {
	return fake.samples, nil
}

type fakeQuotaUsage struct {
	usages []usagecore.QuotaWindowUsage
	ranges []usagecore.QuotaWindowRange
}

func (fake *fakeQuotaUsage) QueryQuotaWindowUsage(
	_ context.Context,
	_ string,
	ranges []usagecore.QuotaWindowRange,
) ([]usagecore.QuotaWindowUsage, error) {
	fake.ranges = ranges
	return fake.usages, nil
}

type fakeQuotaSnapshots struct {
	snapshot usagecore.Snapshot
	err      error
}

func (fake *fakeQuotaSnapshots) ReplaceUsageSnapshot(context.Context, usagecore.Snapshot) error {
	return nil
}

func (fake *fakeQuotaSnapshots) ReplaceUsageSnapshotIfCredentialVersion(
	context.Context,
	usagecore.Snapshot,
	time.Time,
) error {
	return nil
}

func (fake *fakeQuotaSnapshots) GetUsageSnapshot(
	context.Context,
	accountcore.AccountRef,
) (usagecore.Snapshot, error) {
	return fake.snapshot, fake.err
}

func testAccountRef(t *testing.T) accountcore.AccountRef {
	t.Helper()
	accountRef, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	return accountRef
}

func float64Ptr(value float64) *float64 { return &value }

func newQuotaStatsService(
	t *testing.T,
	samples *fakeQuotaSamples,
	usage *fakeQuotaUsage,
	snapshots *fakeQuotaSnapshots,
	now time.Time,
) *QuotaStatsService {
	t.Helper()
	service, err := NewQuotaStatsService(QuotaStatsDependencies{
		Samples:   samples,
		Usage:     usage,
		Snapshots: snapshots,
		Clock:     func() time.Time { return now },
	})
	if err != nil {
		t.Fatalf("NewQuotaStatsService() error = %v", err)
	}
	return service
}

func TestQuotaStatsBuildsWindowsAndSummary(t *testing.T) {
	base := time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC)
	const hour = int64(60 * 60 * 1000)
	baseMS := base.UnixMilli()
	samples := &fakeQuotaSamples{
		scopes: []usagecore.QuotaWindowScope{
			{QuotaKey: "rate_limit:primary", WindowLabel: "5h", WindowMinutes: 300, SampleCount: 4, LastCapturedAtMS: baseMS + 7*hour},
		},
		samples: []usagecore.QuotaWindowSample{
			{QuotaKey: "rate_limit:primary", WindowMinutes: 300, RemainingPct: float64Ptr(80), ExpectedResetAtMS: baseMS + 5*hour, CapturedAtMS: baseMS + 10*60_000},
			{QuotaKey: "rate_limit:primary", WindowMinutes: 300, RemainingPct: float64Ptr(20), ExpectedResetAtMS: baseMS + 5*hour, CapturedAtMS: baseMS + 3*hour},
			{QuotaKey: "rate_limit:primary", WindowMinutes: 300, RemainingPct: float64Ptr(99), ExpectedResetAtMS: baseMS + 11*hour, CapturedAtMS: baseMS + 6*hour + 10*60_000},
			{QuotaKey: "rate_limit:primary", WindowMinutes: 300, RemainingPct: float64Ptr(60), ExpectedResetAtMS: baseMS + 11*hour, CapturedAtMS: baseMS + 7*hour},
		},
	}
	usage := &fakeQuotaUsage{usages: []usagecore.QuotaWindowUsage{
		{Index: 0, Tokens: 200, RequestCount: 2},
		{Index: 1, Tokens: 400, RequestCount: 4},
	}}
	snapshots := &fakeQuotaSnapshots{err: ErrSnapshotNotFound}
	service := newQuotaStatsService(t, samples, usage, snapshots, base.Add(8*time.Hour))

	result, err := service.BuildQuotaStats(context.Background(), QuotaStatsQuery{
		AccountRef: testAccountRef(t),
		RangeDays:  30,
	})
	if err != nil {
		t.Fatalf("BuildQuotaStats() error = %v", err)
	}
	if len(result.Windows) != 2 {
		t.Fatalf("窗口数 = %d, want 2: %+v", len(result.Windows), result.Windows)
	}
	if result.Windows[0].ConsumedPct == nil || *result.Windows[0].ConsumedPct != 80 {
		t.Fatalf("窗口 0 消耗 = %v, want 80", result.Windows[0].ConsumedPct)
	}
	if result.Windows[0].Tokens != 200 || result.Windows[1].Tokens != 400 {
		t.Fatalf("用量未按窗口归集: %+v", result.Windows)
	}
	if result.Summary.TotalTokens != 600 || result.Summary.RequestCount != 6 {
		t.Fatalf("汇总 = %+v", result.Summary)
	}
	if result.Summary.CostKnown || result.Summary.TotalCostUSD != nil {
		t.Fatalf("Go 无定价时成本必须是「不可用」而不是 0: %+v", result.Summary)
	}
	if result.CostSupported {
		t.Fatalf("CostSupported 应为 false")
	}
	if result.EmptyReason != "" {
		t.Fatalf("EmptyReason = %q", result.EmptyReason)
	}
	if len(usage.ranges) != 2 {
		t.Fatalf("应把 2 个窗口交给用量聚合，得到 %d", len(usage.ranges))
	}
	if usage.ranges[1].StartMS != baseMS+6*hour {
		t.Fatalf("第二个窗口起点 = %d, want %d", usage.ranges[1].StartMS, baseMS+6*hour)
	}
}

func TestQuotaStatsFallsBackToFirstAvailableDimension(t *testing.T) {
	base := time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC)
	baseMS := base.UnixMilli()
	samples := &fakeQuotaSamples{
		scopes: []usagecore.QuotaWindowScope{
			{QuotaKey: "rate_limit:secondary", WindowLabel: "weekly", WindowMinutes: 10080, SampleCount: 1, LastCapturedAtMS: baseMS},
		},
		samples: []usagecore.QuotaWindowSample{
			{QuotaKey: "rate_limit:secondary", WindowMinutes: 10080, RemainingPct: float64Ptr(50), ExpectedResetAtMS: baseMS + 7*24*60*60*1000, CapturedAtMS: baseMS + 60*60*1000},
		},
	}
	service := newQuotaStatsService(t, samples, &fakeQuotaUsage{}, &fakeQuotaSnapshots{err: ErrSnapshotNotFound}, base.Add(2*time.Hour))

	result, err := service.BuildQuotaStats(context.Background(), QuotaStatsQuery{
		AccountRef: testAccountRef(t),
	})
	if err != nil {
		t.Fatalf("BuildQuotaStats() error = %v", err)
	}
	if result.WindowMinutes != 10080 {
		t.Fatalf("WindowMinutes = %d, want 10080（回退到第一个可用维度）", result.WindowMinutes)
	}
	if len(result.Windows) != 1 {
		t.Fatalf("窗口数 = %d, want 1", len(result.Windows))
	}
	if result.Dimensions[0].DataState != "empty" || result.Dimensions[1].DataState != "ready" {
		t.Fatalf("维度状态 = %+v", result.Dimensions)
	}
}

func TestQuotaStatsRejectsUnknownDimension(t *testing.T) {
	service := newQuotaStatsService(t, &fakeQuotaSamples{}, &fakeQuotaUsage{}, &fakeQuotaSnapshots{err: ErrSnapshotNotFound}, time.Now())
	_, err := service.BuildQuotaStats(context.Background(), QuotaStatsQuery{
		AccountRef:    testAccountRef(t),
		WindowMinutes: 123,
	})
	if !errors.Is(err, ErrInvalidQuotaStatsQuery) {
		t.Fatalf("error = %v, want ErrInvalidQuotaStatsQuery", err)
	}
}

func TestQuotaStatsRejectsOutOfRangeDays(t *testing.T) {
	service := newQuotaStatsService(t, &fakeQuotaSamples{}, &fakeQuotaUsage{}, &fakeQuotaSnapshots{err: ErrSnapshotNotFound}, time.Now())
	for _, days := range []int{-1, MaxQuotaStatsRangeDays + 1} {
		_, err := service.BuildQuotaStats(context.Background(), QuotaStatsQuery{
			AccountRef: testAccountRef(t),
			RangeDays:  days,
		})
		if !errors.Is(err, ErrInvalidQuotaStatsQuery) {
			t.Fatalf("RangeDays=%d error = %v, want ErrInvalidQuotaStatsQuery", days, err)
		}
	}
}

func TestQuotaStatsReportsDimensionUnavailable(t *testing.T) {
	service := newQuotaStatsService(t, &fakeQuotaSamples{}, &fakeQuotaUsage{}, &fakeQuotaSnapshots{err: ErrSnapshotNotFound}, time.Now())
	result, err := service.BuildQuotaStats(context.Background(), QuotaStatsQuery{
		AccountRef: testAccountRef(t),
	})
	if err != nil {
		t.Fatalf("BuildQuotaStats() error = %v", err)
	}
	if result.EmptyReason != "dimension_unavailable" {
		t.Fatalf("EmptyReason = %q", result.EmptyReason)
	}
	if len(result.Dimensions) != 3 || result.Dimensions[0].Available {
		t.Fatalf("维度 = %+v", result.Dimensions)
	}
	if result.Windows == nil || len(result.Windows) != 0 {
		t.Fatalf("Windows 应为空切片而不是 null: %+v", result.Windows)
	}
}

func TestQuotaStatsReportsNoWindowsInRange(t *testing.T) {
	base := time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC)
	oldMS := base.Add(-60 * 24 * time.Hour).UnixMilli()
	samples := &fakeQuotaSamples{
		scopes: []usagecore.QuotaWindowScope{
			{QuotaKey: "rate_limit:primary", WindowMinutes: 300, SampleCount: 1, LastCapturedAtMS: oldMS},
		},
		samples: []usagecore.QuotaWindowSample{
			{QuotaKey: "rate_limit:primary", WindowMinutes: 300, RemainingPct: float64Ptr(70), ExpectedResetAtMS: oldMS + 5*60*60*1000, CapturedAtMS: oldMS + 60*60*1000},
		},
	}
	service := newQuotaStatsService(t, samples, &fakeQuotaUsage{}, &fakeQuotaSnapshots{err: ErrSnapshotNotFound}, base)

	result, err := service.BuildQuotaStats(context.Background(), QuotaStatsQuery{
		AccountRef: testAccountRef(t),
		RangeDays:  7,
	})
	if err != nil {
		t.Fatalf("BuildQuotaStats() error = %v", err)
	}
	if result.EmptyReason != "no_windows_in_range" {
		t.Fatalf("EmptyReason = %q", result.EmptyReason)
	}
}

func newQuotaStatsSnapshot(
	t *testing.T,
	accountRef accountcore.AccountRef,
	capturedAt time.Time,
	windowSeconds int64,
	resetAt time.Time,
	remainingPct float64,
) usagecore.Snapshot {
	t.Helper()
	snapshot, err := usagecore.NewSnapshot(usagecore.SnapshotInput{
		AccountRef: accountRef,
		ProviderID: "codex",
		Source:     "codex_read_rate_limits",
		CapturedAt: capturedAt,
		Entries: []usagecore.EntryInput{{
			Bucket:               "primary",
			Kind:                 usagecore.KindWindow,
			Scope:                usagecore.ScopeAccount,
			HasRemaining:         true,
			RemainingBasisPoints: uint16(remainingPct * 100),
			WindowSeconds:        windowSeconds,
			ResetAt:              resetAt,
			Availability:         usagecore.AvailabilityAvailable,
		}},
	})
	if err != nil {
		t.Fatalf("NewSnapshot() error = %v", err)
	}
	return snapshot
}

func TestQuotaStatsPrefersLatestSampleForCurrent(t *testing.T) {
	base := time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC)
	baseMS := base.UnixMilli()
	const hour = int64(60 * 60 * 1000)
	accountRef := testAccountRef(t)
	samples := &fakeQuotaSamples{
		scopes: []usagecore.QuotaWindowScope{
			{QuotaKey: "rate_limit:primary", WindowMinutes: 300, SampleCount: 2, LastCapturedAtMS: baseMS + 7*hour},
		},
		samples: []usagecore.QuotaWindowSample{
			{QuotaKey: "rate_limit:primary", WindowMinutes: 300, RemainingPct: float64Ptr(99), ExpectedResetAtMS: baseMS + 11*hour, CapturedAtMS: baseMS + 6*hour + 10*60_000},
			{QuotaKey: "rate_limit:primary", WindowMinutes: 300, RemainingPct: float64Ptr(60), ExpectedResetAtMS: baseMS + 11*hour, CapturedAtMS: baseMS + 7*hour},
		},
	}
	// 快照比最新样本更旧：当前值必须取样本的 60%，而不是快照的 88%。
	snapshot := newQuotaStatsSnapshot(t, accountRef, base.Add(90*time.Minute), 300*60, base.Add(11*time.Hour), 88)
	service := newQuotaStatsService(t, samples, &fakeQuotaUsage{}, &fakeQuotaSnapshots{snapshot: snapshot}, base.Add(8*time.Hour))

	result, err := service.BuildQuotaStats(context.Background(), QuotaStatsQuery{AccountRef: accountRef})
	if err != nil {
		t.Fatalf("BuildQuotaStats() error = %v", err)
	}
	if result.Current == nil {
		t.Fatalf("Current 不应为空")
	}
	if result.Current.RemainingPct == nil || *result.Current.RemainingPct != 60 {
		t.Fatalf("Current.RemainingPct = %v, want 60（最新样本优先）", result.Current.RemainingPct)
	}
	if result.Current.CapturedAtMS != baseMS+7*hour {
		t.Fatalf("Current.CapturedAtMS = %d, want %d", result.Current.CapturedAtMS, baseMS+7*hour)
	}
}

func TestQuotaStatsSkipsPhantomSampleForCurrent(t *testing.T) {
	base := time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC)
	baseMS := base.UnixMilli()
	const hour = int64(60 * 60 * 1000)
	samples := &fakeQuotaSamples{
		scopes: []usagecore.QuotaWindowScope{
			{QuotaKey: "rate_limit:primary", WindowMinutes: 300, SampleCount: 2, LastCapturedAtMS: baseMS + 6*hour},
		},
		samples: []usagecore.QuotaWindowSample{
			{QuotaKey: "rate_limit:primary", WindowMinutes: 300, RemainingPct: float64Ptr(80), ExpectedResetAtMS: baseMS + 5*hour, CapturedAtMS: baseMS + 10*60_000},
			// 最新一条是幻影（锚点≈采集时刻），不能当成当前窗口。
			{QuotaKey: "rate_limit:primary", WindowMinutes: 300, RemainingPct: float64Ptr(100), ExpectedResetAtMS: baseMS + 11*hour, CapturedAtMS: baseMS + 6*hour + 30_000},
		},
	}
	service := newQuotaStatsService(t, samples, &fakeQuotaUsage{}, &fakeQuotaSnapshots{err: ErrSnapshotNotFound}, base.Add(7*time.Hour))

	result, err := service.BuildQuotaStats(context.Background(), QuotaStatsQuery{AccountRef: testAccountRef(t)})
	if err != nil {
		t.Fatalf("BuildQuotaStats() error = %v", err)
	}
	if result.Current == nil || result.Current.RemainingPct == nil || *result.Current.RemainingPct != 80 {
		t.Fatalf("幻影样本必须跳过，Current = %+v", result.Current)
	}
}

func TestQuotaStatsDimensionFromSnapshotOnly(t *testing.T) {
	base := time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC)
	accountRef := testAccountRef(t)
	// 窗口在 2 小时前锚定、3 小时后关窗；快照采集于 1 小时前 → 真实窗口，不是幻影。
	snapshot := newQuotaStatsSnapshot(t, accountRef, base.Add(-time.Hour), 300*60, base.Add(3*time.Hour), 88)
	service := newQuotaStatsService(t, &fakeQuotaSamples{}, &fakeQuotaUsage{}, &fakeQuotaSnapshots{snapshot: snapshot}, base)

	result, err := service.BuildQuotaStats(context.Background(), QuotaStatsQuery{AccountRef: accountRef})
	if err != nil {
		t.Fatalf("BuildQuotaStats() error = %v", err)
	}
	dimension := result.Dimensions[0]
	if !dimension.Available || dimension.DataState != "pending" {
		t.Fatalf("只有快照时维度应可用且为 pending: %+v", dimension)
	}
	if len(dimension.Scopes) != 1 || !dimension.Scopes[0].Synthetic {
		t.Fatalf("scope 应为 synthetic: %+v", dimension.Scopes)
	}
	if result.Current == nil || result.Current.RemainingPct == nil || *result.Current.RemainingPct != 88 {
		t.Fatalf("Current 应回落到快照: %+v", result.Current)
	}
	if len(result.Windows) != 1 || !result.Windows[0].Live {
		t.Fatalf("当前窗口应出现在图里: %+v", result.Windows)
	}
}

func TestQuotaStatsIgnoresPhantomCurrentSnapshot(t *testing.T) {
	base := time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC)
	baseMS := base.UnixMilli()
	accountRef := testAccountRef(t)
	snapshot, err := usagecore.NewSnapshot(usagecore.SnapshotInput{
		AccountRef: accountRef,
		ProviderID: "codex",
		Source:     "codex_read_rate_limits",
		CapturedAt: base,
		Entries: []usagecore.EntryInput{{
			Bucket:               "primary",
			Kind:                 usagecore.KindWindow,
			Scope:                usagecore.ScopeAccount,
			HasRemaining:         true,
			RemainingBasisPoints: 10_000,
			WindowSeconds:        300 * 60,
			ResetAt:              base.Add(5 * time.Hour),
			Availability:         usagecore.AvailabilityAvailable,
		}},
	})
	if err != nil {
		t.Fatalf("NewSnapshot() error = %v", err)
	}
	samples := &fakeQuotaSamples{
		scopes: []usagecore.QuotaWindowScope{
			{QuotaKey: "rate_limit:primary", WindowMinutes: 300, SampleCount: 1, LastCapturedAtMS: baseMS},
		},
	}
	service := newQuotaStatsService(t, samples, &fakeQuotaUsage{}, &fakeQuotaSnapshots{snapshot: snapshot}, base)

	result, err := service.BuildQuotaStats(context.Background(), QuotaStatsQuery{
		AccountRef: accountRef,
	})
	if err != nil {
		t.Fatalf("BuildQuotaStats() error = %v", err)
	}
	if result.Current != nil {
		t.Fatalf("幻影 reset 不能当成当前窗口: %+v", result.Current)
	}
}

package accountusage

import (
	"testing"
	"time"
)

func testMS(value time.Time) int64 { return value.UnixMilli() }

func pct(value float64) *float64 { return &value }

func TestIsPhantomSampleBoundary(t *testing.T) {
	const windowMinutes = int64(300)
	const windowMS = windowMinutes * MS_PER_MINUTE
	const resetAt = int64(1_800_000_000_000)

	cases := []struct {
		name       string
		capturedAt int64
		resetAt    int64
		minutes    int64
		want       bool
	}{
		{name: "正好 90 秒仍是幻影", capturedAt: resetAt - windowMS + 90_000, resetAt: resetAt, minutes: windowMinutes, want: true},
		{name: "负向 90 秒仍是幻影", capturedAt: resetAt - windowMS - 90_000, resetAt: resetAt, minutes: windowMinutes, want: true},
		{name: "超过 90 秒是真实窗口", capturedAt: resetAt - windowMS + 90_001, resetAt: resetAt, minutes: windowMinutes, want: false},
		{name: "窗口期中段是真实窗口", capturedAt: resetAt - windowMS/2, resetAt: resetAt, minutes: windowMinutes, want: false},
		{name: "缺字段一律不判幻影", capturedAt: 0, resetAt: resetAt, minutes: windowMinutes, want: false},
		{name: "缺窗口长度一律不判幻影", capturedAt: resetAt, resetAt: resetAt, minutes: 0, want: false},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got := IsPhantomSample(testCase.capturedAt, testCase.resetAt, testCase.minutes)
			if got != testCase.want {
				t.Fatalf("IsPhantomSample() = %v, want %v", got, testCase.want)
			}
		})
	}
}

func TestBuildQuotaWindowsDropsAllPhantomGroup(t *testing.T) {
	base := time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC)
	baseMS := testMS(base)
	// 每一条都恰好落在「reset - 5h」，说明这段时间根本没有窗口。
	samples := []QuotaWindowSample{
		{QuotaKey: "rate_limit:primary", WindowMinutes: 300, RemainingPct: pct(100), ExpectedResetAtMS: baseMS + 5*60*60*1000, CapturedAtMS: baseMS},
	}
	windows := BuildQuotaWindows(BuildQuotaWindowsInput{
		Samples:       samples,
		WindowMinutes: 300,
		RangeFromMS:   baseMS - 24*60*60*1000,
		RangeToMS:     baseMS + 24*60*60*1000,
		NowMS:         baseMS,
	})
	if len(windows) != 0 {
		t.Fatalf("全幻影分组不应造出窗口，得到 %d 个", len(windows))
	}
}

func TestBuildQuotaWindowsGroupsByResetValue(t *testing.T) {
	base := time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC)
	baseMS := testMS(base)
	const windowMS = int64(300 * MS_PER_MINUTE)
	samples := make([]QuotaWindowSample, 0, 20)
	for index := 0; index < 20; index++ {
		// 从锚点后 3 分钟开始：紧贴锚点的样本按幻影判据会被剔除。
		samples = append(samples, QuotaWindowSample{
			QuotaKey:          "rate_limit:primary",
			WindowMinutes:     300,
			RemainingPct:      pct(float64(100 - index)),
			ExpectedResetAtMS: baseMS + windowMS,
			CapturedAtMS:      baseMS + int64(3+index)*60_000,
		})
	}
	windows := BuildQuotaWindows(BuildQuotaWindowsInput{
		Samples:       samples,
		WindowMinutes: 300,
		RangeFromMS:   baseMS - 24*60*60*1000,
		RangeToMS:     baseMS + 24*60*60*1000,
		NowMS:         baseMS + 30*60_000,
	})
	if len(windows) != 1 {
		t.Fatalf("同一个 reset 应只产生 1 个窗口，得到 %d 个", len(windows))
	}
	if windows[0].SampleCount != 20 {
		t.Fatalf("SampleCount = %d, want 20", windows[0].SampleCount)
	}
	if windows[0].AnchorAtMS != baseMS {
		t.Fatalf("AnchorAtMS = %d, want %d", windows[0].AnchorAtMS, baseMS)
	}
}

// 用户举的例子：00:00 开窗、05:00 计划关窗，但 03:10 额度提前回血；
// 之后一直没人用，06:00 才第一次真实请求。正确结果只有两个窗口：
// 00:00–05:00（覆盖到 03:05）和 06:00–11:00；不存在 03:10 或 05:00 锚定的窗口。
func TestBuildQuotaWindowsEarlyReplenishmentThenIdle(t *testing.T) {
	base := time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC)
	baseMS := testMS(base)
	const hour = int64(60 * 60 * 1000)
	samples := []QuotaWindowSample{
		{QuotaKey: "rate_limit:primary", WindowMinutes: 300, RemainingPct: pct(80), ExpectedResetAtMS: baseMS + 5*hour, CapturedAtMS: baseMS + 10*60_000},
		{QuotaKey: "rate_limit:primary", WindowMinutes: 300, RemainingPct: pct(50), ExpectedResetAtMS: baseMS + 5*hour, CapturedAtMS: baseMS + 1*hour},
		{QuotaKey: "rate_limit:primary", WindowMinutes: 300, RemainingPct: pct(20), ExpectedResetAtMS: baseMS + 5*hour, CapturedAtMS: baseMS + 3*hour + 5*60_000},
		{QuotaKey: "rate_limit:primary", WindowMinutes: 300, RemainingPct: pct(99), ExpectedResetAtMS: baseMS + 11*hour, CapturedAtMS: baseMS + 6*hour},
		{QuotaKey: "rate_limit:primary", WindowMinutes: 300, RemainingPct: pct(60), ExpectedResetAtMS: baseMS + 11*hour, CapturedAtMS: baseMS + 7*hour},
	}
	windows := BuildQuotaWindows(BuildQuotaWindowsInput{
		Samples:       samples,
		WindowMinutes: 300,
		RangeFromMS:   baseMS - 24*hour,
		RangeToMS:     baseMS + 24*hour,
		NowMS:         baseMS + 8*hour,
	})
	if len(windows) != 2 {
		t.Fatalf("应得到 2 个窗口，得到 %d 个: %+v", len(windows), windows)
	}
	if windows[0].AnchorAtMS != baseMS || windows[0].CloseAtMS != baseMS+5*hour {
		t.Fatalf("第一个窗口 = [%d,%d), want [%d,%d)", windows[0].AnchorAtMS, windows[0].CloseAtMS, baseMS, baseMS+5*hour)
	}
	if windows[1].AnchorAtMS != baseMS+6*hour || windows[1].CloseAtMS != baseMS+11*hour {
		t.Fatalf("第二个窗口应从 06:00 锚定，得到 [%d,%d)", windows[1].AnchorAtMS, windows[1].CloseAtMS)
	}
	for _, window := range windows {
		if window.AnchorAtMS == baseMS+3*hour+10*60_000 {
			t.Fatalf("提前回血的发现时刻不能成为锚点")
		}
	}
	if windows[0].ConsumedPct == nil || *windows[0].ConsumedPct != 80 {
		t.Fatalf("第一个窗口消耗 = %v, want 80", windows[0].ConsumedPct)
	}
	if windows[1].Live != true {
		t.Fatalf("第二个窗口应仍在进行")
	}
}

func TestBuildQuotaWindowsUnknownRemainingStaysUnknown(t *testing.T) {
	base := time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC)
	baseMS := testMS(base)
	const hour = int64(60 * 60 * 1000)
	windows := BuildQuotaWindows(BuildQuotaWindowsInput{
		Samples: []QuotaWindowSample{
			{QuotaKey: "rate_limit:primary", WindowMinutes: 300, RemainingPct: nil, ExpectedResetAtMS: baseMS + 5*hour, CapturedAtMS: baseMS + hour},
		},
		WindowMinutes: 300,
		RangeFromMS:   baseMS - hour,
		RangeToMS:     baseMS + 24*hour,
		NowMS:         baseMS + hour,
	})
	if len(windows) != 1 {
		t.Fatalf("应保留 1 个窗口，得到 %d 个", len(windows))
	}
	if windows[0].ConsumedPct != nil {
		t.Fatalf("未知剩余额度不能算成 0%% 剩余（即 100%% 消耗），得到 %v", *windows[0].ConsumedPct)
	}
	if windows[0].PeakConsumedPct != nil {
		t.Fatalf("未知剩余额度的峰值也应为未知")
	}
}

func TestBuildQuotaWindowsCurrentSnapshotWindowWithoutSamples(t *testing.T) {
	base := time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC)
	baseMS := testMS(base)
	const hour = int64(60 * 60 * 1000)
	windows := BuildQuotaWindows(BuildQuotaWindowsInput{
		Current: &CurrentQuotaWindow{
			WindowMinutes: 300,
			ResetAtMS:     baseMS + 5*hour,
			RemainingPct:  pct(88),
			CapturedAtMS:  baseMS + hour,
		},
		WindowMinutes: 300,
		RangeFromMS:   baseMS - hour,
		RangeToMS:     baseMS + 24*hour,
		NowMS:         baseMS + hour,
	})
	if len(windows) != 1 {
		t.Fatalf("当前窗口应出现 1 个，得到 %d 个", len(windows))
	}
	window := windows[0]
	if !window.Live || window.Source != "live" || window.Confidence != "low" {
		t.Fatalf("当前快照窗口标记 = live:%v source:%s confidence:%s", window.Live, window.Source, window.Confidence)
	}
	if window.SampleCount != 0 || window.AnchorAtMS != baseMS {
		t.Fatalf("窗口 = %+v", window)
	}
}

func TestBuildQuotaWindowsDoesNotInventClosedWindow(t *testing.T) {
	base := time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC)
	baseMS := testMS(base)
	const hour = int64(60 * 60 * 1000)
	windows := BuildQuotaWindows(BuildQuotaWindowsInput{
		Current: &CurrentQuotaWindow{
			WindowMinutes: 300,
			ResetAtMS:     baseMS - hour,
			RemainingPct:  pct(50),
		},
		WindowMinutes: 300,
		RangeFromMS:   baseMS - 24*hour,
		RangeToMS:     baseMS + 24*hour,
		NowMS:         baseMS,
	})
	if len(windows) != 0 {
		t.Fatalf("已关闭的当前窗口没有样本背书时不能造窗，得到 %d 个", len(windows))
	}
}

func TestBuildQuotaWindowsClipsRangeAndIndexes(t *testing.T) {
	base := time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC)
	baseMS := testMS(base)
	const hour = int64(60 * 60 * 1000)
	samples := []QuotaWindowSample{
		{QuotaKey: "rate_limit:primary", WindowMinutes: 300, RemainingPct: pct(70), ExpectedResetAtMS: baseMS + 5*hour, CapturedAtMS: baseMS + hour},
		{QuotaKey: "rate_limit:primary", WindowMinutes: 300, RemainingPct: pct(60), ExpectedResetAtMS: baseMS + 11*hour, CapturedAtMS: baseMS + 6*hour + 5*60_000},
	}
	windows := BuildQuotaWindows(BuildQuotaWindowsInput{
		Samples:       samples,
		WindowMinutes: 300,
		RangeFromMS:   baseMS + 5*hour + 1,
		RangeToMS:     baseMS + 10*hour,
		NowMS:         baseMS + 8*hour,
	})
	if len(windows) != 1 {
		t.Fatalf("范围内应只剩 1 个窗口，得到 %d 个", len(windows))
	}
	if windows[0].Index != 0 || windows[0].AnchorAtMS != baseMS+6*hour {
		t.Fatalf("裁剪后窗口 = %+v", windows[0])
	}
}

func TestBuildQuotaWindowsIgnoresOtherWindowLengthsAndKeys(t *testing.T) {
	base := time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC)
	baseMS := testMS(base)
	const hour = int64(60 * 60 * 1000)
	samples := []QuotaWindowSample{
		{QuotaKey: "rate_limit:primary", WindowMinutes: 300, RemainingPct: pct(70), ExpectedResetAtMS: baseMS + 5*hour, CapturedAtMS: baseMS + hour},
		{QuotaKey: "rate_limit:secondary", WindowMinutes: 300, RemainingPct: pct(70), ExpectedResetAtMS: baseMS + 5*hour, CapturedAtMS: baseMS + hour},
		{QuotaKey: "rate_limit:primary", WindowMinutes: 10080, RemainingPct: pct(70), ExpectedResetAtMS: baseMS + 7*24*hour, CapturedAtMS: baseMS + hour},
	}
	windows := BuildQuotaWindows(BuildQuotaWindowsInput{
		Samples:       samples,
		WindowMinutes: 300,
		QuotaKey:      "rate_limit:primary",
		RangeFromMS:   baseMS - hour,
		RangeToMS:     baseMS + 24*hour,
		NowMS:         baseMS + hour,
	})
	if len(windows) != 1 || windows[0].SampleCount != 1 {
		t.Fatalf("只应统计目标 quotaKey/窗口长度的 1 条样本，得到 %+v", windows)
	}
}

func TestQuotaWindowDimensionsAreCopied(t *testing.T) {
	dimensions := QuotaWindowDimensions()
	if len(dimensions) != 3 {
		t.Fatalf("维度数量 = %d, want 3", len(dimensions))
	}
	dimensions[0].Label = "changed"
	if QuotaWindowDimensions()[0].Label != "5h" {
		t.Fatalf("调用方修改返回值不应影响包级维度")
	}
}

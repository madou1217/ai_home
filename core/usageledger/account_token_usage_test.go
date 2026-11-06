package usageledger

import (
	"testing"
	"time"
)

// TestResolveAccountTokenUsageWindowsTZOffsetShiftsDayStart 验证同一锚点下
// offset=0 与 offset=480 的「今天」相差 8 小时：+08 的本地 00:00 落在前一天 16:00 UTC。
func TestResolveAccountTokenUsageWindowsTZOffsetShiftsDayStart(t *testing.T) {
	anchor := time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC)
	utcWindows, err := ResolveAccountTokenUsageWindows(anchor, 0)
	if err != nil {
		t.Fatalf("ResolveAccountTokenUsageWindows(0) error = %v", err)
	}
	localWindows, err := ResolveAccountTokenUsageWindows(anchor, 480)
	if err != nil {
		t.Fatalf("ResolveAccountTokenUsageWindows(480) error = %v", err)
	}
	if want := time.Date(2026, 11, 6, 0, 0, 0, 0, time.UTC); !utcWindows.DayStart.Equal(want) {
		t.Fatalf("offset=0 DayStart = %v, want %v", utcWindows.DayStart, want)
	}
	if want := time.Date(2026, 11, 5, 16, 0, 0, 0, time.UTC); !localWindows.DayStart.Equal(want) {
		t.Fatalf("offset=480 DayStart = %v, want %v", localWindows.DayStart, want)
	}
	if diff := utcWindows.DayStart.Sub(localWindows.DayStart); diff != 8*time.Hour {
		t.Fatalf("day 起点差 = %v, want 8h", diff)
	}
	// 起点必须是 UTC 瞬时：账本按 UTC 毫秒比较，不能让调用方拿到本地 Location。
	for name, start := range map[string]time.Time{
		"day":   localWindows.DayStart,
		"week":  localWindows.WeekStart,
		"month": localWindows.MonthStart,
	} {
		if start.Location() != time.UTC {
			t.Fatalf("%s Location = %v, want UTC", name, start.Location())
		}
	}
}

// TestResolveAccountTokenUsageWindowsTZOffsetUsesLocalCalendar 验证周一与 1 日
// 边界按本地日历取，而不是按 UTC 自然日：本地周一 00:00（+08）是周日 16:00 UTC。
func TestResolveAccountTokenUsageWindowsTZOffsetUsesLocalCalendar(t *testing.T) {
	cases := []struct {
		name   string
		anchor time.Time
		offset int
		want   AccountTokenUsageWindows
	}{
		{
			// 本地 2026-11-02 周一 10:00：day/week 同为本地周一 00:00。
			name:   "本地周一边界",
			anchor: time.Date(2026, 11, 2, 2, 0, 0, 0, time.UTC),
			offset: 480,
			want: AccountTokenUsageWindows{
				DayStart:   time.Date(2026, 11, 1, 16, 0, 0, 0, time.UTC),
				WeekStart:  time.Date(2026, 11, 1, 16, 0, 0, 0, time.UTC),
				MonthStart: time.Date(2026, 10, 31, 16, 0, 0, 0, time.UTC),
			},
		},
		{
			// 本地 2026-11-01 周日 04:00：UTC 仍是 10-31，月起点必须取本地 11-01 00:00。
			name:   "本地月初边界",
			anchor: time.Date(2026, 10, 31, 20, 0, 0, 0, time.UTC),
			offset: 480,
			want: AccountTokenUsageWindows{
				DayStart:   time.Date(2026, 10, 31, 16, 0, 0, 0, time.UTC),
				WeekStart:  time.Date(2026, 10, 25, 16, 0, 0, 0, time.UTC),
				MonthStart: time.Date(2026, 10, 31, 16, 0, 0, 0, time.UTC),
			},
		},
		{
			// 负偏移（UTC-8）：本地 11-05 周四，日/周/月边界整体后移 8 小时。
			name:   "负偏移",
			anchor: time.Date(2026, 11, 6, 2, 0, 0, 0, time.UTC),
			offset: -480,
			want: AccountTokenUsageWindows{
				DayStart:   time.Date(2026, 11, 5, 8, 0, 0, 0, time.UTC),
				WeekStart:  time.Date(2026, 11, 2, 8, 0, 0, 0, time.UTC),
				MonthStart: time.Date(2026, 11, 1, 8, 0, 0, 0, time.UTC),
			},
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			windows, err := ResolveAccountTokenUsageWindows(testCase.anchor, testCase.offset)
			if err != nil {
				t.Fatalf("ResolveAccountTokenUsageWindows() error = %v", err)
			}
			if !windows.DayStart.Equal(testCase.want.DayStart) {
				t.Fatalf("DayStart = %v, want %v", windows.DayStart, testCase.want.DayStart)
			}
			if !windows.WeekStart.Equal(testCase.want.WeekStart) {
				t.Fatalf("WeekStart = %v, want %v", windows.WeekStart, testCase.want.WeekStart)
			}
			if !windows.MonthStart.Equal(testCase.want.MonthStart) {
				t.Fatalf("MonthStart = %v, want %v", windows.MonthStart, testCase.want.MonthStart)
			}
		})
	}
}

// TestResolveAccountTokenUsageWindowsRejectsInvalidTZOffset 验证越界偏移被拒绝，
// 闭区间端点 -720 / 840 可用。
func TestResolveAccountTokenUsageWindowsRejectsInvalidTZOffset(t *testing.T) {
	anchor := time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC)
	for _, offset := range []int{-721, 841, -1440, 100000} {
		if _, err := ResolveAccountTokenUsageWindows(anchor, offset); err != ErrInvalidQuery {
			t.Fatalf("offset=%d error = %v, want ErrInvalidQuery", offset, err)
		}
	}
	for _, offset := range []int{MinTZOffsetMinutes, MaxTZOffsetMinutes} {
		if _, err := ResolveAccountTokenUsageWindows(anchor, offset); err != nil {
			t.Fatalf("offset=%d error = %v, want nil", offset, err)
		}
	}
}

package scheduledtasks

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
)

// Schedule 描述一条计划任务的触发规则。
type Schedule struct {
	Kind       string `json:"kind"`
	At         string `json:"at,omitempty"`
	Weekday    *int   `json:"weekday,omitempty"`
	Hours      *int   `json:"hours,omitempty"`
	Minutes    *int   `json:"minutes,omitempty"`
	Expression string `json:"expression,omitempty"`
}

// ScheduleInput 表示客户端提交的未归一化调度字段（数值允许小数以匹配 JS Number）。
type ScheduleInput struct {
	Kind       string   `json:"kind"`
	At         string   `json:"at"`
	Weekday    *float64 `json:"weekday"`
	Hours      *float64 `json:"hours"`
	Minutes    *float64 `json:"minutes"`
	Expression string   `json:"expression"`
}

func parseClock(raw string) (int, int, bool) {
	trimmed := strings.TrimSpace(raw)
	colon := strings.IndexByte(trimmed, ':')
	if colon <= 0 || len(trimmed[colon+1:]) != 2 {
		return 0, 0, false
	}
	left := trimmed[:colon]
	right := trimmed[colon+1:]
	if len(left) > 2 || !isDigitsOnly(left) || !isDigitsOnly(right) {
		return 0, 0, false
	}
	hour, err1 := strconv.Atoi(left)
	minute, err2 := strconv.Atoi(right)
	if err1 != nil || err2 != nil || hour < 0 || hour > 23 || minute < 0 || minute > 59 {
		return 0, 0, false
	}
	return hour, minute, true
}

// NormalizeSchedule 校验并归一化调度定义；不合法返回 nil。
func NormalizeSchedule(input *ScheduleInput) *Schedule {
	if input == nil {
		return nil
	}
	kind := strings.ToLower(strings.TrimSpace(input.Kind))
	switch kind {
	case "daily":
		hour, minute, ok := parseClock(input.At)
		if !ok {
			return nil
		}
		return &Schedule{Kind: "daily", At: fmt.Sprintf("%02d:%02d", hour, minute)}
	case "weekly":
		hour, minute, ok := parseClock(input.At)
		if !ok || input.Weekday == nil || math.IsNaN(*input.Weekday) || math.IsInf(*input.Weekday, 0) {
			return nil
		}
		wd := *input.Weekday
		if wd != math.Trunc(wd) || wd < 0 || wd > 6 {
			return nil
		}
		wdInt := int(wd)
		return &Schedule{
			Kind:    "weekly",
			Weekday: &wdInt,
			At:      fmt.Sprintf("%02d:%02d", hour, minute),
		}
	case "interval":
		if input.Hours == nil || math.IsNaN(*input.Hours) || math.IsInf(*input.Hours, 0) || *input.Hours < 0 {
			return nil
		}
		minutesVal := 0.0
		if input.Minutes != nil {
			if math.IsNaN(*input.Minutes) || math.IsInf(*input.Minutes, 0) || *input.Minutes < 0 {
				return nil
			}
			minutesVal = *input.Minutes
		}
		totalMinutes := int(math.Round((*input.Hours)*60 + minutesVal))
		if totalMinutes < 5 || totalMinutes > 24*60 {
			return nil
		}
		hrs := totalMinutes / 60
		mins := totalMinutes % 60
		return &Schedule{
			Kind:    "interval",
			Hours:   &hrs,
			Minutes: &mins,
		}
	case "cron":
		cron := ParseCron(input.Expression)
		if cron == nil {
			return nil
		}
		return &Schedule{Kind: "cron", Expression: cron.Expression}
	default:
		return nil
	}
}

// ScheduleLabel 返回面向 UI 展示的中文调度说明。
func ScheduleLabel(schedule *Schedule) string {
	if schedule == nil {
		return "未设置"
	}
	switch schedule.Kind {
	case "daily":
		return "每天 " + schedule.At
	case "weekly":
		name := "周"
		if schedule.Weekday != nil && *schedule.Weekday >= 0 && *schedule.Weekday < len(weekdayNames) {
			name = weekdayNames[*schedule.Weekday]
		}
		return fmt.Sprintf("每%s %s", name, schedule.At)
	case "interval":
		var parts []string
		if schedule.Hours != nil && *schedule.Hours > 0 {
			parts = append(parts, fmt.Sprintf("%d 小时", *schedule.Hours))
		}
		if schedule.Minutes != nil && *schedule.Minutes > 0 {
			parts = append(parts, fmt.Sprintf("%d 分钟", *schedule.Minutes))
		}
		if len(parts) == 0 {
			return "每 5 分钟"
		}
		return "每 " + strings.Join(parts, " ")
	case "cron":
		if described := DescribeCron(schedule.Expression); described != "" {
			return fmt.Sprintf("%s（%s）", schedule.Expression, described)
		}
		return schedule.Expression
	default:
		return "未设置"
	}
}

// ComputeNextRunAt 计算下一次运行毫秒时间戳；interval 以 anchorMS 为锚点。
func ComputeNextRunAt(schedule *Schedule, fromMS int64, anchorMS int64, loc *time.Location) int64 {
	if schedule == nil {
		return 0
	}
	if loc == nil {
		loc = time.Local
	}
	base := time.UnixMilli(fromMS).In(loc)
	switch schedule.Kind {
	case "daily":
		hour, minute, ok := parseClock(schedule.At)
		if !ok {
			return 0
		}
		candidate := time.Date(base.Year(), base.Month(), base.Day(), hour, minute, 0, 0, loc)
		if candidate.UnixMilli() <= fromMS {
			candidate = candidate.AddDate(0, 0, 1)
		}
		return candidate.UnixMilli()
	case "weekly":
		hour, minute, ok := parseClock(schedule.At)
		if !ok || schedule.Weekday == nil {
			return 0
		}
		candidate := time.Date(base.Year(), base.Month(), base.Day(), hour, minute, 0, 0, loc)
		for int(candidate.Weekday()) != *schedule.Weekday || candidate.UnixMilli() <= fromMS {
			candidate = candidate.AddDate(0, 0, 1)
		}
		return candidate.UnixMilli()
	case "interval":
		hrs := 0
		mins := 0
		if schedule.Hours != nil {
			hrs = *schedule.Hours
		}
		if schedule.Minutes != nil {
			mins = *schedule.Minutes
		}
		stepMS := int64(hrs*60+mins) * 60 * 1000
		if stepMS <= 0 {
			return 0
		}
		anchor := anchorMS
		if anchor <= 0 {
			anchor = fromMS
		}
		if anchor+stepMS > fromMS {
			return anchor + stepMS
		}
		elapsed := fromMS - anchor
		return anchor + (elapsed/stepMS+1)*stepMS
	case "cron":
		return ParseCron(schedule.Expression).NextRunAt(base, loc)
	default:
		return 0
	}
}

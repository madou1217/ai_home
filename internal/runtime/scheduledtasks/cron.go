// Package scheduledtasks 实现计划任务的 CRUD、5 段 cron 调度、防重入执行与持久化。
package scheduledtasks

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	// MaxCronScanDays 是逐分钟前扫的最大跨度天数。
	MaxCronScanDays = 366
)

var weekdayNames = []string{"周日", "周一", "周二", "周三", "周四", "周五", "周六"}

type fieldRange struct {
	name string
	min  int
	max  int
}

var cronFieldRanges = []fieldRange{
	{name: "minute", min: 0, max: 59},
	{name: "hour", min: 0, max: 23},
	{name: "dayOfMonth", min: 1, max: 31},
	{name: "month", min: 1, max: 12},
	{name: "dayOfWeek", min: 0, max: 6},
}

// Cron 表示解析后的标准 5 段表达式（分 时 日 月 周）。
type Cron struct {
	Expression string
	Minute     map[int]struct{}
	Hour       map[int]struct{}
	DayOfMonth map[int]struct{}
	Month      map[int]struct{}
	DayOfWeek  map[int]struct{}
}

// ParseCron 解析标准 5 段 cron；支持 * / a / a-b / a-b/n / */n / a,b,c；非法返回 nil。
func ParseCron(expression string) *Cron {
	collapsed := strings.Join(strings.Fields(strings.TrimSpace(expression)), " ")
	if collapsed == "" {
		return nil
	}
	parts := strings.Split(collapsed, " ")
	if len(parts) != 5 {
		return nil
	}
	minute := parseCronField(parts[0], cronFieldRanges[0])
	hour := parseCronField(parts[1], cronFieldRanges[1])
	dom := parseCronField(parts[2], cronFieldRanges[2])
	month := parseCronField(parts[3], cronFieldRanges[3])
	dow := parseCronField(parts[4], cronFieldRanges[4])
	if minute == nil || hour == nil || dom == nil || month == nil || dow == nil {
		return nil
	}
	return &Cron{
		Expression: collapsed,
		Minute:     minute,
		Hour:       hour,
		DayOfMonth: dom,
		Month:      month,
		DayOfWeek:  dow,
	}
}

func parseCronField(raw string, rng fieldRange) map[int]struct{} {
	text := strings.TrimSpace(raw)
	if text == "" {
		return nil
	}
	values := make(map[int]struct{})
	for _, part := range strings.Split(text, ",") {
		chunk := strings.TrimSpace(part)
		if chunk == "" {
			return nil
		}
		step := 1
		body := chunk
		if slash := strings.IndexByte(chunk, '/'); slash >= 0 {
			if strings.ContainsRune(chunk[slash+1:], '/') {
				return nil
			}
			stepText := chunk[slash+1:]
			parsedStep, err := strconv.Atoi(stepText)
			if err != nil || !isDigitsOnly(stepText) || parsedStep <= 0 {
				return nil
			}
			step = parsedStep
			body = chunk[:slash]
		}
		var start, end int
		if body == "*" {
			start, end = rng.min, rng.max
		} else if dash := strings.IndexByte(body, '-'); dash >= 0 {
			left := body[:dash]
			right := body[dash+1:]
			if !isDigitsOnly(left) || !isDigitsOnly(right) {
				return nil
			}
			var err error
			start, err = strconv.Atoi(left)
			if err != nil {
				return nil
			}
			end, err = strconv.Atoi(right)
			if err != nil {
				return nil
			}
		} else {
			if !isDigitsOnly(body) {
				return nil
			}
			var err error
			start, err = strconv.Atoi(body)
			if err != nil {
				return nil
			}
			if strings.ContainsRune(chunk, '/') {
				end = rng.max
			} else {
				end = start
			}
		}
		// 周日 7 归一化为 0（仅对 dayOfWeek）。
		if rng.name == "dayOfWeek" {
			if start == 7 {
				start = 0
			}
			if end == 7 {
				end = 0
			}
		}
		if start < rng.min || start > rng.max || end < rng.min || end > rng.max || end < start {
			return nil
		}
		for v := start; v <= end; v += step {
			values[v] = struct{}{}
		}
	}
	if len(values) == 0 {
		return nil
	}
	return values
}

func isDigitsOnly(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

func isWildcardField(field map[int]struct{}, rng fieldRange) bool {
	return len(field) == rng.max-rng.min+1
}

// Matches 检查某个本地时间点是否命中 cron 规则。
func (cron *Cron) Matches(t time.Time) bool {
	if cron == nil {
		return false
	}
	if _, ok := cron.Minute[t.Minute()]; !ok {
		return false
	}
	if _, ok := cron.Hour[t.Hour()]; !ok {
		return false
	}
	if _, ok := cron.Month[int(t.Month())]; !ok {
		return false
	}
	domRestricted := !isWildcardField(cron.DayOfMonth, cronFieldRanges[2])
	dowRestricted := !isWildcardField(cron.DayOfWeek, cronFieldRanges[4])
	_, domHit := cron.DayOfMonth[t.Day()]
	_, dowHit := cron.DayOfWeek[int(t.Weekday())]
	if domRestricted && dowRestricted {
		return domHit || dowHit
	}
	if domRestricted {
		return domHit
	}
	if dowRestricted {
		return dowHit
	}
	return true
}

// NextRunAt 计算自 from 起的下一次触发时间戳（毫秒）；366 天内不匹配返回 0。
func (cron *Cron) NextRunAt(from time.Time, loc *time.Location) int64 {
	if cron == nil {
		return 0
	}
	if loc == nil {
		loc = time.Local
	}
	local := from.In(loc)
	cursor := time.Date(local.Year(), local.Month(), local.Day(), local.Hour(), local.Minute()+1, 0, 0, loc)
	limitMS := cursor.UnixMilli() + int64(MaxCronScanDays)*24*60*60*1000
	for cursor.UnixMilli() <= limitMS {
		if cron.Matches(cursor) {
			return cursor.UnixMilli()
		}
		cursor = cursor.Add(time.Minute)
	}
	return 0
}

// DescribeCron 生成与 Node scheduled-task-cron 一致的中文调度解读。
func DescribeCron(expression string) string {
	cron := ParseCron(expression)
	if cron == nil {
		return ""
	}
	minutes := sortedKeys(cron.Minute)
	hours := sortedKeys(cron.Hour)
	dowValues := sortedKeys(cron.DayOfWeek)
	domRestricted := !isWildcardField(cron.DayOfMonth, cronFieldRanges[2])
	monthRestricted := !isWildcardField(cron.Month, cronFieldRanges[3])

	var pieces []string
	if len(hours) == 1 && len(minutes) == 1 {
		clock := fmt.Sprintf("%02d:%02d", hours[0], minutes[0])
		if len(dowValues) > 0 && len(dowValues) < 7 {
			names := make([]string, len(dowValues))
			for i, v := range dowValues {
				if v >= 0 && v < len(weekdayNames) {
					names[i] = weekdayNames[v]
				} else {
					names[i] = fmt.Sprintf("周%d", v)
				}
			}
			pieces = append(pieces, strings.Join(names, "、")+" "+clock)
		} else if domRestricted {
			days := joinInts(sortedKeys(cron.DayOfMonth), "、")
			pieces = append(pieces, fmt.Sprintf("每月 %s 日 %s", days, clock))
		} else {
			pieces = append(pieces, "每天 "+clock)
		}
	} else if len(hours) == 1 {
		pieces = append(pieces, fmt.Sprintf("每天 %02d 点的 %s 分", hours[0], joinInts(minutes, "、")))
	} else if len(hours) < 24 {
		firstMin := 0
		if len(minutes) > 0 {
			firstMin = minutes[0]
		}
		times := make([]string, len(hours))
		for i, h := range hours {
			times[i] = fmt.Sprintf("%02d:%02d", h, firstMin)
		}
		pieces = append(pieces, "每天 "+strings.Join(times, "、"))
	} else {
		pieces = append(pieces, fmt.Sprintf("每小时的第 %s 分", joinInts(minutes, "、")))
	}
	if monthRestricted {
		pieces = append(pieces, fmt.Sprintf("仅 %s 月", joinInts(sortedKeys(cron.Month), "、")))
	}
	return strings.Join(pieces, " · ")
}

func sortedKeys(m map[int]struct{}) []int {
	keys := make([]int, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Ints(keys)
	return keys
}

func joinInts(values []int, sep string) string {
	parts := make([]string, len(values))
	for i, v := range values {
		parts[i] = strconv.Itoa(v)
	}
	return strings.Join(parts, sep)
}

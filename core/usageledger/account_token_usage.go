package usageledger

import (
	"sort"
	"strings"
	"time"
)

// AccountTokenUsageWindows 是「按账号 token 用量」三个滚动窗口的起点。
//
// 为什么只存起点：Node 的账号行只回答「从某个起点累加到锚点用了多少」，
// 四个维度（day/week/month/total）共享同一个右端点（查询的 to），
// 所以窗口用起点就能唯一表达，不需要再记区间。
type AccountTokenUsageWindows struct {
	DayStart   time.Time
	WeekStart  time.Time
	MonthStart time.Time
}

// 时区偏移（分钟）的合法范围：-720（UTC-12）..840（UTC+14），
// 覆盖现实中所有民用时区；越界视为调用方参数错误而不是钳制。
const (
	MinTZOffsetMinutes = -720
	MaxTZOffsetMinutes = 840
)

// ResolveAccountTokenUsageWindows 以 anchor 为右端点、在 tzOffsetMinutes 这个
// 本地时区下切出 day/week/month 的起点，返回的起点都是 UTC 瞬时。
//
// 语义是「本地时间 = UTC + tzOffsetMinutes」：
//   - day：本地当日 00:00；
//   - week：本地本周一 00:00（与 Node 的 (getDay()+6)%7 同一边界）；
//   - month：本地本月 1 日 00:00。
//
// 先把 anchor 平移到固定偏移的 Local 里取年月日，再换算回 UTC 瞬时，
// 这样账本（occurred_at_ms 存 UTC 毫秒）不需要任何时区转换，窗口却按
// 用户看到的日历切分。
//
// 为什么用偏移而不是 IANA 时区：Node 侧只持有本地偏移（getTimezoneOffset），
// 没有时区名可传；而且 IANA 需要 tzdata——Go 在 Windows、精简容器镜像里默认
// 可能取不到，历史/未来边界还会随时区库版本变化，同一份账本在不同机器上算出
// 不同的「今天」。固定偏移无依赖、可复现，也便于单测。
// 代价是夏令时切换当天不跟随本地日历，但 Node 侧传入的同样是当日生效的偏移，
// 两端口径保持一致。
//
// total 没有起点（从账本最早一条算起），由查询的 from 限定，
// 与 Node 的 totalStartMs = 0 一致。
func ResolveAccountTokenUsageWindows(
	anchor time.Time,
	tzOffsetMinutes int,
) (AccountTokenUsageWindows, error) {
	if tzOffsetMinutes < MinTZOffsetMinutes || tzOffsetMinutes > MaxTZOffsetMinutes {
		return AccountTokenUsageWindows{}, ErrInvalidQuery
	}
	// 固定偏移的 Location：它只做日期算术，不带任何夏令时规则。
	local := anchor.UTC().In(time.FixedZone("local", tzOffsetMinutes*60))
	dayStart := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, local.Location())
	// time.Weekday: Sunday=0；转成「距离本周一几天」，与 BucketStart 同口径。
	weekdayOffset := (int(dayStart.Weekday()) + 6) % 7
	return AccountTokenUsageWindows{
		DayStart:   dayStart.UTC(),
		WeekStart:  dayStart.AddDate(0, 0, -weekdayOffset).UTC(),
		MonthStart: time.Date(local.Year(), local.Month(), 1, 0, 0, 0, 0, local.Location()).UTC(),
	}, nil
}

// AccountTokenUsageModel 是单个模型的用量。
//
// 字段与 lib/usage/account-token-usage.js 的模型条目一一对应：
// model ↔ model，day/week/month/total 就是四个维度的 token 数（平铺，不嵌套）。
// Node 的 *CostUsd 字段不在 core 里：账本只存 token 事实，定价由 HTTP 适配器
// 按「未知」补 null，避免把成本口径写进领域层。
type AccountTokenUsageModel struct {
	Model string `json:"model"`
	Day   uint64 `json:"day"`
	Week  uint64 `json:"week"`
	Month uint64 `json:"month"`
	Total uint64 `json:"total"`
}

// AccountTokenUsage 是账号行的 token 用量。
//
// 与 Node 的对应关系：day/week/month/total 就是 ACCOUNT_TOKEN_USAGE_DIMENSIONS
// 四个维度上的累加值（Node 把四个数字平铺在账号对象上），models 对应
// normalizeAccountTokenUsageValue 产出的模型条目数组。
type AccountTokenUsage struct {
	Day    uint64                   `json:"day"`
	Week   uint64                   `json:"week"`
	Month  uint64                   `json:"month"`
	Total  uint64                   `json:"total"`
	Models []AccountTokenUsageModel `json:"models"`
}

// AggregateAccountTokenUsage 把账号的账本记录按四个维度累加。
//
// 过滤口径与 AggregateModels / AggregateBuckets 保持一致：时间区间左闭右闭、
// provider/model 精确匹配、AccountRef 非空时只统计该账号。窗口右端点就是
// query.To，所以这里只判下界；记录可能来自更宽的扫描范围，仍按 query 再滤一次。
//
// 模型排序复刻 Node 的 compareAccountTokenUsageModels：先用 day+week+month
// 的滚动权重降序（total 不参与权重，否则只在历史用过的模型会抢占首位），
// 权重相同再比 total，最后按模型名升序。
func AggregateAccountTokenUsage(
	records []Record,
	query Query,
	windows AccountTokenUsageWindows,
) AccountTokenUsage {
	if query.Validate() != nil ||
		windows.DayStart.IsZero() ||
		windows.WeekStart.IsZero() ||
		windows.MonthStart.IsZero() {
		return AccountTokenUsage{Models: []AccountTokenUsageModel{}}
	}
	provider := strings.TrimSpace(strings.ToLower(query.Provider))
	model := strings.TrimSpace(query.Model)
	accountRef := strings.TrimSpace(query.AccountRef.String())
	models := make(map[string]*AccountTokenUsageModel)
	var usage AccountTokenUsage
	for _, record := range records {
		if !record.IsValid() ||
			record.OccurredAt().Before(query.From) ||
			record.OccurredAt().After(query.To) {
			continue
		}
		if provider != "" && record.Provider() != provider ||
			model != "" && record.Model() != model {
			continue
		}
		if accountRef != "" && record.AccountRef().String() != accountRef {
			continue
		}
		tokens := record.Usage().TotalTokens()
		item := models[record.Model()]
		if item == nil {
			item = &AccountTokenUsageModel{Model: record.Model()}
			models[record.Model()] = item
		}
		usage.Total += tokens
		item.Total += tokens
		occurredAt := record.OccurredAt()
		if !occurredAt.Before(windows.DayStart) {
			usage.Day += tokens
			item.Day += tokens
		}
		if !occurredAt.Before(windows.WeekStart) {
			usage.Week += tokens
			item.Week += tokens
		}
		if !occurredAt.Before(windows.MonthStart) {
			usage.Month += tokens
			item.Month += tokens
		}
	}
	result := make([]AccountTokenUsageModel, 0, len(models))
	for _, item := range models {
		// 与 Node 一致：四个维度全零的模型不进结果（例如只有被 from 裁掉的记录）。
		if item.Day == 0 && item.Week == 0 && item.Month == 0 && item.Total == 0 {
			continue
		}
		result = append(result, *item)
	}
	sort.Slice(result, func(left, right int) bool {
		leftWeight := result[left].Day + result[left].Week + result[left].Month
		rightWeight := result[right].Day + result[right].Week + result[right].Month
		if leftWeight != rightWeight {
			return leftWeight > rightWeight
		}
		if result[left].Total != result[right].Total {
			return result[left].Total > result[right].Total
		}
		return result[left].Model < result[right].Model
	})
	usage.Models = result
	return usage
}

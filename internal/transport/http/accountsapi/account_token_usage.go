package accountsapi

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/usageledger"
)

// TokenUsageManagement 提供按账号、按窗口起点的 token 用量读取。
//
// tzOffsetMinutes 表达调用方的本地时区偏移（本地时间 = UTC + 偏移），
// 只影响 day/week/month 的边界，账本与查询区间始终是 UTC。
type TokenUsageManagement interface {
	QueryAccountTokenUsage(
		ctx context.Context,
		query usageledger.Query,
		tzOffsetMinutes int,
	) (usageledger.AccountTokenUsage, error)
}

// tokenUsageTZOffsetParam 是时区偏移的 query 参数名。
//
// 为什么传偏移而不是 IANA 时区名：Node 侧只有 getTimezoneOffset() 拿到的本地偏移，
// 没有可传的时区名；而 IANA 需要 tzdata（Windows、精简容器镜像里可能缺失），
// 历史/未来边界还会随库版本变化。固定偏移无外部依赖，两端算出的日历一致。
const tokenUsageTZOffsetParam = "tz_offset_minutes"

// accountTokenUsageModelView 逐字段对齐 Node 的模型条目
// （lib/usage/account-token-usage.js 的 normalizeAccountTokenUsageValue）：
//
//	model                        ↔ model
//	day / week / month / total   ↔ 四个维度的 token 数
//	dayCostUsd / weekCostUsd …   ↔ Node 的 ${dimension}CostUsd
//
// 成本恒为 null：Go 的 usage_ledger 只存 token 事实，没有逐次调用的 cost_usd。
// 用现行定价重算会与 Node 写入时的历史成本不一致，所以这里明确「未知」，
// 由上层连同 cost_known=false 一起判断，绝不把未知写成 0 元。
type accountTokenUsageModelView struct {
	Model        string   `json:"model"`
	Day          uint64   `json:"day"`
	Week         uint64   `json:"week"`
	Month        uint64   `json:"month"`
	Total        uint64   `json:"total"`
	DayCostUSD   *float64 `json:"dayCostUsd"`
	WeekCostUSD  *float64 `json:"weekCostUsd"`
	MonthCostUSD *float64 `json:"monthCostUsd"`
	TotalCostUSD *float64 `json:"totalCostUsd"`
}

// accountTokenUsageView 是账号行 token 用量的对外形状。
//
// 与 Node 账号对象的对应关系：day/week/month/total 四个数字和 models 数组
// 就是 Node 直接平铺在账号上的形状（见 lib/usage/account-token-usage.js 的
// ACCOUNT_TOKEN_USAGE_DIMENSIONS）；from_ms/to_ms 是本端点额外给出的
// 实际扫描区间，便于调用方核对窗口口径。
type accountTokenUsageView struct {
	Day    uint64                       `json:"day"`
	Week   uint64                       `json:"week"`
	Month  uint64                       `json:"month"`
	Total  uint64                       `json:"total"`
	Models []accountTokenUsageModelView `json:"models"`
	FromMS int64                        `json:"from_ms"`
	ToMS   int64                        `json:"to_ms"`
	// CostKnown=false 表示本响应里的成本全部未知（值为 null），不是 0 元。
	CostKnown bool `json:"cost_known"`
}

type accountTokenUsageResponse struct {
	Data accountTokenUsageView `json:"data"`
}

// handleAccountTokenUsage 返回单账号的 day/week/month/total token 用量。
//
// Node 的账号行原先从 model_usage_records 现算这份数据；切到 Go 之后，
// 账号行装配改为读这里，四个时间维度与分模型明细一次拿齐。
func (handler *Handler) handleAccountTokenUsage(
	response http.ResponseWriter,
	request *http.Request,
	accountRef accountcore.AccountRef,
) {
	if handler.tokenUsage == nil {
		writeAPIError(
			response,
			http.StatusServiceUnavailable,
			"token_usage_unavailable",
			"token 用量查询不可用",
		)
		return
	}
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeMethodNotAllowed(response)
		return
	}
	query, tzOffsetMinutes, ok := parseAccountTokenUsageQuery(response, request, accountRef)
	if !ok {
		return
	}
	usage, err := handler.tokenUsage.QueryAccountTokenUsage(request.Context(), query, tzOffsetMinutes)
	if err != nil {
		if errors.Is(err, usageledger.ErrInvalidQuery) {
			writeAPIError(
				response,
				http.StatusBadRequest,
				"invalid_token_usage_query",
				"token 用量查询参数无效",
			)
			return
		}
		writeApplicationError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, accountTokenUsageResponse{
		Data: newAccountTokenUsageView(usage, query),
	})
}

// parseAccountTokenUsageQuery 解析 from/to/tz_offset_minutes，未传 from 时扫描全部
// 历史，未传 to 时锚定当前时刻，未传 tz_offset_minutes 时按 UTC（偏移 0）。
//
// 语义与 usagestatsapi.parseQuery 一致：from/to 可以写 2006-01-02（from 取当天
// 00:00、to 取当天 23:59:59.999999999），也可以写 RFC3339Nano；两者都归一到 UTC。
// 这里的 to 同时是窗口锚点（见 store 注释），所以「今天/本周/本月」随 to 移动；
// 偏移再把这三个边界挪到调用方本地日历上。
func parseAccountTokenUsageQuery(
	response http.ResponseWriter,
	request *http.Request,
	accountRef accountcore.AccountRef,
) (usageledger.Query, int, bool) {
	values := request.URL.Query()
	for key, entries := range values {
		if (key != "from" && key != "to" && key != tokenUsageTZOffsetParam) ||
			len(entries) != 1 {
			writeAPIError(
				response,
				http.StatusBadRequest,
				"invalid_token_usage_query",
				"token 用量查询参数无效",
			)
			return usageledger.Query{}, 0, false
		}
	}
	// 缺省 0 = UTC，与老调用方（还没传偏移）保持同一口径。
	tzOffsetMinutes := 0
	if values.Has(tokenUsageTZOffsetParam) {
		parsed, err := parseTokenUsageTZOffset(values.Get(tokenUsageTZOffsetParam))
		if err != nil {
			writeAPIError(
				response,
				http.StatusBadRequest,
				"invalid_token_usage_query",
				"tz_offset_minutes 无效",
			)
			return usageledger.Query{}, 0, false
		}
		tzOffsetMinutes = parsed
	}
	// 默认从账本最早一条算起（1970-01-01，等价于 Node 的 totalStartMs=0），
	// 终点取当前时刻：不传参数就是账号行要的「今天/本周/本月/累计」。
	from := time.UnixMilli(0).UTC()
	to := time.Now().UTC()
	if values.Has("from") {
		parsed, err := parseTokenUsageTime(values.Get("from"), false)
		if err != nil {
			writeAPIError(
				response,
				http.StatusBadRequest,
				"invalid_token_usage_query",
				"from 时间格式无效",
			)
			return usageledger.Query{}, 0, false
		}
		from = parsed
	}
	if values.Has("to") {
		parsed, err := parseTokenUsageTime(values.Get("to"), true)
		if err != nil {
			writeAPIError(
				response,
				http.StatusBadRequest,
				"invalid_token_usage_query",
				"to 时间格式无效",
			)
			return usageledger.Query{}, 0, false
		}
		to = parsed
	}
	query := usageledger.Query{From: from, To: to, AccountRef: accountRef}
	if query.Validate() != nil {
		writeAPIError(
			response,
			http.StatusBadRequest,
			"invalid_token_usage_query",
			"时间范围无效",
		)
		return usageledger.Query{}, 0, false
	}
	return query, tzOffsetMinutes, true
}

// parseTokenUsageTZOffset 解析 tz_offset_minutes：必须是有符号十进制整数，
// 且落在 [-720, 840]。用偏移而不是 IANA 时区名的原因见 tokenUsageTZOffsetParam。
func parseTokenUsageTZOffset(raw string) (int, error) {
	offset, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil {
		return 0, errInvalidQuery
	}
	if offset < usageledger.MinTZOffsetMinutes || offset > usageledger.MaxTZOffsetMinutes {
		return 0, errInvalidQuery
	}
	return offset, nil
}

// parseTokenUsageTime 复刻 usagestatsapi 的时间解析语义（日期按天、否则 RFC3339Nano）。
func parseTokenUsageTime(raw string, endOfDay bool) (time.Time, error) {
	if parsed, err := time.Parse("2006-01-02", raw); err == nil {
		if endOfDay {
			return parsed.Add(24*time.Hour - time.Nanosecond), nil
		}
		return parsed, nil
	}
	parsed, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil {
		return time.Time{}, errInvalidQuery
	}
	return parsed.UTC(), nil
}

// newAccountTokenUsageView 把领域结果映射成 Node 的字段名与层级。
func newAccountTokenUsageView(
	usage usageledger.AccountTokenUsage,
	query usageledger.Query,
) accountTokenUsageView {
	models := make([]accountTokenUsageModelView, 0, len(usage.Models))
	for _, model := range usage.Models {
		models = append(models, accountTokenUsageModelView{
			Model: model.Model,
			Day:   model.Day,
			Week:  model.Week,
			Month: model.Month,
			Total: model.Total,
			// 四个成本位保持 null（见类型注释），不用 0 冒充。
		})
	}
	return accountTokenUsageView{
		Day:       usage.Day,
		Week:      usage.Week,
		Month:     usage.Month,
		Total:     usage.Total,
		Models:    models,
		FromMS:    query.From.UnixMilli(),
		ToMS:      query.To.UnixMilli(),
		CostKnown: false,
	}
}

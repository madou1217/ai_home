package accountsapi

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"

	usageapp "github.com/madou1217/ai_home/application/accountusage"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// maxQuotaStatsWindowMinutes 是窗口期的上界（366 天），只防荒谬值。
const maxQuotaStatsWindowMinutes = 366 * 24 * 60

// QuotaStatsManagement 提供按窗口期的额度统计。
type QuotaStatsManagement interface {
	BuildQuotaStats(
		ctx context.Context,
		query usageapp.QuotaStatsQuery,
	) (usageapp.QuotaStatsResult, error)
}

type accountQuotaStatsResponse struct {
	Data usageapp.QuotaStatsResult `json:"data"`
}

// handleAccountQuotaStats 返回单账号按窗口期（5h / 7 天 / 30 天）的额度与用量统计。
func (handler *Handler) handleAccountQuotaStats(
	response http.ResponseWriter,
	request *http.Request,
	accountRef accountcore.AccountRef,
) {
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeMethodNotAllowed(response)
		return
	}
	query, ok := parseQuotaStatsQuery(response, request, accountRef)
	if !ok {
		return
	}
	result, err := handler.quotaStats.BuildQuotaStats(request.Context(), query)
	if err != nil {
		if errors.Is(err, usageapp.ErrInvalidQuotaStatsQuery) {
			writeAPIError(
				response,
				http.StatusBadRequest,
				"invalid_quota_stats_query",
				"额度统计参数无效",
			)
			return
		}
		writeApplicationError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, accountQuotaStatsResponse{Data: result})
}

// parseQuotaStatsQuery 严格解析 window / scope / range_days，未知参数一律拒绝。
func parseQuotaStatsQuery(
	response http.ResponseWriter,
	request *http.Request,
	accountRef accountcore.AccountRef,
) (usageapp.QuotaStatsQuery, bool) {
	query := usageapp.QuotaStatsQuery{AccountRef: accountRef}
	values := request.URL.Query()
	for key := range values {
		switch key {
		case "window", "scope", "range_days":
		default:
			writeAPIError(
				response,
				http.StatusBadRequest,
				"invalid_quota_stats_query",
				"额度统计参数无效",
			)
			return usageapp.QuotaStatsQuery{}, false
		}
	}
	if raw := strings.TrimSpace(values.Get("window")); raw != "" {
		windowMinutes, err := strconv.ParseInt(raw, 10, 64)
		// 只挡脏参数（非整数 / 非正 / 荒谬值），不维护档位白名单：
		// 上游随时新增 12h、1天 这类窗口，写死档位会让新维度直接 400。
		if err != nil || windowMinutes <= 0 || windowMinutes > maxQuotaStatsWindowMinutes {
			writeAPIError(
				response,
				http.StatusBadRequest,
				"invalid_quota_stats_query",
				"窗口期必须是正整数分钟数",
			)
			return usageapp.QuotaStatsQuery{}, false
		}
		query.WindowMinutes = windowMinutes
	}
	if raw := strings.TrimSpace(values.Get("range_days")); raw != "" {
		rangeDays, err := strconv.Atoi(raw)
		if err != nil ||
			rangeDays < usageapp.MinQuotaStatsRangeDays ||
			rangeDays > usageapp.MaxQuotaStatsRangeDays {
			writeAPIError(
				response,
				http.StatusBadRequest,
				"invalid_quota_stats_query",
				"统计范围只支持 1–90 天",
			)
			return usageapp.QuotaStatsQuery{}, false
		}
		query.RangeDays = rangeDays
	}
	query.QuotaKey = strings.TrimSpace(values.Get("scope"))
	return query, true
}

func isQuotaStatsDimension(windowMinutes int64) bool {
	return windowMinutes > 0 && windowMinutes <= maxQuotaStatsWindowMinutes
}

package accountsapi

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"

	usageapp "github.com/madou1217/ai_home/application/accountusage"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
)

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
		if err != nil || !isQuotaStatsDimension(windowMinutes) {
			writeAPIError(
				response,
				http.StatusBadRequest,
				"invalid_quota_stats_query",
				"窗口长度只支持 300 / 10080 / 43200 分钟",
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
	for _, dimension := range usagecore.QuotaWindowDimensions() {
		if dimension.WindowMinutes == windowMinutes {
			return true
		}
	}
	return false
}

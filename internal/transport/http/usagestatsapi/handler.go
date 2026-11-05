// Package usagestatsapi exposes Go's durable inference token ledger as a
// read-only management contract. It is intentionally smaller than Node's
// dashboard surface until the remaining projections have matching sources.
package usagestatsapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/madou1217/ai_home/core/usageledger"
)

const (
	Path         = "/v1/management/usage/stats"
	ModelsPath   = "/v1/management/usage/models"
	SessionsPath = "/v1/management/usage/sessions"
)

type Authorizer interface{ Authorized(*http.Request) bool }

type Source interface {
	QueryUsageStats(context.Context, usageledger.Query) (usageledger.Stats, error)
}

type Handler struct {
	authorizer Authorizer
	source     Source
}

type ModelsSource interface {
	QueryUsageModels(context.Context, usageledger.Query) ([]usageledger.ModelStats, error)
}

// ModelCostCalculator 为一批模型用量补充成本。
//
// 为什么是批接口：定价目录要读一整张表，按行调用会把一次查询放大成 N 次。
// 第二个返回值表示定价目录是否可用——不可用时成本是「未知」，不是「0 元」。
type ModelCostCalculator interface {
	Costs(context.Context, []usageledger.ModelStats) ([]float64, []bool, bool)
}

type ModelsHandler struct {
	authorizer Authorizer
	source     ModelsSource
	cost       ModelCostCalculator
}

// modelUsageRow 是模型用量行的对外形状：原字段打平，成本按行追加。
type modelUsageRow struct {
	usageledger.ModelStats
	CostUSD   *float64 `json:"cost_usd"`
	CostKnown bool     `json:"cost_known"`
}

type SessionsSource interface {
	QueryUsageSessions(context.Context, usageledger.Query) ([]usageledger.SessionStats, error)
}

type SessionsHandler struct {
	authorizer Authorizer
	source     SessionsSource
}

func NewHandler(authorizer Authorizer, source Source) (*Handler, error) {
	if authorizer == nil || source == nil {
		return nil, usageledger.ErrInvalidQuery
	}
	return &Handler{authorizer: authorizer, source: source}, nil
}

func NewModelsHandler(
	authorizer Authorizer,
	source ModelsSource,
	cost ModelCostCalculator,
) (*ModelsHandler, error) {
	if authorizer == nil || source == nil {
		return nil, usageledger.ErrInvalidQuery
	}
	return &ModelsHandler{authorizer: authorizer, source: source, cost: cost}, nil
}

func NewSessionsHandler(authorizer Authorizer, source SessionsSource) (*SessionsHandler, error) {
	if authorizer == nil || source == nil {
		return nil, usageledger.ErrInvalidQuery
	}
	return &SessionsHandler{authorizer: authorizer, source: source}, nil
}

func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	serveUsageQuery(response, request, handler.authorizer, "usage_stats_failed", "用量统计不可用",
		func(ctx context.Context, query usageledger.Query) (map[string]any, error) {
			stats, err := handler.source.QueryUsageStats(ctx, query)
			return map[string]any{"stats": stats}, err
		})
}

func (handler *ModelsHandler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	serveUsageQuery(response, request, handler.authorizer, "usage_models_failed", "用量模型统计不可用",
		func(ctx context.Context, query usageledger.Query) (map[string]any, error) {
			models, err := handler.source.QueryUsageModels(ctx, query)
			if err != nil {
				return nil, err
			}
			rows, costSupported := handler.enrichWithCost(ctx, models)
			return map[string]any{"models": rows, "cost_supported": costSupported}, nil
		})
}

// enrichWithCost 给每行补成本；任何一行没有定价就标 cost_known=false，
// 让前端能区分「确实为 0」与「没有价格口径」。
func (handler *ModelsHandler) enrichWithCost(
	ctx context.Context,
	models []usageledger.ModelStats,
) ([]modelUsageRow, bool) {
	// 空结果保持 null，不把契约从 null 改成 []。
	if models == nil {
		return nil, false
	}
	rows := make([]modelUsageRow, len(models))
	for index, row := range models {
		rows[index] = modelUsageRow{ModelStats: row}
	}
	if handler.cost == nil || len(models) == 0 {
		return rows, false
	}
	costs, known, supported := handler.cost.Costs(ctx, models)
	if !supported || len(costs) != len(rows) || len(known) != len(rows) {
		return rows, false
	}
	for index := range rows {
		if !known[index] {
			continue
		}
		value := costs[index]
		rows[index].CostUSD = &value
		rows[index].CostKnown = true
	}
	return rows, true
}

func (handler *SessionsHandler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	serveUsageQuery(response, request, handler.authorizer, "usage_sessions_failed", "用量会话统计不可用",
		func(ctx context.Context, query usageledger.Query) (map[string]any, error) {
			sessions, err := handler.source.QueryUsageSessions(ctx, query)
			return map[string]any{"sessions": sessions}, err
		})
}

func parseQuery(request *http.Request) (usageledger.Query, error) {
	from, err := parseTime(request.URL.Query().Get("from"), false)
	if err != nil {
		return usageledger.Query{}, err
	}
	to, err := parseTime(request.URL.Query().Get("to"), true)
	if err != nil {
		return usageledger.Query{}, err
	}
	query := usageledger.Query{
		From:     from,
		To:       to,
		Provider: strings.TrimSpace(strings.ToLower(request.URL.Query().Get("provider"))),
		Model:    strings.TrimSpace(request.URL.Query().Get("model")),
	}
	return query, query.Validate()
}

func parseTime(raw string, endOfDay bool) (time.Time, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return time.Time{}, usageledger.ErrInvalidQuery
	}
	if parsed, err := time.Parse("2006-01-02", value); err == nil {
		if endOfDay {
			return parsed.UTC().Add(24*time.Hour - time.Nanosecond), nil
		}
		return parsed.UTC(), nil
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}, usageledger.ErrInvalidQuery
	}
	return parsed.UTC(), nil
}

func writeJSON(response http.ResponseWriter, status int, body any) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(body)
}

// serveUsageQuery 是三个用量接口共用的前置流程：鉴权 → 方法 → 解析范围 → 取数 → 写出。
//
// 为什么合并：这三段原本逐字重复，改一次错误码要改三遍；更糟的是新增一个接口很容易
// 漏掉其中一步（例如忘了设 WWW-Authenticate）。失败码与文案由调用方给，其余一致。
func serveUsageQuery(
	response http.ResponseWriter,
	request *http.Request,
	authorizer Authorizer,
	failureCode string,
	failureMessage string,
	build func(context.Context, usageledger.Query) (map[string]any, error),
) {
	if authorizer == nil || !authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeJSON(response, http.StatusUnauthorized, map[string]any{"error": map[string]string{"code": "unauthorized", "message": "需要管理密钥"}})
		return
	}
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeJSON(response, http.StatusMethodNotAllowed, map[string]any{"error": map[string]string{"code": "method_not_allowed", "message": "只支持 GET"}})
		return
	}
	query, err := parseQuery(request)
	if err != nil {
		writeJSON(response, http.StatusBadRequest, map[string]any{"error": map[string]string{"code": "invalid_query", "message": "时间范围无效"}})
		return
	}
	payload, err := build(request.Context(), query)
	if err != nil {
		writeJSON(response, http.StatusInternalServerError, map[string]any{"error": map[string]string{"code": failureCode, "message": failureMessage}})
		return
	}
	if payload == nil {
		payload = map[string]any{}
	}
	payload["ok"] = true
	payload["range"] = map[string]string{
		"from": query.From.Format(time.RFC3339Nano),
		"to":   query.To.Format(time.RFC3339Nano),
	}
	writeJSON(response, http.StatusOK, payload)
}

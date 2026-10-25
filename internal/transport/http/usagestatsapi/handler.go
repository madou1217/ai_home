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
	Path       = "/v1/management/usage/stats"
	ModelsPath = "/v1/management/usage/models"
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

type ModelsHandler struct {
	authorizer Authorizer
	source     ModelsSource
}

func NewHandler(authorizer Authorizer, source Source) (*Handler, error) {
	if authorizer == nil || source == nil {
		return nil, usageledger.ErrInvalidQuery
	}
	return &Handler{authorizer: authorizer, source: source}, nil
}

func NewModelsHandler(authorizer Authorizer, source ModelsSource) (*ModelsHandler, error) {
	if authorizer == nil || source == nil {
		return nil, usageledger.ErrInvalidQuery
	}
	return &ModelsHandler{authorizer: authorizer, source: source}, nil
}

func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if !handler.authorizer.Authorized(request) {
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
	stats, err := handler.source.QueryUsageStats(request.Context(), query)
	if err != nil {
		writeJSON(response, http.StatusInternalServerError, map[string]any{"error": map[string]string{"code": "usage_stats_failed", "message": "用量统计不可用"}})
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"ok": true,
		"range": map[string]string{
			"from": query.From.Format(time.RFC3339Nano),
			"to":   query.To.Format(time.RFC3339Nano),
		},
		"stats": stats,
	})
}

func (handler *ModelsHandler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if !handler.authorizer.Authorized(request) {
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
	models, err := handler.source.QueryUsageModels(request.Context(), query)
	if err != nil {
		writeJSON(response, http.StatusInternalServerError, map[string]any{"error": map[string]string{"code": "usage_models_failed", "message": "用量模型统计不可用"}})
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"ok":     true,
		"range":  map[string]string{"from": query.From.Format(time.RFC3339Nano), "to": query.To.Format(time.RFC3339Nano)},
		"models": models,
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

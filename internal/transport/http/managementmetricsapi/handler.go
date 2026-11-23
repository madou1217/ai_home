package managementmetricsapi

import (
	"encoding/json"
	"net/http"

	"github.com/madou1217/ai_home/application/admission"
)

const Path = "/v1/management/metrics"

type Authorizer interface{ Authorized(*http.Request) bool }
type Snapshot struct {
	TotalRequests uint64            `json:"total_requests"`
	TotalSuccess  uint64            `json:"total_success"`
	TotalFailures uint64            `json:"total_failures"`
	TotalTimeouts uint64            `json:"total_timeouts"`
	SuccessRate   float64           `json:"success_rate"`
	TimeoutRate   float64           `json:"timeout_rate"`
	RouteCounts   map[string]uint64 `json:"route_counts"`
}
type Source interface{ Snapshot() Snapshot }
type Handler struct {
	authorizer Authorizer
	source     Source
}

func NewHandler(authorizer Authorizer, source Source) (*Handler, error) {
	if authorizer == nil || source == nil {
		return nil, http.ErrNotSupported
	}
	return &Handler{authorizer: authorizer, source: source}, nil
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
	snapshot := handler.source.Snapshot()
	body := map[string]any{"ok": true, "total_requests": snapshot.TotalRequests, "total_success": snapshot.TotalSuccess, "total_failures": snapshot.TotalFailures, "total_timeouts": snapshot.TotalTimeouts, "success_rate": snapshot.SuccessRate, "timeout_rate": snapshot.TimeoutRate, "route_counts": snapshot.RouteCounts}
	// 并发准入队列快照：复用既有 metrics 响应，不新建仪表盘。
	if controller := admission.Current(); controller != nil {
		stats := controller.Stats()
		queue := make(map[string]any, len(stats.Providers))
		for provider, item := range stats.Providers {
			queue[provider] = map[string]any{
				"name":           provider,
				"running":        item.Running,
				"queued":         stats.Queued,
				"maxConcurrency": item.MaxConcurrency,
				"queueLimit":     item.QueueLimit,
				"totalScheduled": item.TotalScheduled,
				"totalRejected":  item.TotalRejected,
			}
		}
		body["queue"] = queue
	}
	writeJSON(response, http.StatusOK, body)
}
func writeJSON(response http.ResponseWriter, status int, body any) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(body)
}

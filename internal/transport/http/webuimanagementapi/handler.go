package webuimanagementapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/managementops"
	"github.com/madou1217/ai_home/internal/transport/http/httpjson"
)

const (
	// BasePath 是 WebUI 管理面聚合接口在 Go 侧的命名空间前缀。
	BasePath = "/v1/management/webui/management"

	UIPath                           = BasePath + "/ui"
	StatusPath                       = BasePath + "/status"
	MetricsPath                      = BasePath + "/metrics"
	ModelsPath                       = BasePath + "/models"
	AccountsPath                     = BasePath + "/accounts"
	WatchPath                        = BasePath + "/watch"
	WatchSnapshotPath                = BasePath + "/watch/snapshot"
	ReloadPath                       = BasePath + "/reload"
	CooldownClearPath                = BasePath + "/cooldown/clear"
	RestartPath                      = BasePath + "/restart"
	StateIndexOperationalStatusPath  = BasePath + "/state-index/operational-status"
	StateIndexRuntimeStatePath       = BasePath + "/state-index/runtime-state"
	StateIndexUpsertPath             = BasePath + "/state-index/upsert"
	StateIndexPruneMissingPath       = BasePath + "/state-index/prune-missing"
	UsagePath                        = BasePath + "/usage"
	UsageStatsPath                   = BasePath + "/usage/stats"
	UsageDashboardPath               = BasePath + "/usage/dashboard"
	UsageModelsPath                  = BasePath + "/usage/models"
	UsageSessionsPath                = BasePath + "/usage/sessions"
	UsageRequestsPath                = BasePath + "/usage/requests"
	UsageBreakdownPath               = BasePath + "/usage/breakdown"
	UsageSessionDetailPath           = BasePath + "/usage/session-detail"
	UsageScanPath                    = BasePath + "/usage/scan"
	UsageScanWatchPath               = BasePath + "/usage/scan/watch"
	UsageDashboardQueryPath          = BasePath + "/usage/dashboard/query"
	UsageDashboardQueryWatchPath     = BasePath + "/usage/dashboard/query/watch"
	UsageDashboardQueryMemberPattern = BasePath + "/usage/dashboard/query/{jobId}"

	maxManagementBodyBytes int64 = 1024 * 1024
	sseHeartbeatInterval         = 30 * time.Second
)

// ErrInvalidDependencies 表示 Handler 缺少必需鉴权器或服务。
var ErrInvalidDependencies = errors.New("管理面 WebUI 接口依赖无效")

// Authorizer 校验 WebUI 管理面请求权限。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 汇总 webuimanagementapi 所需注入依赖。
type Dependencies struct {
	Authorizer Authorizer
	Service    *managementops.ManagementService
	Now        func() time.Time
}

// Handler 承接管理面运行时监控、状态索引写操作、实时 SSE 与本地用量/扫描/看板查询端点。
type Handler struct {
	authorizer Authorizer
	service    *managementops.ManagementService
	now        func() time.Time
}

// NewHandler 创建管理面 HTTP 处理器。
func NewHandler(deps Dependencies) (*Handler, error) {
	if deps.Authorizer == nil || deps.Service == nil {
		return nil, ErrInvalidDependencies
	}
	nowFn := deps.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	return &Handler{
		authorizer: deps.Authorizer,
		service:    deps.Service,
		now:        nowFn,
	}, nil
}

// ServeHTTP 按精确路径分发全部管理面路由，严格失败关闭。
func (h *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if h == nil || h.authorizer == nil {
		writeError(response, http.StatusServiceUnavailable, "management_unavailable", "管理接口未初始化")
		return
	}
	if !h.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	if h.service == nil {
		writeError(response, http.StatusServiceUnavailable, "management_unavailable", "管理服务未初始化")
		return
	}

	path := request.URL.Path
	switch path {
	case UIPath:
		h.handleUI(response, request)
	case WatchPath:
		h.handleWatch(response, request)
	case WatchSnapshotPath:
		h.handleWatchSnapshot(response, request)
	case StatusPath:
		h.handleStatus(response, request)
	case MetricsPath:
		h.handleMetrics(response, request)
	case ModelsPath:
		h.handleModels(response, request)
	case AccountsPath:
		h.handleAccounts(response, request)
	case ReloadPath:
		h.handleReload(response, request)
	case CooldownClearPath:
		h.handleCooldownClear(response, request)
	case RestartPath:
		h.handleRestart(response, request)
	case StateIndexOperationalStatusPath:
		h.handleStateIndexOperationalStatus(response, request)
	case StateIndexRuntimeStatePath:
		h.handleStateIndexRuntimeState(response, request)
	case StateIndexUpsertPath:
		h.handleStateIndexUpsert(response, request)
	case StateIndexPruneMissingPath:
		h.handleStateIndexPruneMissing(response, request)
	case UsageDashboardQueryWatchPath:
		h.handleUsageDashboardQueryWatch(response, request)
	case UsageDashboardQueryPath:
		h.handleUsageDashboardQueryStart(response, request)
	case UsageScanWatchPath:
		h.handleUsageScanWatch(response, request)
	case UsageScanPath:
		h.handleUsageScan(response, request)
	case UsagePath, UsageStatsPath, UsageDashboardPath, UsageModelsPath,
		UsageSessionsPath, UsageRequestsPath, UsageBreakdownPath, UsageSessionDetailPath:
		h.handleUsageRead(response, request)
	default:
		if strings.HasPrefix(path, UsageDashboardQueryPath+"/") {
			h.handleUsageDashboardQueryMember(response, request)
			return
		}
		if strings.HasPrefix(path, BasePath+"/usage/") {
			writeError(response, http.StatusNotFound, "model_usage_not_found", "")
			return
		}
		writeError(response, http.StatusNotFound, "management_not_found", "")
	}
}

func (h *Handler) handleUI(response http.ResponseWriter, request *http.Request) {
	if !requireMethod(response, request, http.MethodGet) {
		return
	}
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "text/html; charset=utf-8")
	response.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(response, RenderStatusPageHTML())
}

func (h *Handler) handleStatus(response http.ResponseWriter, request *http.Request) {
	if !requireMethod(response, request, http.MethodGet) {
		return
	}
	writeJSON(response, http.StatusOK, h.service.Status(request.Context()))
}

func (h *Handler) handleMetrics(response http.ResponseWriter, request *http.Request) {
	if !requireMethod(response, request, http.MethodGet) {
		return
	}
	writeJSON(response, http.StatusOK, h.service.Metrics(request.Context()))
}

func (h *Handler) handleModels(response http.ResponseWriter, request *http.Request) {
	if !requireMethod(response, request, http.MethodGet) {
		return
	}
	q := request.URL.Query()
	refresh := parseBoolQuery(q.Get("refresh"))
	accountLimit := managementops.DefaultModelAccountLimit
	if raw := strings.TrimSpace(q.Get("accountLimit")); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			accountLimit = n
		}
	}
	ttl := managementops.DefaultModelsCacheTTL
	if raw := strings.TrimSpace(q.Get("ttlMs")); raw != "" {
		if ms, err := strconv.ParseInt(raw, 10, 64); err == nil && ms >= 0 {
			ttl = time.Duration(ms) * time.Millisecond
		}
	}
	resp, err := h.service.Models(request.Context(), refresh, accountLimit, ttl)
	if err != nil {
		writeServiceError(response, err, "management_models_failed")
		return
	}
	writeJSON(response, http.StatusOK, resp)
}

func (h *Handler) handleAccounts(response http.ResponseWriter, request *http.Request) {
	if !requireMethod(response, request, http.MethodGet) {
		return
	}
	resp, err := h.service.Accounts(request.Context())
	if err != nil {
		writeServiceError(response, err, "management_accounts_failed")
		return
	}
	writeJSON(response, http.StatusOK, resp)
}

func (h *Handler) handleWatch(response http.ResponseWriter, request *http.Request) {
	if !requireMethod(response, request, http.MethodGet) {
		return
	}
	watch := h.service.Watch()
	if watch == nil {
		writeError(response, http.StatusServiceUnavailable, "management_watch_unavailable", "")
		return
	}
	serveSSE(response, request, watch.Subscribe)
}

func (h *Handler) handleWatchSnapshot(response http.ResponseWriter, request *http.Request) {
	if !requireMethod(response, request, http.MethodPost) {
		return
	}
	watch := h.service.Watch()
	if watch == nil {
		writeError(response, http.StatusServiceUnavailable, "management_watch_unavailable", "")
		return
	}
	broadcasted := watch.NotifySnapshot(request.Context(), true)
	writeJSON(response, http.StatusAccepted, map[string]any{
		"ok":          true,
		"accepted":    true,
		"broadcasted": broadcasted,
		"requestedAt": h.now().UnixMilli(),
	})
}

func (h *Handler) handleReload(response http.ResponseWriter, request *http.Request) {
	if !requireMethod(response, request, http.MethodPost) {
		return
	}
	resp, err := h.service.Reload(request.Context())
	if err != nil {
		writeServiceError(response, err, "management_reload_failed")
		return
	}
	writeJSON(response, http.StatusOK, resp)
}

func (h *Handler) handleCooldownClear(response http.ResponseWriter, request *http.Request) {
	if !requireMethod(response, request, http.MethodPost) {
		return
	}
	if err := h.service.ClearCooldowns(request.Context()); err != nil {
		writeServiceError(response, err, "management_cooldown_clear_failed")
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true})
}

func (h *Handler) handleRestart(response http.ResponseWriter, request *http.Request) {
	if !requireMethod(response, request, http.MethodPost) {
		return
	}
	resp, err := h.service.Restart(request.Context())
	if err != nil {
		if errors.Is(err, managementops.ErrRestartUnavailable) {
			writeError(response, http.StatusServiceUnavailable, "management_restart_unavailable", err.Error())
			return
		}
		writeError(response, http.StatusInternalServerError, "management_restart_failed", err.Error())
		return
	}
	writeJSON(response, http.StatusOK, resp)
}

func (h *Handler) handleStateIndexOperationalStatus(response http.ResponseWriter, request *http.Request) {
	if !requireMethod(response, request, http.MethodPost) {
		return
	}
	var input managementops.StateIndexOperationalStatusInput
	if !decodeManagementJSON(response, request, &input) {
		writeError(response, http.StatusBadRequest, "invalid_state_index_payload", "")
		return
	}
	updated, err := h.service.StateIndexOperationalStatus(request.Context(), input)
	if err != nil {
		writeServiceError(response, err, "state_index_failed")
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "updated": updated})
}

func (h *Handler) handleStateIndexRuntimeState(response http.ResponseWriter, request *http.Request) {
	if !requireMethod(response, request, http.MethodPost) {
		return
	}
	var input managementops.StateIndexRuntimeStateInput
	if !decodeManagementJSON(response, request, &input) {
		writeError(response, http.StatusBadRequest, "invalid_state_index_payload", "")
		return
	}
	updated, err := h.service.StateIndexRuntimeState(request.Context(), input)
	if err != nil {
		writeServiceError(response, err, "state_index_failed")
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "updated": updated})
}

func (h *Handler) handleStateIndexUpsert(response http.ResponseWriter, request *http.Request) {
	if !requireMethod(response, request, http.MethodPost) {
		return
	}
	var input managementops.StateIndexUpsertInput
	if !decodeManagementJSON(response, request, &input) {
		writeError(response, http.StatusBadRequest, "invalid_state_index_payload", "")
		return
	}
	updated, err := h.service.StateIndexUpsert(request.Context(), input)
	if err != nil {
		writeServiceError(response, err, "state_index_failed")
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "updated": updated})
}

func (h *Handler) handleStateIndexPruneMissing(response http.ResponseWriter, request *http.Request) {
	if !requireMethod(response, request, http.MethodPost) {
		return
	}
	var input managementops.StateIndexPruneMissingInput
	if !decodeManagementJSON(response, request, &input) {
		writeError(response, http.StatusBadRequest, "invalid_state_index_payload", "")
		return
	}
	removed, err := h.service.StateIndexPruneMissing(request.Context(), input)
	if err != nil {
		writeServiceError(response, err, "state_index_failed")
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "removed": removed})
}

func (h *Handler) handleUsageDashboardQueryWatch(response http.ResponseWriter, request *http.Request) {
	if !requireMethod(response, request, http.MethodGet) {
		return
	}
	jobs := h.requireUsageJobs(response)
	if jobs == nil {
		return
	}
	serveSSE(response, request, jobs.SubscribeDashboardQuery)
}

func (h *Handler) handleUsageDashboardQueryStart(response http.ResponseWriter, request *http.Request) {
	if !requireMethod(response, request, http.MethodPost) {
		return
	}
	jobs := h.requireUsageJobs(response)
	if jobs == nil {
		return
	}
	query, ok := h.parseUsageQueryOrWriteError(response, request)
	if !ok {
		return
	}
	job, err := jobs.StartDashboardQuery(request.Context(), query)
	if err != nil {
		writeServiceError(response, err, "model_usage_failed")
		return
	}
	writeJSON(response, http.StatusAccepted, map[string]any{
		"ok":       true,
		"accepted": true,
		"job":      job,
	})
}

func (h *Handler) handleUsageDashboardQueryMember(response http.ResponseWriter, request *http.Request) {
	jobs := h.requireUsageJobs(response)
	if jobs == nil {
		return
	}
	rawID := strings.TrimSpace(request.PathValue("jobId"))
	if rawID == "" {
		rawID = strings.TrimPrefix(request.URL.Path, UsageDashboardQueryPath+"/")
	}
	if decoded, err := url.PathUnescape(rawID); err == nil {
		rawID = decoded
	}
	jobID := strings.TrimSpace(rawID)
	if jobID == "" || strings.Contains(jobID, "/") {
		writeError(response, http.StatusNotFound, "model_usage_query_job_not_found", "")
		return
	}

	switch request.Method {
	case http.MethodGet:
		job, found := jobs.GetDashboardQuery(jobID)
		if !found {
			writeError(response, http.StatusNotFound, "model_usage_query_job_not_found", "")
			return
		}
		writeJSON(response, http.StatusOK, map[string]any{"ok": true, "job": job})
	case http.MethodDelete:
		result, found := jobs.CancelDashboardQuery(jobID)
		if !found {
			writeError(response, http.StatusNotFound, "model_usage_query_job_not_found", "")
			return
		}
		writeJSON(response, http.StatusOK, map[string]any{
			"ok":        true,
			"cancelled": result.Cancelled,
			"job":       result.Job,
		})
	default:
		response.Header().Set("Allow", "GET, DELETE")
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "")
	}
}

func (h *Handler) handleUsageScanWatch(response http.ResponseWriter, request *http.Request) {
	if !requireMethod(response, request, http.MethodGet) {
		return
	}
	jobs := h.requireUsageJobs(response)
	if jobs == nil {
		return
	}
	serveSSE(response, request, jobs.SubscribeScan)
}

func (h *Handler) handleUsageScan(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet && request.Method != http.MethodPost {
		response.Header().Set("Allow", "GET, POST")
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "")
		return
	}
	jobs := h.requireUsageJobs(response)
	if jobs == nil {
		return
	}
	query, ok := h.parseUsageQueryOrWriteError(response, request)
	if !ok {
		return
	}
	started, err := jobs.StartScanJob(request.Context(), query.Provider)
	if err != nil {
		writeServiceError(response, err, "model_usage_failed")
		return
	}
	writeJSON(response, http.StatusAccepted, map[string]any{
		"ok":             true,
		"accepted":       started.Accepted,
		"alreadyRunning": started.AlreadyRunning,
		"job":            started.Job,
	})
}

func (h *Handler) handleUsageRead(response http.ResponseWriter, request *http.Request) {
	if !requireMethod(response, request, http.MethodGet) {
		return
	}
	store := h.service.UsageStore()
	jobs := h.service.UsageJobs()
	if store == nil || jobs == nil {
		writeError(response, http.StatusServiceUnavailable, "model_usage_unavailable", "")
		return
	}
	query, ok := h.parseUsageQueryOrWriteError(response, request)
	if !ok {
		return
	}
	if query.Scan && (query.Provider == "" || h.service.SupportsUsageScan(query.Provider)) {
		if _, err := jobs.ScanSync(request.Context(), query.Provider); err != nil {
			writeServiceError(response, err, "model_usage_failed")
			return
		}
	}

	rng := managementops.UsageRange{From: query.From, To: query.To}
	switch request.URL.Path {
	case UsagePath, UsageStatsPath:
		stats, err := store.QueryStats(request.Context(), query)
		if err != nil {
			writeServiceError(response, err, "model_usage_failed")
			return
		}
		writeJSON(response, http.StatusOK, map[string]any{"ok": true, "range": rng, "stats": stats})
	case UsageDashboardPath:
		dashboard, err := store.QueryDashboard(request.Context(), query)
		if err != nil {
			writeServiceError(response, err, "model_usage_failed")
			return
		}
		writeJSON(response, http.StatusOK, map[string]any{
			"ok":           true,
			"range":        rng,
			"stats":        dashboard.Stats,
			"models":       dashboard.Models,
			"sessions":     dashboard.Sessions,
			"modelOptions": dashboard.ModelOptions,
			"trend":        dashboard.Trend,
		})
	case UsageModelsPath:
		models, err := store.QueryCostByModel(request.Context(), query)
		if err != nil {
			writeServiceError(response, err, "model_usage_failed")
			return
		}
		writeJSON(response, http.StatusOK, map[string]any{"ok": true, "range": rng, "models": models})
	case UsageSessionsPath:
		sessions, err := store.QuerySessions(request.Context(), query)
		if err != nil {
			writeServiceError(response, err, "model_usage_failed")
			return
		}
		writeJSON(response, http.StatusOK, map[string]any{"ok": true, "range": rng, "sessions": sessions})
	case UsageRequestsPath:
		details, err := store.QueryRequestDetails(request.Context(), query)
		if err != nil {
			writeServiceError(response, err, "model_usage_failed")
			return
		}
		writeJSON(response, http.StatusOK, map[string]any{
			"ok":     true,
			"range":  rng,
			"usage":  details.Usage,
			"errors": details.Errors,
		})
	case UsageBreakdownPath:
		if query.SessionID == "" && query.Model == "" {
			writeError(response, http.StatusBadRequest, "usage_breakdown_scope_required", "")
			return
		}
		breakdown, err := store.QueryBreakdown(request.Context(), query)
		if err != nil {
			writeServiceError(response, err, "model_usage_failed")
			return
		}
		writeJSON(response, http.StatusOK, map[string]any{
			"ok":       true,
			"range":    rng,
			"summary":  breakdown.Summary,
			"accounts": breakdown.Accounts,
			"models":   breakdown.Models,
		})
	case UsageSessionDetailPath:
		if query.SessionID == "" {
			writeError(response, http.StatusBadRequest, "session_id_required", "")
			return
		}
		detail, err := store.QuerySessionDetail(request.Context(), query)
		if err != nil {
			writeServiceError(response, err, "model_usage_failed")
			return
		}
		writeJSON(response, http.StatusOK, map[string]any{"ok": true, "range": rng, "session": detail})
	}
}

func (h *Handler) requireUsageJobs(response http.ResponseWriter) *managementops.UsageJobManager {
	if h.service.UsageStore() == nil || h.service.UsageJobs() == nil {
		writeError(response, http.StatusServiceUnavailable, "model_usage_unavailable", "")
		return nil
	}
	return h.service.UsageJobs()
}

func (h *Handler) parseUsageQueryOrWriteError(response http.ResponseWriter, request *http.Request) (managementops.UsageQuery, bool) {
	q := request.URL.Query()
	provider := firstNonEmpty(q.Get("provider"), q.Get("source"))
	sessionID := firstNonEmpty(q.Get("session_id"), q.Get("sessionId"))
	limit := managementops.DefaultUsageQueryLimit
	if raw := strings.TrimSpace(q.Get("limit")); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			limit = n
		}
	}
	scan := parseBoolQuery(q.Get("scan"))
	parsed, err := managementops.ParseUsageQuery(
		q.Get("from"),
		q.Get("to"),
		provider,
		q.Get("model"),
		sessionID,
		limit,
		scan,
		h.now(),
	)
	if err != nil {
		writeError(response, http.StatusBadRequest, "invalid_usage_query", err.Error())
		return managementops.UsageQuery{}, false
	}
	return parsed, true
}

func serveSSE(
	response http.ResponseWriter,
	request *http.Request,
	subscribe func(context.Context) (<-chan []byte, func()),
) {
	flusher, ok := response.(http.Flusher)
	if !ok {
		writeError(response, http.StatusInternalServerError, "sse_unsupported", "streaming unsupported")
		return
	}
	headers := response.Header()
	headers.Set("Content-Type", "text/event-stream; charset=utf-8")
	headers.Set("Cache-Control", "no-cache, no-transform")
	headers.Set("Connection", "keep-alive")
	headers.Set("X-Accel-Buffering", "no")
	response.WriteHeader(http.StatusOK)

	events, cancel := subscribe(request.Context())
	defer cancel()

	ticker := time.NewTicker(sseHeartbeatInterval)
	defer ticker.Stop()

	for {
		select {
		case <-request.Context().Done():
			return
		case payload, alive := <-events:
			if !alive {
				return
			}
			if _, err := fmt.Fprintf(response, "data: %s\n\n", payload); err != nil {
				return
			}
			flusher.Flush()
		case <-ticker.C:
			if _, err := io.WriteString(response, ": keepalive\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func decodeManagementJSON(response http.ResponseWriter, request *http.Request, target any) bool {
	if request == nil || request.Body == nil || target == nil {
		return false
	}
	limited := http.MaxBytesReader(response, request.Body, maxManagementBodyBytes)
	raw, err := io.ReadAll(limited)
	if err != nil {
		return false
	}
	if len(strings.TrimSpace(string(raw))) == 0 {
		return true
	}
	if err := httpjson.ValidateDocument(raw); err != nil {
		return false
	}
	return json.Unmarshal(raw, target) == nil
}

func requireMethod(response http.ResponseWriter, request *http.Request, allowed string) bool {
	if request.Method == allowed {
		return true
	}
	response.Header().Set("Allow", allowed)
	writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "")
	return false
}

func writeServiceError(response http.ResponseWriter, err error, fallbackCode string) {
	switch {
	case errors.Is(err, managementops.ErrInvalidUsageQuery):
		writeError(response, http.StatusBadRequest, "invalid_usage_query", err.Error())
	case errors.Is(err, managementops.ErrBreakdownScopeRequired):
		writeError(response, http.StatusBadRequest, "usage_breakdown_scope_required", err.Error())
	case errors.Is(err, managementops.ErrSessionIDRequired):
		writeError(response, http.StatusBadRequest, "session_id_required", err.Error())
	case errors.Is(err, managementops.ErrInvalidStateIndexPayload):
		writeError(response, http.StatusBadRequest, "invalid_state_index_payload", err.Error())
	case errors.Is(err, managementops.ErrQueryJobNotFound):
		writeError(response, http.StatusNotFound, "model_usage_query_job_not_found", err.Error())
	case errors.Is(err, managementops.ErrUsageUnavailable):
		writeError(response, http.StatusServiceUnavailable, "model_usage_unavailable", err.Error())
	case errors.Is(err, managementops.ErrStateIndexUnavailable):
		writeError(response, http.StatusServiceUnavailable, "state_index_unavailable", err.Error())
	case errors.Is(err, managementops.ErrRestartUnavailable):
		writeError(response, http.StatusServiceUnavailable, "management_restart_unavailable", err.Error())
	case errors.Is(err, managementops.ErrManagementUnavailable):
		writeError(response, http.StatusServiceUnavailable, "management_unavailable", err.Error())
	default:
		writeError(response, http.StatusInternalServerError, fallbackCode, err.Error())
	}
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code, message string) {
	body := map[string]any{
		"ok":    false,
		"error": code,
	}
	if message != "" {
		body["message"] = message
	}
	writeJSON(response, status, body)
}

func parseBoolQuery(raw string) bool {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "1", "true", "yes":
		return true
	default:
		return false
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

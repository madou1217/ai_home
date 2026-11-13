// Package webuigeoresourcesapi 提供工具箱 GeoIP 数据资源的 HTTP 管理面接口与 SSE 进度流。
//
// 契约对应 Node 侧 lib/server/webui-geo-resource-routes.js：
//
//	GET  /v1/management/webui/geo-resources
//	GET  /v1/management/webui/geo-resources/jobs
//	POST /v1/management/webui/geo-resources/jobs
//	GET  /v1/management/webui/geo-resources/jobs/{jobId}
//	GET  /v1/management/webui/geo-resources/jobs/{jobId}/watch
//	POST /v1/management/webui/geo-resources/jobs/{jobId}/cancel
package webuigeoresourcesapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	runtimegeo "github.com/madou1217/ai_home/internal/runtime/geo"
	"github.com/madou1217/ai_home/internal/transport/http/httpjson"
)

const (
	// Path 是 GeoIP 资源汇总根路径。
	Path = "/v1/management/webui/geo-resources"
	// JobsPath 是 GeoIP 资源作业列表与创建路径。
	JobsPath = "/v1/management/webui/geo-resources/jobs"
	// JobPath 是单条 GeoIP 资源作业查询路径。
	JobPath = "/v1/management/webui/geo-resources/jobs/{jobId}"
	// JobWatchPath 是单条 GeoIP 资源作业 SSE 观察流路径。
	JobWatchPath = "/v1/management/webui/geo-resources/jobs/{jobId}/watch"
	// JobCancelPath 是取消单条 GeoIP 资源作业的路径。
	JobCancelPath = "/v1/management/webui/geo-resources/jobs/{jobId}/cancel"
)

const (
	maxJSONBodyBytes  = 8 * 1024
	watchHeartbeat    = 30 * time.Second
)

// ErrInvalidDependencies 表示缺少必要依赖。
var ErrInvalidDependencies = errors.New("GeoIP 资源接口依赖无效")

// Authorizer 校验管理面请求鉴权。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 配置 GeoIP 资源 HTTP 处理器依赖。
type Dependencies struct {
	Authorizer Authorizer
	Manager    *runtimegeo.JobManager
}

// Handler 是 GeoIP 资源与作业管理接口的 HTTP 入站适配器。
type Handler struct {
	authorizer Authorizer
	manager    *runtimegeo.JobManager
}

// NewHandler 校验依赖并构造 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Manager == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		authorizer: dependencies.Authorizer,
		manager:    dependencies.Manager,
	}, nil
}

// ServeHTTP 按路径与方法分发所有 /v1/management/webui/geo-resources* 请求。
func (h *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if h == nil || h.authorizer == nil || h.manager == nil {
		writeError(response, http.StatusServiceUnavailable, "geo_resources_unavailable", "GeoIP 资源接口未就绪")
		return
	}
	if !h.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}

	path := request.URL.Path
	switch path {
	case Path:
		if request.Method != http.MethodGet {
			methodNotAllowed(response, http.MethodGet)
			return
		}
		h.handleOverview(response)
		return
	case JobsPath:
		switch request.Method {
		case http.MethodGet:
			writeJSON(response, http.StatusOK, map[string]any{
				"ok":   true,
				"jobs": h.manager.ListActive(),
			})
		case http.MethodPost:
			h.handleStartJob(response, request)
		default:
			methodNotAllowed(response, "GET, POST")
		}
		return
	}

	jobID, action, ok := parseJobRoute(request)
	if !ok {
		writeError(response, http.StatusNotFound, "not_found", "未找到 GeoIP 资源路径")
		return
	}
	switch {
	case action == "" && request.Method == http.MethodGet:
		job, found := h.manager.Get(jobID)
		if !found {
			writeJSON(response, http.StatusNotFound, map[string]any{"ok": false, "error": "job_not_found"})
			return
		}
		writeJSON(response, http.StatusOK, map[string]any{"ok": true, "job": job})
	case action == "watch" && request.Method == http.MethodGet:
		h.handleWatchJob(response, request, jobID)
	case action == "cancel" && request.Method == http.MethodPost:
		result := h.manager.Cancel(jobID)
		status := http.StatusOK
		if !result.OK {
			status = http.StatusConflict
		}
		writeJSON(response, status, result)
	default:
		if action == "cancel" {
			methodNotAllowed(response, http.MethodPost)
		} else {
			methodNotAllowed(response, http.MethodGet)
		}
	}
}

func (h *Handler) handleOverview(response http.ResponseWriter) {
	aiHome := h.manager.AIHomeDir()
	home := h.manager.HomeDir()
	writeJSON(response, http.StatusOK, map[string]any{
		"ok":        true,
		"resources": runtimegeo.ListResources(aiHome),
		"providers": runtimegeo.DescribeProviders(aiHome, home),
		"jobs":      h.manager.ListActive(),
	})
}

func (h *Handler) handleStartJob(response http.ResponseWriter, request *http.Request) {
	payload, ok := decodeJSONObject(response, request)
	if !ok {
		writeJSON(response, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid_json_body"})
		return
	}
	req := runtimegeo.JobStartRequest{
		ResourceID: scalarString(payload["resourceId"]),
		Action:     scalarString(payload["action"]),
	}
	if req.Action == "" {
		req.Action = "install"
	}
	result := h.manager.Start(req)
	status := http.StatusOK
	if !result.OK {
		status = http.StatusConflict
	}
	writeJSON(response, status, result)
}

func (h *Handler) handleWatchJob(response http.ResponseWriter, request *http.Request, jobID string) {
	initial, found := h.manager.Get(jobID)
	if !found {
		writeJSON(response, http.StatusNotFound, map[string]any{"ok": false, "error": "job_not_found"})
		return
	}
	flusher, ok := response.(http.Flusher)
	if !ok {
		writeError(response, http.StatusInternalServerError, "sse_unsupported", "当前连接不支持事件流")
		return
	}

	events, cancel := h.manager.Subscribe()
	defer cancel()

	response.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	response.Header().Set("Cache-Control", "no-cache, no-transform")
	response.Header().Set("Connection", "keep-alive")
	response.Header().Set("X-Accel-Buffering", "no")
	response.WriteHeader(http.StatusOK)

	writeEvent := func(payload any) bool {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return false
		}
		if _, err := fmt.Fprintf(response, "data: %s\n\n", encoded); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}

	if !writeEvent(map[string]any{"type": "connected", "job": initial}) {
		return
	}
	if isTerminalStatus(initial.Status) {
		return
	}

	heartbeat := time.NewTicker(watchHeartbeat)
	defer heartbeat.Stop()

	for {
		select {
		case <-request.Context().Done():
			return
		case event, open := <-events:
			if !open {
				return
			}
			if event.Job.ID != jobID {
				continue
			}
			if !writeEvent(event) {
				return
			}
			if isTerminalStatus(event.Job.Status) {
				return
			}
		case <-heartbeat.C:
			if _, err := io.WriteString(response, ": heartbeat\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func parseJobRoute(request *http.Request) (jobID string, action string, ok bool) {
	path := request.URL.Path
	prefix := JobsPath + "/"
	if !strings.HasPrefix(path, prefix) {
		return "", "", false
	}
	rest := strings.TrimPrefix(path, prefix)
	if rest == "" {
		return "", "", false
	}
	parts := strings.Split(rest, "/")
	if len(parts) > 2 {
		return "", "", false
	}
	rawID := parts[0]
	if pv := request.PathValue("jobId"); pv != "" {
		jobID = pv
	} else {
		decoded, err := url.PathUnescape(rawID)
		if err != nil || strings.TrimSpace(decoded) == "" {
			return "", "", false
		}
		jobID = decoded
	}
	if strings.TrimSpace(jobID) == "" {
		return "", "", false
	}
	if len(parts) == 2 {
		if parts[1] != "watch" && parts[1] != "cancel" {
			return "", "", false
		}
		action = parts[1]
	}
	return jobID, action, true
}

func decodeJSONObject(response http.ResponseWriter, request *http.Request) (map[string]any, bool) {
	if request.Body == nil {
		return map[string]any{}, true
	}
	reader := http.MaxBytesReader(response, request.Body, maxJSONBodyBytes)
	raw, err := io.ReadAll(reader)
	if err != nil {
		return nil, false
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return map[string]any{}, true
	}
	if err := httpjson.ValidateDocument(trimmed); err != nil {
		return nil, false
	}
	var payload any
	if err := json.Unmarshal(trimmed, &payload); err != nil {
		return nil, false
	}
	obj, ok := payload.(map[string]any)
	if !ok || obj == nil {
		return nil, false
	}
	return obj, true
}

func scalarString(value any) string {
	text, _ := value.(string)
	return strings.TrimSpace(text)
}

func isTerminalStatus(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "succeeded", "failed", "cancelled":
		return true
	default:
		return false
	}
}

func methodNotAllowed(response http.ResponseWriter, allow string) {
	response.Header().Set("Allow", allow)
	writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "不支持该 HTTP 方法")
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code string, message string) {
	writeJSON(response, status, map[string]any{
		"ok":      false,
		"error":   code,
		"message": message,
	})
}

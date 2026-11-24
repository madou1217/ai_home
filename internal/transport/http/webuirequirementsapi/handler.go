// Package webuirequirementsapi 是「需求管理」的 WebUI HTTP 边界。
//
//	GET    /v1/management/webui/requirements              读快照（工作区 + 需求 + 调度状态）
//	POST   /v1/management/webui/requirements              新建需求
//	PATCH  /v1/management/webui/requirements/{id}         局部更新 / 确认状态
//	DELETE /v1/management/webui/requirements/{id}         删除需求
//	POST   /v1/management/webui/requirements/{id}/refine  AI 拆解（必须指定工作区）
//	POST   /v1/management/webui/requirements/{id}/dispatch 手动调度
//	POST   /v1/management/webui/requirements/{id}/cancel  取消执行
//	GET    /v1/management/webui/requirements/{id}/events  需求时间线
//	POST   /v1/management/webui/requirements/import      导入 TodoList
//	POST   /v1/management/webui/requirements/reorder     人工排序
//	GET    /v1/management/webui/requirements/scheduler   调度器状态
//	POST   /v1/management/webui/requirements/scheduler/run 立即调度一次
//	PATCH  /v1/management/webui/requirements/scheduler   更新调度器配置
//	GET    /v1/management/webui/requirements/watch        SSE 快照流
package webuirequirementsapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/requirements"
)

const (
	// Path 是需求管理的管理契约根路径。
	Path = "/v1/management/webui/requirements"
	// PublicPath 是浏览器可直接访问的别名路径。
	PublicPath = "/v0/webui/requirements"
)

// Authorizer 校验 WebUI 管理请求。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// ServerProfileView is the sanitized execution-server catalog returned to the
// browser. It never contains a management key.
type ServerProfileView struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	Endpoint string `json:"endpoint"`
	Active   bool   `json:"active"`
}

// Handler 处理需求管理请求。
type Handler struct {
	Authorizer Authorizer
	Service    *requirements.Service
	Scheduler  requirements.Scheduler
	Dispatcher requirements.Dispatcher
	Servers    func(context.Context) ([]ServerProfileView, error)
	MaxBody    int64
}

// NewHandler 创建处理器。
func NewHandler(authorizer Authorizer, service *requirements.Service, scheduler requirements.Scheduler, dispatcher requirements.Dispatcher) (*Handler, error) {
	if authorizer == nil || service == nil {
		return nil, errors.New("requirements_handler_dependencies_invalid")
	}
	return &Handler{Authorizer: authorizer, Service: service, Scheduler: scheduler, Dispatcher: dispatcher, MaxBody: 8 << 20}, nil
}

// ServeHTTP 分发需求管理的全部子路径。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.Service == nil {
		writeError(response, http.StatusServiceUnavailable, "requirements_unavailable", "需求服务未就绪")
		return
	}
	if handler.Authorizer != nil && !handler.Authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	path := strings.TrimSpace(request.URL.Path)
	if !strings.HasPrefix(path, Path) {
		writeError(response, http.StatusNotFound, "not_found", "没有这个需求路由")
		return
	}
	rest := strings.Trim(strings.TrimPrefix(path, Path), "/")
	switch {
	case rest == "":
		handler.handleCollection(response, request)
	case rest == "watch":
		handler.handleWatch(response, request)
	case rest == "import":
		handler.handleImport(response, request)
	case rest == "reorder":
		handler.handleReorder(response, request)
	case rest == "servers":
		handler.handleServers(response, request)
	case rest == "scheduler":
		handler.handleScheduler(response, request)
	case rest == "scheduler/run":
		handler.handleSchedulerRun(response, request)
	case strings.HasSuffix(rest, "/refine"):
		handler.handleRefine(response, request, strings.TrimSuffix(rest, "/refine"))
	case strings.HasSuffix(rest, "/dispatch"):
		handler.handleDispatch(response, request, strings.TrimSuffix(rest, "/dispatch"))
	case strings.HasSuffix(rest, "/cancel"):
		handler.handleCancel(response, request, strings.TrimSuffix(rest, "/cancel"))
	case strings.HasSuffix(rest, "/events"):
		handler.handleEvents(response, request, strings.TrimSuffix(rest, "/events"))
	case strings.Contains(rest, "/"):
		writeError(response, http.StatusNotFound, "not_found", "没有这个需求路由")
	default:
		handler.handleRequirementItem(response, request, rest)
	}
}

func (handler *Handler) handleCollection(response http.ResponseWriter, request *http.Request) {
	switch request.Method {
	case http.MethodGet:
		handler.writeSnapshot(response, request.Context(), http.StatusOK)
	case http.MethodPost:
		var input requirements.Requirement
		if !decodeJSON(response, request, handler.MaxBody, &input) {
			return
		}
		created, err := handler.Service.CreateRequirement(request.Context(), input)
		if err != nil {
			writeServiceError(response, err)
			return
		}
		writeJSON(response, http.StatusCreated, map[string]any{"ok": true, "requirement": created})
	default:
		methodNotAllowed(response, "GET, POST")
	}
}

func (handler *Handler) handleRequirementItem(response http.ResponseWriter, request *http.Request, id string) {
	switch request.Method {
	case http.MethodPatch:
		var patch requirements.RequirementPatch
		if !decodeJSON(response, request, handler.MaxBody, &patch) {
			return
		}
		updated, err := handler.Service.UpdateRequirement(request.Context(), id, patch)
		if err != nil {
			writeServiceError(response, err)
			return
		}
		writeJSON(response, http.StatusOK, map[string]any{"ok": true, "requirement": updated})
	case http.MethodDelete:
		if err := handler.Service.DeleteRequirement(request.Context(), id); err != nil {
			writeServiceError(response, err)
			return
		}
		writeJSON(response, http.StatusOK, map[string]any{"ok": true})
	default:
		methodNotAllowed(response, "PATCH, DELETE")
	}
}

func (handler *Handler) handleRefine(response http.ResponseWriter, request *http.Request, id string) {
	if request.Method != http.MethodPost {
		methodNotAllowed(response, "POST")
		return
	}
	var input struct {
		WorkspacePath  string `json:"workspacePath"`
		WorkspaceLabel string `json:"workspaceLabel"`
		WorkspaceKind  string `json:"workspaceKind"`
	}
	if request.ContentLength != 0 {
		if !decodeJSON(response, request, handler.MaxBody, &input) {
			return
		}
	}
	updated, err := handler.Service.Refine(request.Context(), id, input.WorkspacePath, input.WorkspaceLabel, input.WorkspaceKind)
	if err != nil {
		writeServiceError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "requirement": updated})
}

func (handler *Handler) handleDispatch(response http.ResponseWriter, request *http.Request, id string) {
	if request.Method != http.MethodPost {
		methodNotAllowed(response, "POST")
		return
	}
	var input struct {
		WorkspacePath  string `json:"workspacePath"`
		WorkspaceLabel string `json:"workspaceLabel"`
		WorkspaceKind  string `json:"workspaceKind"`
	}
	if request.ContentLength != 0 {
		if !decodeJSON(response, request, handler.MaxBody, &input) {
			return
		}
	}
	updated, err := handler.Service.Dispatch(request.Context(), handler.Dispatcher, id, input.WorkspacePath, input.WorkspaceLabel, input.WorkspaceKind)
	if err != nil {
		writeServiceError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "requirement": updated})
}

func (handler *Handler) handleCancel(response http.ResponseWriter, request *http.Request, id string) {
	if request.Method != http.MethodPost {
		methodNotAllowed(response, "POST")
		return
	}
	updated, err := handler.Service.Cancel(request.Context(), handler.Dispatcher, id)
	if err != nil {
		writeServiceError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "requirement": updated})
}

func (handler *Handler) handleEvents(response http.ResponseWriter, request *http.Request, id string) {
	if request.Method != http.MethodGet {
		methodNotAllowed(response, "GET")
		return
	}
	events, err := handler.Service.Events(request.Context(), id)
	if err != nil {
		writeServiceError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "events": events})
}

func (handler *Handler) handleImport(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		methodNotAllowed(response, "POST")
		return
	}
	var input requirements.ImportInput
	if !decodeJSON(response, request, handler.MaxBody, &input) {
		return
	}
	created, err := handler.Service.Import(request.Context(), input)
	if err != nil {
		writeServiceError(response, err)
		return
	}
	writeJSON(response, http.StatusCreated, map[string]any{"ok": true, "count": len(created), "requirements": created})
}

func (handler *Handler) handleReorder(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		methodNotAllowed(response, "POST")
		return
	}
	var input struct {
		IDs []string `json:"ids"`
	}
	if !decodeJSON(response, request, handler.MaxBody, &input) {
		return
	}
	if err := handler.Service.Reorder(request.Context(), input.IDs); err != nil {
		writeServiceError(response, err)
		return
	}
	handler.writeSnapshot(response, request.Context(), http.StatusOK)
}

func (handler *Handler) handleServers(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		methodNotAllowed(response, http.MethodGet)
		return
	}
	if handler.Servers == nil {
		writeJSON(response, http.StatusOK, map[string]any{"ok": true, "servers": []ServerProfileView{}})
		return
	}
	servers, err := handler.Servers(request.Context())
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "server_profiles_unavailable", "无法读取 Server 列表")
		return
	}
	if servers == nil {
		servers = []ServerProfileView{}
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "servers": servers})
}

func (handler *Handler) handleScheduler(response http.ResponseWriter, request *http.Request) {
	switch request.Method {
	case http.MethodGet:
		settings, err := handler.Service.Settings(request.Context())
		if err != nil {
			writeServiceError(response, err)
			return
		}
		status := requirements.SchedulerStatus{}
		if handler.Scheduler != nil {
			status = handler.Scheduler.Status()
		}
		writeJSON(response, http.StatusOK, map[string]any{"ok": true, "settings": settings, "status": status})
	case http.MethodPatch:
		var input requirements.SchedulerSettings
		if !decodeJSON(response, request, handler.MaxBody, &input) {
			return
		}
		updated, err := handler.Service.UpdateSettings(request.Context(), input)
		if err != nil {
			writeServiceError(response, err)
			return
		}
		writeJSON(response, http.StatusOK, map[string]any{"ok": true, "settings": updated})
	default:
		methodNotAllowed(response, "GET, PATCH")
	}
}

func (handler *Handler) handleSchedulerRun(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		methodNotAllowed(response, "POST")
		return
	}
	if handler.Scheduler == nil {
		writeError(response, http.StatusServiceUnavailable, "scheduler_unavailable", "调度器未就绪")
		return
	}
	summary, err := handler.Scheduler.RunOnce(request.Context())
	if err != nil {
		writeServiceError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "summary": summary, "status": handler.Scheduler.Status()})
}

func (handler *Handler) handleWatch(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		methodNotAllowed(response, "GET")
		return
	}
	flusher, _ := response.(http.Flusher)
	events, cancel := handler.Service.Subscribe()
	defer cancel()
	header := response.Header()
	header.Set("Content-Type", "text/event-stream")
	header.Set("Cache-Control", "no-cache")
	header.Set("Connection", "keep-alive")
	header.Set("X-Accel-Buffering", "no")
	response.WriteHeader(http.StatusOK)
	if flusher != nil {
		flusher.Flush()
	}
	handler.writeSnapshotEvent(response, request.Context())
	if flusher != nil {
		flusher.Flush()
	}
	heartbeat := time.NewTicker(25 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-request.Context().Done():
			return
		case _, ok := <-events:
			if !ok {
				return
			}
			handler.writeSnapshotEvent(response, request.Context())
			if flusher != nil {
				flusher.Flush()
			}
		case <-heartbeat.C:
			if _, err := io.WriteString(response, ": heartbeat\n\n"); err != nil {
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
	}
}

func (handler *Handler) writeSnapshotEvent(response http.ResponseWriter, ctx context.Context) {
	snapshot, err := handler.readSnapshot(ctx)
	if err != nil {
		payload, _ := json.Marshal(map[string]any{"ok": false, "error": err.Error()})
		_, _ = response.Write([]byte("event: error\ndata: " + string(payload) + "\n\n"))
		return
	}
	payload, err := json.Marshal(snapshot)
	if err != nil {
		return
	}
	_, _ = response.Write([]byte("event: snapshot\ndata: " + string(payload) + "\n\n"))
}

func (handler *Handler) writeSnapshot(response http.ResponseWriter, ctx context.Context, status int) {
	snapshot, err := handler.readSnapshot(ctx)
	if err != nil {
		writeServiceError(response, err)
		return
	}
	writeJSON(response, status, map[string]any{"ok": true, "snapshot": snapshot})
}

func (handler *Handler) readSnapshot(ctx context.Context) (map[string]any, error) {
	snapshot, err := handler.Service.List(ctx)
	if err != nil {
		return nil, err
	}
	status := requirements.SchedulerStatus{}
	if handler.Scheduler != nil {
		status = handler.Scheduler.Status()
	}
	return map[string]any{
		"requirements": snapshot.Requirements,
		"settings":     snapshot.Settings,
		"scheduler":    status,
		"generatedAt":  snapshot.GeneratedAt,
	}, nil
}

func decodeJSON(response http.ResponseWriter, request *http.Request, limit int64, target any) bool {
	defer request.Body.Close()
	if limit <= 0 {
		limit = 8 << 20
	}
	decoder := json.NewDecoder(io.LimitReader(request.Body, limit))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		writeError(response, http.StatusBadRequest, "invalid_json", "请求体无法解析："+err.Error())
		return false
	}
	return true
}

func writeServiceError(response http.ResponseWriter, err error) {
	status := http.StatusInternalServerError
	code := "requirements_failed"
	switch {
	case errors.Is(err, requirements.ErrNotFound):
		status, code = http.StatusNotFound, "requirements_not_found"
	case errors.Is(err, requirements.ErrInvalid):
		status, code = http.StatusUnprocessableEntity, "requirements_invalid"
	case errors.Is(err, requirements.ErrConflict):
		status, code = http.StatusConflict, "requirements_conflict"
	case errors.Is(err, requirements.ErrUnavailable):
		status, code = http.StatusServiceUnavailable, "requirements_unavailable"
	}
	writeError(response, status, code, err.Error())
}

func writeError(response http.ResponseWriter, status int, code, message string) {
	writeJSON(response, status, map[string]any{"ok": false, "error": code, "message": message})
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	body, err := json.Marshal(payload)
	if err != nil {
		http.Error(response, "json_encode_failed", http.StatusInternalServerError)
		return
	}
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_, _ = response.Write(body)
}

func methodNotAllowed(response http.ResponseWriter, allow string) {
	response.Header().Set("Allow", allow)
	writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", fmt.Sprintf("只接受 %s", allow))
}

package webuitoolkitcoreapi

import (
	"context"
	"net/http"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/toolkit/tools"
)

func (h *Handler) handleToolsList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, http.MethodGet)
		return
	}
	if h.toolJobCacheInvalid.Load() && len(h.toolJobs.ListActive()) == 0 {
		h.toolsCache.clear()
		h.toolJobCacheInvalid.Store(false)
	}
	data := h.toolsCache.get(h.now(), func() tools.ListResult {
		return tools.ListManagedTools(context.Background(), h.toolsOpts, h.toolServices)
	})
	writeJSON(w, http.StatusOK, data)
}

func (h *Handler) handleToolsPlan(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, http.MethodPost)
		return
	}
	var body struct {
		ToolID string `json:"toolId"`
		Action string `json:"action"`
	}
	if ok, status, errMsg := decodeJSONBody(w, r, smallBodyMaxBytes, &body); !ok {
		writeError(w, status, errMsg, "网络工具参数无效。")
		return
	}
	res := tools.PlanManagedToolAction(r.Context(), body.ToolID, body.Action, h.toolsOpts)
	status := http.StatusOK
	if !res.OK {
		status = toolJobErrorStatus(res.Error)
	}
	writeJSON(w, status, res)
}

func (h *Handler) handleToolsExecute(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, http.MethodPost)
		return
	}
	var body struct {
		ToolID    string `json:"toolId"`
		Action    string `json:"action"`
		Confirmed bool   `json:"confirmed"`
	}
	if ok, status, errMsg := decodeJSONBody(w, r, smallBodyMaxBytes, &body); !ok {
		writeError(w, status, errMsg, "网络工具参数无效。")
		return
	}
	res := h.toolJobs.Start(r.Context(), body.ToolID, body.Action, body.Confirmed, nil)
	if res.OK {
		h.toolJobCacheInvalid.Store(true)
		h.toolsCache.clear()
		writeJSON(w, http.StatusAccepted, res)
		return
	}
	writeJSON(w, toolJobErrorStatus(res.Error), res)
}

func (h *Handler) handleToolsJobs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, http.MethodGet)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":   true,
		"jobs": h.toolJobs.ListActive(),
	})
}

func (h *Handler) handleToolsJobWithID(w http.ResponseWriter, r *http.Request, jobID string) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, http.MethodGet)
		return
	}
	jobID = strings.TrimSpace(jobID)
	job, found := h.toolJobs.Get(jobID)
	if !found {
		writeError(w, http.StatusNotFound, "job_not_found", "网络工具任务不存在或已清理。")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "job": job})
}

func (h *Handler) handleToolsJobCancelWithID(w http.ResponseWriter, r *http.Request, jobID string) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, http.MethodPost)
		return
	}
	jobID = strings.TrimSpace(jobID)
	res := h.toolJobs.Cancel(jobID)
	status := http.StatusOK
	if !res.OK {
		status = toolJobErrorStatus(res.Error)
	} else {
		h.toolsCache.clear()
	}
	writeJSON(w, status, res)
}

func (h *Handler) handleToolConfigWithID(w http.ResponseWriter, r *http.Request, toolID string) {
	toolID = strings.TrimSpace(toolID)
	switch r.Method {
	case http.MethodGet:
		data, err := tools.ReadToolConfig(r.Context(), toolID, h.toolsOpts)
		if err != nil {
			writeConfigError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, data)

	case http.MethodPut:
		var body struct {
			Content        *string `json:"content"`
			Revision       string  `json:"revision"`
			TargetRevision string  `json:"targetRevision"`
		}
		if ok, status, errMsg := decodeJSONBody(w, r, configBodyMaxBytes, &body); !ok {
			writeError(w, status, errMsg, errMsg)
			return
		}
		if body.Content == nil {
			writeError(w, http.StatusBadRequest, "content_required", "必须提供配置文本内容")
			return
		}
		data, err := tools.SaveToolConfig(r.Context(), toolID, *body.Content, body.Revision, body.TargetRevision, h.toolsOpts)
		if err != nil {
			writeConfigError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, data)

	default:
		writeMethodNotAllowed(w, http.MethodGet+", "+http.MethodPut)
	}
}

func (h *Handler) handleToolServiceWithID(w http.ResponseWriter, r *http.Request, toolID string) {
	toolID = strings.TrimSpace(toolID)
	switch r.Method {
	case http.MethodGet:
		res := h.toolServices.DescribeToolService(r.Context(), toolID)
		writeToolServiceResult(w, res)

	case http.MethodPost:
		var body struct {
			Action    string `json:"action"`
			Confirmed bool   `json:"confirmed"`
		}
		if ok, status, errMsg := decodeJSONBody(w, r, smallBodyMaxBytes, &body); !ok {
			writeError(w, status, "invalid_service_payload", "服务操作参数无效。("+errMsg+")")
			return
		}
		if !body.Confirmed {
			writeError(w, http.StatusPreconditionRequired, "confirmation_required", "服务操作需要确认。")
			return
		}
		res := h.toolServices.ControlToolService(r.Context(), toolID, body.Action)
		writeToolServiceResult(w, res)

	default:
		writeMethodNotAllowed(w, http.MethodGet+", "+http.MethodPost)
	}
}

func (h *Handler) handleToolServiceSettingsWithID(w http.ResponseWriter, r *http.Request, toolID string) {
	if r.Method != http.MethodPut {
		writeMethodNotAllowed(w, http.MethodPut)
		return
	}
	toolID = strings.TrimSpace(toolID)
	var body struct {
		AutoStart   *bool `json:"autoStart"`
		AutoRestart *bool `json:"autoRestart"`
	}
	if ok, status, errMsg := decodeJSONBody(w, r, smallBodyMaxBytes, &body); !ok {
		writeError(w, status, "invalid_service_payload", "服务设置参数无效。("+errMsg+")")
		return
	}
	res := h.toolServices.UpdateToolServiceSettings(r.Context(), toolID, body.AutoStart, body.AutoRestart)
	writeToolServiceResult(w, res)
}

func (h *Handler) handleToolServiceConfigWithID(w http.ResponseWriter, r *http.Request, toolID string) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, http.MethodPost)
		return
	}
	toolID = strings.TrimSpace(toolID)
	res := h.toolServices.CreateToolServiceConfig(r.Context(), toolID)
	writeToolServiceResult(w, res)
}

func (h *Handler) handleToolServiceLogsWithID(w http.ResponseWriter, r *http.Request, toolID string) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, http.MethodGet)
		return
	}
	toolID = strings.TrimSpace(toolID)
	lines := 200
	if raw := strings.TrimSpace(r.URL.Query().Get("lines")); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			lines = parsed
		}
	}
	res := h.toolServices.ReadToolServiceLogs(r.Context(), toolID, lines)
	status := http.StatusOK
	if !res.OK {
		status = toolServiceErrorStatus(res.Error)
	}
	writeJSON(w, status, res)
}

func writeToolServiceResult(w http.ResponseWriter, res tools.ServiceOpResult) {
	status := http.StatusOK
	if !res.OK {
		status = toolServiceErrorStatus(res.Error)
	}
	writeJSON(w, status, res)
}

func toolJobErrorStatus(errCode string) int {
	switch errCode {
	case "confirmation_required":
		return http.StatusPreconditionRequired
	case "managed_tool_not_found", "job_not_found":
		return http.StatusNotFound
	case "managed_tool_already_installed", "managed_tool_not_installed",
		"managed_tool_action_unavailable", "job_not_cancellable":
		return http.StatusConflict
	case "managed_tool_action_timeout":
		return http.StatusGatewayTimeout
	case "managed_tool_action_failed", "managed_tool_action_spawn_failed":
		return http.StatusBadGateway
	}
	if strings.HasPrefix(errCode, "invalid_") || strings.HasPrefix(errCode, "unsupported_") {
		return http.StatusBadRequest
	}
	return http.StatusInternalServerError
}

func toolServiceErrorStatus(errCode string) int {
	switch errCode {
	case "confirmation_required":
		return http.StatusPreconditionRequired
	case "managed_tool_not_found":
		return http.StatusNotFound
	case "service_conflict_external_instance", "service_config_exists",
		"service_config_missing", "managed_tool_not_installed", "service_settings_readonly":
		return http.StatusConflict
	case "service_control_failed", "service_spawn_failed":
		return http.StatusBadGateway
	case "service_unsupported", "service_config_create_unsupported":
		return http.StatusBadRequest
	}
	if strings.HasPrefix(errCode, "unsupported_") || strings.HasPrefix(errCode, "invalid_") {
		return http.StatusBadRequest
	}
	return http.StatusInternalServerError
}

func (h *Handler) handleToolsSubtree(w http.ResponseWriter, r *http.Request) {
	rest := strings.Trim(strings.TrimSpace(r.PathValue("rest")), "/")
	if rest == "" {
		writeError(w, http.StatusNotFound, "not_found", "Not Found")
		return
	}
	parts := strings.Split(rest, "/")
	if parts[0] == "jobs" {
		if len(parts) == 2 && parts[1] != "" {
			h.handleToolsJobWithID(w, r, parts[1])
			return
		}
		if len(parts) == 3 && parts[1] != "" && parts[2] == "watch" {
			h.handleToolsJobWatchWithID(w, r, parts[1])
			return
		}
		if len(parts) == 3 && parts[1] != "" && parts[2] == "cancel" {
			h.handleToolsJobCancelWithID(w, r, parts[1])
			return
		}
		writeError(w, http.StatusBadRequest, "unsupported_managed_tool_job_action", "不支持的网络工具任务操作。")
		return
	}
	toolID := parts[0]
	if toolID == "" {
		writeError(w, http.StatusNotFound, "not_found", "Not Found")
		return
	}
	if len(parts) == 2 && parts[1] == "config" {
		h.handleToolConfigWithID(w, r, toolID)
		return
	}
	if len(parts) == 2 && parts[1] == "service" {
		h.handleToolServiceWithID(w, r, toolID)
		return
	}
	if len(parts) == 3 && parts[1] == "service" {
		switch parts[2] {
		case "settings":
			h.handleToolServiceSettingsWithID(w, r, toolID)
		case "config":
			h.handleToolServiceConfigWithID(w, r, toolID)
		case "logs":
			h.handleToolServiceLogsWithID(w, r, toolID)
		default:
			writeError(w, http.StatusBadRequest, "unsupported_service_route", "不支持的服务操作。")
		}
		return
	}
	writeError(w, http.StatusNotFound, "not_found", "Not Found")
}

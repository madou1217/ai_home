// Package webuischeduledtasksapi 提供 WebUI 计划任务管理与运行记录 HTTP 接口。
package webuischeduledtasksapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/scheduledtasks"
)

const (
	// TasksPath 是计划任务列表与保存契约路径。
	TasksPath = "/v1/management/webui/scheduled-tasks"
	// RecordsPath 是运行记录分页查询契约路径。
	RecordsPath = "/v1/management/webui/scheduled-tasks/records"
	// PreviewPath 是调度预览契约路径。
	PreviewPath = "/v1/management/webui/scheduled-tasks/preview"
	// ActionPrefix 是单任务操作路由前缀。
	ActionPrefix = "/v1/management/webui/scheduled-tasks/"

	maxBodyBytes = 64 * 1024
)

var taskActionPattern = regexp.MustCompile(`^([A-Za-z0-9._:-]{1,128})/(run|toggle|delete)$`)

// ErrInvalidDependencies 表示 Handler 缺少必需端口。
var ErrInvalidDependencies = errors.New("计划任务 WebUI 接口依赖无效")

// Authorizer 校验 WebUI 管理请求授权。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 汇总处理器依赖。
type Dependencies struct {
	Authorizer Authorizer
	Service    *scheduledtasks.Service
}

// Handler 处理 /v1/management/webui/scheduled-tasks* 请求。
type Handler struct {
	authorizer Authorizer
	service    *scheduledtasks.Service
}

// NewHandler 创建失败关闭的计划任务处理器。
func NewHandler(deps Dependencies) (*Handler, error) {
	if deps.Authorizer == nil || deps.Service == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		authorizer: deps.Authorizer,
		service:    deps.Service,
	}, nil
}

func (h *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if h == nil || h.authorizer == nil || h.service == nil {
		writeJSON(response, http.StatusServiceUnavailable, map[string]any{"ok": false, "error": "scheduled_tasks_unavailable"})
		return
	}
	if !h.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeJSON(response, http.StatusUnauthorized, map[string]any{"ok": false, "error": "unauthorized", "message": "需要管理密钥"})
		return
	}

	path := request.URL.Path
	switch path {
	case TasksPath:
		switch request.Method {
		case http.MethodGet:
			list := h.service.List()
			writeJSON(response, http.StatusOK, map[string]any{
				"ok":                  true,
				"tasks":               list.Tasks,
				"events":              list.Events,
				"tickIntervalMs":      list.TickIntervalMS,
				"recordRetentionDays": list.RecordRetentionDays,
				"schedulerRunning":    list.SchedulerRunning,
				"lastTickAt":          list.LastTickAt,
			})
		case http.MethodPost:
			var input scheduledtasks.UpsertInput
			if err := decodeOptionalJSON(request, &input); err != nil {
				writeJSON(response, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid_body"})
				return
			}
			task, errCode := h.service.Upsert(input)
			if errCode != "" {
				writeJSON(response, http.StatusBadRequest, map[string]any{"ok": false, "error": errCode})
				return
			}
			writeJSON(response, http.StatusOK, map[string]any{"ok": true, "task": task})
		default:
			methodNotAllowed(response)
		}
		return

	case RecordsPath:
		if request.Method != http.MethodGet {
			methodNotAllowed(response)
			return
		}
		q := request.URL.Query()
		days, _ := strconv.Atoi(strings.TrimSpace(q.Get("days")))
		limit, _ := strconv.Atoi(strings.TrimSpace(q.Get("limit")))
		offset, _ := strconv.Atoi(strings.TrimSpace(q.Get("offset")))
		res := h.service.Records(scheduledtasks.RecordsQuery{
			Days:   days,
			TaskID: q.Get("taskId"),
			Limit:  limit,
			Offset: offset,
		})
		writeJSON(response, http.StatusOK, map[string]any{
			"ok":      true,
			"records": res.Records,
			"days":    res.Days,
			"total":   res.Total,
			"limit":   res.Limit,
			"offset":  res.Offset,
			"hasMore": res.HasMore,
		})
		return

	case PreviewPath:
		if request.Method != http.MethodPost {
			methodNotAllowed(response)
			return
		}
		var payload struct {
			Schedule *scheduledtasks.ScheduleInput `json:"schedule"`
		}
		if err := decodeOptionalJSON(request, &payload); err != nil {
			writeJSON(response, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid_body"})
			return
		}
		preview := h.service.PreviewSchedule(payload.Schedule)
		status := http.StatusOK
		if !preview.OK {
			status = http.StatusBadRequest
		}
		writeJSON(response, status, preview)
		return
	}

	if strings.HasPrefix(path, ActionPrefix) {
		suffix := strings.TrimPrefix(path, ActionPrefix)
		matches := taskActionPattern.FindStringSubmatch(suffix)
		if len(matches) == 3 {
			if request.Method != http.MethodPost {
				methodNotAllowed(response)
				return
			}
			taskID := matches[1]
			action := matches[2]
			switch action {
			case "delete":
				ok, errCode := h.service.Remove(taskID)
				if !ok {
					writeJSON(response, http.StatusConflict, map[string]any{"ok": false, "error": errCode})
					return
				}
				writeJSON(response, http.StatusOK, map[string]any{"ok": true})
			case "toggle":
				var payload struct {
					Enabled *bool `json:"enabled"`
				}
				if err := decodeOptionalJSON(request, &payload); err != nil {
					writeJSON(response, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid_body"})
					return
				}
				enabled := true
				if payload.Enabled != nil {
					enabled = *payload.Enabled
				}
				task, errCode := h.service.SetEnabled(taskID, enabled)
				if errCode != "" {
					writeJSON(response, http.StatusNotFound, map[string]any{"ok": false, "error": errCode})
					return
				}
				writeJSON(response, http.StatusOK, map[string]any{"ok": true, "task": task})
			case "run":
				if !h.service.TaskExists(taskID) {
					writeJSON(response, http.StatusNotFound, map[string]any{"ok": false, "error": "task_not_found"})
					return
				}
				if h.service.IsRunning(taskID) {
					writeJSON(response, http.StatusConflict, map[string]any{"ok": false, "error": "task_running"})
					return
				}
				go func() {
					_ = h.service.RunTask(context.Background(), taskID, scheduledtasks.TriggerManual)
				}()
				writeJSON(response, http.StatusAccepted, map[string]any{"ok": true, "accepted": true})
			}
			return
		}
	}

	writeJSON(response, http.StatusNotFound, map[string]any{"ok": false, "error": "not_found"})
}

func decodeOptionalJSON(request *http.Request, target any) error {
	if request == nil || request.Body == nil {
		return nil
	}
	body, err := io.ReadAll(io.LimitReader(request.Body, maxBodyBytes+1))
	if err != nil {
		return err
	}
	if len(body) > maxBodyBytes {
		return errors.New("body_too_large")
	}
	trimmed := strings.TrimSpace(string(body))
	if trimmed == "" {
		return nil
	}
	return json.Unmarshal([]byte(trimmed), target)
}

func methodNotAllowed(response http.ResponseWriter) {
	writeJSON(response, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method_not_allowed"})
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

// Package webuihousekeepingapi 提供远程备份状态/触发与持久会话清理按需触发 HTTP 管理接口。
package webuihousekeepingapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/persistent"
	"github.com/madou1217/ai_home/internal/runtime/remotebackup"
	"github.com/madou1217/ai_home/internal/transport/http/httpjson"
)

const (
	// BackupStatusPath 查询当前远程备份配置、目标状态与后台调度运行态。
	BackupStatusPath = "/v1/management/webui/backup/status"
	// BackupTriggerPath 提交去抖生命周期备份事件或按需立即执行一次备份。
	BackupTriggerPath = "/v1/management/webui/backup/trigger"
	// JanitorRunPath 按需执行一轮持久会话空闲回收与死 socket 清理。
	JanitorRunPath = "/v1/management/webui/janitor/run"

	maxRequestBodyBytes = 16 * 1024
)

// ErrInvalidDependencies 表示 Handler 缺少授权器或任何可执行控制器。
var ErrInvalidDependencies = errors.New("housekeeping HTTP 处理器缺少必需依赖")

var (
	errBodyTooLarge         = errors.New("request_body_too_large")
	errUnsupportedMediaType = errors.New("unsupported_media_type")
)

// Authorizer 校验 WebUI 管理接口请求的鉴权凭证。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// BackupController 抽象远程备份调度器的状态查询与按需触发能力。
type BackupController interface {
	Status(ctx context.Context) (remotebackup.BackupStatus, error)
	Trigger(reason string) bool
	RunNow(ctx context.Context, reason string, force bool, full bool, targetIDs []string) (remotebackup.BackupRunResult, error)
}

// JanitorController 抽象持久会话清理器按需执行一轮扫描回收的能力。
type JanitorController interface {
	RunNow(ctx context.Context) (persistent.JanitorRunResult, error)
}

// Dependencies 汇总创建 Handler 所需的依赖端口。
type Dependencies struct {
	Authorizer Authorizer
	Backup     BackupController
	Janitor    JanitorController
}

// BackupTriggerRequest 描述 POST /v1/management/webui/backup/trigger 的可选 JSON 请求体。
type BackupTriggerRequest struct {
	Reason    string   `json:"reason"`
	Force     bool     `json:"force"`
	RunNow    bool     `json:"runNow"`
	Full      bool     `json:"full"`
	TargetIDs []string `json:"targetIds"`
}

type emptyRequest struct{}

// Handler 提供 /v1/management/webui/backup/* 与 /janitor/run 的 fail-closed HTTP 处理器。
type Handler struct {
	authorizer Authorizer
	backup     BackupController
	janitor    JanitorController
}

// NewHandler 创建并校验依赖完整的 Handler；缺少授权器或控制器时失败关闭。
func NewHandler(deps Dependencies) (*Handler, error) {
	if deps.Authorizer == nil || (deps.Backup == nil && deps.Janitor == nil) {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		authorizer: deps.Authorizer,
		backup:     deps.Backup,
		janitor:    deps.Janitor,
	}, nil
}

// ServeHTTP 按路由与方法分发远程备份管理与持久会话清理请求。
func (h *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if h == nil || h.authorizer == nil {
		writeError(response, http.StatusServiceUnavailable, "housekeeping_unavailable", "运维管理服务不可用")
		return
	}
	if !h.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}

	switch request.URL.Path {
	case BackupStatusPath:
		h.handleBackupStatus(response, request)
	case BackupTriggerPath:
		h.handleBackupTrigger(response, request)
	case JanitorRunPath:
		h.handleJanitorRun(response, request)
	default:
		writeError(response, http.StatusNotFound, "not_found", "未找到对应管理路由")
	}
}

func (h *Handler) handleBackupStatus(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 GET")
		return
	}
	if h.backup == nil {
		writeError(response, http.StatusServiceUnavailable, "backup_unavailable", "远程备份调度器不可用")
		return
	}
	status, err := h.backup.Status(request.Context())
	if err != nil {
		writeError(response, http.StatusInternalServerError, "backup_status_failed", err.Error())
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"ok":     true,
		"status": status,
	})
}

func (h *Handler) handleBackupTrigger(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 POST")
		return
	}
	if h.backup == nil {
		writeError(response, http.StatusServiceUnavailable, "backup_unavailable", "远程备份调度器不可用")
		return
	}
	var req BackupTriggerRequest
	if !decodeRequestOrWriteError(response, request, &req) {
		return
	}
	reason := strings.TrimSpace(req.Reason)
	if reason == "" {
		reason = "manual"
	}
	if req.RunNow {
		result, err := h.backup.RunNow(request.Context(), reason, req.Force, req.Full, req.TargetIDs)
		if err != nil {
			writeError(response, http.StatusInternalServerError, "backup_run_failed", err.Error())
			return
		}
		writeJSON(response, http.StatusOK, map[string]any{
			"ok":     result.OK,
			"mode":   "run_now",
			"reason": reason,
			"result": result,
		})
		return
	}
	scheduled := h.backup.Trigger(reason)
	writeJSON(response, http.StatusOK, map[string]any{
		"ok":        true,
		"mode":      "debounced",
		"reason":    reason,
		"scheduled": scheduled,
	})
}

func (h *Handler) handleJanitorRun(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 POST")
		return
	}
	if h.janitor == nil {
		writeError(response, http.StatusServiceUnavailable, "janitor_unavailable", "持久会话清理器不可用")
		return
	}
	var req emptyRequest
	if !decodeRequestOrWriteError(response, request, &req) {
		return
	}
	result, err := h.janitor.RunNow(request.Context())
	if err != nil {
		writeError(response, http.StatusInternalServerError, "janitor_run_failed", err.Error())
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"ok":     true,
		"result": result,
	})
}

func decodeRequestOrWriteError(response http.ResponseWriter, request *http.Request, target any) bool {
	if err := decodeOptionalJSON(request, target); err != nil {
		switch {
		case errors.Is(err, errUnsupportedMediaType):
			writeError(response, http.StatusUnsupportedMediaType, "unsupported_media_type", "请使用 application/json 请求体")
		case errors.Is(err, errBodyTooLarge):
			writeError(response, http.StatusRequestEntityTooLarge, "body_too_large", "请求体过大")
		default:
			writeError(response, http.StatusBadRequest, "invalid_body", "JSON 请求体格式无效")
		}
		return false
	}
	return true
}

func decodeOptionalJSON(request *http.Request, target any) error {
	if request == nil || request.Body == nil {
		return nil
	}
	raw, err := io.ReadAll(io.LimitReader(request.Body, maxRequestBodyBytes+1))
	if err != nil {
		return err
	}
	if len(raw) > maxRequestBodyBytes {
		return errBodyTooLarge
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return nil
	}
	if ct := strings.TrimSpace(request.Header.Get("Content-Type")); ct != "" {
		mediaType, _, parseErr := mime.ParseMediaType(ct)
		if parseErr != nil || mediaType != "application/json" {
			return errUnsupportedMediaType
		}
	}
	if err := httpjson.ValidateDocument(trimmed); err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return httpjson.ErrInvalidDocument
	}
	return nil
}

func writeError(response http.ResponseWriter, status int, code, message string) {
	writeJSON(response, status, map[string]any{
		"ok":      false,
		"error":   code,
		"message": message,
	})
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

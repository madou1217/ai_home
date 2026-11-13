// Package webuiserverrestartapi 提供 WebUI server 异步重启触发契约。
package webuiserverrestartapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	// Path 是 server 重启的管理契约路径。
	Path = "/v1/management/webui/server/restart"
)

var (
	// ErrInvalidDependencies 表示 Handler 缺少必需端口。
	ErrInvalidDependencies = errors.New("server 重启接口依赖无效")
	// ErrRestartUnavailable 表示当前运行环境缺少拉起重启进程所需的 Node 或入口脚本。
	ErrRestartUnavailable = errors.New("server_restart_unavailable")
)

// Authorizer 校验 WebUI 管理请求的访问权限。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// RestartJob 表示一次服务器重启作业记录。
type RestartJob struct {
	ID        string `json:"id"`
	Status    string `json:"status"`
	CreatedAt int64  `json:"createdAt"`
}

// RestartEvent 表示推送至 management/watch 与 202 响应的作业事件。
type RestartEvent struct {
	Type      string         `json:"type"`
	JobID     string         `json:"jobId"`
	Status    string         `json:"status"`
	CreatedAt int64          `json:"createdAt"`
	UpdatedAt int64          `json:"updatedAt"`
	PID       int            `json:"pid,omitempty"`
	Config    map[string]any `json:"appliedConfig,omitempty"`
	Error     string         `json:"error,omitempty"`
	Message   string         `json:"message,omitempty"`
}

// RestartOutcome 描述宿主拉起新进程的结果。
type RestartOutcome struct {
	PID           int
	AppliedConfig map[string]any
}

// Restarter 执行实际的后台重启动作。
type Restarter interface {
	Restart(ctx context.Context, job RestartJob) (RestartOutcome, error)
}

// Dependencies 汇总重启处理器依赖。
type Dependencies struct {
	Authorizer Authorizer
	Restarter  Restarter
	Now        func() time.Time
	EmitEvent  func(event RestartEvent)
}

// Handler 处理 POST /v1/management/webui/server/restart 请求。
type Handler struct {
	authorizer Authorizer
	restarter  Restarter
	now        func() time.Time
	emitEvent  func(event RestartEvent)
}

// NewHandler 创建失败关闭的 server 重启处理器。
func NewHandler(deps Dependencies) (*Handler, error) {
	if deps.Authorizer == nil {
		return nil, ErrInvalidDependencies
	}
	now := deps.Now
	if now == nil {
		now = time.Now
	}
	return &Handler{
		authorizer: deps.Authorizer,
		restarter:  deps.Restarter,
		now:        now,
		emitEvent:  deps.EmitEvent,
	}, nil
}

func (h *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if h == nil || h.authorizer == nil {
		writeJSON(response, http.StatusServiceUnavailable, map[string]any{"ok": false, "error": "server_restart_unavailable"})
		return
	}
	if !h.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeJSON(response, http.StatusUnauthorized, map[string]any{"ok": false, "error": "unauthorized", "message": "需要管理密钥"})
		return
	}
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeJSON(response, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method_not_allowed"})
		return
	}
	if h.restarter == nil {
		writeJSON(response, http.StatusServiceUnavailable, map[string]any{"ok": false, "error": "server_restart_unavailable"})
		return
	}

	createdAt := h.now().UnixMilli()
	job := RestartJob{
		ID:        newRestartJobID(createdAt),
		Status:    "queued",
		CreatedAt: createdAt,
	}
	queued := buildEvent(job, "queued", createdAt)
	h.emit(queued)

	restarter := h.restarter
	go func() {
		h.emit(buildEvent(job, "starting", h.now().UnixMilli()))
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		outcome, err := restarter.Restart(ctx, job)
		nowMS := h.now().UnixMilli()
		if err != nil {
			ev := buildEvent(job, "failed", nowMS)
			ev.Error = "server_restart_failed"
			ev.Message = err.Error()
			h.emit(ev)
			return
		}
		ev := buildEvent(job, "started", nowMS)
		ev.PID = outcome.PID
		ev.Config = sanitizePublicConfig(outcome.AppliedConfig)
		h.emit(ev)
	}()

	writeJSON(response, http.StatusAccepted, map[string]any{
		"ok":         true,
		"accepted":   true,
		"restarting": true,
		"job":        queued,
	})
}

func (h *Handler) emit(event RestartEvent) {
	if h.emitEvent != nil {
		func() {
			defer func() { _ = recover() }()
			h.emitEvent(event)
		}()
	}
}

func buildEvent(job RestartJob, status string, atMS int64) RestartEvent {
	return RestartEvent{
		Type:      "restart",
		JobID:     job.ID,
		Status:    status,
		CreatedAt: job.CreatedAt,
		UpdatedAt: atMS,
	}
}

func sanitizePublicConfig(cfg map[string]any) map[string]any {
	if len(cfg) == 0 {
		return nil
	}
	out := make(map[string]any, len(cfg)+2)
	for k, v := range cfg {
		out[k] = v
	}
	apiKey, _ := cfg["apiKey"].(string)
	mgmtKey, _ := cfg["managementKey"].(string)
	apiConfigured, hasAPIConfigured := cfg["apiKeyConfigured"].(bool)
	mgmtConfigured, hasMgmtConfigured := cfg["managementKeyConfigured"].(bool)
	out["apiKey"] = ""
	out["managementKey"] = ""
	out["apiKeyConfigured"] = strings.TrimSpace(apiKey) != "" || (hasAPIConfigured && apiConfigured)
	out["managementKeyConfigured"] = strings.TrimSpace(mgmtKey) != "" || (hasMgmtConfigured && mgmtConfigured)
	return out
}

func newRestartJobID(nowMS int64) string {
	var raw [4]byte
	_, _ = rand.Read(raw[:])
	return "server-restart-" + strconv.FormatInt(nowMS, 36) + "-" + hex.EncodeToString(raw[:])
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

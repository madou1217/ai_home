// Package webuiserverrestartapi 提供 WebUI server 异步重启触发契约。
package webuiserverrestartapi

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	// Path 是 server 重启的管理契约路径。
	Path = "/v1/management/webui/server/restart"
	// InternalRestartPath 是 Node 宿主承接进程拉起的回环执行端点。
	InternalRestartPath = "/v0/internal/server/restart"
)

// ErrInvalidDependencies 表示 Handler 缺少必需端口。
var ErrInvalidDependencies = errors.New("server 重启接口依赖无效")

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

// HostRestarterOptions 配置通过 Node 宿主回环重启的参数。
type HostRestarterOptions struct {
	BaseURL       string
	ManagementKey func() string
	HTTPClient    *http.Client
}

// HostRestarter 通过 POST <NodeBaseURL>/v0/internal/server/restart 委托 Node 宿主重启。
type HostRestarter struct {
	baseURL       string
	managementKey func() string
	client        *http.Client
}

// NewHostRestarter 创建宿主重启桥；BaseURL 为空时返回 nil。
func NewHostRestarter(options HostRestarterOptions) *HostRestarter {
	baseURL := strings.TrimRight(strings.TrimSpace(options.BaseURL), "/")
	if baseURL == "" {
		return nil
	}
	client := options.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	return &HostRestarter{
		baseURL:       baseURL,
		managementKey: options.ManagementKey,
		client:        client,
	}
}

// Restart 通知 Node 宿主使用持久化配置重启服务。
func (r *HostRestarter) Restart(ctx context.Context, job RestartJob) (RestartOutcome, error) {
	if r == nil {
		return RestartOutcome{}, errors.New("server_restart_unavailable")
	}
	body, err := json.Marshal(map[string]any{"job": job})
	if err != nil {
		return RestartOutcome{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.baseURL+InternalRestartPath, bytes.NewReader(body))
	if err != nil {
		return RestartOutcome{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	if r.managementKey != nil {
		if key := strings.TrimSpace(r.managementKey()); key != "" {
			req.Header.Set("Authorization", "Bearer "+key)
		}
	}
	resp, err := r.client.Do(req)
	if err != nil {
		return RestartOutcome{}, err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 256*1024))
	if err != nil {
		return RestartOutcome{}, err
	}
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusAccepted {
		return RestartOutcome{}, errors.New("server_restart_host_rejected")
	}
	var decoded struct {
		OK            bool           `json:"ok"`
		PID           int            `json:"pid"`
		AppliedConfig map[string]any `json:"appliedConfig"`
		Error         string         `json:"error"`
	}
	if err := json.Unmarshal(raw, &decoded); err != nil || !decoded.OK {
		if strings.TrimSpace(decoded.Error) != "" {
			return RestartOutcome{}, errors.New(strings.TrimSpace(decoded.Error))
		}
		return RestartOutcome{}, errors.New("server_restart_invalid_host_response")
	}
	return RestartOutcome{
		PID:           decoded.PID,
		AppliedConfig: decoded.AppliedConfig,
	}, nil
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
	out["apiKey"] = ""
	out["managementKey"] = ""
	out["apiKeyConfigured"] = strings.TrimSpace(apiKey) != ""
	out["managementKeyConfigured"] = strings.TrimSpace(mgmtKey) != ""
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

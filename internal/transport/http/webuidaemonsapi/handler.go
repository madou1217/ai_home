// Package webuidaemonsapi 提供 Go 后台守护与调度器状态查询和按需触发 HTTP 接口。
package webuidaemonsapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/peer"
	"github.com/madou1217/ai_home/internal/runtime/retention"
	"github.com/madou1217/ai_home/internal/runtime/usagedaemons"
	"github.com/madou1217/ai_home/internal/transport/http/httpjson"
)

const (
	// StatusPath 查询全部后台守护与调度器的实时状态快照。
	StatusPath = "/v1/management/webui/daemons/status"
	// TriggerPath 按指定目标或全局手动触发一轮后台守护执行。
	TriggerPath = "/v1/management/webui/daemons/trigger"

	maxTriggerBodyBytes = 16 * 1024
)

var (
	// ErrInvalidDependencies 表示缺少必需授权器或守护控制器。
	ErrInvalidDependencies = errors.New("后台守护 HTTP 处理器缺少必需依赖")
	// ErrInvalidTarget 表示请求的触发目标不在支持列表内。
	ErrInvalidTarget = errors.New("invalid_daemon_target")
)

// Authorizer 校验 WebUI 管理接口的鉴权状态。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// StatusReport 聚合各后台守护与调度器的即时可观测状态。
type StatusReport struct {
	GeneratedAt     int64                               `json:"generatedAt"`
	Peer            *peer.DispatchDaemonState           `json:"peer,omitempty"`
	Retention       *retention.DaemonState              `json:"retention,omitempty"`
	QuotaProbe      *usagedaemons.QuotaProbeState       `json:"quotaProbe,omitempty"`
	UsageScan       *usagedaemons.UsageScanState        `json:"usageScan,omitempty"`
	ProviderRefresh *usagedaemons.ProviderRefreshState  `json:"providerRefresh,omitempty"`
}

// TriggerRequest 指定手动触发的守护目标与可选 provider 过滤。
type TriggerRequest struct {
	Daemon   string `json:"daemon,omitempty"`
	Provider string `json:"provider,omitempty"`
}

// TriggerResult 返回单次手动触发后各项结果与最新状态快照。
type TriggerResult struct {
	Target  string         `json:"target"`
	Results map[string]any `json:"results"`
	Status  StatusReport   `json:"status"`
}

// Controller 抽象后台守护集合的查询与按需触发能力。
type Controller interface {
	Status(ctx context.Context) StatusReport
	Trigger(ctx context.Context, req TriggerRequest) (TriggerResult, error)
}

// Dependencies 定义创建 Handler 所需的最小依赖端口。
type Dependencies struct {
	Authorizer Authorizer
	Controller Controller
}

// Handler 处理 /v1/management/webui/daemons/status 与 /trigger 请求。
type Handler struct {
	authorizer Authorizer
	controller Controller
}

// NewHandler 创建 fail-closed 的后台守护 HTTP 处理器。
func NewHandler(deps Dependencies) (*Handler, error) {
	if deps.Authorizer == nil || deps.Controller == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		authorizer: deps.Authorizer,
		controller: deps.Controller,
	}, nil
}

// NormalizeTarget 将请求目标名归一到规范枚举；无效值返回 ErrInvalidTarget。
func NormalizeTarget(raw string) (string, error) {
	key := strings.ToLower(strings.TrimSpace(raw))
	switch key {
	case "", "all":
		return "all", nil
	case "peer", "peer-dispatch":
		return "peer", nil
	case "logs", "log-rotation":
		return "logs", nil
	case "retention", "runtime-retention":
		return "retention", nil
	case "quota", "quota-probe":
		return "quota-probe", nil
	case "usage", "usage-scan", "model-usage":
		return "usage-scan", nil
	case "provider", "provider-refresh":
		return "provider-refresh", nil
	default:
		return "", ErrInvalidTarget
	}
}

func (h *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if h == nil || h.authorizer == nil || h.controller == nil {
		writeJSON(response, http.StatusServiceUnavailable, map[string]any{
			"ok":    false,
			"error": "daemons_unavailable",
		})
		return
	}
	if !h.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeJSON(response, http.StatusUnauthorized, map[string]any{
			"ok":      false,
			"error":   "unauthorized",
			"message": "需要管理密钥",
		})
		return
	}

	switch request.URL.Path {
	case StatusPath:
		if request.Method != http.MethodGet {
			methodNotAllowed(response)
			return
		}
		report := h.controller.Status(request.Context())
		if report.GeneratedAt == 0 {
			report.GeneratedAt = time.Now().UnixMilli()
		}
		writeJSON(response, http.StatusOK, map[string]any{
			"ok":     true,
			"status": report,
		})

	case TriggerPath:
		if request.Method != http.MethodPost {
			methodNotAllowed(response)
			return
		}
		var req TriggerRequest
		if err := decodeOptionalJSON(request, &req); err != nil {
			writeJSON(response, http.StatusBadRequest, map[string]any{
				"ok":    false,
				"error": "invalid_body",
			})
			return
		}
		normalized, err := NormalizeTarget(req.Daemon)
		if err != nil {
			writeJSON(response, http.StatusBadRequest, map[string]any{
				"ok":    false,
				"error": ErrInvalidTarget.Error(),
			})
			return
		}
		req.Daemon = normalized
		result, err := h.controller.Trigger(request.Context(), req)
		if err != nil {
			status := http.StatusInternalServerError
			errCode := "trigger_failed"
			if errors.Is(err, ErrInvalidTarget) {
				status = http.StatusBadRequest
				errCode = ErrInvalidTarget.Error()
			}
			writeJSON(response, status, map[string]any{
				"ok":      false,
				"error":   errCode,
				"message": err.Error(),
			})
			return
		}
		if result.Status.GeneratedAt == 0 {
			result.Status.GeneratedAt = time.Now().UnixMilli()
		}
		writeJSON(response, http.StatusOK, map[string]any{
			"ok":      true,
			"target":  result.Target,
			"results": result.Results,
			"status":  result.Status,
		})

	default:
		writeJSON(response, http.StatusNotFound, map[string]any{
			"ok":    false,
			"error": "not_found",
		})
	}
}

func decodeOptionalJSON(request *http.Request, target any) error {
	if request == nil || request.Body == nil {
		return nil
	}
	raw, err := io.ReadAll(io.LimitReader(request.Body, maxTriggerBodyBytes+1))
	if err != nil {
		return err
	}
	if len(raw) > maxTriggerBodyBytes {
		return errors.New("body_too_large")
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return nil
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
	if err := decoder.Decode(&trailing); err != io.EOF {
		return errors.New("trailing_json_tokens")
	}
	return nil
}

func methodNotAllowed(response http.ResponseWriter) {
	writeJSON(response, http.StatusMethodNotAllowed, map[string]any{
		"ok":    false,
		"error": "method_not_allowed",
	})
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

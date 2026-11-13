// Package webuicodexresetcreditapi 提供 WebUI Codex 额度重置卡列表、消费、核对与进度观察接口。
package webuicodexresetcreditapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/codexresetcredit"
)

const (
	// ListPatternPrefix 是 Codex 重置卡路由公共前缀。
	ListPatternPrefix = "/v1/management/webui/accounts/codex/"

	defaultWatchInterval = 1500 * time.Millisecond
	maxBodyBytes         = 32 * 1024
)

var (
	listPattern      = regexp.MustCompile(`^/v1/management/webui/accounts/codex/([^/]+)/reset-credits$`)
	consumePattern   = regexp.MustCompile(`^/v1/management/webui/accounts/codex/([^/]+)/reset-credits/consume$`)
	watchPattern     = regexp.MustCompile(`^/v1/management/webui/accounts/codex/([^/]+)/reset-operations/([^/]+)/watch$`)
	operationPattern = regexp.MustCompile(`^/v1/management/webui/accounts/codex/([^/]+)/reset-operations/([^/]+)$`)
	reconcilePattern = regexp.MustCompile(`^/v1/management/webui/accounts/codex/([^/]+)/reset-operations/([^/]+)/reconcile$`)
)

// ErrInvalidDependencies 表示 Handler 缺少必需依赖。
var ErrInvalidDependencies = errors.New("Codex 重置卡 WebUI 接口依赖无效")

// Authorizer 校验 WebUI 管理请求授权。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 汇总处理器所需依赖。
type Dependencies struct {
	Authorizer    Authorizer
	Service       *codexresetcredit.Service
	WatchInterval time.Duration
}

// Handler 处理 /v1/management/webui/accounts/codex/*/reset-* 请求。
type Handler struct {
	authorizer    Authorizer
	service       *codexresetcredit.Service
	watchInterval time.Duration
}

// NewHandler 创建失败关闭的 Codex 重置卡 HTTP 处理器。
func NewHandler(deps Dependencies) (*Handler, error) {
	if deps.Authorizer == nil || deps.Service == nil {
		return nil, ErrInvalidDependencies
	}
	interval := deps.WatchInterval
	if interval <= 0 {
		interval = defaultWatchInterval
	}
	return &Handler{
		authorizer:    deps.Authorizer,
		service:       deps.Service,
		watchInterval: interval,
	}, nil
}

type routeMatch struct {
	kind        string
	accountRef  string
	operationID string
	invalid     bool
}

func resolveRoute(path string) *routeMatch {
	patterns := []struct {
		kind string
		re   *regexp.Regexp
	}{
		{"watch", watchPattern},
		{"reconcile", reconcilePattern},
		{"operation", operationPattern},
		{"consume", consumePattern},
		{"list", listPattern},
	}
	for _, p := range patterns {
		m := p.re.FindStringSubmatch(path)
		if m == nil {
			continue
		}
		accountRef := decodeSegment(m[1])
		opID := ""
		if len(m) > 2 {
			opID = decodeSegment(m[2])
		}
		if accountRef == "" {
			return &routeMatch{invalid: true}
		}
		return &routeMatch{
			kind:        p.kind,
			accountRef:  accountRef,
			operationID: opID,
		}
	}
	return nil
}

func decodeSegment(raw string) string {
	decoded, err := url.PathUnescape(raw)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(decoded)
}

func writeSecurityHeaders(response http.ResponseWriter) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Pragma", "no-cache")
	response.Header().Set("Referrer-Policy", "no-referrer")
	response.Header().Set("X-Content-Type-Options", "nosniff")
}

func (h *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if h == nil || h.authorizer == nil {
		writeJSON(response, http.StatusServiceUnavailable, map[string]any{
			"ok":      false,
			"error":   "codex_reset_service_unavailable",
			"message": "Codex 重置服务不可用",
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

	writeSecurityHeaders(response)
	route := resolveRoute(request.URL.Path)
	if route == nil {
		writeJSON(response, http.StatusNotFound, map[string]any{"ok": false, "error": "not_found"})
		return
	}
	if route.invalid {
		writeJSON(response, http.StatusBadRequest, map[string]any{
			"ok":      false,
			"error":   "invalid_codex_reset_credit_path",
			"message": "Codex 重置卡路径无效",
		})
		return
	}
	if h.service == nil {
		writeJSON(response, http.StatusServiceUnavailable, map[string]any{
			"ok":      false,
			"error":   "codex_reset_service_unavailable",
			"message": "Codex 重置服务不可用",
		})
		return
	}

	switch {
	case route.kind == "list" && request.Method == http.MethodGet:
		res, err := h.service.List(request.Context(), route.accountRef)
		if err != nil {
			writeServiceError(response, err)
			return
		}
		writeJSON(response, http.StatusOK, map[string]any{
			"ok":               true,
			"accountRef":       res.AccountRef,
			"supported":        res.Supported,
			"availableCount":   res.AvailableCount,
			"selectableCount":  res.SelectableCount,
			"selectionMode":    res.SelectionMode,
			"detailsComplete":  res.DetailsComplete,
			"inventoryVersion": res.InventoryVersion,
			"capturedAt":       res.CapturedAt,
			"credits":          res.Credits,
			"nextCreditId":     res.NextCreditID,
			"activeOperation":  res.ActiveOperation,
		})

	case route.kind == "consume" && request.Method == http.MethodPost:
		var body struct {
			OperationID      string `json:"operationId"`
			InventoryVersion string `json:"inventoryVersion"`
		}
		if err := decodeJSONBody(request, &body); err != nil || strings.TrimSpace(body.OperationID) == "" || strings.TrimSpace(body.InventoryVersion) == "" {
			writeJSON(response, http.StatusBadRequest, map[string]any{
				"ok":      false,
				"error":   "invalid_codex_reset_consume_payload",
				"message": "重置操作 ID 或库存版本缺失",
			})
			return
		}
		res, err := h.service.Consume(request.Context(), route.accountRef, body.OperationID, body.InventoryVersion)
		if err != nil {
			writeServiceError(response, err)
			return
		}
		status := http.StatusOK
		if res.ReconciliationRequired {
			status = http.StatusAccepted
		}
		writeJSON(response, status, map[string]any{
			"ok":                     true,
			"operation":              res.Operation,
			"reconciliationRequired": res.ReconciliationRequired,
		})

	case route.kind == "watch" && request.Method == http.MethodGet:
		h.serveWatch(response, request, route.accountRef, route.operationID)

	case route.kind == "operation" && request.Method == http.MethodGet:
		op, err := h.service.GetOperation(request.Context(), route.accountRef, route.operationID)
		if err != nil {
			writeServiceError(response, err)
			return
		}
		writeJSON(response, http.StatusOK, map[string]any{
			"ok":        true,
			"operation": op,
		})

	case route.kind == "reconcile" && request.Method == http.MethodPost:
		res, err := h.service.Reconcile(request.Context(), route.accountRef, route.operationID)
		if err != nil {
			writeServiceError(response, err)
			return
		}
		status := http.StatusOK
		if res.ReconciliationRequired {
			status = http.StatusAccepted
		}
		writeJSON(response, status, map[string]any{
			"ok":                     true,
			"operation":              res.Operation,
			"reconciliationRequired": res.ReconciliationRequired,
		})

	default:
		writeJSON(response, http.StatusMethodNotAllowed, map[string]any{
			"ok":      false,
			"error":   "method_not_allowed",
			"message": "不支持的 Codex 重置卡操作",
		})
	}
}

func (h *Handler) serveWatch(response http.ResponseWriter, request *http.Request, accountRef string, operationID string) {
	response.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	response.Header().Set("Connection", "keep-alive")
	response.Header().Set("X-Accel-Buffering", "no")
	response.WriteHeader(http.StatusOK)

	flusher, _ := response.(http.Flusher)
	emit := func(payload any) bool {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return false
		}
		if _, err := fmt.Fprintf(response, "data: %s\n\n", encoded); err != nil {
			return false
		}
		if flusher != nil {
			flusher.Flush()
		}
		return true
	}

	ticker := time.NewTicker(h.watchInterval)
	defer ticker.Stop()

	for {
		op, err := h.service.GetOperation(request.Context(), accountRef, operationID)
		if err != nil {
			code, _, _ := codexresetcredit.ExtractError(err, "codex_reset_operation_failed")
			_ = emit(map[string]any{"type": "error", "error": code})
			return
		}
		if !emit(map[string]any{"type": "operation", "operation": op}) {
			return
		}
		if op != nil && (op.Status == "succeeded" || op.Status == "failed" || op.Status == "unknown") {
			return
		}
		select {
		case <-request.Context().Done():
			return
		case <-ticker.C:
		}
	}
}

func decodeJSONBody(request *http.Request, target any) error {
	if request == nil || request.Body == nil {
		return errors.New("missing_body")
	}
	raw, err := io.ReadAll(io.LimitReader(request.Body, maxBodyBytes+1))
	if err != nil || len(raw) > maxBodyBytes {
		return errors.New("invalid_body")
	}
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return nil
	}
	return json.Unmarshal([]byte(trimmed), target)
}

func writeServiceError(response http.ResponseWriter, err error) {
	code, message, status := codexresetcredit.ExtractError(err, "codex_reset_request_failed")
	writeJSON(response, status, map[string]any{
		"ok":      false,
		"error":   code,
		"message": message,
	})
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

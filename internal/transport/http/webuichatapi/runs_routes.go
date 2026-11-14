package webuichatapi

import (
	"bytes"
	"encoding/json"
	"math"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/chatruntime"
)

const (
	// ManagementRunsCollectionPath 是 Go Core 内部管理活动 Run 集合路径。
	ManagementRunsCollectionPath = "/v1/management/webui/chat/runs"
	// ManagementRunsPrefixPath 是 Go Core 内部管理单个 Run 控制前缀。
	ManagementRunsPrefixPath = "/v1/management/webui/chat/runs/"
	// ManagementInternalApprovalPath 是权限工具长挂审批内部回调路径。
	ManagementInternalApprovalPath = "/v1/management/webui/chat/internal/approval-request"
	// ManagementCLIInstallConfirmationsPrefixPath 是 CLI 安装确认决策路径前缀。
	ManagementCLIInstallConfirmationsPrefixPath = "/v1/management/webui/chat/cli-install-confirmations/"
	// ManagementLegacyChatPath 是已迁移提示（legacy POST /v0/webui/chat）内部入口。
	ManagementLegacyChatPath = "/v1/management/webui/chat"

	legacyRunsPrefixPath                    = "/v0/webui/chat/runs/"
	legacyCLIInstallConfirmationsPrefixPath = "/v0/webui/chat/cli-install-confirmations/"

	approvalStreamKeepaliveInterval = 25 * time.Second
	runControlBodyLimit             = 256 * 1024
	approvalInboundBodyLimit        = 512 * 1024
)

func (handler *Handler) requireRunsRuntime(response http.ResponseWriter, request *http.Request) (*chatruntime.Service, bool) {
	if !handler.authorizer.Authorized(request) {
		writeRouteError(response, newRouteError(
			http.StatusUnauthorized, "chat_runtime_unauthorized", "管理凭据无效", nil,
		))
		return nil, false
	}
	rt, _ := handler.currentRuntime()
	if rt == nil {
		writeRouteError(response, newRouteError(
			http.StatusServiceUnavailable, "chat_runtime_unavailable", "聊天运行时尚未就绪", nil,
		))
		return nil, false
	}
	return rt, true
}

// ServeRunsCollection 处理 GET /v1/management/webui/chat/runs（列出仍在运行的 native/chat run）。
func (handler *Handler) ServeRunsCollection(response http.ResponseWriter, request *http.Request) {
	rt, ok := handler.requireRunsRuntime(response, request)
	if !ok {
		return
	}
	if request.Method != http.MethodGet {
		writeMethodNotAllowed(response, http.MethodGet)
		return
	}
	query := request.URL.Query()
	runs, err := rt.ListActiveRuns(request.Context(), chatruntime.ListActiveRunsFilter{
		SessionID:      strings.TrimSpace(query.Get("sessionId")),
		Provider:       strings.TrimSpace(query.Get("provider")),
		ProjectDirName: strings.TrimSpace(query.Get("projectDirName")),
	})
	if err != nil {
		writeRuntimeError(response, err)
		return
	}
	if runs == nil {
		runs = []chatruntime.ActiveRunSummary{}
	}
	writeJSONResponse(response, http.StatusOK, map[string]any{
		"ok":   true,
		"runs": runs,
	})
}

// ServeRunSubpath 分发 /v1/management/webui/chat/runs/{runId}/... 子路径控制请求。
func (handler *Handler) ServeRunSubpath(response http.ResponseWriter, request *http.Request) {
	rt, ok := handler.requireRunsRuntime(response, request)
	if !ok {
		return
	}
	segs := splitEscapedPathAfter(request.URL, ManagementRunsPrefixPath, legacyRunsPrefixPath)
	if len(segs) < 2 {
		writeRouteError(response, newRouteError(
			http.StatusNotFound, "not_found", "未找到对应的聊天运行控制路径", nil,
		))
		return
	}
	runID, err := url.PathUnescape(segs[0])
	if err != nil {
		runID = segs[0]
	}
	runID = strings.TrimSpace(runID)

	switch {
	case len(segs) == 2 && segs[1] == "input":
		handler.handleRunInput(response, request, rt, runID)
	case len(segs) == 2 && segs[1] == "resize":
		handler.handleRunResize(response, request, rt, runID)
	case len(segs) == 2 && segs[1] == "abort":
		handler.handleRunAbort(response, request, rt, runID)
	case len(segs) == 3 && segs[1] == "approvals":
		approvalID, uerr := url.PathUnescape(segs[2])
		if uerr != nil {
			approvalID = segs[2]
		}
		handler.handleRunApprovalDecision(response, request, rt, runID, strings.TrimSpace(approvalID))
	default:
		writeRouteError(response, newRouteError(
			http.StatusNotFound, "not_found", "未找到对应的聊天运行控制路径", nil,
		))
	}
}

func (handler *Handler) handleRunInput(
	response http.ResponseWriter,
	request *http.Request,
	rt *chatruntime.Service,
	runID string,
) {
	if request.Method != http.MethodPost {
		writeMethodNotAllowed(response, http.MethodPost)
		return
	}
	var payload struct {
		Input         string `json:"input"`
		AppendNewline *bool  `json:"appendNewline"`
		PromptID      string `json:"promptId"`
		Mode          string `json:"mode"`
	}
	if routeErr := decodeJSONObject(request, runControlBodyLimit, &payload); routeErr != nil {
		writeRouteError(response, routeErr)
		return
	}
	appendNewline := true
	if payload.AppendNewline != nil {
		appendNewline = *payload.AppendNewline
	}
	mode := strings.TrimSpace(payload.Mode)
	if err := rt.WriteRunInput(request.Context(), runID, payload.Input, appendNewline, mode); err != nil {
		writeRuntimeError(response, err)
		return
	}
	outMode := mode
	if outMode == "" {
		outMode = "input"
	}
	writeJSONResponse(response, http.StatusOK, map[string]any{
		"ok":    true,
		"runId": runID,
		"mode":  outMode,
	})
}

func (handler *Handler) handleRunResize(
	response http.ResponseWriter,
	request *http.Request,
	rt *chatruntime.Service,
	runID string,
) {
	if request.Method != http.MethodPost {
		writeMethodNotAllowed(response, http.MethodPost)
		return
	}
	var payload map[string]any
	if routeErr := decodeJSONObject(request, 64*1024, &payload); routeErr != nil {
		writeRouteError(response, routeErr)
		return
	}
	colsFloat, colsOK := payload["cols"].(float64)
	rowsFloat, rowsOK := payload["rows"].(float64)
	colsValid := colsOK && !math.IsNaN(colsFloat) && !math.IsInf(colsFloat, 0)
	rowsValid := rowsOK && !math.IsNaN(rowsFloat) && !math.IsInf(rowsFloat, 0)

	// 先查 run 存在性再报错维度非法，与 Node 路由先 404 后 400 的口径一致。
	if !colsValid || !rowsValid {
		runs, err := rt.ListActiveRuns(request.Context(), chatruntime.ListActiveRunsFilter{})
		if err == nil {
			found := false
			for _, item := range runs {
				if item.RunID == runID {
					found = true
					break
				}
			}
			if !found {
				writeJSONResponse(response, http.StatusNotFound, map[string]any{
					"ok":    false,
					"error": "native_chat_run_not_found",
				})
				return
			}
		}
		writeJSONResponse(response, http.StatusBadRequest, map[string]any{
			"ok":    false,
			"error": "native_chat_resize_invalid",
		})
		return
	}

	cols, rows, err := rt.ResizeRun(request.Context(), runID, int(colsFloat), int(rowsFloat))
	if err != nil {
		writeRuntimeError(response, err)
		return
	}
	writeJSONResponse(response, http.StatusOK, map[string]any{
		"ok":    true,
		"runId": runID,
		"cols":  cols,
		"rows":  rows,
	})
}

func (handler *Handler) handleRunAbort(
	response http.ResponseWriter,
	request *http.Request,
	rt *chatruntime.Service,
	runID string,
) {
	if request.Method != http.MethodPost {
		writeMethodNotAllowed(response, http.MethodPost)
		return
	}
	alreadyGone, err := rt.AbortRun(request.Context(), runID)
	if err != nil {
		writeRuntimeError(response, err)
		return
	}
	resp := map[string]any{
		"ok":    true,
		"runId": runID,
	}
	if alreadyGone {
		resp["alreadyGone"] = true
	}
	writeJSONResponse(response, http.StatusOK, resp)
}

func (handler *Handler) handleRunApprovalDecision(
	response http.ResponseWriter,
	request *http.Request,
	rt *chatruntime.Service,
	runID string,
	approvalID string,
) {
	if request.Method != http.MethodPost {
		writeMethodNotAllowed(response, http.MethodPost)
		return
	}
	var payload struct {
		Decision string `json:"decision"`
		Message  string `json:"message"`
	}
	if routeErr := decodeJSONObject(request, 64*1024, &payload); routeErr != nil {
		writeRouteError(response, routeErr)
		return
	}
	outcome, err := rt.DecideNativeApproval(request.Context(), runID, approvalID, payload.Decision, payload.Message)
	if err != nil {
		writeRuntimeError(response, err)
		return
	}
	if outcome.AlreadyResolved {
		writeJSONResponse(response, http.StatusOK, map[string]any{
			"ok":              true,
			"approvalId":      approvalID,
			"alreadyResolved": true,
		})
		return
	}
	writeJSONResponse(response, http.StatusOK, map[string]any{
		"ok":         true,
		"approvalId": approvalID,
		"decision":   outcome.Decision,
	})
}

// ServeApprovalRequest 处理 POST /v1/management/webui/chat/internal/approval-request 长挂审批回调。
func (handler *Handler) ServeApprovalRequest(response http.ResponseWriter, request *http.Request) {
	rt, ok := handler.requireRunsRuntime(response, request)
	if !ok {
		return
	}
	if request.Method != http.MethodPost {
		writeMethodNotAllowed(response, http.MethodPost)
		return
	}
	var req chatruntime.NativeApprovalInboundRequest
	if routeErr := decodeJSONObject(request, approvalInboundBodyLimit, &req); routeErr != nil {
		writeRouteError(response, routeErr)
		return
	}

	// 校验完成后立即刷出 200 响应头，避免 Node fetch headersTimeout(300s) 中断长挂等待，
	// 同时允许对端断连触发 HTTP 流关闭并立即取消 Go request.Context()。
	rc := http.NewResponseController(response)
	_ = rc.SetWriteDeadline(time.Time{})
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(http.StatusOK)
	_ = rc.Flush()

	type approvalResult struct {
		decision map[string]any
		err      error
	}
	resCh := make(chan approvalResult, 1)
	go func() {
		dec, rerr := rt.RequestNativeApproval(request.Context(), req)
		resCh <- approvalResult{decision: dec, err: rerr}
	}()

	keepalive := time.NewTicker(approvalStreamKeepaliveInterval)
	defer keepalive.Stop()

	for {
		select {
		case res := <-resCh:
			if request.Context().Err() != nil {
				return
			}
			out := res.decision
			if res.err != nil {
				out = map[string]any{
					"behavior": "deny",
					"error":    "native_approval_surface_failed",
					"message":  res.err.Error(),
				}
			}
			encoded, err := json.Marshal(out)
			if err != nil {
				encoded = []byte(`{"behavior":"deny","message":"审批结果序列化失败"}`)
			}
			_, _ = response.Write(encoded)
			_ = rc.Flush()
			return
		case <-keepalive.C:
			if request.Context().Err() != nil {
				_ = <-resCh
				return
			}
			_, _ = response.Write([]byte(" "))
			_ = rc.Flush()
		}
	}
}

// ServeCliInstallConfirmation 处理 POST /v1/management/webui/chat/cli-install-confirmations/{confirmationId}。
func (handler *Handler) ServeCliInstallConfirmation(response http.ResponseWriter, request *http.Request) {
	rt, ok := handler.requireRunsRuntime(response, request)
	if !ok {
		return
	}
	if request.Method != http.MethodPost {
		writeMethodNotAllowed(response, http.MethodPost)
		return
	}
	segs := splitEscapedPathAfter(request.URL, ManagementCLIInstallConfirmationsPrefixPath, legacyCLIInstallConfirmationsPrefixPath)
	confirmationID := ""
	if len(segs) == 1 {
		unescaped, err := url.PathUnescape(segs[0])
		if err == nil {
			confirmationID = strings.TrimSpace(unescaped)
		} else {
			confirmationID = strings.TrimSpace(segs[0])
		}
	}

	var payload struct {
		Decision string `json:"decision"`
	}
	if routeErr := decodeJSONObject(request, 64*1024, &payload); routeErr != nil {
		writeRouteError(response, routeErr)
		return
	}
	decision := strings.ToLower(strings.TrimSpace(payload.Decision))
	if confirmationID == "" || (decision != "confirm" && decision != "cancel") {
		writeJSONResponse(response, http.StatusBadRequest, map[string]any{
			"ok":    false,
			"error": "invalid_cli_install_confirmation",
		})
		return
	}

	outcome := rt.DecideCLIInstallConfirmation(confirmationID, decision, "user")
	if outcome == nil {
		writeJSONResponse(response, http.StatusNotFound, map[string]any{
			"ok":             false,
			"error":          "cli_install_confirmation_expired",
			"confirmationId": confirmationID,
		})
		return
	}
	writeJSONResponse(response, http.StatusOK, map[string]any{
		"ok":             true,
		"confirmationId": confirmationID,
		"decision":       outcome.Decision,
	})
}

// ServeLegacyChat 处理已退役的 POST /v1/management/webui/chat，校验载荷后统一引导至原生 Harness。
func (handler *Handler) ServeLegacyChat(response http.ResponseWriter, request *http.Request) {
	if !handler.authorizer.Authorized(request) {
		writeRouteError(response, newRouteError(
			http.StatusUnauthorized, "chat_runtime_unauthorized", "管理凭据无效", nil,
		))
		return
	}
	if request.Method != http.MethodPost {
		writeMethodNotAllowed(response, http.MethodPost)
		return
	}
	rawBody, err := readRequestBody(request, handler.maxBodyBytes)
	if err != nil {
		writeJSONResponse(response, http.StatusBadRequest, map[string]any{
			"ok":      false,
			"error":   "invalid_payload",
			"message": "请求体必须是有效 JSON 对象",
		})
		return
	}
	trimmed := bytes.TrimSpace(rawBody)
	var body map[string]any
	if len(trimmed) == 0 || trimmed[0] != '{' || json.Unmarshal(trimmed, &body) != nil || body == nil {
		writeJSONResponse(response, http.StatusBadRequest, map[string]any{
			"ok":      false,
			"error":   "invalid_payload",
			"message": "请求体必须是有效 JSON 对象",
		})
		return
	}
	if _, ok := body["messages"].([]any); !ok {
		writeJSONResponse(response, http.StatusBadRequest, map[string]any{
			"ok":      false,
			"error":   "invalid_payload",
			"message": "请求体必须包含 messages 数组",
		})
		return
	}
	writeJSONResponse(response, http.StatusConflict, map[string]any{
		"ok":       false,
		"error":    "chat_harness_required",
		"message":  "Chat 已迁移到原生 Harness，请刷新页面后继续对话。",
		"endpoint": "/v0/webui/chat/sessions",
	})
}

func splitEscapedPathAfter(u *url.URL, prefixes ...string) []string {
	if u == nil {
		return nil
	}
	escaped := u.EscapedPath()
	for _, prefix := range prefixes {
		if strings.HasPrefix(escaped, prefix) {
			rest := strings.Trim(strings.TrimPrefix(escaped, prefix), "/")
			if rest == "" {
				return nil
			}
			return strings.Split(rest, "/")
		}
	}
	return nil
}

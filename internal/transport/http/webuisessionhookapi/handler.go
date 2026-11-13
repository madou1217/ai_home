// Package webuisessionhookapi 接收并归一 Provider 官方 Hook / CLI 运行时会话事件。
//
// 路由（管理面）：
//
//	POST /v1/management/webui/session-events/provider-hook
//
// 职责：
//  1. 鉴权并解析 256KB 上限 JSON payload。
//  2. 处理内部高优先事件 AihCliInteractionSync 与 AihRetryStatus（依赖 correlationId）。
//  3. 归一所有受支持 Provider 的 Hook 事件，原子写入 provider-session-state 快照。
//  4. 绑定 Codex 持久会话 correlationId -> nativeSessionId，触发账号活跃与恢复旁路。
//  5. 将标准事件实时发布到 Go sessionevents.Bus，驱动会话 SSE/WS watcher。
package webuisessionhookapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/runtime/sessionevents"
)

const (
	// Path 是 provider hook 接收契约路径。
	Path = "/v1/management/webui/session-events/provider-hook"

	cliRetryEventName           = "AihRetryStatus"
	cliInteractionSyncEventName = "AihCliInteractionSync"

	maxHookBodyBytes = 256 * 1024
)

// ErrInvalidDependencies 表示缺少必需依赖。
var ErrInvalidDependencies = errors.New("WebUI provider hook 接口依赖无效")

// Authorizer 是管理面请求的鉴权策略。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 汇总 provider hook handler 依赖。
type Dependencies struct {
	Authorizer       Authorizer
	Bus              *sessionevents.Bus
	StateStore       *sessionevents.StateStore
	Catalog          *providers.Catalog
	AIHomeDir        string
	Now              func() time.Time
	AccountActivity  AccountActivityTracker
	OutcomeRecorder  OutcomeRecorder
	RuntimeRecoverer RuntimeRecoverer
}

// Handler 处理 POST /v1/management/webui/session-events/provider-hook。
type Handler struct {
	authorizer       Authorizer
	bus              *sessionevents.Bus
	stateStore       *sessionevents.StateStore
	catalog          *providers.Catalog
	aiHomeDir        string
	now              func() time.Time
	accountActivity  AccountActivityTracker
	outcomeRecorder  OutcomeRecorder
	runtimeRecoverer RuntimeRecoverer
}

// NewHandler 校验依赖并构建 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Bus == nil || dependencies.StateStore == nil {
		return nil, ErrInvalidDependencies
	}
	nowFn := dependencies.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	return &Handler{
		authorizer:       dependencies.Authorizer,
		bus:              dependencies.Bus,
		stateStore:       dependencies.StateStore,
		catalog:          dependencies.Catalog,
		aiHomeDir:        strings.TrimSpace(dependencies.AIHomeDir),
		now:              nowFn,
		accountActivity:  dependencies.AccountActivity,
		outcomeRecorder:  dependencies.OutcomeRecorder,
		runtimeRecoverer: dependencies.RuntimeRecoverer,
	}, nil
}

// ServeHTTP 解析、归一并广播 provider hook 事件。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.bus == nil || handler.stateStore == nil {
		writeJSON(response, http.StatusServiceUnavailable, map[string]any{
			"ok":      false,
			"error":   "provider_hook_unavailable",
			"message": "会话事件接收服务不可用",
		})
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeJSON(response, http.StatusUnauthorized, map[string]any{
			"ok":      false,
			"error":   "unauthorized",
			"message": "需要管理密钥",
		})
		return
	}
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeJSON(response, http.StatusMethodNotAllowed, map[string]any{
			"ok":      false,
			"error":   "method_not_allowed",
			"message": "仅支持 POST",
		})
		return
	}

	body, ok := readObjectPayload(response, request)
	if !ok {
		writeJSON(response, http.StatusBadRequest, map[string]any{
			"ok":      false,
			"error":   "invalid_payload",
			"message": "provider hook payload 无效",
		})
		return
	}

	query := request.URL.Query()
	rawEvent := ParsePayloadRoot(body)
	provider := firstText(query.Get("provider"), anyText(body["provider"]), anyText(rawEvent["provider"]))
	eventName := firstText(
		query.Get("event"),
		anyText(body["eventName"]),
		anyText(body["hookEventName"]),
		anyText(rawEvent["eventName"]),
		anyText(rawEvent["hookEventName"]),
		anyText(rawEvent["hook_event_name"]),
		anyText(rawEvent["event"]),
	)
	correlationID := firstText(anyText(body["correlationId"]), anyText(body["correlation_id"]))

	switch eventName {
	case cliInteractionSyncEventName:
		handler.handleCliInteractionSync(response, body, correlationID)
		return
	case cliRetryEventName:
		handler.handleCliRetryStatus(response, body, correlationID)
		return
	}

	normalized := NormalizeProviderHookEvent(provider, rawEvent, NormalizeOptions{
		EventName:      eventName,
		SessionID:      firstText(query.Get("sessionId"), anyText(body["sessionId"]), anyText(body["session_id"])),
		ProjectDirName: firstText(query.Get("projectDirName"), anyText(body["projectDirName"]), anyText(body["project_dir_name"])),
		ProjectPath:    firstText(query.Get("projectPath"), anyText(body["projectPath"]), anyText(body["project_path"])),
		Now:            handler.now,
		IsSupportedProvider: func(candidate string) bool {
			return handler.isSupportedProvider(candidate)
		},
	})
	if !normalized.OK {
		errCode := normalized.Error
		if errCode == "" {
			errCode = "invalid_provider_hook_event"
		}
		writeJSON(response, http.StatusBadRequest, map[string]any{
			"ok":      false,
			"error":   errCode,
			"message": "provider hook 事件无效: " + errCode,
		})
		return
	}

	eventID := firstText(anyText(body["eventId"]), anyText(body["event_id"]))
	if eventID == "" {
		eventID = fmt.Sprintf("%s:%s:%s:%d",
			normalized.Session.Provider,
			normalized.Session.SessionID,
			firstText(normalized.Event.EventName, normalized.Event.Type),
			normalized.Event.At,
		)
	}
	revision := parseRevision(body["revision"], body["eventRevision"])

	stateRes := handler.stateStore.Apply(sessionevents.StateEvent{
		EventID: eventID,
		Session: sessionevents.StateSession{
			Provider:       normalized.Session.Provider,
			SessionID:      normalized.Session.SessionID,
			ProjectPath:    normalized.Session.ProjectPath,
			ProjectDirName: normalized.Session.ProjectDirName,
		},
		CorrelationID: correlationID,
		Source:        normalized.Event.Source,
		Type:          normalized.Event.Type,
		Revision:      revision,
		At:            normalized.Event.At,
		Payload:       normalized.Event.Payload,
	})
	if !stateRes.Accepted && stateRes.Reason == "correlation_conflict" {
		writeJSON(response, http.StatusConflict, map[string]any{
			"ok":      false,
			"error":   "session_correlation_conflict",
			"message": "会话 correlationId 与已有会话冲突",
		})
		return
	}

	if correlationID != "" && normalized.Session.Provider == "codex" && handler.aiHomeDir != "" {
		bindPersistentSessionByCorrelation(handler.aiHomeDir, "codex", correlationID, normalized.Session.SessionID)
	}

	accountRef := NormalizeProviderAccountRef(anyText(body["accountRef"]))
	handler.applyAccountSideEffects(request, normalized, accountRef)

	published := handler.bus.Publish(sessionevents.Session{
		Provider:       normalized.Session.Provider,
		SessionID:      normalized.Session.SessionID,
		ProjectDirName: normalized.Session.ProjectDirName,
		ProjectPath:    normalized.Session.ProjectPath,
	}, sessionevents.Event{
		Type:           normalized.Event.Type,
		Source:         normalized.Event.Source,
		Reason:         normalized.Event.Reason,
		At:             normalized.Event.At,
		EventName:      normalized.Event.EventName,
		Phase:          normalized.Event.Phase,
		TranscriptPath: normalized.Event.TranscriptPath,
		CWD:            normalized.Event.CWD,
		ProjectPath:    normalized.Event.ProjectPath,
		ProjectDirName: normalized.Event.ProjectDirName,
		TurnID:         normalized.Event.TurnID,
	})

	runtimeRecovered := false
	if normalized.Event.Type == "session:turn-completed" && accountRef != "" && handler.runtimeRecoverer != nil {
		runtimeRecovered = handler.runtimeRecoverer.RecoverOnHookSuccess(
			request.Context(),
			normalized.Session.Provider,
			accountRef,
			normalized.Event.At,
		)
	}

	writeJSON(response, http.StatusOK, map[string]any{
		"ok":               true,
		"published":        published,
		"runtimeRecovered": runtimeRecovered,
		"event": map[string]any{
			"type":           normalized.Event.Type,
			"provider":       normalized.Session.Provider,
			"sessionId":      normalized.Session.SessionID,
			"projectDirName": normalized.Session.ProjectDirName,
			"projectPath":    normalized.Session.ProjectPath,
			"source":         normalized.Event.Source,
			"eventName":      normalized.Event.EventName,
			"phase":          normalized.Event.Phase,
		},
	})
}

func (handler *Handler) handleCliInteractionSync(
	response http.ResponseWriter,
	body map[string]any,
	correlationID string,
) {
	correlated, ok := handler.stateStore.ResolveCorrelation(correlationID)
	if !ok {
		writeJSON(response, http.StatusConflict, map[string]any{
			"ok":      false,
			"error":   "session_correlation_not_ready",
			"message": "会话 correlation 尚未就绪",
		})
		return
	}

	prompt, hasPrompt := body["prompt"].(map[string]any)
	cleared := anyText(body["clearedPromptId"])
	nowMs := handler.now().UnixMilli()
	revision := parseRevision(body["promptRevision"], body["clearedPromptRevision"])

	var eventType string
	var eventID string
	var statePayload map[string]any
	if hasPrompt && prompt != nil {
		eventType = "question-opened"
		promptKey := firstText(anyText(prompt["promptId"]), strconv.FormatInt(revision, 10), strconv.FormatInt(nowMs, 10))
		eventID = "codex:question:" + promptKey
		opts := extractPromptOptions(prompt["options"])
		statePayload = map[string]any{
			"question": firstText(anyText(prompt["question"]), anyText(prompt["text"]), anyText(prompt["prompt"])),
			"options":  opts,
		}
	} else if cleared != "" {
		eventType = "question-cleared"
		revText := firstText(anyScalarText(body["clearedPromptRevision"]), strconv.FormatInt(nowMs, 10))
		eventID = fmt.Sprintf("codex:question-clear:%s:%s", cleared, revText)
		statePayload = map[string]any{"reason": "cleared"}
	} else {
		writeJSON(response, http.StatusBadRequest, map[string]any{
			"ok":      false,
			"error":   "invalid_payload",
			"message": "AihCliInteractionSync 缺少 prompt 或 clearedPromptId",
		})
		return
	}

	res := handler.stateStore.Apply(sessionevents.StateEvent{
		EventID:       eventID,
		Session:       correlated,
		CorrelationID: correlationID,
		Source:        "native-event",
		Type:          eventType,
		Revision:      revision,
		At:            nowMs,
		Payload:       statePayload,
	})
	if !res.Accepted && res.Reason == "correlation_conflict" {
		writeJSON(response, http.StatusConflict, map[string]any{
			"ok":      false,
			"error":   "session_correlation_conflict",
			"message": "会话 correlation 冲突",
		})
		return
	}

	busSession := sessionevents.Session{
		Provider:       correlated.Provider,
		SessionID:      correlated.SessionID,
		ProjectPath:    correlated.ProjectPath,
		ProjectDirName: correlated.ProjectDirName,
	}
	if res.Accepted {
		busEvent := sessionevents.Event{
			Type:   "session:" + eventType,
			Source: "native-event",
			Phase:  "turn-updated",
			At:     nowMs,
		}
		if hasPrompt && prompt != nil {
			busEvent.PromptID = anyText(prompt["promptId"])
			busEvent.Prompt = prompt
			busEvent.Reason = "question_opened"
		} else {
			busEvent.PromptID = cleared
			busEvent.Reason = "question_cleared"
		}
		handler.bus.Publish(busSession, busEvent)
	}

	writeJSON(response, http.StatusOK, map[string]any{
		"ok":    true,
		"state": res.State,
	})
}

func (handler *Handler) handleCliRetryStatus(
	response http.ResponseWriter,
	body map[string]any,
	correlationID string,
) {
	correlated, ok := handler.stateStore.ResolveCorrelation(correlationID)
	if !ok {
		writeJSON(response, http.StatusConflict, map[string]any{
			"ok":      false,
			"error":   "session_correlation_not_ready",
			"message": "会话 correlation 尚未就绪",
		})
		return
	}

	rawRetry, _ := body["retryStatus"].(map[string]any)
	cloned := make(map[string]any, len(rawRetry)+1)
	for k, v := range rawRetry {
		cloned[k] = v
	}
	cloned["source"] = "provider-runtime"
	retryStatus := sessionevents.NormalizeRetryStatus(cloned, correlated.Provider)

	nowMs := handler.now().UnixMilli()
	eventID := fmt.Sprintf("retry:%s:%d:%d", correlationID, retryStatus.Attempt, retryStatus.MaxAttempts)
	handler.stateStore.Apply(sessionevents.StateEvent{
		EventID:       eventID,
		Session:       correlated,
		CorrelationID: correlationID,
		Source:        "provider-runtime",
		Type:          "retry-updated",
		At:            nowMs,
		Payload:       retryStatus.ToMap(),
	})

	published := handler.bus.Publish(sessionevents.Session{
		Provider:       correlated.Provider,
		SessionID:      correlated.SessionID,
		ProjectPath:    correlated.ProjectPath,
		ProjectDirName: correlated.ProjectDirName,
	}, sessionevents.Event{
		Type:        "session:retry-status",
		Source:      "provider-runtime",
		Reason:      "cli_retry",
		Phase:       "turn-updated",
		RetryStatus: &retryStatus,
		At:          nowMs,
	})

	writeJSON(response, http.StatusOK, map[string]any{
		"ok":        true,
		"published": published,
	})
}

func (handler *Handler) applyAccountSideEffects(
	request *http.Request,
	normalized NormalizeResult,
	accountRef string,
) {
	if accountRef == "" {
		return
	}
	if handler.accountActivity != nil {
		switch ResolveSessionTurnAction(normalized.Event.Type, normalized.Event.EventName) {
		case TurnActionAlive:
			handler.accountActivity.MarkSessionTurn(normalized.Session.Provider, accountRef)
		case TurnActionDone:
			handler.accountActivity.EndSessionTurn(normalized.Session.Provider, accountRef)
		}
	}
	if handler.outcomeRecorder != nil {
		if outcome := ResolveSessionTurnOutcome(normalized.Event.Type, normalized.Event.EventName); outcome != "" {
			at := time.UnixMilli(normalized.Event.At)
			if normalized.Event.At <= 0 {
				at = handler.now()
			}
			handler.outcomeRecorder.RecordHookOutcome(request.Context(), normalized.Session.Provider, accountRef, outcome, at)
		}
	}
}

func (handler *Handler) isSupportedProvider(provider string) bool {
	if handler.catalog == nil {
		return provider != ""
	}
	return handler.catalog.Contains(provider)
}

func extractPromptOptions(raw any) []string {
	items, ok := raw.([]any)
	if !ok {
		return []string{}
	}
	opts := make([]string, 0, len(items))
	for _, item := range items {
		if len(opts) >= 32 {
			break
		}
		if obj, isObj := item.(map[string]any); isObj {
			txt := firstText(anyText(obj["value"]), anyText(obj["label"]))
			if txt != "" {
				opts = append(opts, txt)
			}
			continue
		}
		if txt := anyScalarText(item); txt != "" {
			opts = append(opts, txt)
		}
	}
	return opts
}

func readObjectPayload(response http.ResponseWriter, request *http.Request) (map[string]any, bool) {
	raw, err := io.ReadAll(io.LimitReader(request.Body, maxHookBodyBytes+1))
	if err != nil || len(raw) > maxHookBodyBytes || len(strings.TrimSpace(string(raw))) == 0 {
		return nil, false
	}
	var decoded any
	if json.Unmarshal(raw, &decoded) != nil {
		return nil, false
	}
	obj, ok := decoded.(map[string]any)
	if !ok || obj == nil {
		return nil, false
	}
	return obj, true
}

func parseRevision(values ...any) int64 {
	for _, value := range values {
		switch typed := value.(type) {
		case float64:
			if typed > 0 {
				return int64(typed)
			}
		case int64:
			if typed > 0 {
				return typed
			}
		case int:
			if typed > 0 {
				return int64(typed)
			}
		case string:
			if num, err := strconv.ParseInt(strings.TrimSpace(typed), 10, 64); err == nil && num > 0 {
				return num
			}
		}
	}
	return 0
}

func writeJSON(response http.ResponseWriter, status int, body any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	encoder := json.NewEncoder(response)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(body)
}

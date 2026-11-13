package chatruntime

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"maps"
	"math"
	"net/http"
	"slices"
	"sort"
	"strconv"
	"strings"
)

const (
	// EventSchema 是 WebUI Canonical Chat Event 的唯一 schema 标识。
	EventSchema = "aih.chat.event.v1"

	MaxTurnAttachments = 8
	MaxGoalObjective   = 16000
)

var (
	ValidCommandTypes = map[string]struct{}{
		"runtime.prewarm": {}, "turn.submit": {}, "turn.retry": {}, "turn.regenerate": {},
		"session.fork": {}, "turn.intervene": {}, "turn.interrupt": {},
		"queue.add": {}, "queue.edit": {}, "queue.remove": {}, "queue.move": {}, "queue.dispatch": {},
		"interaction.answer": {}, "approval.decide": {}, "slash.execute": {},
		"session.policy.set": {}, "session.goal.set": {}, "session.goal.get": {}, "session.goal.clear": {},
	}

	ValidEventTypes = map[string]struct{}{
		"session.created": {}, "session.runtime.bound": {}, "session.runtime.rebound": {},
		"session.policy.changed": {}, "session.closed": {}, "session.snapshot.reset": {},
		"session.goal.updated": {}, "session.goal.cleared": {},
		"turn.queued": {}, "turn.started": {}, "turn.phase.changed": {}, "turn.metrics.updated": {},
		"turn.interrupt.requested": {}, "turn.interrupted": {}, "turn.completed": {}, "turn.failed": {},
		"queue.item.added": {}, "queue.item.updated": {}, "queue.item.moved": {},
		"queue.item.removed": {}, "queue.item.dispatched": {},
		"timeline.item.started": {}, "timeline.item.delta": {},
		"timeline.item.updated": {}, "timeline.item.completed": {},
		"interaction.requested": {}, "interaction.updated": {}, "interaction.resolved": {}, "interaction.expired": {},
		"run.detached": {}, "run.reattached": {}, "run.adopted": {}, "run.lost": {},
		"runtime.prewarm.started": {}, "runtime.prewarm.ready": {}, "runtime.prewarm.failed": {},
		"stream.error": {},
	}

	ValidSessionStates = map[string]struct{}{
		"idle": {}, "starting": {}, "running": {}, "waiting_input": {},
		"interrupting": {}, "completing": {}, "recovering": {}, "closed": {},
	}

	ValidTimelineKinds = map[string]struct{}{
		"message": {}, "reasoning": {}, "plan": {}, "tool": {}, "shell": {},
		"diff": {}, "file_change": {}, "terminal": {}, "question": {}, "approval": {},
		"subagent": {}, "command": {}, "attachment": {}, "artifact": {}, "notice": {}, "error": {},
	}

	ValidTimelineStatuses = map[string]struct{}{
		"pending": {}, "running": {}, "waiting_input": {}, "completed": {},
		"failed": {}, "cancelled": {}, "unknown": {},
	}

	ValidTimelineDeltaChannels = map[string]struct{}{
		"summary": {}, "content": {}, "plan": {}, "output": {}, "diff": {}, "progress": {},
	}

	ValidQueuePolicies = map[string]struct{}{
		"after_tool_boundary": {}, "after_turn": {},
	}

	ValidQueueStatuses = map[string]struct{}{
		"queued": {}, "leased": {}, "running": {}, "completed": {}, "failed": {},
	}

	ValidInterveneModes = map[string]struct{}{
		"steer_current": {}, "after_tool_boundary": {}, "after_turn_same_run": {}, "replace_current": {},
	}

	ValidQuestionActions = map[string]struct{}{
		"submit": {}, "decline": {}, "cancel": {},
	}

	ValidGoalStatuses = map[string]struct{}{
		"active": {}, "paused": {}, "blocked": {}, "usageLimited": {}, "budgetLimited": {}, "complete": {},
	}

	metricFieldNames = []string{
		"durationMs", "ttftMs", "inputTokens", "outputTokens", "tokensPerSec", "contextTokens", "contextWindow",
	}
)

// EventSource 描述产生事件的 Provider 与 Runtime 标识。
type EventSource struct {
	Provider      string `json:"provider"`
	RuntimeID     string `json:"runtimeId"`
	NativeEventID string `json:"nativeEventId,omitempty"`
}

// EventEnvelope 是标准 WebUI 聊天事件信封。
type EventEnvelope struct {
	Schema    string         `json:"schema"`
	EventID   string         `json:"eventId"`
	SessionID string         `json:"sessionId"`
	Seq       int64          `json:"seq"`
	Type      string         `json:"type"`
	At        int64          `json:"at"`
	TurnID    string         `json:"turnId,omitempty"`
	RunID     string         `json:"runId,omitempty"`
	ItemID    string         `json:"itemId,omitempty"`
	Source    EventSource    `json:"source"`
	Payload   map[string]any `json:"payload"`
}

// EventDraft 是持久化前的事件草稿。
type EventDraft struct {
	EventID string
	Type    string
	At      *int64
	TurnID  string
	RunID   string
	ItemID  string
	Source  EventSource
	Payload map[string]any
}

// ActiveTurn 记录正在进行中的轮次状态。
type ActiveTurn struct {
	TurnID              string         `json:"turnId"`
	RunID               string         `json:"runId"`
	ClientUserMessageID string         `json:"clientUserMessageId,omitempty"`
	StartedAt           int64          `json:"startedAt,omitempty"`
	FirstTokenAt        *int64         `json:"firstTokenAt,omitempty"`
	Metrics             map[string]any `json:"metrics,omitempty"`
	UsageTotals         map[string]any `json:"usageTotals,omitempty"`
	NativeTurnID        string         `json:"nativeTurnId,omitempty"`
	State               string         `json:"state"`
	InterruptRequested  bool           `json:"interruptRequested,omitempty"`
}

// FailedTurn 描述最新一次可诊断或可重试的失败轮次。
type FailedTurn struct {
	TurnID         string         `json:"turnId"`
	FailedAt       int64          `json:"failedAt"`
	Error          map[string]any `json:"error"`
	Retryable      bool           `json:"retryable"`
	OutcomeUnknown bool           `json:"outcomeUnknown,omitempty"`
}

// Session 是 Canonical 会话主记录。
type Session struct {
	SessionID           string         `json:"sessionId"`
	Provider            string         `json:"provider"`
	ExecutionAccountRef string         `json:"executionAccountRef"`
	ProjectPath         string         `json:"projectPath"`
	State               string         `json:"state"`
	RuntimeBinding      map[string]any `json:"runtimeBinding"`
	CapabilitySnapshot  map[string]any `json:"capabilitySnapshot"`
	Policy              map[string]any `json:"policy"`
	ActiveTurn          *ActiveTurn    `json:"activeTurn,omitempty"`
	LastEventSeq        int64          `json:"lastEventSeq"`
	CreatedAt           int64          `json:"createdAt"`
	UpdatedAt           int64          `json:"updatedAt"`
}

// Command 描述一条已受理的会话指令。
type Command struct {
	CommandID   string         `json:"commandId"`
	SessionID   string         `json:"sessionId"`
	Type        string         `json:"type"`
	Payload     map[string]any `json:"payload"`
	Status      string         `json:"status"`
	Result      map[string]any `json:"result,omitempty"`
	AcceptedSeq int64          `json:"acceptedSeq"`
	CreatedAt   int64          `json:"createdAt"`
	UpdatedAt   int64          `json:"updatedAt"`
}

// QueueEntry 描述一条会话队列项。
type QueueEntry struct {
	QueueID        string         `json:"queueId"`
	SessionID      string         `json:"sessionId"`
	CommandID      string         `json:"commandId"`
	Position       int            `json:"position"`
	Policy         string         `json:"policy"`
	Payload        map[string]any `json:"payload"`
	Status         string         `json:"status"`
	LeaseID        string         `json:"leaseId,omitempty"`
	BoundaryItemID string         `json:"boundaryItemId,omitempty"`
	Result         map[string]any `json:"result,omitempty"`
	CreatedAt      int64          `json:"createdAt"`
	UpdatedAt      int64          `json:"updatedAt"`
}

// Interaction 描述一次需要用户响应的审批、提问或计划确认。
type Interaction struct {
	InteractionID string         `json:"interactionId"`
	SessionID     string         `json:"sessionId"`
	ItemID        string         `json:"itemId"`
	Kind          string         `json:"kind"`
	Revision      int            `json:"revision"`
	Payload       map[string]any `json:"payload"`
	State         string         `json:"state"`
	Resolution    map[string]any `json:"resolution,omitempty"`
	CreatedAt     int64          `json:"createdAt"`
	UpdatedAt     int64          `json:"updatedAt"`
}

// TimelineItem 是投影到前端的时间线条目。
type TimelineItem struct {
	ID        string         `json:"id"`
	Kind      string         `json:"kind"`
	CreatedAt int64          `json:"createdAt"`
	UpdatedAt *int64         `json:"updatedAt,omitempty"`
	Status    string         `json:"status"`
	TurnID    string         `json:"turnId,omitempty"`
	Content   *string        `json:"content,omitempty"`
	Detail    map[string]any `json:"detail"`
}

// Snapshot 是会话全量实时快照。
type Snapshot struct {
	SessionID          string         `json:"sessionId"`
	State              string         `json:"state"`
	ThroughSeq         int64          `json:"throughSeq"`
	RuntimeBinding     map[string]any `json:"runtimeBinding,omitempty"`
	CapabilitySnapshot map[string]any `json:"capabilitySnapshot,omitempty"`
	ActiveTurn         *ActiveTurn    `json:"activeTurn,omitempty"`
	FailedTurn         *FailedTurn    `json:"failedTurn,omitempty"`
	Policy             map[string]any `json:"policy"`
	Queue              []QueueEntry   `json:"queue"`
	Interactions       []Interaction  `json:"interactions"`
	Timeline           []TimelineItem `json:"timeline"`
	TimelineHasMore    bool           `json:"timelineHasMore"`
	TimelineNextBefore *string        `json:"timelineNextBefore"`
}

// TimelinePage 描述一次分页读取的时间线结果。
type TimelinePage struct {
	SessionID  string         `json:"sessionId"`
	Items      []TimelineItem `json:"items"`
	HasMore    bool           `json:"hasMore"`
	NextBefore *string        `json:"nextBefore"`
	ThroughSeq int64          `json:"throughSeq"`
}

// Attachment 描述一条已落盘的会话附件元数据。
type Attachment struct {
	AttachmentID string `json:"attachmentId"`
	SessionID    string `json:"sessionId"`
	Name         string `json:"name"`
	MimeType     string `json:"mimeType"`
	CreatedAt    int64  `json:"createdAt"`
	FilePath     string `json:"-"`
}

// Artifact 描述可下载的对话产物。
type Artifact struct {
	ContentType string
	Body        []byte
}

// CreateSessionInput 描述创建/打开会话请求。
type CreateSessionInput struct {
	SessionID           string         `json:"sessionId,omitempty"`
	ChatSessionID       string         `json:"chatSessionId,omitempty"`
	Provider            string         `json:"provider"`
	ExecutionAccountRef string         `json:"executionAccountRef"`
	ProjectPath         string         `json:"projectPath"`
	State               string         `json:"state,omitempty"`
	NativeSessionID     string         `json:"nativeSessionId,omitempty"`
	RuntimeBinding      map[string]any `json:"runtimeBinding,omitempty"`
	CapabilitySnapshot  map[string]any `json:"capabilitySnapshot,omitempty"`
	Policy              map[string]any `json:"policy,omitempty"`
	ReadOnly            bool           `json:"readOnly,omitempty"`
}

// ResolveSessionResult 表示 sessions/resolve 结果。
type ResolveSessionResult struct {
	Status  string   `json:"status"`
	Session *Session `json:"session"`
}

// ListSessionsFilter 控制会话列表查询。
type ListSessionsFilter struct {
	Provider            string
	ChatOnly            bool
	ExecutionAccountRef string
	ProjectPath         string
	NativeSessionID     string
	Limit               int
}

// BranchSessionID 返回分支操作确定的子会话 ID（与 Node SHA-256 保持一致）。
func BranchSessionID(commandID string) string {
	sum := sha256.Sum256([]byte(commandID))
	return "session-" + hex.EncodeToString(sum[:])
}

// RequiredText 校验并裁剪必填文本。
func RequiredText(value any, code string) (string, error) {
	if value == nil {
		return "", ErrInvalid(code)
	}
	text := strings.TrimSpace(asString(value))
	if text == "" {
		return "", ErrInvalid(code)
	}
	return text, nil
}

// ValidateSessionState 校验会话状态值。
func ValidateSessionState(state string) (string, error) {
	text := strings.TrimSpace(state)
	if text == "" {
		return "", ErrInvalid("chat_session_state_required")
	}
	if _, ok := ValidSessionStates[text]; !ok {
		return "", NewError("invalid_chat_session_state", http.StatusUnprocessableEntity, map[string]any{"state": text})
	}
	return text, nil
}

// NormalizeMessageMetrics 校验并规范化轮次/消息用量指标。
func NormalizeMessageMetrics(value any) (map[string]any, error) {
	raw, ok := value.(map[string]any)
	if !ok || raw == nil {
		return nil, NewError("chat_metrics_invalid", http.StatusUnprocessableEntity, nil)
	}
	metrics := make(map[string]any)
	var ttft *float64
	var dur *float64
	for _, field := range metricFieldNames {
		v, present := raw[field]
		if !present || v == nil {
			continue
		}
		f, ok := toFiniteNonNegFloat(v)
		if !ok {
			return nil, NewError("chat_metrics_invalid", http.StatusUnprocessableEntity, map[string]any{"field": field})
		}
		if field == "ttftMs" {
			val := f
			ttft = &val
		}
		if field == "durationMs" {
			val := f
			dur = &val
		}
		metrics[field] = preserveNumericType(f)
	}
	if ttft != nil && dur != nil && *ttft > *dur {
		return nil, NewError("chat_metrics_invalid", http.StatusUnprocessableEntity, map[string]any{"field": "ttftMs"})
	}
	return metrics, nil
}

// NormalizeCommandInput 规范化并校验一条原始指令 JSON。
func NormalizeCommandInput(input map[string]any) (*Command, error) {
	if input == nil {
		return nil, ErrInvalid("invalid_chat_payload")
	}
	cmdType, err := RequiredText(input["type"], "chat_command_type_required")
	if err != nil {
		return nil, err
	}
	if _, ok := ValidCommandTypes[cmdType]; !ok {
		return nil, NewError("unsupported_chat_command", http.StatusUnprocessableEntity, map[string]any{"type": cmdType})
	}
	cmdID, err := RequiredText(input["commandId"], "chat_command_id_required")
	if err != nil {
		return nil, err
	}
	sessionID, err := RequiredText(input["sessionId"], "chat_session_id_required")
	if err != nil {
		return nil, err
	}
	payload, err := normalizeCommandPayload(cmdType, input["payload"])
	if err != nil {
		return nil, err
	}
	return &Command{
		CommandID: cmdID,
		SessionID: sessionID,
		Type:      cmdType,
		Payload:   payload,
	}, nil
}

func normalizeCommandPayload(cmdType string, raw any) (map[string]any, error) {
	var payload map[string]any
	if raw == nil {
		payload = map[string]any{}
	} else {
		m, ok := raw.(map[string]any)
		if !ok {
			return nil, ErrInvalid("invalid_chat_payload")
		}
		payload = CloneMap(m)
	}
	switch cmdType {
	case "turn.submit":
		return normalizeTurnSubmitPayload(payload)
	case "turn.retry":
		return normalizeTurnRetryPayload(payload)
	case "turn.regenerate", "session.fork":
		return normalizeMessageOperationPayload(payload)
	case "turn.intervene":
		return normalizeTurnIntervenePayload(payload)
	case "interaction.answer":
		return normalizeInteractionAnswerPayload(payload)
	case "approval.decide":
		return normalizeApprovalDecisionPayload(payload)
	case "slash.execute":
		return normalizeSlashExecutePayload(payload)
	case "session.goal.set":
		return normalizeGoalSetPayload(payload)
	case "session.goal.clear":
		if len(payload) > 0 {
			return nil, NewError("chat_goal_payload_invalid", http.StatusUnprocessableEntity, map[string]any{
				"unknown": sortedMapKeys(payload),
			})
		}
		return map[string]any{}, nil
	case "queue.edit", "queue.remove":
		id, err := RequiredText(payload["queueId"], "chat_queue_id_required")
		if err != nil {
			return nil, err
		}
		payload["queueId"] = id
		return payload, nil
	case "queue.move":
		id, err := RequiredText(payload["queueId"], "chat_queue_id_required")
		if err != nil {
			return nil, err
		}
		payload["queueId"] = id
		if v, ok := payload["beforeQueueId"]; ok && v != nil {
			beforeID, err := RequiredText(v, "chat_before_queue_id_invalid")
			if err != nil {
				return nil, err
			}
			payload["beforeQueueId"] = beforeID
		} else {
			delete(payload, "beforeQueueId")
		}
		return payload, nil
	case "queue.dispatch":
		if v, ok := payload["afterRunId"]; ok && v != nil {
			runID, err := RequiredText(v, "chat_run_id_required")
			if err != nil {
				return nil, err
			}
			payload["afterRunId"] = runID
		} else {
			delete(payload, "afterRunId")
		}
		if v, ok := payload["queueId"]; ok && v != nil {
			qID, err := RequiredText(v, "chat_queue_id_invalid")
			if err != nil {
				return nil, err
			}
			payload["queueId"] = qID
		} else {
			delete(payload, "queueId")
		}
		return payload, nil
	default:
		return payload, nil
	}
}

func normalizeTurnSubmitPayload(payload map[string]any) (map[string]any, error) {
	for _, key := range []string{"runId", "turnId"} {
		if _, exists := payload[key]; exists {
			return nil, NewError("chat_turn_identity_client_controlled", http.StatusUnprocessableEntity, map[string]any{"key": key})
		}
	}
	ids, err := NormalizeAttachmentIDs(payload["attachmentIds"], true)
	if err != nil {
		return nil, err
	}
	content := strings.TrimSpace(asString(payload["content"]))
	if content == "" && len(ids) == 0 {
		return nil, NewError("chat_turn_content_required", http.StatusUnprocessableEntity, nil)
	}
	payload["content"] = content
	if len(ids) == 0 {
		delete(payload, "attachmentIds")
	} else {
		payload["attachmentIds"] = toAnyStringSlice(ids)
	}
	for _, key := range []string{"model", "reasoningEffort"} {
		v, exists := payload[key]
		if !exists {
			continue
		}
		val := strings.TrimSpace(asString(v))
		if val == "" {
			return nil, NewError("chat_turn_model_control_invalid", http.StatusUnprocessableEntity, map[string]any{"key": key})
		}
		payload[key] = val
	}
	return payload, nil
}

// NormalizeAttachmentIDs 校验附件 ID 列表。
func NormalizeAttachmentIDs(value any, enforceMax bool) ([]string, error) {
	if value == nil {
		return nil, nil
	}
	var items []any
	switch typed := value.(type) {
	case []string:
		items = make([]any, len(typed))
		for i, s := range typed {
			items[i] = s
		}
	case []any:
		items = typed
	default:
		return nil, NewError("chat_attachment_ids_invalid", http.StatusUnprocessableEntity, map[string]any{"limit": MaxTurnAttachments})
	}
	if enforceMax && len(items) > MaxTurnAttachments {
		return nil, NewError("chat_attachment_ids_invalid", http.StatusUnprocessableEntity, map[string]any{"limit": MaxTurnAttachments})
	}
	ids := make([]string, 0, len(items))
	seen := make(map[string]struct{}, len(items))
	for _, raw := range items {
		id, err := RequiredText(raw, "chat_attachment_id_invalid")
		if err != nil {
			return nil, NewError("chat_attachment_id_invalid", http.StatusUnprocessableEntity, nil)
		}
		if _, dup := seen[id]; dup {
			return nil, NewError("chat_attachment_ids_duplicate", http.StatusUnprocessableEntity, nil)
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	return ids, nil
}

func normalizeTurnRetryPayload(payload map[string]any) (map[string]any, error) {
	for k := range payload {
		if k != "sourceTurnId" {
			return nil, NewError("chat_retry_payload_invalid", http.StatusUnprocessableEntity, nil)
		}
	}
	id, err := RequiredText(payload["sourceTurnId"], "chat_retry_source_turn_required")
	if err != nil {
		return nil, err
	}
	return map[string]any{"sourceTurnId": id}, nil
}

func normalizeMessageOperationPayload(payload map[string]any) (map[string]any, error) {
	for k := range payload {
		if k != "sourceItemId" {
			return nil, NewError("chat_message_operation_payload_invalid", http.StatusUnprocessableEntity, nil)
		}
	}
	id, err := RequiredText(payload["sourceItemId"], "chat_source_item_required")
	if err != nil {
		return nil, err
	}
	return map[string]any{"sourceItemId": id}, nil
}

func normalizeTurnIntervenePayload(payload map[string]any) (map[string]any, error) {
	if v, ok := payload["expectedRunId"]; ok && v != nil {
		runID, err := RequiredText(v, "chat_run_id_required")
		if err != nil {
			return nil, err
		}
		payload["expectedRunId"] = runID
	} else {
		delete(payload, "expectedRunId")
	}
	mode := asString(payload["mode"])
	if _, ok := ValidInterveneModes[mode]; !ok {
		return nil, NewError("invalid_turn_intervene_mode", http.StatusUnprocessableEntity, map[string]any{"mode": payload["mode"]})
	}
	return payload, nil
}

func normalizeApprovalDecisionPayload(payload map[string]any) (map[string]any, error) {
	if payload["decision"] != nil || payload["grant"] != nil {
		return nil, NewError("approval_native_decision_not_allowed", http.StatusUnprocessableEntity, nil)
	}
	allowed := map[string]struct{}{"interactionId": {}, "revision": {}, "choiceId": {}}
	var unknown []string
	for k := range payload {
		if _, ok := allowed[k]; !ok {
			unknown = append(unknown, k)
		}
	}
	if len(unknown) > 0 {
		sort.Strings(unknown)
		return nil, NewError("invalid_approval_command_payload", http.StatusUnprocessableEntity, map[string]any{"unknown": unknown})
	}
	id, err := RequiredText(payload["interactionId"], "chat_interaction_id_required")
	if err != nil {
		return nil, err
	}
	choiceID, err := RequiredText(payload["choiceId"], "chat_approval_choice_id_required")
	if err != nil {
		return nil, err
	}
	payload["interactionId"] = id
	payload["choiceId"] = choiceID
	return payload, nil
}

func normalizeInteractionAnswerPayload(payload map[string]any) (map[string]any, error) {
	id, err := RequiredText(payload["interactionId"], "chat_interaction_id_required")
	if err != nil {
		return nil, err
	}
	payload["interactionId"] = id
	action := asString(payload["action"])
	if _, ok := ValidQuestionActions[action]; !ok {
		return nil, NewError("invalid_question_action", http.StatusUnprocessableEntity, map[string]any{"action": payload["action"]})
	}
	_, hasAnswer := payload["answer"]
	if action == "submit" && !hasAnswer {
		return nil, NewError("chat_question_answer_required", http.StatusUnprocessableEntity, nil)
	}
	if action != "submit" && hasAnswer {
		return nil, NewError("chat_question_answer_not_allowed", http.StatusUnprocessableEntity, nil)
	}
	return payload, nil
}

func normalizeSlashExecutePayload(payload map[string]any) (map[string]any, error) {
	var unknown []string
	for k := range payload {
		if k != "name" && k != "arguments" {
			unknown = append(unknown, k)
		}
	}
	if len(unknown) > 0 {
		sort.Strings(unknown)
		return nil, NewError("chat_slash_payload_invalid", http.StatusUnprocessableEntity, map[string]any{"unknown": unknown})
	}
	rawName, err := RequiredText(payload["name"], "chat_slash_name_required")
	if err != nil {
		return nil, NewError("chat_slash_name_required", http.StatusUnprocessableEntity, nil)
	}
	name := strings.ToLower(strings.TrimPrefix(rawName, "/"))
	if name == "" {
		return nil, NewError("chat_slash_name_required", http.StatusUnprocessableEntity, nil)
	}
	payload["name"] = name
	if v, ok := payload["arguments"]; ok && v != nil {
		str, isStr := v.(string)
		if !isStr {
			return nil, NewError("chat_slash_arguments_invalid", http.StatusUnprocessableEntity, nil)
		}
		trimmed := strings.TrimSpace(str)
		if trimmed == "" {
			delete(payload, "arguments")
		} else {
			payload["arguments"] = trimmed
		}
	}
	return payload, nil
}

func normalizeGoalSetPayload(payload map[string]any) (map[string]any, error) {
	var unknown []string
	for k := range payload {
		if k != "objective" && k != "tokenBudget" {
			unknown = append(unknown, k)
		}
	}
	if len(unknown) > 0 {
		sort.Strings(unknown)
		return nil, NewError("chat_goal_payload_invalid", http.StatusUnprocessableEntity, map[string]any{"unknown": unknown})
	}
	obj, err := RequiredText(payload["objective"], "chat_goal_objective_required")
	if err != nil {
		return nil, err
	}
	if len([]rune(obj)) > MaxGoalObjective {
		return nil, NewError("chat_goal_objective_too_large", http.StatusUnprocessableEntity, nil)
	}
	payload["objective"] = obj
	if budget, exists := payload["tokenBudget"]; exists && budget != nil {
		n, ok := asPositiveSafeInt64(budget)
		if !ok {
			return nil, NewError("chat_goal_token_budget_invalid", http.StatusUnprocessableEntity, nil)
		}
		payload["tokenBudget"] = n
	} else {
		payload["tokenBudget"] = nil
	}
	return payload, nil
}

// NormalizeTimelineDetail 校验并规范化时间线条目的 detail。
func NormalizeTimelineDetail(kind string, input map[string]any) (map[string]any, error) {
	if input == nil {
		return nil, NewError("timeline_detail_invalid", http.StatusUnprocessableEntity, nil)
	}
	detail := CloneMap(input)
	if (kind == "message" || kind == "reasoning") && detail["metrics"] != nil {
		normalizedMetrics, err := NormalizeMessageMetrics(detail["metrics"])
		if err != nil {
			return nil, err
		}
		detail["metrics"] = normalizedMetrics
	}
	switch kind {
	case "tool":
		if detail["exitCode"] == nil {
			delete(detail, "exitCode")
		}
	case "shell":
		for _, field := range []string{"output", "exitCode", "processId"} {
			if detail[field] == nil {
				delete(detail, field)
			}
		}
	}

	switch kind {
	case "message":
		if err := requireEnumDetail(detail, "role", map[string]struct{}{"user": {}, "assistant": {}, "system": {}}); err != nil {
			return nil, err
		}
		for _, k := range []string{"phase", "model", "effort"} {
			if err := normalizeOptionalDetailText(detail, k); err != nil {
				return nil, err
			}
		}
	case "reasoning":
	case "plan":
		if v, exists := detail["state"]; exists && v != nil {
			if err := requireEnumDetail(detail, "state", map[string]struct{}{"draft": {}, "proposed": {}, "accepted": {}, "rejected": {}}); err != nil {
				return nil, err
			}
		} else {
			delete(detail, "state")
		}
		if stepsRaw, exists := detail["steps"]; exists && stepsRaw != nil {
			if !validatePlanSteps(stepsRaw) {
				return nil, invalidTimelineDetailField("steps")
			}
		}
	case "tool":
		if err := requireDetailText(detail, "name"); err != nil {
			return nil, err
		}
		if v, exists := detail["exitCode"]; exists {
			if _, ok := asSafeInt64(v); !ok {
				return nil, invalidTimelineDetailField("exitCode")
			}
		}
	case "shell":
		if err := requireDetailText(detail, "command"); err != nil {
			return nil, err
		}
		if v, exists := detail["output"]; exists {
			if _, ok := v.(string); !ok {
				return nil, invalidTimelineDetailField("output")
			}
		}
		if v, exists := detail["exitCode"]; exists {
			if _, ok := asSafeInt64(v); !ok {
				return nil, invalidTimelineDetailField("exitCode")
			}
		}
		if v, exists := detail["processId"]; exists {
			if s, isStr := v.(string); isStr {
				if strings.TrimSpace(s) == "" {
					return nil, invalidTimelineDetailField("processId")
				}
			} else if n, ok := asSafeInt64(v); !ok || n < 0 {
				return nil, invalidTimelineDetailField("processId")
			}
		}
	case "diff":
		if v, exists := detail["paths"]; exists && v != nil {
			if !isStringSlice(v) {
				return nil, invalidTimelineDetailField("paths")
			}
		}
	case "file_change":
		if !isAnySlice(detail["changes"]) {
			return nil, invalidTimelineDetailField("changes")
		}
	case "terminal":
		if err := requireEnumDetail(detail, "stream", map[string]struct{}{"stdin": {}, "stdout": {}, "stderr": {}}); err != nil {
			return nil, err
		}
	case "question":
		if err := requireDetailText(detail, "interactionId"); err != nil {
			return nil, err
		}
	case "approval":
		if err := requireDetailText(detail, "interactionId"); err != nil {
			return nil, err
		}
		if err := requireDetailText(detail, "action"); err != nil {
			return nil, err
		}
	case "subagent":
		if err := requireDetailText(detail, "agentId"); err != nil {
			return nil, err
		}
	case "command":
		if err := requireDetailText(detail, "commandId"); err != nil {
			return nil, err
		}
		if err := requireDetailText(detail, "command"); err != nil {
			return nil, err
		}
	case "attachment":
		if err := requireDetailText(detail, "name"); err != nil {
			return nil, err
		}
		if err := requireDetailText(detail, "mimeType"); err != nil {
			return nil, err
		}
	case "artifact":
		if err := requireDetailText(detail, "artifactId"); err != nil {
			return nil, err
		}
		if err := requireDetailText(detail, "name"); err != nil {
			return nil, err
		}
		if err := requireDetailText(detail, "mimeType"); err != nil {
			return nil, err
		}
	case "notice":
		if err := requireEnumDetail(detail, "level", map[string]struct{}{"info": {}, "warning": {}, "success": {}}); err != nil {
			return nil, err
		}
	case "error":
		if err := requireDetailText(detail, "code"); err != nil {
			return nil, err
		}
	default:
		return nil, NewError("unknown_timeline_kind", http.StatusUnprocessableEntity, map[string]any{"kind": kind})
	}
	return detail, nil
}

// NormalizeTimelineItem 校验并规范化 TimelineItem。
func NormalizeTimelineItem(item TimelineItem) (TimelineItem, error) {
	kind := strings.TrimSpace(item.Kind)
	if kind == "" {
		return TimelineItem{}, ErrInvalid("timeline_kind_required")
	}
	if _, ok := ValidTimelineKinds[kind]; !ok {
		return TimelineItem{}, NewError("unknown_timeline_kind", http.StatusUnprocessableEntity, map[string]any{"kind": kind})
	}
	status := strings.TrimSpace(item.Status)
	if status == "" {
		return TimelineItem{}, ErrInvalid("timeline_status_required")
	}
	if _, ok := ValidTimelineStatuses[status]; !ok {
		return TimelineItem{}, NewError("invalid_timeline_status", http.StatusUnprocessableEntity, map[string]any{"status": status})
	}
	id, err := RequiredText(item.ID, "timeline_item_id_required")
	if err != nil {
		return TimelineItem{}, err
	}
	if item.CreatedAt < 0 {
		return TimelineItem{}, ErrInvalid("timeline_created_at_invalid")
	}
	if item.UpdatedAt != nil && *item.UpdatedAt < 0 {
		return TimelineItem{}, ErrInvalid("timeline_updated_at_invalid")
	}
	detail, err := NormalizeTimelineDetail(kind, item.Detail)
	if err != nil {
		return TimelineItem{}, err
	}
	var updatedAt *int64
	if item.UpdatedAt != nil {
		v := *item.UpdatedAt
		updatedAt = &v
	}
	var content *string
	if item.Content != nil {
		v := *item.Content
		content = &v
	}
	return TimelineItem{
		ID:        id,
		Kind:      kind,
		CreatedAt: item.CreatedAt,
		UpdatedAt: updatedAt,
		Status:    status,
		TurnID:    item.TurnID,
		Content:   content,
		Detail:    detail,
	}, nil
}

// NormalizeEventEnvelope 校验并规范化事件信封。
func NormalizeEventEnvelope(ev EventEnvelope) (EventEnvelope, error) {
	schema := ev.Schema
	if schema == "" {
		schema = EventSchema
	}
	if schema != EventSchema {
		return EventEnvelope{}, NewError("unsupported_chat_event_schema", http.StatusUnprocessableEntity, map[string]any{"schema": schema})
	}
	evType, err := RequiredText(ev.Type, "chat_event_type_required")
	if err != nil {
		return EventEnvelope{}, err
	}
	if _, ok := ValidEventTypes[evType]; !ok {
		return EventEnvelope{}, NewError("unknown_chat_event_type", http.StatusUnprocessableEntity, map[string]any{"type": evType})
	}
	eventID, err := RequiredText(ev.EventID, "chat_event_id_required")
	if err != nil {
		return EventEnvelope{}, err
	}
	sessionID, err := RequiredText(ev.SessionID, "chat_session_id_required")
	if err != nil {
		return EventEnvelope{}, err
	}
	if IsTransportEvent(evType) {
		if ev.Seq < 0 {
			return EventEnvelope{}, ErrInvalid("chat_event_seq_invalid")
		}
	} else if ev.Seq < 1 {
		return EventEnvelope{}, ErrInvalid("chat_event_seq_invalid")
	}
	if ev.At < 0 {
		return EventEnvelope{}, ErrInvalid("chat_event_at_invalid")
	}
	provider, err := RequiredText(ev.Source.Provider, "chat_event_provider_required")
	if err != nil {
		return EventEnvelope{}, ErrInvalid("chat_event_provider_required")
	}
	runtimeID, err := RequiredText(ev.Source.RuntimeID, "chat_event_runtime_id_required")
	if err != nil {
		return EventEnvelope{}, ErrInvalid("chat_event_runtime_id_required")
	}
	src := EventSource{
		Provider:      provider,
		RuntimeID:     runtimeID,
		NativeEventID: ev.Source.NativeEventID,
	}
	payload := CloneMap(ev.Payload)
	if err := validateEventPayload(evType, payload, ev.TurnID); err != nil {
		return EventEnvelope{}, err
	}
	return EventEnvelope{
		Schema:    schema,
		EventID:   eventID,
		SessionID: sessionID,
		Seq:       ev.Seq,
		Type:      evType,
		At:        ev.At,
		TurnID:    ev.TurnID,
		RunID:     ev.RunID,
		ItemID:    ev.ItemID,
		Source:    src,
		Payload:   payload,
	}, nil
}

// IsTransportEvent 判断事件是否为纯传输事件（seq 允许为 0 且不入库）。
func IsTransportEvent(eventType string) bool {
	return eventType == "stream.error" || eventType == "session.snapshot.reset"
}

func validateEventPayload(eventType string, payload map[string]any, eventTurnID string) error {
	switch eventType {
	case "session.goal.updated":
		if src, ok := payload["goalSource"]; ok && src != nil {
			s := asString(src)
			if s != "aih" && s != "native" {
				return NewError("chat_goal_source_invalid", http.StatusUnprocessableEntity, nil)
			}
		}
		if err := normalizeGoalMap(payload["goal"]); err != nil {
			return err
		}
	case "session.goal.cleared":
		if v, exists := payload["goalId"]; exists && v != nil {
			id, err := RequiredText(v, "chat_goal_id_invalid")
			if err != nil {
				return err
			}
			payload["goalId"] = id
		} else {
			delete(payload, "goalId")
		}
	case "turn.metrics.updated":
		metrics, err := NormalizeMessageMetrics(payload["metrics"])
		if err != nil {
			return err
		}
		payload["metrics"] = metrics
		if totals, exists := payload["totals"]; exists && totals != nil {
			tNorm, err := NormalizeMessageMetrics(totals)
			if err != nil {
				return err
			}
			payload["totals"] = tNorm
		} else {
			delete(payload, "totals")
		}
	case "timeline.item.started", "timeline.item.updated", "timeline.item.completed":
		rawItem, ok := payload["item"].(map[string]any)
		if !ok || rawItem == nil {
			return ErrInvalid("invalid_timeline_item")
		}
		item, err := itemFromMap(rawItem)
		if err != nil {
			return err
		}
		norm, err := NormalizeTimelineItem(item)
		if err != nil {
			return err
		}
		if eventTurnID != "" && norm.TurnID != "" && norm.TurnID != eventTurnID {
			return NewError("timeline_turn_id_mismatch", http.StatusUnprocessableEntity, map[string]any{
				"eventTurnId": eventTurnID,
				"itemTurnId":  norm.TurnID,
			})
		}
		payload["item"] = itemToMap(norm)
	case "timeline.item.delta":
		itemID, err := RequiredText(payload["itemId"], "timeline_item_id_required")
		if err != nil {
			return err
		}
		payload["itemId"] = itemID
		if payload["chunk"] == nil {
			payload["chunk"] = ""
		} else {
			payload["chunk"] = asString(payload["chunk"])
		}
		if detailRaw, exists := payload["detail"]; exists && detailRaw != nil {
			detailMap, ok := detailRaw.(map[string]any)
			if !ok {
				return ErrInvalid("invalid_timeline_delta_detail")
			}
			ch, err := RequiredText(detailMap["channel"], "timeline_delta_channel_required")
			if err != nil {
				return err
			}
			if _, ok := ValidTimelineDeltaChannels[ch]; !ok {
				return NewError("unknown_timeline_delta_channel", http.StatusUnprocessableEntity, map[string]any{"channel": ch})
			}
			normDetail := map[string]any{"channel": ch}
			if idx, ok := detailMap["index"]; ok && idx != nil {
				n, ok := asSafeInt64(idx)
				if !ok || n < 0 {
					return ErrInvalid("timeline_delta_index_invalid")
				}
				normDetail["index"] = n
			}
			payload["detail"] = normDetail
		} else {
			delete(payload, "detail")
		}
	case "queue.item.added", "queue.item.updated", "queue.item.dispatched":
		entryRaw, ok := payload["entry"].(map[string]any)
		if !ok || entryRaw == nil {
			return ErrInvalid("invalid_chat_queue_entry")
		}
		if err := normalizeQueueEntryMap(entryRaw); err != nil {
			return err
		}
	}
	return nil
}

func normalizeGoalMap(v any) error {
	m, ok := v.(map[string]any)
	if !ok || m == nil {
		return ErrInvalid("chat_goal_invalid")
	}
	if _, err := RequiredText(m["threadId"], "chat_goal_thread_invalid"); err != nil {
		return err
	}
	if _, err := RequiredText(m["objective"], "chat_goal_objective_invalid"); err != nil {
		return err
	}
	status, err := RequiredText(m["status"], "chat_goal_status_invalid")
	if err != nil {
		return err
	}
	if _, ok := ValidGoalStatuses[status]; !ok {
		return NewError("chat_goal_status_invalid", http.StatusUnprocessableEntity, map[string]any{"status": status})
	}
	for _, pair := range [][2]string{
		{"tokensUsed", "chat_goal_tokens_used_invalid"},
		{"timeUsedSeconds", "chat_goal_time_used_invalid"},
		{"createdAt", "chat_goal_created_at_invalid"},
		{"updatedAt", "chat_goal_updated_at_invalid"},
	} {
		n, ok := asSafeInt64(m[pair[0]])
		if !ok || n < 0 {
			return ErrInvalid(pair[1])
		}
	}
	if tb, ok := m["tokenBudget"]; ok && tb != nil {
		n, ok := asSafeInt64(tb)
		if !ok || n < 0 {
			return ErrInvalid("chat_goal_token_budget_invalid")
		}
	} else {
		m["tokenBudget"] = nil
	}
	return nil
}

func normalizeQueueEntryMap(m map[string]any) error {
	policy, err := RequiredText(m["policy"], "chat_queue_policy_required")
	if err != nil {
		return err
	}
	if _, ok := ValidQueuePolicies[policy]; !ok {
		return NewError("invalid_chat_queue_policy", http.StatusUnprocessableEntity, map[string]any{"policy": policy})
	}
	status, err := RequiredText(m["status"], "chat_queue_status_required")
	if err != nil {
		return err
	}
	if _, ok := ValidQueueStatuses[status]; !ok {
		return NewError("invalid_chat_queue_status", http.StatusUnprocessableEntity, map[string]any{"status": status})
	}
	for _, pair := range [][2]string{
		{"queueId", "chat_queue_id_required"},
		{"sessionId", "chat_session_id_required"},
		{"commandId", "chat_queue_command_id_required"},
	} {
		if _, err := RequiredText(m[pair[0]], pair[1]); err != nil {
			return err
		}
	}
	if pos, ok := asSafeInt64(m["position"]); !ok || pos < 0 {
		return ErrInvalid("chat_queue_position_invalid")
	}
	if cAt, ok := asSafeInt64(m["createdAt"]); !ok || cAt < 0 {
		return ErrInvalid("chat_queue_created_at_invalid")
	}
	if uAt, ok := asSafeInt64(m["updatedAt"]); !ok || uAt < 0 {
		return ErrInvalid("chat_queue_updated_at_invalid")
	}
	if _, ok := m["payload"].(map[string]any); !ok {
		return ErrInvalid("invalid_chat_queue_payload")
	}
	res := ProjectCanonicalQueueResult(status, m["result"])
	if res == nil {
		delete(m, "result")
	} else {
		m["result"] = res
	}
	return nil
}

// ProjectCanonicalQueueResult 按队列终态裁剪/脱敏 result。
func ProjectCanonicalQueueResult(status string, input any) map[string]any {
	if status == "completed" {
		return map[string]any{}
	}
	if status != "failed" {
		return nil
	}
	res, _ := input.(map[string]any)
	var errSource any = res
	if res != nil {
		if nested, ok := res["error"].(map[string]any); ok {
			errSource = nested
		}
	}
	diag := SanitizeCanonicalDiagnostic(errSource, DiagnosticOptions{FallbackCode: "chat_queue_failed"})
	return map[string]any{
		"error": map[string]any{
			"code":    diag.Code,
			"message": diag.Message,
		},
	}
}

// --- JSON 规范化与深拷贝辅助工具 ---

// CanonicalJSON 生成键名按字典序排序的稳定 JSON 字符串（省略 nil 与空前导）。
func CanonicalJSON(v any) (string, error) {
	sorted := sortJSONValue(v)
	raw, err := json.Marshal(sorted)
	if err != nil {
		return "", NewError("invalid_chat_runtime_json", http.StatusBadRequest, nil)
	}
	return string(raw), nil
}

// CanonicalJSONEquals 按规范化 JSON 判定两值是否结构相等。
func CanonicalJSONEquals(a, b any) bool {
	sa, errA := CanonicalJSON(a)
	sb, errB := CanonicalJSON(b)
	return errA == nil && errB == nil && sa == sb
}

func sortJSONValue(v any) any {
	if v == nil {
		return nil
	}
	switch typed := v.(type) {
	case map[string]any:
		keys := sortedMapKeys(typed)
		out := make(map[string]any, len(keys))
		for _, k := range keys {
			out[k] = sortJSONValue(typed[k])
		}
		return out
	case []any:
		out := make([]any, len(typed))
		for i, item := range typed {
			out[i] = sortJSONValue(item)
		}
		return out
	default:
		// 结构体通过 JSON 往返后再排序
		b, err := json.Marshal(typed)
		if err != nil {
			return typed
		}
		var generic any
		if err := json.Unmarshal(b, &generic); err != nil {
			return typed
		}
		if _, isMap := generic.(map[string]any); isMap {
			return sortJSONValue(generic)
		}
		if _, isSlice := generic.([]any); isSlice {
			return sortJSONValue(generic)
		}
		return generic
	}
}

// CloneMap 返回 map[string]any 的深拷贝（nil 输入返回空 map）。
func CloneMap(m map[string]any) map[string]any {
	if m == nil {
		return map[string]any{}
	}
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = cloneAny(v)
	}
	return out
}

func cloneMapOrNil(m map[string]any) map[string]any {
	if m == nil {
		return nil
	}
	return CloneMap(m)
}

func cloneAny(v any) any {
	switch typed := v.(type) {
	case nil:
		return nil
	case map[string]any:
		return CloneMap(typed)
	case []any:
		out := make([]any, len(typed))
		for i, elem := range typed {
			out[i] = cloneAny(elem)
		}
		return out
	case []string:
		return slices.Clone(typed)
	default:
		return typed
	}
}

// CloneActiveTurn 深拷贝 ActiveTurn。
func CloneActiveTurn(t *ActiveTurn) *ActiveTurn {
	if t == nil {
		return nil
	}
	cp := *t
	if t.FirstTokenAt != nil {
		v := *t.FirstTokenAt
		cp.FirstTokenAt = &v
	}
	if t.Metrics != nil {
		cp.Metrics = CloneMap(t.Metrics)
	}
	if t.UsageTotals != nil {
		cp.UsageTotals = CloneMap(t.UsageTotals)
	}
	return &cp
}

func sortedMapKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func asString(v any) string {
	switch s := v.(type) {
	case nil:
		return ""
	case string:
		return s
	case bool:
		return strconv.FormatBool(s)
	case int:
		return strconv.Itoa(s)
	case int64:
		return strconv.FormatInt(s, 10)
	case float64:
		if math.IsNaN(s) || math.IsInf(s, 0) {
			return ""
		}
		return strconv.FormatFloat(s, 'f', -1, 64)
	case json.Number:
		return s.String()
	default:
		return ""
	}
}

func asSafeInt64(v any) (int64, bool) {
	switch n := v.(type) {
	case int:
		return int64(n), true
	case int32:
		return int64(n), true
	case int64:
		return n, true
	case float64:
		if math.IsNaN(n) || math.IsInf(n, 0) || math.Trunc(n) != n {
			return 0, false
		}
		if n < -9007199254740991 || n > 9007199254740991 {
			return 0, false
		}
		return int64(n), true
	case json.Number:
		parsed, err := n.Int64()
		return parsed, err == nil
	default:
		return 0, false
	}
}

func asPositiveSafeInt64(v any) (int64, bool) {
	n, ok := asSafeInt64(v)
	return n, ok && n >= 1
}

func toFiniteNonNegFloat(v any) (float64, bool) {
	switch n := v.(type) {
	case int:
		return float64(n), n >= 0
	case int32:
		return float64(n), n >= 0
	case int64:
		return float64(n), n >= 0
	case uint:
		return float64(n), true
	case uint32:
		return float64(n), true
	case uint64:
		return float64(n), true
	case float32:
		f := float64(n)
		return f, !math.IsNaN(f) && !math.IsInf(f, 0) && f >= 0
	case float64:
		return n, !math.IsNaN(n) && !math.IsInf(n, 0) && n >= 0
	case json.Number:
		f, err := n.Float64()
		return f, err == nil && !math.IsNaN(f) && !math.IsInf(f, 0) && f >= 0
	default:
		return 0, false
	}
}

func preserveNumericType(f float64) any {
	if math.Trunc(f) == f && f >= -9007199254740991 && f <= 9007199254740991 {
		return int64(f)
	}
	return f
}

func toAnyStringSlice(in []string) []any {
	out := make([]any, len(in))
	for i, s := range in {
		out[i] = s
	}
	return out
}

func invalidTimelineDetailField(field string) error {
	return NewError("timeline_detail_invalid", http.StatusUnprocessableEntity, map[string]any{"field": field})
}

func requireDetailText(detail map[string]any, key string) error {
	if strings.TrimSpace(asString(detail[key])) == "" {
		return invalidTimelineDetailField(key)
	}
	return nil
}

func requireEnumDetail(detail map[string]any, key string, allowed map[string]struct{}) error {
	val := strings.TrimSpace(asString(detail[key]))
	if val == "" {
		return invalidTimelineDetailField(key)
	}
	if _, ok := allowed[val]; !ok {
		return invalidTimelineDetailField(key)
	}
	return nil
}

func normalizeOptionalDetailText(detail map[string]any, key string) error {
	v, exists := detail[key]
	if !exists {
		return nil
	}
	str, ok := v.(string)
	if !ok {
		return invalidTimelineDetailField(key)
	}
	trimmed := strings.TrimSpace(str)
	if trimmed == "" {
		delete(detail, key)
	} else {
		detail[key] = trimmed
	}
	return nil
}

func validatePlanSteps(raw any) bool {
	slice, ok := raw.([]any)
	if !ok {
		return false
	}
	validStatuses := map[string]struct{}{"pending": {}, "in_progress": {}, "completed": {}}
	for _, entry := range slice {
		m, ok := entry.(map[string]any)
		if !ok || m == nil {
			return false
		}
		if strings.TrimSpace(asString(m["step"])) == "" {
			return false
		}
		if _, ok := validStatuses[asString(m["status"])]; !ok {
			return false
		}
	}
	return true
}

func isStringSlice(v any) bool {
	switch s := v.(type) {
	case []string:
		return true
	case []any:
		for _, elem := range s {
			if _, ok := elem.(string); !ok {
				return false
			}
		}
		return true
	default:
		return false
	}
}

func isAnySlice(v any) bool {
	switch v.(type) {
	case []any, []map[string]any:
		return true
	default:
		return false
	}
}

func itemToMap(item TimelineItem) map[string]any {
	out := map[string]any{
		"id":        item.ID,
		"kind":      item.Kind,
		"createdAt": item.CreatedAt,
		"status":    item.Status,
		"detail":    CloneMap(item.Detail),
	}
	if item.UpdatedAt != nil {
		out["updatedAt"] = *item.UpdatedAt
	}
	if item.TurnID != "" {
		out["turnId"] = item.TurnID
	}
	if item.Content != nil {
		out["content"] = *item.Content
	}
	return out
}

func itemFromMap(m map[string]any) (TimelineItem, error) {
	if m == nil {
		return TimelineItem{}, ErrInvalid("invalid_timeline_item")
	}
	createdAt, ok := asSafeInt64(m["createdAt"])
	if !ok || createdAt < 0 {
		return TimelineItem{}, ErrInvalid("timeline_created_at_invalid")
	}
	var updatedAt *int64
	if rawUp, exists := m["updatedAt"]; exists && rawUp != nil {
		u, ok := asSafeInt64(rawUp)
		if !ok || u < 0 {
			return TimelineItem{}, ErrInvalid("timeline_updated_at_invalid")
		}
		updatedAt = &u
	}
	var content *string
	if rawContent, exists := m["content"]; exists && rawContent != nil {
		s := asString(rawContent)
		content = &s
	}
	detail, ok := m["detail"].(map[string]any)
	if !ok {
		return TimelineItem{}, NewError("timeline_detail_invalid", http.StatusUnprocessableEntity, nil)
	}
	return TimelineItem{
		ID:        asString(m["id"]),
		Kind:      asString(m["kind"]),
		CreatedAt: createdAt,
		UpdatedAt: updatedAt,
		Status:    asString(m["status"]),
		TurnID:    asString(m["turnId"]),
		Content:   content,
		Detail:    CloneMap(detail),
	}, nil
}

// cloneStructMap 把 JSON 友好的结构体或 map 转成 map[string]any。
func structToMap(v any) map[string]any {
	b, err := json.Marshal(v)
	if err != nil {
		return map[string]any{}
	}
	var out map[string]any
	if err := json.Unmarshal(b, &out); err != nil {
		return map[string]any{}
	}
	if out == nil {
		return map[string]any{}
	}
	return out
}

func mapKeysEqual(a, b map[string]any) bool {
	return maps.EqualFunc(a, b, CanonicalJSONEquals)
}

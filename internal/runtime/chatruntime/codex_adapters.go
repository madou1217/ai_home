package chatruntime

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"
)

// CodexApprovalPolicy 描述三种 AIH 标准审批模式映射到 Codex app-server 的策略参数。
type CodexApprovalPolicy struct {
	ApprovalPolicy    string
	ThreadSandbox     string
	TurnSandboxPolicy map[string]any
}

var codexApprovalPolicies = map[string]CodexApprovalPolicy{
	"bypass": {
		ApprovalPolicy:    "never",
		ThreadSandbox:     "danger-full-access",
		TurnSandboxPolicy: map[string]any{"type": "dangerFullAccess"},
	},
	"confirm": {
		ApprovalPolicy:    "untrusted",
		ThreadSandbox:     "workspace-write",
		TurnSandboxPolicy: map[string]any{"type": "workspaceWrite"},
	},
	"plan": {
		ApprovalPolicy:    "untrusted",
		ThreadSandbox:     "workspace-write",
		TurnSandboxPolicy: map[string]any{"type": "workspaceWrite"},
	},
}

// ResolveCodexApprovalModePolicy 解析 AIH 审批模式到 app-server 参数（未声明值直接失败关闭）。
func ResolveCodexApprovalModePolicy(approvalMode string) (CodexApprovalPolicy, error) {
	mode := strings.ToLower(strings.TrimSpace(approvalMode))
	policy, ok := codexApprovalPolicies[mode]
	if !ok {
		return CodexApprovalPolicy{}, NewError("codex_approval_mode_unsupported", http.StatusUnprocessableEntity, map[string]any{
			"approvalMode": mode,
		})
	}
	return policy, nil
}

// BuildCodexThreadStartParams 构造 thread/start 请求参数。
func BuildCodexThreadStartParams(approvalMode, cwd string, experimentalRawEvents bool) (map[string]any, error) {
	policy, err := ResolveCodexApprovalModePolicy(approvalMode)
	if err != nil {
		return nil, err
	}
	params := map[string]any{
		"approvalPolicy": policy.ApprovalPolicy,
		"sandbox":        policy.ThreadSandbox,
	}
	if clean := strings.TrimSpace(cwd); clean != "" {
		params["cwd"] = clean
	}
	if experimentalRawEvents {
		params["experimentalRawEvents"] = true
	}
	return params, nil
}

// BuildCodexThreadResumeParams 构造 thread/resume 请求参数。
func BuildCodexThreadResumeParams(approvalMode, threadID string, excludeTurns bool) (map[string]any, error) {
	policy, err := ResolveCodexApprovalModePolicy(approvalMode)
	if err != nil {
		return nil, err
	}
	params := map[string]any{
		"threadId":       strings.TrimSpace(threadID),
		"approvalPolicy": policy.ApprovalPolicy,
		"sandbox":        policy.ThreadSandbox,
	}
	if excludeTurns {
		params["excludeTurns"] = true
	}
	return params, nil
}

// BuildCodexTurnStartParams 构造 turn/start 请求参数。
func BuildCodexTurnStartParams(
	approvalMode, threadID, prompt string,
	imagePaths []string,
	clientUserMessageID, model, reasoningEffort string,
) (map[string]any, error) {
	policy, err := ResolveCodexApprovalModePolicy(approvalMode)
	if err != nil {
		return nil, err
	}
	input := []map[string]any{
		{"type": "text", "text": prompt},
	}
	for _, p := range imagePaths {
		if clean := strings.TrimSpace(p); clean != "" {
			input = append(input, map[string]any{
				"type": "localImage",
				"path": clean,
			})
		}
	}
	params := map[string]any{
		"approvalPolicy": policy.ApprovalPolicy,
		"sandboxPolicy":  CloneMap(policy.TurnSandboxPolicy),
		"threadId":       strings.TrimSpace(threadID),
		"input":          input,
	}
	if cleanID := strings.TrimSpace(clientUserMessageID); cleanID != "" {
		params["clientUserMessageId"] = cleanID
	}
	cleanModel := strings.TrimSpace(model)
	if cleanModel != "" {
		params["model"] = cleanModel
	}
	cleanEffort := strings.ToLower(strings.TrimSpace(reasoningEffort))
	if cleanEffort != "" {
		params["effort"] = cleanEffort
	}
	if cleanModel != "" && cleanEffort != "" {
		mode := "default"
		if strings.EqualFold(strings.TrimSpace(approvalMode), "plan") {
			mode = "plan"
		}
		params["collaborationMode"] = map[string]any{
			"mode": mode,
			"settings": map[string]any{
				"model":                  cleanModel,
				"reasoning_effort":       cleanEffort,
				"developer_instructions": nil,
			},
		}
	}
	return params, nil
}

// BuildCodexTurnSteerParams 构造 turn/steer 参数。
func BuildCodexTurnSteerParams(threadID, expectedTurnID, content string) map[string]any {
	return map[string]any{
		"threadId":       strings.TrimSpace(threadID),
		"expectedTurnId": strings.TrimSpace(expectedTurnID),
		"input":          []map[string]any{{"type": "text", "text": content}},
	}
}

// BuildCodexTurnInterruptParams 构造 turn/interrupt 参数。
func BuildCodexTurnInterruptParams(threadID, turnID string) map[string]any {
	return map[string]any{
		"threadId": strings.TrimSpace(threadID),
		"turnId":   strings.TrimSpace(turnID),
	}
}

// ApplyCodexNativeHistoryPolicy 统一追加 persistExtendedHistory 策略开关。
func ApplyCodexNativeHistoryPolicy(params map[string]any) map[string]any {
	out := CloneMap(params)
	out["persistExtendedHistory"] = true
	return out
}

// ApplyCodexChatThreadParams 为 chat 模式附加 read-only 沙箱、baseInstructions 与禁用外部工具参数。
func ApplyCodexChatThreadParams(params map[string]any, sess *Session, systemPrompt string) map[string]any {
	out := CloneMap(params)
	if !IsChatSession(sess) {
		return out
	}
	out["approvalPolicy"] = "never"
	out["sandbox"] = "read-only"
	out["baseInstructions"] = ChatInstructions
	if cleanSys := strings.TrimSpace(systemPrompt); cleanSys != "" {
		out["developerInstructions"] = cleanSys
	}
	out["config"] = map[string]any{
		"features.shell_tool":           false,
		"features.unified_exec":         false,
		"features.apply_patch_freeform": false,
		"features.web_search":           false,
		"features.mcp":                  false,
		"features.collab":               false,
		"features.skills":               false,
		"features.personality":          false,
		"mcp_servers":                   map[string]any{},
	}
	return out
}

// ApplyCodexChatTurnParams 为 chat 模式覆写 turn 级 readOnly 沙箱策略。
func ApplyCodexChatTurnParams(params map[string]any, sess *Session) map[string]any {
	out := CloneMap(params)
	if !IsChatSession(sess) {
		return out
	}
	out["approvalPolicy"] = "never"
	out["sandboxPolicy"] = map[string]any{"type": "readOnly"}
	return out
}

var codexItemKindMap = map[string]string{
	"userMessage":         "message",
	"agentMessage":        "message",
	"reasoning":           "reasoning",
	"plan":                "plan",
	"commandExecution":    "shell",
	"fileChange":          "file_change",
	"mcpToolCall":         "tool",
	"dynamicToolCall":     "tool",
	"webSearch":           "tool",
	"imageView":           "tool",
	"sleep":               "tool",
	"imageGeneration":     "tool",
	"collabAgentToolCall": "subagent",
	"subAgentActivity":    "subagent",
	"hookPrompt":          "notice",
	"enteredReviewMode":   "notice",
	"exitedReviewMode":    "notice",
	"contextCompaction":   "notice",
	"error":               "error",
}

func joinedChangeDiff(changes []any) string {
	parts := make([]string, 0, len(changes))
	for _, entry := range changes {
		if m, ok := entry.(map[string]any); ok {
			if diff, okStr := m["diff"].(string); okStr && diff != "" {
				parts = append(parts, diff)
			}
		}
	}
	return strings.Join(parts, "\n")
}

// BuildCodexTimelineItem 把 Codex app-server 的 thread item 投影为 Canonical TimelineItem map。
func BuildCodexTimelineItem(item map[string]any, params map[string]any, completed bool) map[string]any {
	rawType := asString(item["type"])
	kind, ok := codexItemKindMap[rawType]
	if !ok {
		kind = "error"
	}
	var at int64
	if completed {
		if n, okTs := coerceInt64(params["completedAtMs"]); okTs && n >= 0 {
			at = n
		}
	} else {
		if n, okTs := coerceInt64(params["startedAtMs"]); okTs && n >= 0 {
			at = n
		}
	}

	userMsgContent := ""
	var userInputs []map[string]any
	if rawType == "userMessage" {
		userMsgContent, userInputs = projectCodexUserMessage(item["content"])
	}

	status := "running"
	if kind == "error" {
		status = "failed"
	} else {
		switch asString(item["status"]) {
		case "inProgress":
			status = "running"
		case "completed":
			status = "completed"
		case "failed":
			status = "failed"
		case "declined":
			status = "cancelled"
		default:
			if completed {
				status = "completed"
			}
		}
	}

	result := map[string]any{
		"id":        asString(item["id"]),
		"kind":      kind,
		"createdAt": at,
		"status":    status,
		"detail":    codexItemDetail(item, kind, completed, userInputs, params),
	}
	if content, has := codexItemContent(item, kind, userMsgContent); has {
		result["content"] = content
	}
	if completed {
		result["updatedAt"] = at
	}
	return CompactTimelineItem(result)
}

func codexItemDetail(item map[string]any, kind string, completed bool, userInputs []map[string]any, params map[string]any) map[string]any {
	switch kind {
	case "message":
		detail := map[string]any{
			"role": "assistant",
		}
		if asString(item["type"]) == "userMessage" {
			detail["role"] = "user"
		}
		if phase, ok := item["phase"].(string); ok && phase != "" {
			detail["phase"] = phase
		}
		if model := asString(params["model"]); model != "" {
			detail["model"] = model
		}
		if len(userInputs) > 0 {
			detail["inputs"] = userInputs
		}
		return detail
	case "reasoning":
		detail := map[string]any{}
		if sum := textSegments(item["summary"]); len(sum) > 0 {
			detail["summary"] = strings.Join(sum, "\n")
		}
		if segs := textSegments(item["content"]); len(segs) > 0 {
			detail["segments"] = segs
		}
		return detail
	case "plan":
		state := "draft"
		if completed {
			state = "proposed"
		}
		return map[string]any{
			"state": state,
			"steps": cloneSliceValue(item["steps"]),
		}
	case "shell":
		detail := map[string]any{
			"callId":  item["id"],
			"command": asString(item["command"]),
		}
		if cwd := item["cwd"]; cwd != nil {
			detail["cwd"] = cwd
		}
		if out := item["aggregatedOutput"]; out != nil {
			detail["output"] = out
		} else if out := item["output"]; out != nil {
			detail["output"] = out
		}
		if ec := item["exitCode"]; ec != nil {
			detail["exitCode"] = ec
		}
		if pid := item["processId"]; pid != nil {
			detail["processId"] = pid
		}
		if acts := item["commandActions"]; acts != nil {
			detail["actions"] = acts
		}
		return detail
	case "tool":
		callID := item["callId"]
		if callID == nil || asString(callID) == "" {
			callID = item["id"]
		}
		name := asString(item["tool"])
		if name == "" {
			name = asString(item["type"])
		}
		input := firstNonNil(item["arguments"], item["input"], item["query"], item["path"])
		result := firstNonNil(item["result"], item["contentItems"], item["error"])
		detail := map[string]any{
			"callId": callID,
			"name":   name,
			"input":  input,
			"result": result,
		}
		if srv := item["server"]; srv != nil {
			detail["server"] = srv
		}
		if ec := item["exitCode"]; ec != nil {
			detail["exitCode"] = ec
		}
		return detail
	case "subagent":
		agentID := firstNonNil(item["agentId"], item["id"])
		return map[string]any{
			"agentId": agentID,
			"state":   item["status"],
		}
	case "notice":
		return map[string]any{
			"level": "info",
			"code":  asString(item["type"]),
		}
	case "file_change":
		changes, _ := item["changes"].([]any)
		if changes == nil {
			changes = []any{}
		}
		return map[string]any{
			"callId":  item["id"],
			"changes": changes,
			"diff":    joinedChangeDiff(changes),
		}
	default:
		code := asString(item["code"])
		if code == "" {
			code = "codex_item_error"
		}
		return map[string]any{
			"code":      code,
			"retryable": false,
		}
	}
}

func codexItemContent(item map[string]any, kind, userMsgContent string) (string, bool) {
	switch kind {
	case "message":
		if asString(item["type"]) == "userMessage" {
			return userMsgContent, true
		}
		return asString(item["text"]), true
	case "plan":
		return asString(item["text"]), true
	case "reasoning":
		parts := append(textSegments(item["summary"]), textSegments(item["content"])...)
		return strings.Join(parts, "\n"), true
	case "shell":
		if out, ok := item["aggregatedOutput"].(string); ok {
			return out, true
		}
		return "", false
	case "file_change":
		changes, _ := item["changes"].([]any)
		return joinedChangeDiff(changes), true
	case "notice":
		if asString(item["type"]) == "contextCompaction" {
			return "Context compacted", true
		}
		msg := asString(item["message"])
		if msg == "" {
			msg = asString(item["text"])
		}
		return msg, true
	case "error":
		msg := asString(item["message"])
		if msg == "" {
			msg = "unknown_codex_item_type"
		}
		return msg, true
	default:
		return "", false
	}
}

func projectCodexUserMessage(raw any) (string, []map[string]any) {
	arr, ok := raw.([]any)
	if !ok {
		return "", nil
	}
	texts := make([]string, 0, len(arr))
	inputs := make([]map[string]any, 0, len(arr))
	for _, entry := range arr {
		m, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		switch asString(m["type"]) {
		case "text":
			if t, ok := m["text"].(string); ok && t != "" {
				texts = append(texts, t)
			}
		case "image", "localImage":
			inputs = append(inputs, map[string]any{"kind": "image"})
		case "skill", "mention":
			if name := strings.TrimSpace(asString(m["name"])); name != "" {
				inputs = append(inputs, map[string]any{
					"kind": asString(m["type"]),
					"name": name,
				})
			}
		}
	}
	return strings.Join(texts, "\n"), inputs
}

func textSegments(raw any) []string {
	if raw == nil {
		return nil
	}
	var values []any
	switch v := raw.(type) {
	case []any:
		values = v
	default:
		values = []any{v}
	}
	out := make([]string, 0, len(values))
	for _, entry := range values {
		switch e := entry.(type) {
		case map[string]any:
			if t := asString(e["text"]); t != "" {
				out = append(out, t)
			}
		default:
			if t := asString(e); t != "" {
				out = append(out, t)
			}
		}
	}
	return out
}

func cloneSliceValue(raw any) any {
	if raw == nil {
		return []any{}
	}
	return raw
}

func firstNonNil(vals ...any) any {
	for _, v := range vals {
		if v != nil {
			return v
		}
	}
	return nil
}

// CodexInteractionEnvelope 保存挂起的 Codex 原生交互请求私密上下文以便回写答案。
type CodexInteractionEnvelope struct {
	Method          string
	NativeRequest   map[string]any
	NativeThreadID  string
	Provider        string
	RequestID       any
	SessionID       string
	ChoiceResponses map[string]map[string]any
}

// CodexMappedMessage 表示一次 app-server 消息映射结果。
type CodexMappedMessage struct {
	Classification string // "" | "known_noop"
	Type           string
	Method         string
	TurnID         string
	ItemID         string
	Payload        map[string]any
	Envelope       *CodexInteractionEnvelope
}

var codexKnownNoopMethods = map[string]struct{}{
	"mcpServer/startupStatus/updated": {},
	"thread/settings/updated":         {},
	"thread/status/changed":           {},
	"thread/tokenUsage/updated":       {},
	"item/reasoning/summaryPartAdded": {},
	"rawResponseItem/completed":       {},
	"rawResponse/completed":           {},
}

// MapCodexAppServerMessage 把 Codex app-server 通知或请求映射为 Canonical 事件意图。
func MapCodexAppServerMessage(msg CodexJSONRPCMessage, sessionID string, onUnknownNotification func(string)) CodexMappedMessage {
	method := strings.TrimSpace(msg.Method)
	params := msg.Params
	if params == nil {
		params = map[string]any{}
	}

	switch method {
	case "thread/tokenUsage/updated":
		return mapCodexTokenUsage(params)
	case "thread/goal/updated":
		return mapCodexGoalUpdated(params)
	case "thread/goal/cleared":
		return mapCodexGoalCleared(params)
	case "turn/started":
		return mapCodexTurnStarted(params)
	case "turn/completed":
		return mapCodexTurnCompleted(params)
	case "turn/diff/updated":
		return mapCodexTurnDiff(params)
	case "thread/compacted":
		return mapCodexContextCompacted(params)
	case "turn/plan/updated":
		return mapCodexPlanUpdate(params)
	case "hook/started":
		return mapCodexHookNotification(params, false)
	case "hook/completed":
		return mapCodexHookNotification(params, true)
	case "item/agentMessage/delta":
		return mapCodexDelta(params, "", "")
	case "item/reasoning/summaryTextDelta":
		return mapCodexDelta(params, "summary", "summaryIndex")
	case "item/reasoning/textDelta":
		return mapCodexDelta(params, "content", "contentIndex")
	case "item/plan/delta":
		return mapCodexDelta(params, "plan", "")
	case "item/commandExecution/outputDelta":
		return mapCodexDelta(params, "output", "")
	case "item/fileChange/outputDelta":
		return mapCodexDelta(params, "diff", "")
	case "item/mcpToolCall/progress":
		return mapCodexMcpProgress(params)
	case "item/started":
		return mapCodexItemLifecycle(false, params)
	case "item/completed":
		return mapCodexItemLifecycle(true, params)
	case "item/commandExecution/requestApproval",
		"item/fileChange/requestApproval",
		"item/permissions/requestApproval",
		"item/tool/requestUserInput",
		"mcpServer/elicitation/request":
		mapped, err := mapCodexInteractionRequest(msg.ID, method, params, sessionID)
		if err != nil {
			if rtErr, ok := AsRuntimeError(err); ok && rtErr.Code != "" {
				code := rtErr.Code
				if code == "native_interaction_identity_incomplete" {
					code = "invalid_codex_interaction_identity"
				}
				return codexStreamError(code, params)
			}
			return codexStreamError("invalid_codex_interaction_request", params)
		}
		return mapped
	case "serverRequest/resolved":
		interactionID, err := NativeInteractionID("codex", sessionID, asString(params["threadId"]), asString(params["requestId"]))
		if err != nil {
			return codexStreamError("invalid_codex_interaction_identity", params)
		}
		return CodexMappedMessage{
			Type:    "interaction.resolved",
			Payload: map[string]any{"interactionId": interactionID},
		}
	case "warning":
		return mapCodexWarningNotification(params)
	case "error":
		return codexStreamError("codex_app_server_error", params)
	}

	if _, ok := codexKnownNoopMethods[method]; ok && msg.ID == nil {
		return CodexMappedMessage{Classification: "known_noop", Method: method, Payload: map[string]any{}}
	}
	if msg.ID == nil {
		if onUnknownNotification != nil {
			onUnknownNotification(SanitizeDiagnosticText(method, 128))
		}
		return CodexMappedMessage{Classification: "known_noop", Method: method, Payload: map[string]any{}}
	}
	return codexStreamError("unsupported_codex_app_server_method", params)
}

func codexStreamError(code string, params map[string]any) CodexMappedMessage {
	nativeErr, _ := params["error"].(map[string]any)
	upstreamMsg := ""
	if code == "codex_app_server_error" {
		upstreamMsg = strings.TrimSpace(asString(nativeErr["message"]))
		if upstreamMsg == "" {
			upstreamMsg = strings.TrimSpace(asString(params["message"]))
		}
	}
	defaultMessages := map[string]string{
		"invalid_codex_plan_update":           "Invalid Codex plan update",
		"unsupported_codex_app_server_method": "Unsupported Codex app-server event",
		"invalid_codex_runtime_notification":  "Invalid Codex runtime notification",
		"invalid_codex_timeline_notification": "Invalid Codex timeline notification",
	}
	safeCode := SanitizeDiagnosticCode(code, "codex_app_server_error")
	rawMsg := upstreamMsg
	if rawMsg == "" {
		if m, ok := defaultMessages[safeCode]; ok {
			rawMsg = m
		} else {
			rawMsg = "Codex app-server request could not be adapted"
		}
	}
	willRetry, _ := params["willRetry"].(bool)
	return CodexMappedMessage{
		Type: "stream.error",
		Payload: map[string]any{
			"error":     safeCode,
			"message":   SanitizeDiagnosticText(rawMsg, 512),
			"retryable": code == "codex_app_server_error" && willRetry,
		},
	}
}

func mapCodexTokenUsage(params map[string]any) CodexMappedMessage {
	usage, _ := params["tokenUsage"].(map[string]any)
	last, _ := usage["last"].(map[string]any)
	turnID := strings.TrimSpace(asString(params["turnId"]))
	if turnID == "" || last == nil {
		return CodexMappedMessage{Classification: "known_noop", Method: "thread/tokenUsage/updated", Payload: map[string]any{}}
	}
	metrics := map[string]any{}
	for _, f := range []string{"inputTokens", "outputTokens"} {
		if n, ok := coerceInt64(last[f]); ok && n >= 0 {
			metrics[f] = n
		}
	}
	if n, ok := coerceInt64(last["totalTokens"]); ok && n >= 0 {
		metrics["contextTokens"] = n
	}
	if n, ok := coerceInt64(usage["modelContextWindow"]); ok && n > 0 {
		metrics["contextWindow"] = n
	}
	totals := map[string]any{}
	if totalMap, ok := usage["total"].(map[string]any); ok {
		for _, f := range []string{"inputTokens", "outputTokens"} {
			if n, ok := coerceInt64(totalMap[f]); ok && n >= 0 {
				totals[f] = n
			}
		}
	}
	return CodexMappedMessage{
		Type:    "turn.metrics.updated",
		TurnID:  turnID,
		Payload: map[string]any{"metrics": metrics, "totals": totals},
	}
}

func mapCodexGoalUpdated(params map[string]any) CodexMappedMessage {
	goalRaw, _ := params["goal"].(map[string]any)
	threadID := asString(goalRaw["threadId"])
	if threadID == "" {
		threadID = asString(params["threadId"])
	}
	var tokenBudget any = nil
	if goalRaw["tokenBudget"] != nil {
		if n, ok := coerceInt64(goalRaw["tokenBudget"]); ok {
			tokenBudget = n
		}
	}
	tokensUsed, _ := coerceInt64(goalRaw["tokensUsed"])
	timeUsed, _ := coerceInt64(goalRaw["timeUsedSeconds"])
	createdAt, _ := coerceInt64(goalRaw["createdAt"])
	updatedAt, _ := coerceInt64(goalRaw["updatedAt"])
	return CodexMappedMessage{
		Type:   "session.goal.updated",
		TurnID: asString(params["turnId"]),
		Payload: map[string]any{
			"goal": map[string]any{
				"threadId":        threadID,
				"objective":       asString(goalRaw["objective"]),
				"status":          asString(goalRaw["status"]),
				"tokenBudget":     tokenBudget,
				"tokensUsed":      tokensUsed,
				"timeUsedSeconds": timeUsed,
				"createdAt":       createdAt,
				"updatedAt":       updatedAt,
			},
		},
	}
}

func mapCodexGoalCleared(params map[string]any) CodexMappedMessage {
	payload := map[string]any{}
	if tid := strings.TrimSpace(asString(params["threadId"])); tid != "" {
		payload["goalId"] = tid
	}
	return CodexMappedMessage{Type: "session.goal.cleared", Payload: payload}
}

func mapCodexTurnStarted(params map[string]any) CodexMappedMessage {
	turn, _ := params["turn"].(map[string]any)
	turnID := asString(turn["id"])
	status := asString(turn["status"])
	if status == "" {
		status = "inProgress"
	}
	return CodexMappedMessage{
		Type:   "turn.started",
		TurnID: turnID,
		Payload: map[string]any{
			"threadId":  params["threadId"],
			"status":    status,
			"startedAt": turn["startedAt"],
		},
	}
}

func mapCodexTurnCompleted(params map[string]any) CodexMappedMessage {
	turn, _ := params["turn"].(map[string]any)
	turnID := asString(turn["id"])
	status := asString(turn["status"])
	evType := "turn.failed"
	switch status {
	case "completed":
		evType = "turn.completed"
	case "interrupted":
		evType = "turn.interrupted"
	}
	payload := map[string]any{
		"threadId":    params["threadId"],
		"status":      status,
		"startedAt":   turn["startedAt"],
		"completedAt": turn["completedAt"],
		"durationMs":  turn["durationMs"],
	}
	if errVal, exists := turn["error"]; exists {
		if errVal == nil {
			payload["error"] = nil
		} else {
			diag := SanitizeCanonicalDiagnostic(errVal, DiagnosticOptions{FallbackCode: "codex_turn_failed"})
			payload["error"] = DiagnosticMap(diag, false)
		}
	}
	return CodexMappedMessage{Type: evType, TurnID: turnID, Payload: payload}
}

func mapCodexContextCompacted(params map[string]any) CodexMappedMessage {
	turnID := asString(params["turnId"])
	itemID := "codex-compaction:" + turnID
	return CodexMappedMessage{
		Type:   "timeline.item.completed",
		TurnID: turnID,
		ItemID: itemID,
		Payload: map[string]any{
			"item": map[string]any{
				"id":        itemID,
				"turnId":    turnID,
				"kind":      "notice",
				"createdAt": int64(0),
				"updatedAt": int64(0),
				"status":    "completed",
				"content":   "Context compacted",
				"detail":    map[string]any{"level": "success", "code": "context_compacted"},
			},
		},
	}
}

func mapCodexPlanUpdate(params map[string]any) CodexMappedMessage {
	turnID := strings.TrimSpace(asString(params["turnId"]))
	rawSteps, ok := params["plan"].([]any)
	if turnID == "" || !ok {
		return codexStreamError("invalid_codex_plan_update", params)
	}
	statusMap := map[string]string{
		"pending":    "pending",
		"inProgress": "in_progress",
		"completed":  "completed",
	}
	steps := make([]map[string]any, 0, len(rawSteps))
	allCompleted := len(rawSteps) > 0
	for _, entry := range rawSteps {
		m, okM := entry.(map[string]any)
		if !okM {
			return codexStreamError("invalid_codex_plan_update", params)
		}
		stepText := strings.TrimSpace(asString(m["step"]))
		st, okSt := statusMap[asString(m["status"])]
		if stepText == "" || !okSt {
			return codexStreamError("invalid_codex_plan_update", params)
		}
		if st != "completed" {
			allCompleted = false
		}
		steps = append(steps, map[string]any{"step": stepText, "status": st})
	}
	itemID := "codex-plan:" + turnID
	explanation := strings.TrimSpace(asString(params["explanation"]))
	updatedAt, _ := coerceInt64(params["updatedAtMs"])
	detail := map[string]any{"steps": steps}
	if explanation != "" {
		detail["explanation"] = explanation
	}
	itemStatus := "running"
	if allCompleted {
		itemStatus = "completed"
	}
	item := map[string]any{
		"id":        itemID,
		"turnId":    turnID,
		"kind":      "plan",
		"createdAt": updatedAt,
		"updatedAt": updatedAt,
		"status":    itemStatus,
		"detail":    detail,
	}
	if explanation != "" {
		item["content"] = explanation
	}
	return CodexMappedMessage{
		Type:    "timeline.item.updated",
		TurnID:  turnID,
		ItemID:  itemID,
		Payload: map[string]any{"item": item},
	}
}

func mapCodexTurnDiff(params map[string]any) CodexMappedMessage {
	turnID := strings.TrimSpace(asString(params["turnId"]))
	diffStr, ok := params["diff"].(string)
	if turnID == "" || !ok {
		return codexStreamError("invalid_codex_timeline_notification", params)
	}
	itemID := "codex-diff:" + turnID
	return CodexMappedMessage{
		Type:   "timeline.item.updated",
		TurnID: turnID,
		ItemID: itemID,
		Payload: map[string]any{
			"item": map[string]any{
				"id":        itemID,
				"turnId":    turnID,
				"kind":      "diff",
				"createdAt": int64(0),
				"updatedAt": int64(0),
				"status":    "completed",
				"detail":    map[string]any{"patch": diffStr},
			},
		},
	}
}

func mapCodexMcpProgress(params map[string]any) CodexMappedMessage {
	turnID := strings.TrimSpace(asString(params["turnId"]))
	itemID := strings.TrimSpace(asString(params["itemId"]))
	msg, ok := params["message"].(string)
	if turnID == "" || itemID == "" || !ok {
		return codexStreamError("invalid_codex_timeline_notification", params)
	}
	return CodexMappedMessage{
		Type:   "timeline.item.delta",
		TurnID: turnID,
		ItemID: itemID,
		Payload: map[string]any{
			"itemId": itemID,
			"chunk":  msg,
			"detail": map[string]any{"channel": "progress"},
		},
	}
}

func mapCodexHookNotification(params map[string]any, completed bool) CodexMappedMessage {
	run, _ := params["run"].(map[string]any)
	itemID := strings.TrimSpace(asString(run["id"]))
	eventName := strings.TrimSpace(asString(run["eventName"]))
	if itemID == "" || eventName == "" {
		return codexStreamError("invalid_codex_runtime_notification", params)
	}
	hookStatuses := map[string]string{
		"blocked":   "failed",
		"completed": "completed",
		"failed":    "failed",
		"running":   "running",
		"stopped":   "cancelled",
	}
	status := hookStatuses[strings.TrimSpace(asString(run["status"]))]
	if status == "" {
		if completed {
			status = "completed"
		} else {
			status = "running"
		}
	}
	content := strings.TrimSpace(asString(run["statusMessage"]))
	if content == "" {
		content = eventName + " hook"
	}
	startedAt, _ := coerceInt64(run["startedAt"])
	detailInput := map[string]any{}
	for _, k := range []string{"executionMode", "handlerType", "scope", "sourcePath"} {
		if v := strings.TrimSpace(asString(run[k])); v != "" {
			detailInput[k] = v
		}
	}
	detail := map[string]any{
		"callId": itemID,
		"name":   "Hook: " + eventName,
		"input":  detailInput,
	}
	if completed {
		resMap := map[string]any{"status": status}
		if dm, ok := coerceInt64(run["durationMs"]); ok {
			resMap["durationMs"] = dm
		}
		detail["result"] = resMap
	}
	item := map[string]any{
		"id":        itemID,
		"kind":      "tool",
		"createdAt": startedAt,
		"status":    status,
		"content":   content,
		"detail":    detail,
	}
	if completed {
		completedAt, _ := coerceInt64(run["completedAt"])
		if completedAt <= 0 {
			completedAt = startedAt
		}
		item["updatedAt"] = completedAt
	}
	turnID := strings.TrimSpace(asString(params["turnId"]))
	if turnID != "" {
		item["turnId"] = turnID
	}
	evType := "timeline.item.started"
	if completed {
		evType = "timeline.item.completed"
	}
	return CodexMappedMessage{
		Type:    evType,
		TurnID:  turnID,
		ItemID:  itemID,
		Payload: map[string]any{"item": item},
	}
}

func mapCodexWarningNotification(params map[string]any) CodexMappedMessage {
	msg := strings.TrimSpace(asString(params["message"]))
	if msg == "" {
		return codexStreamError("invalid_codex_runtime_notification", params)
	}
	sum := sha256.Sum256([]byte(asString(params["threadId"]) + "\x00" + msg))
	itemID := "codex-warning:" + hex.EncodeToString(sum[:])[:24]
	return CodexMappedMessage{
		Type:   "timeline.item.completed",
		ItemID: itemID,
		Payload: map[string]any{
			"item": map[string]any{
				"id":        itemID,
				"kind":      "notice",
				"createdAt": int64(0),
				"updatedAt": int64(0),
				"status":    "completed",
				"content":   msg,
				"detail":    map[string]any{"code": "codex_warning", "level": "warning"},
			},
		},
	}
}

func mapCodexDelta(params map[string]any, channel, indexField string) CodexMappedMessage {
	itemID := asString(params["itemId"])
	payload := map[string]any{
		"itemId": itemID,
		"chunk":  asString(params["delta"]),
	}
	if channel != "" {
		detail := map[string]any{"channel": channel}
		if indexField != "" && params[indexField] != nil {
			detail["index"] = params[indexField]
		}
		payload["detail"] = detail
	}
	return CodexMappedMessage{
		Type:    "timeline.item.delta",
		TurnID:  asString(params["turnId"]),
		ItemID:  itemID,
		Payload: payload,
	}
}

func mapCodexItemLifecycle(completed bool, params map[string]any) CodexMappedMessage {
	rawItem, _ := params["item"].(map[string]any)
	itemID := asString(rawItem["id"])
	if itemID == "" {
		return codexStreamError("invalid_codex_app_server_item", params)
	}
	item := BuildCodexTimelineItem(rawItem, params, completed)
	turnID := strings.TrimSpace(asString(params["turnId"]))
	if turnID != "" {
		item["turnId"] = turnID
	}
	evType := "timeline.item.started"
	if completed {
		evType = "timeline.item.completed"
	}
	return CodexMappedMessage{
		Type:    evType,
		TurnID:  turnID,
		ItemID:  itemID,
		Payload: map[string]any{"item": item},
	}
}

func mapCodexInteractionRequest(requestID any, method string, params map[string]any, sessionID string) (CodexMappedMessage, error) {
	if requestID == nil {
		return CodexMappedMessage{}, NewError("invalid_codex_interaction_request_id", http.StatusUnprocessableEntity, nil)
	}
	reqIDStr := fmt.Sprintf("%v", requestID)
	threadID := strings.TrimSpace(asString(params["threadId"]))
	if threadID == "" {
		return CodexMappedMessage{}, NewError("invalid_codex_interaction_thread", http.StatusUnprocessableEntity, nil)
	}
	if strings.TrimSpace(sessionID) == "" {
		return CodexMappedMessage{}, NewError("invalid_codex_interaction_session", http.StatusUnprocessableEntity, nil)
	}
	interactionID, err := NativeInteractionID("codex", sessionID, threadID, reqIDStr)
	if err != nil {
		return CodexMappedMessage{}, err
	}

	var kind, itemID string
	var rawPayload map[string]any
	var choiceResponses map[string]map[string]any

	switch method {
	case "item/commandExecution/requestApproval":
		kind, itemID, rawPayload, choiceResponses, err = adaptCodexCommandApproval(params)
	case "item/fileChange/requestApproval":
		kind, itemID, rawPayload, choiceResponses, err = adaptCodexFileApproval(params)
	case "item/permissions/requestApproval":
		kind, itemID, rawPayload, choiceResponses, err = adaptCodexPermissionsApproval(params)
	case "item/tool/requestUserInput":
		kind, itemID, rawPayload, err = adaptCodexToolQuestion(params)
	case "mcpServer/elicitation/request":
		kind, itemID, rawPayload, err = adaptCodexMCPElicitation(params)
	default:
		return CodexMappedMessage{}, NewError("unsupported_codex_interaction_method", http.StatusUnprocessableEntity, nil)
	}
	if err != nil {
		return CodexMappedMessage{}, err
	}
	if itemID == "" {
		itemID = strings.TrimSpace(asString(params["itemId"]))
	}
	if itemID == "" {
		itemID = interactionID
	}
	normPayload, err := NormalizeCanonicalInteractionPayload(kind, rawPayload)
	if err != nil {
		return CodexMappedMessage{}, err
	}
	interaction := map[string]any{
		"interactionId": interactionID,
		"kind":          kind,
		"revision":      1,
		"state":         "pending",
		"itemId":        itemID,
		"payload":       normPayload,
	}
	env := &CodexInteractionEnvelope{
		Method:          method,
		NativeRequest:   CloneMap(params),
		NativeThreadID:  threadID,
		Provider:        "codex",
		RequestID:       requestID,
		SessionID:       sessionID,
		ChoiceResponses: choiceResponses,
	}
	return CodexMappedMessage{
		Type:     "interaction.requested",
		TurnID:   asString(params["turnId"]),
		ItemID:   itemID,
		Payload:  map[string]any{"interaction": interaction},
		Envelope: env,
	}, nil
}

func adaptCodexCommandApproval(params map[string]any) (string, string, map[string]any, map[string]map[string]any, error) {
	itemID := strings.TrimSpace(asString(params["itemId"]))
	if itemID == "" {
		return "", "", nil, nil, NewError("invalid_codex_interaction_item", http.StatusUnprocessableEntity, nil)
	}
	avail, ok := params["availableDecisions"].([]any)
	if !ok || len(avail) == 0 {
		return "", "", nil, nil, NewError("invalid_codex_command_decisions", http.StatusUnprocessableEntity, nil)
	}
	choices := make([]map[string]any, 0, len(avail))
	responses := make(map[string]map[string]any, len(avail))
	basic := map[string][2]string{
		"accept":           {"Allow once", "accept"},
		"acceptForSession": {"Allow for this session", "accept"},
		"decline":          {"Decline and continue", "deny"},
		"cancel":           {"Decline and cancel turn", "cancel"},
	}
	for idx, dec := range avail {
		id := "choice-" + strconv.Itoa(idx)
		switch d := dec.(type) {
		case string:
			meta, okMeta := basic[d]
			if !okMeta {
				return "", "", nil, nil, NewError("unsupported_codex_command_decision", http.StatusUnprocessableEntity, nil)
			}
			choices = append(choices, map[string]any{"id": id, "label": meta[0], "intent": meta[1]})
			responses[id] = map[string]any{"decision": d}
		case map[string]any:
			if ep, okEP := d["acceptWithExecpolicyAmendment"].(map[string]any); okEP {
				prefix := toNonEmptyStringSlice(ep["execpolicy_amendment"])
				if len(prefix) == 0 {
					return "", "", nil, nil, NewError("invalid_codex_execpolicy_decision", http.StatusUnprocessableEntity, nil)
				}
				choices = append(choices, map[string]any{
					"id":          id,
					"label":       "Allow and remember command prefix",
					"description": "Command prefix: " + strings.Join(prefix, " "),
					"intent":      "accept",
				})
				responses[id] = map[string]any{"decision": CloneMap(d)}
				continue
			}
			if np, okNP := d["applyNetworkPolicyAmendment"].(map[string]any); okNP {
				amend, _ := np["network_policy_amendment"].(map[string]any)
				host := strings.TrimSpace(asString(amend["host"]))
				act := strings.TrimSpace(asString(amend["action"]))
				if host == "" || (act != "allow" && act != "deny") {
					return "", "", nil, nil, NewError("invalid_codex_network_policy_decision", http.StatusUnprocessableEntity, nil)
				}
				labelPrefix, intent := "Allow", "accept"
				if act == "deny" {
					labelPrefix, intent = "Deny", "deny"
				}
				choices = append(choices, map[string]any{
					"id":          id,
					"label":       labelPrefix + " and remember network policy",
					"description": labelPrefix + " " + host,
					"intent":      intent,
				})
				responses[id] = map[string]any{"decision": CloneMap(d)}
				continue
			}
			return "", "", nil, nil, NewError("unsupported_codex_command_decision", http.StatusUnprocessableEntity, nil)
		default:
			return "", "", nil, nil, NewError("unsupported_codex_command_decision", http.StatusUnprocessableEntity, nil)
		}
	}
	pres := buildCodexPresentation("Run command?", asString(params["reason"]), firstNonEmptyStr(asString(params["command"]), "Command details unavailable"),
		[][2]string{{"Working directory", asString(params["cwd"])}, {"Environment", asString(params["environmentId"])}})
	return "approval", itemID, map[string]any{"presentation": pres, "choices": choices}, responses, nil
}

func adaptCodexFileApproval(params map[string]any) (string, string, map[string]any, map[string]map[string]any, error) {
	itemID := strings.TrimSpace(asString(params["itemId"]))
	if itemID == "" {
		return "", "", nil, nil, NewError("invalid_codex_interaction_item", http.StatusUnprocessableEntity, nil)
	}
	choices := []map[string]any{
		{"id": "choice-0", "label": "Allow once", "intent": "accept"},
		{"id": "choice-1", "label": "Allow for this session", "intent": "accept"},
		{"id": "choice-2", "label": "Decline and continue", "intent": "deny"},
		{"id": "choice-3", "label": "Decline and cancel turn", "intent": "cancel"},
	}
	responses := map[string]map[string]any{
		"choice-0": {"decision": "accept"},
		"choice-1": {"decision": "acceptForSession"},
		"choice-2": {"decision": "decline"},
		"choice-3": {"decision": "cancel"},
	}
	pres := buildCodexPresentation("Apply file changes?", asString(params["reason"]), "",
		[][2]string{{"Requested root", asString(params["grantRoot"])}})
	return "approval", itemID, map[string]any{"presentation": pres, "choices": choices}, responses, nil
}

func adaptCodexPermissionsApproval(params map[string]any) (string, string, map[string]any, map[string]map[string]any, error) {
	itemID := strings.TrimSpace(asString(params["itemId"]))
	if itemID == "" {
		return "", "", nil, nil, NewError("invalid_codex_interaction_item", http.StatusUnprocessableEntity, nil)
	}
	perms, ok := params["permissions"].(map[string]any)
	if !ok {
		return "", "", nil, nil, NewError("invalid_codex_permissions_request", http.StatusUnprocessableEntity, nil)
	}
	pretty, _ := json.MarshalIndent(perms, "", "  ")
	choices := []map[string]any{
		{"id": "choice-0", "label": "Grant for this turn", "intent": "accept"},
		{"id": "choice-1", "label": "Grant for this turn with strict review", "intent": "accept"},
		{"id": "choice-2", "label": "Grant for this session", "intent": "accept"},
		{"id": "choice-3", "label": "Do not grant permissions", "intent": "deny"},
	}
	responses := map[string]map[string]any{
		"choice-0": {"permissions": CloneMap(perms), "scope": "turn"},
		"choice-1": {"permissions": CloneMap(perms), "scope": "turn", "strictAutoReview": true},
		"choice-2": {"permissions": CloneMap(perms), "scope": "session"},
		"choice-3": {"permissions": map[string]any{}, "scope": "turn"},
	}
	pres := buildCodexPresentation("Grant permissions?", asString(params["reason"]), string(pretty),
		[][2]string{{"Working directory", asString(params["cwd"])}, {"Environment", asString(params["environmentId"])}})
	return "approval", itemID, map[string]any{"presentation": pres, "choices": choices}, responses, nil
}

func adaptCodexToolQuestion(params map[string]any) (string, string, map[string]any, error) {
	itemID := strings.TrimSpace(asString(params["itemId"]))
	if itemID == "" {
		return "", "", nil, NewError("invalid_codex_interaction_item", http.StatusUnprocessableEntity, nil)
	}
	questionsRaw, ok := params["questions"].([]any)
	if !ok || len(questionsRaw) == 0 {
		return "", "", nil, NewError("invalid_codex_tool_question", http.StatusUnprocessableEntity, nil)
	}
	fields := make([]map[string]any, 0, len(questionsRaw))
	seen := make(map[string]struct{}, len(questionsRaw))
	for _, entry := range questionsRaw {
		q, okQ := entry.(map[string]any)
		if !okQ {
			return "", "", nil, NewError("invalid_codex_tool_question", http.StatusUnprocessableEntity, nil)
		}
		id := strings.TrimSpace(asString(q["id"]))
		label := strings.TrimSpace(asString(q["question"]))
		if id == "" || label == "" {
			return "", "", nil, NewError("invalid_codex_tool_question", http.StatusUnprocessableEntity, nil)
		}
		if _, dup := seen[id]; dup {
			return "", "", nil, NewError("invalid_codex_tool_question", http.StatusUnprocessableEntity, nil)
		}
		seen[id] = struct{}{}
		field := map[string]any{
			"id":         id,
			"label":      label,
			"required":   false,
			"allowOther": false,
			"secret":     q["isSecret"] == true,
		}
		if header := strings.TrimSpace(asString(q["header"])); header != "" {
			field["header"] = header
		}
		if rawOpts := q["options"]; rawOpts != nil {
			optList, okOpt := rawOpts.([]any)
			if !okOpt || len(optList) == 0 {
				return "", "", nil, NewError("invalid_codex_tool_question", http.StatusUnprocessableEntity, nil)
			}
			opts := make([]map[string]any, 0, len(optList))
			seenOpt := make(map[string]struct{}, len(optList))
			for _, rawO := range optList {
				om, okO := rawO.(map[string]any)
				if !okO {
					return "", "", nil, NewError("invalid_codex_tool_question", http.StatusUnprocessableEntity, nil)
				}
				lbl := strings.TrimSpace(asString(om["label"]))
				if lbl == "" {
					return "", "", nil, NewError("invalid_codex_tool_question", http.StatusUnprocessableEntity, nil)
				}
				if _, dup := seenOpt[lbl]; dup {
					return "", "", nil, NewError("invalid_codex_tool_question", http.StatusUnprocessableEntity, nil)
				}
				seenOpt[lbl] = struct{}{}
				opt := map[string]any{"value": lbl, "label": lbl}
				if desc := strings.TrimSpace(asString(om["description"])); desc != "" {
					opt["description"] = desc
				}
				opts = append(opts, opt)
			}
			field["type"] = "single_select"
			field["allowOther"] = q["isOther"] == true
			field["options"] = opts
		} else {
			field["type"] = "text"
		}
		fields = append(fields, field)
	}
	payload := map[string]any{
		"presentation":      map[string]any{"title": "Input required"},
		"fields":            fields,
		"actions":           []string{"submit"},
		"answerShape":       "answers",
		"confirmUnanswered": true,
	}
	if autoMs, okAuto := coerceInt64(params["autoResolutionMs"]); okAuto && autoMs >= 60000 && autoMs <= 240000 {
		payload["autoResolution"] = map[string]any{
			"mode":         "inactivity_countdown",
			"inactivityMs": 60000,
			"countdownMs":  60000,
			"onExpire":     "submit_empty",
			"snooze":       "disable",
		}
	}
	return "question", itemID, payload, nil
}

func adaptCodexMCPElicitation(params map[string]any) (string, string, map[string]any, error) {
	mode := asString(params["mode"])
	if mode == "openai/form" {
		return "", "", nil, NewError("unsupported_codex_mcp_openai_form_schema", http.StatusUnprocessableEntity, nil)
	}
	title := firstNonEmptyStr(strings.TrimSpace(asString(params["serverName"])), "MCP input required")
	pres := map[string]any{"title": title}
	if msg := strings.TrimSpace(asString(params["message"])); msg != "" {
		pres["description"] = msg
	}
	if mode == "url" {
		urlStr := strings.TrimSpace(asString(params["url"]))
		if urlStr == "" {
			return "", "", nil, NewError("invalid_codex_mcp_elicitation_url", http.StatusUnprocessableEntity, nil)
		}
		pres["annotations"] = []map[string]any{{"label": "External URL", "value": urlStr}}
		return "question", "", map[string]any{
			"presentation": pres,
			"fields":       []map[string]any{},
			"actions":      []string{"submit", "decline", "cancel"},
			"answerShape":  "object",
		}, nil
	}
	if mode != "form" {
		return "", "", nil, NewError("unsupported_codex_mcp_mode", http.StatusUnprocessableEntity, nil)
	}
	schema, ok := params["requestedSchema"].(map[string]any)
	if !ok || asString(schema["type"]) != "object" {
		return "", "", nil, NewError("unsupported_codex_mcp_form_schema", http.StatusUnprocessableEntity, nil)
	}
	props, ok := schema["properties"].(map[string]any)
	if !ok {
		return "", "", nil, NewError("unsupported_codex_mcp_form_schema", http.StatusUnprocessableEntity, nil)
	}
	requiredSet := map[string]struct{}{}
	for _, r := range toNonEmptyStringSlice(schema["required"]) {
		if _, okProp := props[r]; !okProp {
			return "", "", nil, NewError("unsupported_codex_mcp_form_schema", http.StatusUnprocessableEntity, nil)
		}
		requiredSet[r] = struct{}{}
	}
	fields := make([]map[string]any, 0, len(props))
	for id, defRaw := range props {
		def, okDef := defRaw.(map[string]any)
		if !okDef || strings.TrimSpace(id) == "" {
			return "", "", nil, NewError("unsupported_codex_mcp_form_schema", http.StatusUnprocessableEntity, nil)
		}
		_, isReq := requiredSet[id]
		field := map[string]any{
			"id":         strings.TrimSpace(id),
			"label":      firstNonEmptyStr(strings.TrimSpace(asString(def["title"])), strings.TrimSpace(id)),
			"required":   isReq,
			"allowOther": false,
			"secret":     false,
		}
		if desc := strings.TrimSpace(asString(def["description"])); desc != "" {
			field["description"] = desc
		}
		switch asString(def["type"]) {
		case "string":
			if def["enum"] != nil || def["oneOf"] != nil {
				opts, err := adaptMCPEnumOptions(def)
				if err != nil {
					return "", "", nil, err
				}
				field["type"] = "single_select"
				field["options"] = opts
			} else {
				field["type"] = "text"
			}
		case "number":
			field["type"] = "number"
		case "integer":
			field["type"] = "integer"
		case "boolean":
			field["type"] = "boolean"
		case "array":
			itemsMap, _ := def["items"].(map[string]any)
			opts, err := adaptMCPEnumOptions(itemsMap)
			if err != nil {
				return "", "", nil, err
			}
			field["type"] = "multi_select"
			field["options"] = opts
		default:
			return "", "", nil, NewError("unsupported_codex_mcp_form_schema", http.StatusUnprocessableEntity, nil)
		}
		fields = append(fields, field)
	}
	return "question", "", map[string]any{
		"presentation": pres,
		"fields":       fields,
		"actions":      []string{"submit", "decline", "cancel"},
		"answerShape":  "object",
	}, nil
}

func adaptMCPEnumOptions(schema map[string]any) ([]map[string]any, error) {
	if schema == nil {
		return nil, NewError("unsupported_codex_mcp_form_schema", http.StatusUnprocessableEntity, nil)
	}
	var rawList any
	isConst := false
	if schema["oneOf"] != nil {
		rawList = schema["oneOf"]
		isConst = true
	} else if schema["anyOf"] != nil {
		rawList = schema["anyOf"]
		isConst = true
	} else {
		rawList = schema["enum"]
	}
	items, ok := rawList.([]any)
	if !ok || len(items) == 0 {
		return nil, NewError("unsupported_codex_mcp_form_schema", http.StatusUnprocessableEntity, nil)
	}
	opts := make([]map[string]any, 0, len(items))
	seen := make(map[string]struct{}, len(items))
	if isConst {
		for _, entry := range items {
			m, okM := entry.(map[string]any)
			if !okM {
				return nil, NewError("unsupported_codex_mcp_form_schema", http.StatusUnprocessableEntity, nil)
			}
			val := strings.TrimSpace(asString(m["const"]))
			lbl := strings.TrimSpace(asString(m["title"]))
			if val == "" || lbl == "" {
				return nil, NewError("unsupported_codex_mcp_form_schema", http.StatusUnprocessableEntity, nil)
			}
			if _, dup := seen[val]; dup {
				return nil, NewError("unsupported_codex_mcp_form_schema", http.StatusUnprocessableEntity, nil)
			}
			seen[val] = struct{}{}
			opts = append(opts, map[string]any{"value": val, "label": lbl})
		}
		return opts, nil
	}
	names := toNonEmptyStringSlice(schema["enumNames"])
	if len(names) > 0 && len(names) != len(items) {
		return nil, NewError("unsupported_codex_mcp_form_schema", http.StatusUnprocessableEntity, nil)
	}
	for i, entry := range items {
		val := strings.TrimSpace(asString(entry))
		if val == "" {
			return nil, NewError("unsupported_codex_mcp_form_schema", http.StatusUnprocessableEntity, nil)
		}
		if _, dup := seen[val]; dup {
			return nil, NewError("unsupported_codex_mcp_form_schema", http.StatusUnprocessableEntity, nil)
		}
		seen[val] = struct{}{}
		lbl := val
		if len(names) > 0 {
			lbl = names[i]
		}
		opts = append(opts, map[string]any{"value": val, "label": lbl})
	}
	return opts, nil
}

// AdaptCodexServerResponse 把 Canonical 交互决议转换成 Codex app-server 请求响应载荷。
func AdaptCodexServerResponse(interaction *Interaction, env *CodexInteractionEnvelope, resolution map[string]any) (map[string]any, error) {
	if env == nil {
		return nil, NewError("codex_interaction_private_envelope_missing", http.StatusInternalServerError, nil)
	}
	if resolution == nil {
		return nil, NewError("codex_interaction_resolution_invalid", http.StatusUnprocessableEntity, nil)
	}
	sessionID := env.SessionID
	if interaction != nil && interaction.SessionID != "" {
		sessionID = interaction.SessionID
	}
	expectedID, err := NativeInteractionID("codex", sessionID, env.NativeThreadID, fmt.Sprintf("%v", env.RequestID))
	if err != nil || (interaction != nil && interaction.InteractionID != expectedID) {
		return nil, NewError("codex_interaction_identity_mismatch", http.StatusConflict, nil)
	}

	switch env.Method {
	case "item/commandExecution/requestApproval",
		"item/fileChange/requestApproval",
		"item/permissions/requestApproval":
		choiceID := strings.TrimSpace(asString(resolution["choiceId"]))
		if choiceID == "" {
			return nil, NewError("codex_approval_choice_id_required", http.StatusUnprocessableEntity, nil)
		}
		resp, ok := env.ChoiceResponses[choiceID]
		if !ok {
			return nil, NewError("codex_approval_choice_not_available", http.StatusUnprocessableEntity, map[string]any{"choiceId": choiceID})
		}
		return CloneMap(resp), nil

	case "item/tool/requestUserInput":
		action := strings.TrimSpace(asString(resolution["action"]))
		if _, valid := ValidQuestionActions[action]; !valid {
			return nil, NewError("invalid_question_action", http.StatusUnprocessableEntity, map[string]any{"action": action})
		}
		if action != "submit" {
			return nil, NewError("codex_question_action_unsupported", http.StatusUnprocessableEntity, map[string]any{"action": action})
		}
		answer, ok := resolution["answer"].(map[string]any)
		if !ok {
			return nil, NewError("codex_question_answer_invalid", http.StatusUnprocessableEntity, nil)
		}
		if len(answer) == 0 {
			return map[string]any{"answers": map[string]any{}}, nil
		}
		qMap := make(map[string]map[string]any)
		if qs, okQ := env.NativeRequest["questions"].([]any); okQ {
			for _, entry := range qs {
				if qm, okM := entry.(map[string]any); okM {
					if qid := strings.TrimSpace(asString(qm["id"])); qid != "" {
						qMap[qid] = qm
					}
				}
			}
		}
		unknown := make([]string, 0)
		for k := range answer {
			if _, okKnown := qMap[k]; !okKnown {
				unknown = append(unknown, k)
			}
		}
		if len(unknown) > 0 {
			return nil, NewError("codex_question_answer_unknown_field", http.StatusUnprocessableEntity, map[string]any{"fields": unknown})
		}
		outAnswers := make(map[string]any, len(answer))
		for k, v := range answer {
			q := qMap[k]
			vals, err := extractCodexToolAnswerValues(v, q)
			if err != nil {
				return nil, err
			}
			outAnswers[k] = map[string]any{"answers": vals}
		}
		return map[string]any{"answers": outAnswers}, nil

	case "mcpServer/elicitation/request":
		action := strings.TrimSpace(asString(resolution["action"]))
		if _, valid := ValidQuestionActions[action]; !valid {
			return nil, NewError("invalid_question_action", http.StatusUnprocessableEntity, map[string]any{"action": action})
		}
		if action != "submit" {
			return map[string]any{"action": action, "content": nil, "_meta": nil}, nil
		}
		mode := asString(env.NativeRequest["mode"])
		answer, ok := resolution["answer"].(map[string]any)
		if !ok {
			return nil, NewError("codex_question_answer_invalid", http.StatusUnprocessableEntity, nil)
		}
		if mode == "url" {
			if len(answer) > 0 {
				return nil, NewError("codex_question_answer_not_allowed", http.StatusUnprocessableEntity, nil)
			}
			return map[string]any{"action": "accept", "content": nil, "_meta": nil}, nil
		}
		if mode != "form" {
			return nil, NewError("codex_mcp_elicitation_mode_unsupported", http.StatusUnprocessableEntity, nil)
		}
		if err := validateMCPFormAnswer(answer, env.NativeRequest["requestedSchema"]); err != nil {
			return nil, err
		}
		return map[string]any{"action": "accept", "content": CloneMap(answer), "_meta": nil}, nil

	default:
		return nil, NewError("codex_server_response_adapter_missing", http.StatusUnprocessableEntity, nil)
	}
}

func extractCodexToolAnswerValues(raw any, question map[string]any) ([]string, error) {
	var rawItems []any
	switch v := raw.(type) {
	case []any:
		rawItems = v
	case []string:
		rawItems = make([]any, len(v))
		for i, s := range v {
			rawItems[i] = s
		}
	default:
		rawItems = []any{v}
	}
	trimmed := make([]string, 0, len(rawItems))
	for _, entry := range rawItems {
		s, ok := entry.(string)
		if !ok {
			return nil, NewError("codex_question_answer_invalid", http.StatusUnprocessableEntity, nil)
		}
		if clean := strings.TrimSpace(s); clean != "" {
			trimmed = append(trimmed, clean)
		}
	}
	var optSet map[string]struct{}
	if opts, ok := question["options"].([]any); ok {
		optSet = make(map[string]struct{}, len(opts))
		for _, o := range opts {
			if om, okM := o.(map[string]any); okM {
				optSet[asString(om["label"])] = struct{}{}
			}
		}
	}
	out := make([]string, 0, len(trimmed))
	for _, ans := range trimmed {
		if optSet != nil {
			if _, ok := optSet[ans]; ok {
				out = append(out, ans)
				continue
			}
			if question["isOther"] != true {
				return nil, NewError("codex_question_answer_not_available", http.StatusUnprocessableEntity, nil)
			}
		}
		out = append(out, "user_note: "+ans)
	}
	return out, nil
}

func validateMCPFormAnswer(answer map[string]any, schemaRaw any) error {
	schema, ok := schemaRaw.(map[string]any)
	if !ok {
		return NewError("codex_question_private_schema_invalid", http.StatusInternalServerError, nil)
	}
	props, ok := schema["properties"].(map[string]any)
	if !ok {
		return NewError("codex_question_private_schema_invalid", http.StatusInternalServerError, nil)
	}
	unknown := make([]string, 0)
	for k := range answer {
		if _, okProp := props[k]; !okProp {
			unknown = append(unknown, k)
		}
	}
	if len(unknown) > 0 {
		return NewError("codex_question_answer_unknown_field", http.StatusUnprocessableEntity, map[string]any{"fields": unknown})
	}
	for _, reqKey := range toNonEmptyStringSlice(schema["required"]) {
		if _, okAns := answer[reqKey]; !okAns {
			return NewError("codex_question_required_answer_missing", http.StatusUnprocessableEntity, nil)
		}
	}
	for k, v := range answer {
		propSchema, _ := props[k].(map[string]any)
		switch asString(propSchema["type"]) {
		case "string":
			if _, okStr := v.(string); !okStr {
				return NewError("codex_question_answer_type_mismatch", http.StatusUnprocessableEntity, nil)
			}
		case "number":
			switch n := v.(type) {
			case float64:
				if math.IsNaN(n) || math.IsInf(n, 0) {
					return NewError("codex_question_answer_type_mismatch", http.StatusUnprocessableEntity, nil)
				}
			case json.Number, int, int64:
			default:
				return NewError("codex_question_answer_type_mismatch", http.StatusUnprocessableEntity, nil)
			}
		case "integer":
			if _, okInt := coerceInt64(v); !okInt {
				return NewError("codex_question_answer_type_mismatch", http.StatusUnprocessableEntity, nil)
			}
		case "boolean":
			if _, okBool := v.(bool); !okBool {
				return NewError("codex_question_answer_type_mismatch", http.StatusUnprocessableEntity, nil)
			}
		case "array":
			arr, okArr := v.([]any)
			if !okArr {
				return NewError("codex_question_answer_type_mismatch", http.StatusUnprocessableEntity, nil)
			}
			for _, item := range arr {
				if _, okStr := item.(string); !okStr {
					return NewError("codex_question_answer_type_mismatch", http.StatusUnprocessableEntity, nil)
				}
			}
		default:
			return NewError("codex_question_private_schema_invalid", http.StatusInternalServerError, nil)
		}
	}
	return nil
}

func buildCodexPresentation(title, description, detail string, annEntries [][2]string) map[string]any {
	pres := map[string]any{"title": title}
	if clean := strings.TrimSpace(description); clean != "" {
		pres["description"] = clean
	}
	if clean := strings.TrimSpace(detail); clean != "" {
		pres["detail"] = clean
	}
	anns := make([]map[string]any, 0, len(annEntries))
	for _, entry := range annEntries {
		if val := strings.TrimSpace(entry[1]); val != "" {
			anns = append(anns, map[string]any{"label": entry[0], "value": val})
		}
	}
	if len(anns) > 0 {
		pres["annotations"] = anns
	}
	return pres
}

func toNonEmptyStringSlice(raw any) []string {
	var out []string
	switch v := raw.(type) {
	case []string:
		for _, s := range v {
			if clean := strings.TrimSpace(s); clean != "" {
				out = append(out, clean)
			}
		}
	case []any:
		for _, item := range v {
			if clean := strings.TrimSpace(asString(item)); clean != "" {
				out = append(out, clean)
			}
		}
	}
	return out
}

func firstNonEmptyStr(vals ...string) string {
	for _, s := range vals {
		if strings.TrimSpace(s) != "" {
			return s
		}
	}
	return ""
}

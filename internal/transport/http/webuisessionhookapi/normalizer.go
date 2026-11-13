package webuisessionhookapi

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
)

const defaultSource = "official-hook"

var eventTypeByName = map[string]string{
	"SessionStart":                 "session:opened",
	"Setup":                        "session:updated",
	"UserPromptSubmit":             "session:turn-started",
	"UserPromptExpansion":          "session:turn-started",
	"AppServerTurnStarted":         "session:turn-started",
	"BeforeAgent":                  "session:turn-started",
	"PreToolUse":                   "session:turn-updated",
	"PermissionRequest":            "session:turn-updated",
	"PermissionDenied":             "session:turn-updated",
	"PostToolUse":                  "session:turn-updated",
	"PostToolUseFailure":           "session:turn-updated",
	"PostToolBatch":                "session:turn-updated",
	"BeforeTool":                   "session:turn-updated",
	"AfterTool":                    "session:turn-updated",
	"BeforeToolSelection":          "session:turn-updated",
	"BeforeModel":                  "session:turn-updated",
	"AfterModel":                   "session:turn-updated",
	"PreInvocation":                "session:turn-updated",
	"PostInvocation":               "session:turn-updated",
	"AppServerThreadStatusChanged": "session:turn-updated",
	"Notification":                 "session:notification",
	"MessageDisplay":               "session:turn-updated",
	"SubagentStart":                "session:turn-updated",
	"TaskCreated":                  "session:turn-updated",
	"TaskCompleted":                "session:turn-updated",
	"Stop":                         "session:turn-completed",
	"AppServerTurnCompleted":       "session:turn-completed",
	"StopFailure":                  "session:turn-failed",
	"AfterAgent":                   "session:turn-completed",
	"SubagentStop":                 "session:turn-completed",
	"TeammateIdle":                 "session:turn-updated",
	"InstructionsLoaded":           "session:updated",
	"ConfigChange":                 "session:updated",
	"CwdChanged":                   "session:updated",
	"FileChanged":                  "session:file-changed",
	"WorktreeCreate":               "session:updated",
	"WorktreeRemove":               "session:updated",
	"PreCompact":                   "session:updated",
	"PostCompact":                  "session:updated",
	"PreCompress":                  "session:updated",
	"Elicitation":                  "session:turn-updated",
	"ElicitationResult":            "session:turn-updated",
	"SessionEnd":                   "session:closed",
	"AppServerThreadClosed":        "session:closed",
}

var questionOpenEvents = map[string]bool{
	"question":          true,
	"askuserquestion":   true,
	"ask_user_question": true,
	"elicitation":       true,
	"permissionrequest": true,
}

var questionClearEvents = map[string]bool{
	"questioncleared":    true,
	"question_cleared":   true,
	"elicitationresult":  true,
	"elicitation_result": true,
	"permissionresolved": true,
}

var interruptedEvents = map[string]bool{
	"interrupt":        true,
	"interrupted":      true,
	"cancelled":        true,
	"canceled":         true,
	"turninterrupted":  true,
	"turn_interrupted": true,
}

var waitingNotificationTypes = map[string]bool{
	"permission_prompt":        true,
	"worker_permission_prompt": true,
	"idle_prompt":              true,
	"agent_needs_input":        true,
	"elicitation_dialog":       true,
}

var resolvedNotificationTypes = map[string]bool{
	"elicitation_complete": true,
	"elicitation_response": true,
}

var statuslineEvents = map[string]bool{
	"statusline":         true,
	"status_line":        true,
	"statuslineupdated":  true,
	"statusline_updated": true,
}

// NormalizeOptions 提供查询参数与系统依赖以归一 provider hook 负载。
type NormalizeOptions struct {
	EventName           string
	HookEventName       string
	SessionID           string
	ProjectDirName      string
	ProjectPath         string
	Source              string
	At                  int64
	Now                 func() time.Time
	IsSupportedProvider func(provider string) bool
}

// NormalizedHookSession 是归一后的会话标识。
type NormalizedHookSession struct {
	Provider       string
	SessionID      string
	ProjectDirName string
	ProjectPath    string
}

// NormalizedHookEvent 是归一后的标准 hook 事件。
type NormalizedHookEvent struct {
	Type           string
	Source         string
	Reason         string
	EventName      string
	Phase          string
	TranscriptPath string
	CWD            string
	ProjectPath    string
	ProjectDirName string
	TurnID         string
	At             int64
	Payload        map[string]any
}

// NormalizeResult 是 NormalizeProviderHookEvent 的结果。
type NormalizeResult struct {
	OK      bool
	Error   string
	Session NormalizedHookSession
	Event   NormalizedHookEvent
}

// ParsePayloadRoot 按 Node provider-hook 约定展开 body.payload -> body.event -> body。
func ParsePayloadRoot(body map[string]any) map[string]any {
	if body == nil {
		return map[string]any{}
	}
	if nested, ok := body["payload"].(map[string]any); ok && nested != nil {
		return nested
	}
	if nested, ok := body["event"].(map[string]any); ok && nested != nil {
		return nested
	}
	return body
}

// NormalizeProviderHookEvent 将不同 Provider 的 hook payload 归一为统一事件。
func NormalizeProviderHookEvent(providerRaw string, rawPayload map[string]any, options NormalizeOptions) NormalizeResult {
	payload := rawPayload
	if payload == nil {
		payload = map[string]any{}
	}
	provider := normalizeProvider(firstText(providerRaw, anyText(payload["provider"])))
	if provider == "" || (options.IsSupportedProvider != nil && !options.IsSupportedProvider(provider)) {
		return NormalizeResult{OK: false, Error: "unsupported_provider"}
	}

	eventName := resolveHookEventName(provider, payload, options)
	sessionID := resolveHookSessionID(provider, payload, options)
	if sessionID == "" {
		return NormalizeResult{OK: false, Error: "missing_session_id"}
	}

	eventType := ResolveHookEventType(eventName, provider, payload)
	transcriptPath := resolveTranscriptPath(provider, payload)
	projectPath := resolveHookProjectPath(provider, payload, options)
	projectDirName := firstText(
		options.ProjectDirName,
		anyText(payload["projectDirName"]),
		anyText(payload["project_dir_name"]),
	)
	cwd := firstText(anyText(payload["cwd"]), projectPath)
	at := parseEventTime(payload["timestamp"])
	if at <= 0 {
		at = parseEventTime(payload["at"])
	}
	if at <= 0 {
		at = options.At
	}
	if at <= 0 {
		if options.Now != nil {
			at = options.Now().UnixMilli()
		} else {
			at = time.Now().UnixMilli()
		}
	}
	turnID := resolveTurnID(payload)
	eventPayload := normalizeEventPayload(eventName, payload)
	source := firstText(options.Source, anyText(payload["source"]))
	if source == "" {
		source = defaultSource
	}
	reason := firstText(eventName, eventType)

	return NormalizeResult{
		OK: true,
		Session: NormalizedHookSession{
			Provider:       provider,
			SessionID:      sessionID,
			ProjectDirName: projectDirName,
			ProjectPath:    projectPath,
		},
		Event: NormalizedHookEvent{
			Type:           eventType,
			Source:         source,
			Reason:         reason,
			EventName:      eventName,
			Phase:          resolveHookPhase(eventType),
			TranscriptPath: transcriptPath,
			CWD:            cwd,
			ProjectPath:    projectPath,
			ProjectDirName: projectDirName,
			TurnID:         turnID,
			At:             at,
			Payload:        eventPayload,
		},
	}
}

// ResolveHookEventType 将 hook eventName 与 payload 字段映射为标准会话事件类型。
func ResolveHookEventType(eventName, provider string, payload map[string]any) string {
	normalizedName := normalizeHookEventKey(eventName)
	if questionClearEvents[normalizedName] || isTrue(payload["questionCleared"]) || isTrue(payload["question_cleared"]) {
		return "question-cleared"
	}
	if normalizedName == "notification" {
		kind := strings.ToLower(firstText(anyText(payload["notification_type"]), anyText(payload["notificationType"])))
		if waitingNotificationTypes[kind] {
			return "question-opened"
		}
		if resolvedNotificationTypes[kind] {
			return "question-cleared"
		}
		if mapped, ok := eventTypeByName[eventName]; ok {
			return mapped
		}
		return "session:notification"
	}
	if questionOpenEvents[normalizedName] ||
		hasKey(payload, "question") ||
		hasKey(payload, "options") ||
		(hasKey(payload, "prompt") && isTrue(payload["requiresAnswer"])) {
		return "question-opened"
	}
	if interruptedEvents[normalizedName] || isTrue(payload["interrupted"]) || strings.EqualFold(anyText(payload["interrupted"]), "true") {
		return "turn-interrupted"
	}
	if statuslineEvents[normalizedName] || hasKey(payload, "statusline") || hasKey(payload, "status_line") {
		return "statusline-updated"
	}
	if provider == "agy" && eventName == "Stop" {
		if anyText(payload["error"]) != "" || strings.EqualFold(anyText(payload["terminationReason"]), "error") {
			return "session:turn-failed"
		}
		if val, ok := payload["fullyIdle"].(bool); ok && !val {
			return "session:turn-updated"
		}
		return "session:turn-completed"
	}
	if mapped, ok := eventTypeByName[eventName]; ok {
		return mapped
	}
	return "session:updated"
}

func resolveHookEventName(provider string, payload map[string]any, options NormalizeOptions) string {
	explicit := firstText(
		options.EventName,
		options.HookEventName,
		anyText(payload["eventName"]),
		anyText(payload["hookEventName"]),
		anyText(payload["hook_event_name"]),
		anyText(payload["event"]),
	)
	if explicit != "" {
		return explicit
	}
	if provider == "agy" {
		return inferAgyEventName(payload)
	}
	return ""
}

func inferAgyEventName(payload map[string]any) string {
	if hasKey(payload, "executionNum") || hasKey(payload, "fullyIdle") || hasKey(payload, "terminationReason") {
		return "Stop"
	}
	if tc, ok := payload["toolCall"].(map[string]any); ok && tc != nil {
		return "PreToolUse"
	}
	if hasKey(payload, "error") && hasKey(payload, "stepIdx") {
		return "PostToolUse"
	}
	return ""
}

func resolveHookSessionID(provider string, payload map[string]any, options NormalizeOptions) string {
	if provider == "agy" {
		return firstText(
			options.SessionID,
			anyText(payload["conversationId"]),
			anyText(payload["conversation_id"]),
			anyText(payload["sessionId"]),
			anyText(payload["session_id"]),
		)
	}
	return firstText(
		options.SessionID,
		anyText(payload["session_id"]),
		anyText(payload["sessionId"]),
	)
}

func resolveTranscriptPath(provider string, payload map[string]any) string {
	if provider == "agy" {
		return firstText(anyText(payload["transcriptPath"]), anyText(payload["transcript_path"]))
	}
	return firstText(anyText(payload["transcript_path"]), anyText(payload["transcriptPath"]))
}

func resolveHookProjectPath(provider string, payload map[string]any, options NormalizeOptions) string {
	var workspacePath string
	if provider == "agy" {
		workspacePath = firstWorkspacePath(payload)
	}
	return firstText(
		options.ProjectPath,
		anyText(payload["projectPath"]),
		anyText(payload["project_path"]),
		anyText(payload["cwd"]),
		workspacePath,
	)
}

func firstWorkspacePath(payload map[string]any) string {
	for _, key := range []string{"workspacePaths", "workspace_paths"} {
		if items, ok := payload[key].([]any); ok {
			for _, item := range items {
				if txt := anyText(item); txt != "" {
					return txt
				}
			}
		}
	}
	return ""
}

func resolveTurnID(payload map[string]any) string {
	return firstText(
		anyScalarText(payload["turn_id"]),
		anyScalarText(payload["turnId"]),
		anyScalarText(payload["invocationNum"]),
		anyScalarText(payload["executionNum"]),
		anyScalarText(payload["stepIdx"]),
	)
}

func normalizeEventPayload(eventName string, payload map[string]any) map[string]any {
	normalizedName := normalizeHookEventKey(eventName)
	result := make(map[string]any)

	var permDesc string
	if normalizedName == "permissionrequest" {
		permDesc = describePermissionRequest(payload)
	}
	var notifMsg string
	if normalizedName == "notification" {
		notifMsg = firstText(anyText(payload["message"]), anyText(payload["title"]))
	}
	question := boundedText(firstText(
		anyText(payload["question"]),
		permDesc,
		notifMsg,
		anyText(payload["prompt"]),
		anyText(payload["text"]),
	), 4096)
	if questionOpenEvents[normalizedName] || question != "" {
		if question != "" {
			result["question"] = question
		}
		if rawOpts, ok := payload["options"].([]any); ok {
			opts := make([]string, 0, len(rawOpts))
			for _, item := range rawOpts {
				if len(opts) >= 32 {
					break
				}
				txt := boundedText(anyScalarText(item), 512)
				if txt != "" {
					opts = append(opts, txt)
				}
			}
			result["options"] = opts
		}
	}
	if normalizedName == "notification" && anyText(result["question"]) != "" {
		result["notice"] = true
	}
	reason := boundedText(firstText(
		anyText(payload["reason"]),
		anyText(payload["terminationReason"]),
		anyText(payload["termination_reason"]),
	), 4096)
	if reason != "" {
		result["reason"] = reason
	}
	if hasKey(payload, "error") && payload["error"] != nil {
		errText := boundedText(firstText(anyScalarText(payload["errorMessage"]), anyScalarText(payload["error"])), 4096)
		if errText != "" {
			result["error"] = errText
		}
	}

	statusline, ok := payload["statusline"].(map[string]any)
	if !ok {
		statusline, ok = payload["status_line"].(map[string]any)
	}
	if ok && statusline != nil {
		count := 0
		for key, val := range statusline {
			if count >= 32 {
				break
			}
			k := boundedText(key, 128)
			if str, isStr := val.(string); isStr {
				result[k] = boundedText(str, 1024)
			} else {
				result[k] = val
			}
			count++
		}
	} else if statuslineEvents[normalizedName] {
		for _, key := range []string{"contextPct", "context_pct", "tokens", "inputTokens", "outputTokens", "model"} {
			if val, exists := payload[key]; exists {
				if str, isStr := val.(string); isStr {
					result[key] = boundedText(str, 256)
				} else {
					result[key] = val
				}
			}
		}
	}
	return result
}

func describePermissionRequest(payload map[string]any) string {
	tool := firstText(anyText(payload["tool_name"]), anyText(payload["toolName"]))
	if tool == "" {
		return ""
	}
	input, _ := payload["tool_input"].(map[string]any)
	if input == nil {
		input, _ = payload["toolInput"].(map[string]any)
	}
	if input == nil {
		return tool
	}
	detail := firstText(
		anyText(input["command"]),
		anyText(input["file_path"]),
		anyText(input["path"]),
		anyText(input["url"]),
		anyText(input["pattern"]),
	)
	if detail != "" {
		return tool + ": " + detail
	}
	return tool
}

func resolveHookPhase(eventType string) string {
	switch eventType {
	case "session:opened":
		return "session-opened"
	case "session:closed":
		return "session-closed"
	case "session:turn-started":
		return "turn-started"
	case "session:turn-completed":
		return "turn-completed"
	case "session:turn-failed":
		return "turn-failed"
	case "session:file-changed":
		return "file-changed"
	case "session:notification":
		return "notification"
	default:
		return "turn-updated"
	}
}

func normalizeProvider(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func normalizeHookEventKey(value string) string {
	trimmed := strings.ToLower(strings.TrimSpace(value))
	var out strings.Builder
	inSpace := false
	for _, r := range trimmed {
		if r == ' ' || r == '\t' || r == '\n' || r == '\r' || r == '-' {
			if !inSpace {
				out.WriteByte('_')
				inSpace = true
			}
			continue
		}
		inSpace = false
		out.WriteRune(r)
	}
	return out.String()
}

func parseEventTime(value any) int64 {
	switch typed := value.(type) {
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) || typed <= 0 {
			return 0
		}
		return int64(typed)
	case int64:
		if typed > 0 {
			return typed
		}
		return 0
	case int:
		if typed > 0 {
			return int64(typed)
		}
		return 0
	case string:
		trimmed := strings.TrimSpace(typed)
		if trimmed == "" {
			return 0
		}
		if num, err := strconv.ParseInt(trimmed, 10, 64); err == nil && num > 0 {
			return num
		}
		for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05Z07:00"} {
			if parsed, err := time.Parse(layout, trimmed); err == nil {
				return parsed.UnixMilli()
			}
		}
		return 0
	default:
		return 0
	}
}

func firstText(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func anyText(value any) string {
	str, _ := value.(string)
	return strings.TrimSpace(str)
}

func anyScalarText(value any) string {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) {
			return ""
		}
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case int:
		return strconv.Itoa(typed)
	case int64:
		return strconv.FormatInt(typed, 10)
	case bool:
		return fmt.Sprintf("%t", typed)
	default:
		return ""
	}
}

func boundedText(value string, max int) string {
	trimmed := strings.TrimSpace(value)
	if max <= 0 || len(trimmed) <= max {
		return trimmed
	}
	runes := []rune(trimmed)
	if len(runes) <= max {
		return trimmed
	}
	return string(runes[:max])
}

func hasKey(m map[string]any, key string) bool {
	if m == nil {
		return false
	}
	_, ok := m[key]
	return ok
}

func isTrue(value any) bool {
	b, ok := value.(bool)
	return ok && b
}

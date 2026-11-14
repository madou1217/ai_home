package chatruntime

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/madou1217/ai_home/internal/runtime/providercli"
	"github.com/madou1217/ai_home/internal/runtime/providercli/sessionchat"
	"github.com/madou1217/ai_home/internal/runtime/pty"
	"github.com/madou1217/ai_home/internal/sessionscan/sessionread"
)

const (
	nativeMaxAccountAttempts       = 3
	nativeStreamErrorSettleTimeout = 5 * time.Second
	nativeContinuePrompt           = "continue"
	spawnerNativeStream            = "native-stream"
	spawnerOpenCodeServe           = "opencode-serve"
)

// NativeApprovalTransport 描述单个 CLI Provider 的审批传输规则。
type NativeApprovalTransport struct {
	ID                string
	Channel           string
	Providers         []string
	Modes             []string
	Spawner           string
	UnsupportedReason string
}

var defaultApprovalTransports = []NativeApprovalTransport{
	{
		ID:        "claude-permission-prompt-tool",
		Channel:   "http-callback",
		Providers: []string{"claude"},
		Modes:     []string{"confirm", "plan"},
		Spawner:   spawnerNativeStream,
	},
	{
		ID:        "opencode-serve-permission",
		Channel:   "serve-permission",
		Providers: []string{"opencode"},
		Modes:     []string{"confirm", "plan"},
		Spawner:   spawnerOpenCodeServe,
	},
	{
		ID:        "acp-request-permission",
		Channel:   "acp-permission",
		Providers: []string{"gemini", "cline", "codebuddy", "codebuddycn", "workbuddy", "workbuddycn", "qoder", "qodercn"},
		Modes:     []string{"confirm", "plan"},
		Spawner:   spawnerNativeStream,
	},
	{
		ID:        "zcode-desktop-plan",
		Channel:   "desktop-host",
		Providers: []string{"zcode"},
		Modes:     []string{"plan"},
		Spawner:   spawnerNativeStream,
	},
	{
		ID:                "zcode-desktop-confirm",
		Channel:           "desktop-host",
		Providers:         []string{"zcode"},
		Modes:             []string{"confirm"},
		UnsupportedReason: "zcode_desktop_approval_requires_desktop",
	},
	{
		ID:                "agy-no-permission-channel",
		Channel:           "none",
		Providers:         []string{"agy"},
		Modes:             []string{"confirm", "plan"},
		UnsupportedReason: "agy_cli_has_no_permission_channel",
	},
	{
		ID:                "grok-acp-pending-account",
		Channel:           "acp-permission",
		Providers:         []string{"grok"},
		Modes:             []string{"confirm", "plan"},
		UnsupportedReason: "grok_acp_unverified_no_account",
	},
}

// NativeApprovalResolution 表示原生审批能力解析结果。
type NativeApprovalResolution struct {
	Support   string
	Reason    string
	Spawner   string
	Transport *NativeApprovalTransport
}

// ResolveNativeApprovalTransport 解析 provider + approvalMode 的原生审批支持度。
func ResolveNativeApprovalTransport(provider, approvalMode string, availableSpawners map[string]bool) NativeApprovalResolution {
	mode := strings.ToLower(strings.TrimSpace(approvalMode))
	if mode == "" || mode == "bypass" {
		return NativeApprovalResolution{Support: "not_required"}
	}
	prov := sessionchat.NormalizeProvider(provider)
	for i := range defaultApprovalTransports {
		row := &defaultApprovalTransports[i]
		if !stringSliceContains(row.Providers, prov) || !stringSliceContains(row.Modes, mode) {
			continue
		}
		if row.Spawner == "" {
			reason := row.UnsupportedReason
			if reason == "" {
				reason = "native_session_approval_transport_not_wired"
			}
			return NativeApprovalResolution{Support: "unsupported", Reason: reason, Transport: row}
		}
		if availableSpawners != nil && !availableSpawners[row.Spawner] {
			return NativeApprovalResolution{Support: "unsupported", Reason: "native_session_approval_spawner_unavailable", Transport: row}
		}
		return NativeApprovalResolution{Support: "native", Spawner: row.Spawner, Transport: row}
	}
	return NativeApprovalResolution{Support: "unsupported", Reason: "native_session_approval_transport_undeclared"}
}

// NativeSessionCapabilities 返回原生 CLI 会话驱动的能力矩阵。
func NativeSessionCapabilities(rt RuntimeDescriptor, provider, hostHomeDir string, spawners map[string]bool) map[string]any {
	if spawners == nil {
		spawners = map[string]bool{spawnerNativeStream: true}
	}
	prov := sessionchat.NormalizeProvider(provider)
	confirmRes := ResolveNativeApprovalTransport(prov, "confirm", spawners)
	planRes := ResolveNativeApprovalTransport(prov, "plan", spawners)
	capSupportFrom := func(res NativeApprovalResolution) map[string]any {
		if res.Support == "native" {
			return capSupport("native", "")
		}
		return capSupport("unsupported", res.Reason)
	}
	steerCap := capSupport("unsupported", "native_session_steer_not_wired")
	interveneModes := []string{}
	if sessionchat.ClaudeUsesStreamJSONInput(prov, false, runtime.GOOS) {
		steerCap = capSupport("native", "")
		interveneModes = []string{"steer_current"}
	}
	rev := firstNonEmptyStr(rt.Fingerprint, rt.Version, prov+"-native")
	slashCmds := ProviderSlashCommandNames(hostHomeDir, prov)
	return map[string]any{
		"revision": rev,
		"capabilities": map[string]any{
			"session.resume":                capSupport("native", ""),
			"timeline.reasoning":            capSupport("native", ""),
			"timeline.tool":                 capSupport("native", ""),
			"timeline.diff":                 capSupport("unsupported", "native_session_stream_has_no_diff_events"),
			"mode.plan":                     capSupportFrom(planRes),
			"interaction.question":          capSupport("unsupported", "native_session_interaction_not_wired"),
			"interaction.approval":          capSupportFrom(confirmRes),
			"interaction.plan_confirmation": capSupport("unsupported", "native_session_plan_mode_not_wired"),
			"turn.interrupt":                capSupport("native", ""),
			"turn.steer.current":            steerCap,
			"turn.steer.tool_boundary":      capSupport("emulated", "aih_chat_runtime_tool_boundary_queue"),
			"turn.queue":                    capSupport("emulated", "aih_chat_runtime_queue"),
			"session.goal":                  capSupport("emulated", "aih_session_goal_projection"),
			"slash.execute":                 capSupport("native", ""),
			"terminal.stream":               capSupport("native", ""),
			"run.adopt":                     capSupport("native", ""),
		},
		"slashCommands":      slashCmds,
		"slashPassthrough":   true,
		"turnInterveneModes": interveneModes,
	}
}

// NativeApprovalChoice 描述原生审批提示项的一个可选决策。
type NativeApprovalChoice struct {
	ID     string
	Label  string
	Intent string
	Value  string
	Send   string
}

// NativeApprovalRequest 描述需要向前端弹出交互审批的请求。
type NativeApprovalRequest struct {
	RunID         string
	TurnID        string
	InteractionID string
	ToolName      string
	Title         string
	Detail        string
	Input         map[string]any
	ToolUseID     string
	Choices       []NativeApprovalChoice
	RawPayload    map[string]any
	OnPending     func(interactionID string)
	OnResolve     func(decision map[string]any)
}

// NativeApprovalSurface 桥接原生 CLI 审批/权限请求与 Canonical 交互仓库。
type NativeApprovalSurface struct {
	store     *PublishingStore
	sessionID string
	provider  string
	runtimeID string

	mu      sync.Mutex
	runID   string
	pending map[string]*nativePendingApproval
}

type nativePendingApproval struct {
	interaction *Interaction
	input       map[string]any
	onResolve   func(map[string]any)
	done        chan map[string]any
}

// NewNativeApprovalSurface 创建原生审批桥。
func NewNativeApprovalSurface(store *PublishingStore, sessionID, provider, runtimeID string) *NativeApprovalSurface {
	return &NativeApprovalSurface{
		store:     store,
		sessionID: sessionID,
		provider:  sessionchat.NormalizeProvider(provider),
		runtimeID: runtimeID,
		pending:   make(map[string]*nativePendingApproval),
	}
}

// BindRun 绑定当前活动 runId，供回调审批关联。
func (s *NativeApprovalSurface) BindRun(runID string) {
	s.mu.Lock()
	s.runID = strings.TrimSpace(runID)
	s.mu.Unlock()
}

// HasPending 判断指定 interactionId 当前是否仍挂起等待决策。
func (s *NativeApprovalSurface) HasPending(interactionID string) bool {
	id := strings.TrimSpace(interactionID)
	if s == nil || id == "" {
		return false
	}
	s.mu.Lock()
	_, ok := s.pending[id]
	s.mu.Unlock()
	return ok
}

func buildNativeApprovalPayload(req NativeApprovalRequest) map[string]any {
	choices := make([]map[string]any, 0, len(req.Choices))
	for _, ch := range req.Choices {
		m := map[string]any{
			"id":     ch.ID,
			"label":  ch.Label,
			"intent": firstNonEmptyStr(ch.Intent, "neutral"),
		}
		choices = append(choices, m)
	}
	if len(choices) == 0 {
		choices = []map[string]any{
			{"id": "allow", "label": "允许一次", "intent": "accept"},
			{"id": "deny", "label": "拒绝", "intent": "deny"},
		}
	}

	toolName := strings.TrimSpace(req.ToolName)
	defaultTitle := "需要确认工具调用"
	if toolName != "" {
		defaultTitle = "需要确认工具: " + toolName
	}
	pres := map[string]any{
		"title": firstNonEmptyStr(strings.TrimSpace(req.Title), defaultTitle),
	}
	if detail := strings.TrimSpace(req.Detail); detail != "" {
		pres["detail"] = detail
	} else if len(req.Input) > 0 {
		if raw, err := json.MarshalIndent(req.Input, "", "  "); err == nil && len(raw) > 0 {
			pres["detail"] = string(raw)
		}
	}
	if toolName != "" {
		pres["annotations"] = []map[string]any{
			{"label": "工具", "value": toolName},
		}
	}
	if rawPres, ok := req.RawPayload["presentation"].(map[string]any); ok && rawPres != nil {
		for _, k := range []string{"title", "description", "detail", "annotations"} {
			if v, exists := rawPres[k]; exists && v != nil {
				pres[k] = v
			}
		}
	}
	if rawChoices, ok := req.RawPayload["choices"].([]map[string]any); ok && len(rawChoices) > 0 {
		choices = rawChoices
	}

	return map[string]any{
		"presentation": pres,
		"choices":      choices,
	}
}

// Request 创建待决审批交互并阻塞等待用户响应、取消或超时。
func (s *NativeApprovalSurface) Request(ctx context.Context, req NativeApprovalRequest) (map[string]any, error) {
	if s.store == nil {
		return nil, NewError("native_approval_store_unavailable", http.StatusInternalServerError, nil)
	}
	s.mu.Lock()
	runID := firstNonEmptyStr(req.RunID, s.runID)
	s.mu.Unlock()

	interactionID := strings.TrimSpace(req.InteractionID)
	if interactionID == "" {
		interactionID = s.store.Store().NewID("interaction")
	}
	entry := &nativePendingApproval{
		interaction: &Interaction{
			InteractionID: interactionID,
			SessionID:     s.sessionID,
			Kind:          "approval",
			Revision:      1,
		},
		input:     CloneMap(req.Input),
		onResolve: req.OnResolve,
		done:      make(chan map[string]any, 1),
	}
	s.mu.Lock()
	s.pending[interactionID] = entry
	s.mu.Unlock()

	payload := buildNativeApprovalPayload(req)
	inter, err := s.store.CreateInteraction(ctx, CreateInteractionInput{
		InteractionID: interactionID,
		SessionID:     s.sessionID,
		ItemID:        firstNonEmptyStr(req.InteractionID, runID, req.TurnID, interactionID),
		Kind:          "approval",
		Revision:      1,
		Payload:       payload,
	})
	if err != nil {
		s.mu.Lock()
		delete(s.pending, interactionID)
		s.mu.Unlock()
		return nil, err
	}
	s.mu.Lock()
	entry.interaction = inter
	s.mu.Unlock()
	if req.OnPending != nil {
		req.OnPending(interactionID)
	}

	select {
	case dec := <-entry.done:
		return dec, nil
	case <-ctx.Done():
		s.CancelPending(context.Background(), interactionID, "approval_channel_closed")
		return map[string]any{"behavior": "deny", "choiceId": "deny", "message": "approval_channel_closed"}, ctx.Err()
	}
}

// Resolve 处理来自 WebUI `approval.decide` 的用户决策。
func (s *NativeApprovalSurface) Resolve(ctx context.Context, cmd *Command) (map[string]any, error) {
	payload := cmd.Payload
	interactionID, err := RequiredText(payload["interactionId"], "chat_interaction_id_required")
	if err != nil {
		return nil, err
	}
	choiceID, err := RequiredText(payload["choiceId"], "chat_interaction_choice_required")
	if err != nil {
		return nil, err
	}
	rev, _ := asSafeInt64(payload["revision"])

	s.mu.Lock()
	pending := s.pending[interactionID]
	s.mu.Unlock()
	if pending == nil {
		return nil, NewError("chat_interaction_not_live", http.StatusConflict, nil)
	}
	return s.resolvePending(ctx, pending, int(rev), choiceID, "")
}

// ResolveDecision 处理来自兼容 REST 端点的 allow/deny 审批决策。
func (s *NativeApprovalSurface) ResolveDecision(ctx context.Context, interactionID, decision, message string) (bool, error) {
	id := strings.TrimSpace(interactionID)
	if s == nil || id == "" {
		return false, nil
	}
	s.mu.Lock()
	pending := s.pending[id]
	s.mu.Unlock()
	if pending == nil {
		return false, nil
	}
	choiceID := "deny"
	if strings.EqualFold(strings.TrimSpace(decision), "allow") {
		choiceID = "allow"
	}
	rev := 1
	if pending.interaction != nil && pending.interaction.Revision > 0 {
		rev = pending.interaction.Revision
	}
	if _, err := s.resolvePending(ctx, pending, rev, choiceID, message); err != nil {
		return false, err
	}
	return true, nil
}

func (s *NativeApprovalSurface) resolvePending(
	ctx context.Context,
	pending *nativePendingApproval,
	rev int,
	choiceID string,
	message string,
) (map[string]any, error) {
	interactionID := pending.interaction.InteractionID
	behavior := "deny"
	if choiceID == "allow" || choiceID == "allow_session" || choiceID == "install" || strings.HasPrefix(choiceID, "accept") {
		behavior = "allow"
	}
	decision := map[string]any{
		"choiceId": choiceID,
		"behavior": behavior,
	}
	if behavior == "allow" {
		updated := CloneMap(pending.input)
		if updated == nil {
			updated = map[string]any{}
		}
		decision["updatedInput"] = updated
	} else if msg := strings.TrimSpace(message); msg != "" {
		decision["message"] = msg
	}

	coord := NewInteractionResolutionCoordinator(s.store, nil)
	out, err := coord.Resolve(ctx, interactionID, ResolveInteractionInput{
		SessionID:  s.sessionID,
		Kind:       "approval",
		Revision:   rev,
		Resolution: map[string]any{"choiceId": choiceID},
	}, func(_ *Interaction) (map[string]any, error) {
		if pending.onResolve != nil {
			pending.onResolve(decision)
		}
		select {
		case pending.done <- decision:
		default:
		}
		s.mu.Lock()
		delete(s.pending, interactionID)
		s.mu.Unlock()
		return decision, nil
	})
	if err != nil {
		return nil, err
	}
	return out.Response, nil
}

// CancelPending 在审批工具断开或运行取消时移除挂起审批并同步过期持久化交互。
func (s *NativeApprovalSurface) CancelPending(ctx context.Context, interactionID, reason string) bool {
	id := strings.TrimSpace(interactionID)
	if s == nil || id == "" {
		return false
	}
	s.mu.Lock()
	entry := s.pending[id]
	if entry != nil {
		delete(s.pending, id)
	}
	s.mu.Unlock()
	if entry == nil {
		return false
	}
	if s.store != nil {
		cleanupCtx := ctx
		if cleanupCtx == nil || cleanupCtx.Err() != nil {
			var cancel context.CancelFunc
			cleanupCtx, cancel = context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
		}
		_, _ = s.store.ExpireInteraction(cleanupCtx, id, firstNonEmptyStr(reason, "cancelled"))
	}
	select {
	case entry.done <- map[string]any{
		"behavior": "deny",
		"choiceId": "cancel",
		"message":  firstNonEmptyStr(reason, "cancelled"),
	}:
	default:
	}
	return true
}

// Dispose 取消所有悬而未决的审批等待并清理持久化交互状态。
func (s *NativeApprovalSurface) Dispose() {
	s.mu.Lock()
	entries := make(map[string]*nativePendingApproval, len(s.pending))
	for k, e := range s.pending {
		entries[k] = e
		delete(s.pending, k)
	}
	s.mu.Unlock()
	if len(entries) == 0 {
		return
	}
	cleanupCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	for id, e := range entries {
		if s.store != nil {
			_, _ = s.store.ExpireInteraction(cleanupCtx, id, "disposed")
		}
		select {
		case e.done <- map[string]any{"behavior": "deny", "choiceId": "cancel"}:
		default:
		}
	}
}

// NativeStreamChunk 描述从 CLI 流式输出解析出的一条语义增量。
type NativeStreamChunk struct {
	Type              string
	Delta             string
	Thinking          string
	Content           string
	Message           string
	SessionID         string
	Terminal          bool
	ClaudeResultError bool
	Usage             map[string]any
}

// NativeStreamState 跟踪单次 CLI 运行的流式累积文本与去重状态。
type NativeStreamState struct {
	SessionID       string
	Content         string
	ThinkingContent string
	FailureMessage  string
	Usage           map[string]any
	SeenToolUseIDs  map[string]struct{}
}

// ParseNativeStreamLine 解析各 Provider CLI 的一行 JSONL 流输出，并返回标准化流事件切片。
func ParseNativeStreamLine(provider, line string, state *NativeStreamState) []NativeStreamChunk {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" || state == nil {
		return nil
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(trimmed), &parsed); err != nil || parsed == nil {
		return nil
	}
	if state.SeenToolUseIDs == nil {
		state.SeenToolUseIDs = make(map[string]struct{})
	}
	prov := sessionchat.NormalizeProvider(provider)

	switch prov {
	case "grok":
		typ := asString(parsed["type"])
		if typ == "text" {
			if txt, ok := parsed["data"].(string); ok && txt != "" {
				state.Content += txt
				return []NativeStreamChunk{{Type: "delta", Delta: txt}}
			}
		}
		if typ == "thought" {
			if txt, ok := parsed["data"].(string); ok && txt != "" {
				state.ThinkingContent += txt
				return []NativeStreamChunk{{Type: "thinking", Thinking: txt}}
			}
		}
		if typ == "end" {
			var out []NativeStreamChunk
			if sid := strings.TrimSpace(asString(parsed["sessionId"])); sid != "" && state.SessionID == "" {
				state.SessionID = sid
				out = append(out, NativeStreamChunk{Type: "session-created", SessionID: sid})
			}
			out = append(out, NativeStreamChunk{Type: "result", Content: state.Content, Terminal: true})
			return out
		}
		if typ == "error" {
			return []NativeStreamChunk{{Type: "error", Message: firstNonEmptyStr(asString(parsed["message"]), "grok_stream_failed"), Terminal: true}}
		}
		return nil

	case "gemini":
		typ := asString(parsed["type"])
		if typ == "init" {
			if sid := strings.TrimSpace(asString(parsed["session_id"])); sid != "" && state.SessionID == "" {
				state.SessionID = sid
				return []NativeStreamChunk{{Type: "session-created", SessionID: sid}}
			}
		}
		if typ == "message" && asString(parsed["role"]) == "assistant" {
			txt := asString(parsed["content"])
			direct, _ := parsed["delta"].(bool)
			delta := computeStreamDelta(state.Content, txt, direct)
			state.Content += delta
			if delta != "" {
				return []NativeStreamChunk{{Type: "delta", Delta: delta}}
			}
			return nil
		}
		if typ == "result" {
			resText := strings.TrimSpace(asString(parsed["result"]))
			if resText != "" && state.Content == "" {
				state.Content = resText
			}
			if asString(parsed["status"]) == "error" {
				errObj := asMap(parsed["error"])
				msg := firstNonEmptyStr(asString(errObj["message"]), asString(parsed["message"]), resText, "gemini_stream_failed")
				state.FailureMessage = msg
				return []NativeStreamChunk{{Type: "error", Message: msg, Terminal: true}}
			}
			return []NativeStreamChunk{{Type: "result", Content: firstNonEmptyStr(state.Content, resText), Terminal: true}}
		}
		return nil

	case "codex":
		typ := asString(parsed["type"])
		if typ == "session_meta" {
			if p := asMap(parsed["payload"]); p != nil && asString(p["id"]) != "" && state.SessionID == "" {
				state.SessionID = strings.TrimSpace(asString(p["id"]))
				return []NativeStreamChunk{{Type: "session-created", SessionID: state.SessionID}}
			}
		}
		if typ == "thread.started" {
			if tid := strings.TrimSpace(asString(parsed["thread_id"])); tid != "" && state.SessionID == "" {
				state.SessionID = tid
				return []NativeStreamChunk{{Type: "session-created", SessionID: tid}}
			}
		}
		if typ == "item.completed" {
			item := asMap(parsed["item"])
			if item != nil && asString(item["type"]) == "agent_message" {
				txt := asString(item["text"])
				delta := computeStreamDelta(state.Content, txt, false)
				state.Content += delta
				if delta != "" {
					return []NativeStreamChunk{{Type: "delta", Delta: delta}}
				}
			}
		}
		if typ == "turn.failed" || typ == "error" {
			errObj := asMap(parsed["error"])
			msg := firstNonEmptyStr(asString(errObj["message"]), asString(parsed["message"]), state.FailureMessage, "codex_stream_failed")
			state.FailureMessage = msg
			return []NativeStreamChunk{{Type: "error", Message: msg, Terminal: true}}
		}
		if typ == "turn.completed" {
			if state.Content == "" && state.FailureMessage != "" {
				return []NativeStreamChunk{{Type: "error", Message: state.FailureMessage, Terminal: true}}
			}
			return []NativeStreamChunk{{Type: "result", Content: state.Content, Terminal: true}}
		}
		return nil

	case "opencode":
		if sid := strings.TrimSpace(asString(parsed["sessionID"])); sid != "" && state.SessionID == "" {
			state.SessionID = sid
			return []NativeStreamChunk{{Type: "session-created", SessionID: sid}}
		}
		typ := asString(parsed["type"])
		if typ == "text" {
			part := asMap(parsed["part"])
			if part != nil {
				if txt, ok := part["text"].(string); ok {
					delta := computeStreamDelta(state.Content, txt, false)
					state.Content += delta
					if delta != "" {
						return []NativeStreamChunk{{Type: "delta", Delta: delta}}
					}
				}
			}
		}
		if typ == "step_finish" {
			return []NativeStreamChunk{{Type: "result", Content: state.Content, Terminal: true}}
		}
		if typ == "error" {
			return []NativeStreamChunk{{Type: "error", Message: firstNonEmptyStr(asString(parsed["message"]), "opencode_stream_failed"), Terminal: true}}
		}
		return nil

	default:
		// claude / qoder / qodercn / codebuddy* / workbuddy* / zcode / agy / kiro
		typ := asString(parsed["type"])
		if typ == "system" && asString(parsed["subtype"]) == "init" {
			if sid := strings.TrimSpace(asString(parsed["session_id"])); sid != "" && state.SessionID == "" {
				state.SessionID = sid
				return []NativeStreamChunk{{Type: "session-created", SessionID: sid}}
			}
		}
		if typ == "stream_event" {
			ev := asMap(parsed["event"])
			if asString(ev["type"]) == "content_block_delta" {
				deltaObj := asMap(ev["delta"])
				dTyp := asString(deltaObj["type"])
				if dTyp == "text_delta" {
					if txt, ok := deltaObj["text"].(string); ok && txt != "" {
						delta := computeStreamDelta(state.Content, txt, false)
						if delta != "" {
							state.Content += delta
							return []NativeStreamChunk{{Type: "delta", Delta: delta}}
						}
					}
				}
				if dTyp == "thinking_delta" {
					if txt, ok := deltaObj["thinking"].(string); ok && txt != "" {
						delta := computeStreamDelta(state.ThinkingContent, txt, false)
						if delta != "" {
							state.ThinkingContent += delta
							return []NativeStreamChunk{{Type: "thinking", Thinking: delta}}
						}
					}
				}
			}
			return nil
		}
		if typ == "assistant" {
			var out []NativeStreamChunk
			msg := asMap(parsed["message"])
			blocks, _ := msg["content"].([]any)
			var textParts strings.Builder
			for _, rawB := range blocks {
				b := asMap(rawB)
				if b == nil {
					continue
				}
				switch asString(b["type"]) {
				case "thinking":
					if th, ok := b["thinking"].(string); ok && strings.TrimSpace(th) != "" {
						delta := computeStreamDelta(state.ThinkingContent, th, false)
						if delta != "" {
							state.ThinkingContent += delta
							out = append(out, NativeStreamChunk{Type: "thinking", Thinking: delta})
						}
					}
				case "text":
					if tx, ok := b["text"].(string); ok {
						textParts.WriteString(tx)
					}
				case "tool_use":
					tid := firstNonEmptyStr(asString(b["id"]), asString(b["name"]))
					if tid != "" {
						if _, seen := state.SeenToolUseIDs[tid]; !seen {
							state.SeenToolUseIDs[tid] = struct{}{}
							out = append(out, NativeStreamChunk{
								Type:  "tool_use",
								Delta: fmt.Sprintf("[tool:%s]", asString(b["name"])),
							})
						}
					}
				}
			}
			if full := textParts.String(); full != "" {
				delta := computeStreamDelta(state.Content, full, false)
				if delta != "" {
					state.Content += delta
					out = append(out, NativeStreamChunk{Type: "delta", Delta: delta})
				}
			}
			return out
		}
		if typ == "result" {
			resText := strings.TrimSpace(asString(parsed["result"]))
			if resText != "" && state.Content == "" {
				state.Content = resText
			}
			usage := extractStreamUsage(asMap(parsed["usage"]))
			if usage != nil {
				state.Usage = usage
			}
			isErr, _ := parsed["is_error"].(bool)
			if isErr {
				return []NativeStreamChunk{{
					Type:              "error",
					Message:           firstNonEmptyStr(resText, "claude_stream_failed"),
					Terminal:          true,
					ClaudeResultError: true,
				}}
			}
			return []NativeStreamChunk{{
				Type:     "result",
				Content:  firstNonEmptyStr(state.Content, resText),
				Usage:    usage,
				Terminal: true,
			}}
		}
		return nil
	}
}

func computeStreamDelta(prev, incoming string, preferDirect bool) string {
	if incoming == "" {
		return ""
	}
	if preferDirect || prev == "" {
		return incoming
	}
	if strings.HasPrefix(incoming, prev) {
		return incoming[len(prev):]
	}
	return incoming
}

func extractStreamUsage(raw map[string]any) map[string]any {
	if len(raw) == 0 {
		return nil
	}
	inTok, okIn := asSafeInt64(raw["input_tokens"])
	if !okIn {
		inTok, _ = asSafeInt64(raw["inputTokens"])
	}
	outTok, okOut := asSafeInt64(raw["output_tokens"])
	if !okOut {
		outTok, _ = asSafeInt64(raw["outputTokens"])
	}
	if inTok == 0 && outTok == 0 {
		return nil
	}
	return map[string]any{
		"inputTokens":  inTok,
		"outputTokens": outTok,
	}
}

// NativeRunRequest 描述单次 CLI 执行启动请求。
type NativeRunRequest struct {
	Session         *Session
	Provider        string
	AccountRef      string
	TurnID          string
	RunID           string
	Prompt          string
	ImagePaths      []string
	Model           string
	ApprovalMode    string
	NativeSessionID string
	Slash           bool
}

// NativeRunEvent 描述运行中从 CLI 输出产出的结构化流事件。
type NativeRunEvent struct {
	Type     string
	Delta    string
	Thinking string
	Content  string
	Message  string
	Usage    map[string]any
}

// NativeRunExit 描述 CLI 进程的最终退出结果。
type NativeRunExit struct {
	ExitCode  int
	SessionID string
	Stderr    string
	Err       error
}

// NativeRunHandle 表示已启动的底层原生 CLI 进程句柄。
// Runner 必须在最后一条事件后关闭 Events；Done 可以先到达，但其发送后不能再
// 等待消费者输入才关闭 Events。这样调用方能有序 drain 尾帧再结算进程终态。
type NativeRunHandle struct {
	RunID              string
	WriteSteer         func(content string) error
	WriteInput         func(input string, appendNewline bool) error
	Resize             func(cols, rows int) error
	Abort              func() error
	GetActivePrompt    func() map[string]any
	GetContentSnapshot func() string
	InteractionMode    string
	Events             <-chan NativeRunEvent
	SessionIDs         <-chan string
	Done               <-chan NativeRunExit
}

// NativeTurnRunner 启动单次官方 CLI 执行；默认实现拉起真实子进程，测试可替换为桩实现。
type NativeTurnRunner interface {
	Start(ctx context.Context, req NativeRunRequest) (*NativeRunHandle, error)
}

// NativeDriverOptions 配置原生 CLI 会话驱动。
type NativeDriverOptions struct {
	Session                 *Session
	Runtime                 RuntimeDescriptor
	Store                   *PublishingStore
	AIHomeDir               string
	HostHomeDir             string
	ApprovalCallbackURL     string
	NodeExecutablePath      string
	Runner                  NativeTurnRunner
	ResolveFallbackAccounts func(ctx context.Context, provider, currentRef string) []string
	ReadModels              func(ctx context.Context, provider, accountRef string) []string
	GetAdoptedRun           func(engineRunID string) *NativeRunHandle
	ApprovalSpawners        map[string]bool
	ResolveDefaultModel     func(provider string) string
	OnRunRegistered         func(reg ActiveRunRegistration)
	OnRunUnregistered       func(runID string)
	OnSurfaceCreated        func(sessionID string, surface *NativeApprovalSurface)
	OnSurfaceDisposed       func(sessionID string, surface *NativeApprovalSurface)
	OnSurfaceRunBound       func(runID string, surface *NativeApprovalSurface)
	OnSurfaceRunUnbound     func(runID string, surface *NativeApprovalSurface)
}

// NativeSessionDriver 驱动除 Codex app-server 之外的所有官方 CLI 原生会话。
type NativeSessionDriver struct {
	opts             NativeDriverOptions
	session          *Session
	runtime          RuntimeDescriptor
	store            *PublishingStore
	provider         string
	approvalSurface  *NativeApprovalSurface
	runner           NativeTurnRunner
	approvalSpawners map[string]bool

	mu              sync.Mutex
	nativeSessionID string
	active          *nativeActiveRun
	disposed        bool
}

type nativeActiveRun struct {
	turnID string
	runID  string
	handle *NativeRunHandle
	done   chan ProviderRunResult
	// ready 在首个 attempt 的进程启动并完成控制面注册后关闭。
	// StartTurn 等待它，保证「运行对 ListActiveRuns 可见」时句柄已经可写/可 resize。
	ready     chan struct{}
	readyOnce sync.Once
}

// markReady 关闭 ready；重复调用安全，Start 失败路径也必须调用，避免提交方永久等待。
func (act *nativeActiveRun) markReady() {
	if act == nil {
		return
	}
	act.readyOnce.Do(func() {
		if act.ready != nil {
			close(act.ready)
		}
	})
}

// NewNativeSessionDriver 创建原生 CLI 会话驱动。
func NewNativeSessionDriver(opts NativeDriverOptions) (*NativeSessionDriver, error) {
	if opts.Session == nil || strings.TrimSpace(opts.Session.SessionID) == "" {
		return nil, NewError("native_driver_session_invalid", http.StatusUnprocessableEntity, nil)
	}
	if opts.Store == nil {
		return nil, NewError("native_driver_store_required", http.StatusInternalServerError, nil)
	}
	prov := sessionchat.NormalizeProvider(opts.Session.Provider)
	if prov == "" {
		return nil, NewError("native_driver_provider_required", http.StatusUnprocessableEntity, nil)
	}
	runner := opts.Runner
	if runner == nil {
		runner = &execNativeTurnRunner{
			aiHomeDir:           opts.AIHomeDir,
			hostHomeDir:         opts.HostHomeDir,
			approvalCallbackURL: opts.ApprovalCallbackURL,
		}
	}
	spawners := opts.ApprovalSpawners
	if spawners == nil {
		spawners = map[string]bool{spawnerNativeStream: true}
	}
	nativeSessionID := strings.TrimSpace(asString(opts.Session.RuntimeBinding["nativeSessionId"]))
	surface := NewNativeApprovalSurface(opts.Store, opts.Session.SessionID, prov, opts.Runtime.RuntimeScope)
	if opts.OnSurfaceCreated != nil {
		opts.OnSurfaceCreated(opts.Session.SessionID, surface)
	}
	return &NativeSessionDriver{
		opts:             opts,
		session:          opts.Session,
		runtime:          opts.Runtime,
		store:            opts.Store,
		provider:         prov,
		approvalSurface:  surface,
		runner:           runner,
		approvalSpawners: spawners,
		nativeSessionID:  nativeSessionID,
	}, nil
}

// ApprovalSurface 返回本驱动绑定的原生审批表面。
func (d *NativeSessionDriver) ApprovalSurface() *NativeApprovalSurface {
	if d == nil {
		return nil
	}
	return d.approvalSurface
}

// CreateNativeSessionDriverEntry 构建带有能力和命令处理器的 DriverEntry。
func CreateNativeSessionDriverEntry(opts NativeDriverOptions) (*DriverEntry, error) {
	drv, err := NewNativeSessionDriver(opts)
	if err != nil {
		return nil, err
	}
	handlers := map[string]CommandHandler{
		"approval.decide": func(ctx context.Context, hctx CommandHandlerContext) (map[string]any, error) {
			return drv.approvalSurface.Resolve(ctx, hctx.Command)
		},
		"turn.intervene": func(ctx context.Context, hctx CommandHandlerContext) (map[string]any, error) {
			payload := hctx.Command.Payload
			if asString(payload["mode"]) != "steer_current" {
				return nil, NewError("native_intervene_mode_unsupported", http.StatusUnprocessableEntity, map[string]any{"mode": payload["mode"]})
			}
			expected := asString(payload["expectedRunId"])
			if expected != "" {
				sess, err := hctx.Store.GetSession(ctx, hctx.SessionID)
				if err != nil {
					return nil, err
				}
				activeRunID := ""
				if sess != nil && sess.ActiveTurn != nil {
					activeRunID = sess.ActiveTurn.RunID
				}
				if sess == nil || activeRunID != expected || (sess.State != "running" && sess.State != "waiting_input") {
					return nil, NewError("chat_queue_boundary_superseded", http.StatusConflict, nil)
				}
			}
			return drv.Steer(asString(payload["content"]))
		},
		"runtime.prewarm": func(ctx context.Context, _ CommandHandlerContext) (map[string]any, error) {
			imported, skipped := drv.ImportHistory(ctx, false)
			return map[string]any{
				"ready":    true,
				"provider": drv.provider,
				"history":  map[string]any{"imported": imported, "skipped": skipped},
			}, nil
		},
	}
	return &DriverEntry{
		Driver:       drv,
		Handlers:     handlers,
		Capabilities: NativeSessionCapabilities(opts.Runtime, drv.provider, opts.HostHomeDir, drv.approvalSpawners),
		ComposerCatalog: func(ctx context.Context) (map[string]any, error) {
			return drv.readComposerCatalog(ctx), nil
		},
	}, nil
}

// SlashMode 声明原生 CLI 驱动以交互消息流方式执行 /slash 命令。
func (d *NativeSessionDriver) SlashMode() string { return "interactive" }

// ExecuteSlash 把交互式 slash 命令作为本轮消息提交给原生 CLI。
func (d *NativeSessionDriver) ExecuteSlash(ctx context.Context, tc DriverTurnContext) (*ProviderRun, error) {
	return d.StartTurn(ctx, tc)
}

// Dispose 关闭驱动并终止未结算的活动 CLI 进程。
func (d *NativeSessionDriver) Dispose() bool {
	d.mu.Lock()
	if d.disposed {
		d.mu.Unlock()
		return false
	}
	d.disposed = true
	act := d.active
	d.active = nil
	d.mu.Unlock()
	if act != nil && act.handle != nil && act.handle.Abort != nil {
		_ = act.handle.Abort()
	}
	if d.approvalSurface != nil {
		if d.opts.OnSurfaceDisposed != nil {
			d.opts.OnSurfaceDisposed(d.session.SessionID, d.approvalSurface)
		}
		d.approvalSurface.Dispose()
	}
	return true
}

// Steer 把正在运行的补充提示词写入 CLI stdin（如 claude stream-json）。
func (d *NativeSessionDriver) Steer(content string) (map[string]any, error) {
	val := strings.TrimSpace(content)
	if val == "" {
		return nil, NewError("chat_turn_content_required", http.StatusUnprocessableEntity, nil)
	}
	d.mu.Lock()
	act := d.active
	d.mu.Unlock()
	if act == nil || act.handle == nil || act.handle.WriteSteer == nil {
		return nil, NewError("native_session_run_not_active", http.StatusConflict, nil)
	}
	if err := act.handle.WriteSteer(val); err != nil {
		return nil, NewError("native_steer_unsupported", http.StatusConflict, map[string]any{"message": err.Error()})
	}
	return map[string]any{"accepted": true}, nil
}

// InterruptTurn 终止当前活动的原生 CLI 进程。
func (d *NativeSessionDriver) InterruptTurn(_ context.Context, _ DriverTurnContext) error {
	d.mu.Lock()
	act := d.active
	d.mu.Unlock()
	if act != nil && act.handle != nil && act.handle.Abort != nil {
		return act.handle.Abort()
	}
	return nil
}

// RecoverTurn 重连到服务器重启前遗留的已收养运行（若找不到则 409 fail-closed）。
func (d *NativeSessionDriver) RecoverTurn(ctx context.Context, in RecoverTurnInput) (*ProviderRun, error) {
	d.mu.Lock()
	if d.disposed {
		d.mu.Unlock()
		return nil, NewError("native_session_driver_closed", http.StatusGone, nil)
	}
	if d.active != nil {
		d.mu.Unlock()
		return nil, NewError("chat_turn_already_active", http.StatusConflict, nil)
	}
	d.mu.Unlock()

	engineRunID := ""
	if in.ActiveTurn != nil {
		engineRunID = strings.TrimSpace(in.ActiveTurn.NativeTurnID)
	}
	var handle *NativeRunHandle
	if d.opts.GetAdoptedRun != nil && engineRunID != "" {
		handle = d.opts.GetAdoptedRun(engineRunID)
	}
	if handle == nil || handle.Done == nil {
		return nil, NewError("chat_turn_recovery_unavailable", http.StatusConflict, map[string]any{"engineRunId": engineRunID})
	}
	act := &nativeActiveRun{
		turnID: in.TurnID,
		runID:  in.RunID,
		handle: handle,
		done:   make(chan ProviderRunResult, 1),
	}
	d.mu.Lock()
	d.active = act
	d.mu.Unlock()

	go func() {
		defer d.clearActive(act)
		exit := <-handle.Done
		if sid := strings.TrimSpace(exit.SessionID); sid != "" && sid != d.getNativeSessionID() {
			d.bindNativeSessionID(ctx, sid)
		}
		_, _ = d.ImportHistory(ctx, true)
		if exit.ExitCode != 0 || exit.Err != nil {
			act.done <- ProviderRunResult{Err: NewError("native_session_failed", http.StatusBadGateway, map[string]any{
				"detail": fmt.Sprintf("exit %d", exit.ExitCode),
			})}
			return
		}
		act.done <- ProviderRunResult{Result: map[string]any{"turnId": in.TurnID, "runId": in.RunID}}
	}()

	return &ProviderRun{
		NativeTurnID: engineRunID,
		Done:         act.done,
		Abandon: func(_ string) string {
			if handle.Abort != nil {
				_ = handle.Abort()
			}
			return "completed"
		},
	}, nil
}

// StartTurn 启动新一轮原生 CLI 对话并支持账号级 fallback 自动重试（上限 3 次）。
func (d *NativeSessionDriver) StartTurn(ctx context.Context, tc DriverTurnContext) (*ProviderRun, error) {
	d.mu.Lock()
	if d.disposed {
		d.mu.Unlock()
		return nil, NewError("native_session_driver_closed", http.StatusGone, nil)
	}
	if d.active != nil {
		d.mu.Unlock()
		return nil, NewError("chat_turn_already_active", http.StatusConflict, nil)
	}
	d.mu.Unlock()

	var payload map[string]any
	if tc.Command != nil {
		payload = tc.Command.Payload
	}
	isSlash := tc.Command != nil && tc.Command.Type == "slash.execute"
	rawText := strings.TrimSpace(asString(payload["content"]))
	if isSlash {
		sname := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(asString(payload["name"])), "/"))
		sargs := strings.TrimSpace(asString(payload["arguments"]))
		rawText = "/" + sname
		if sargs != "" {
			rawText += " " + sargs
		}
	}

	var attachmentPaths []string
	if rawIDs, ok := payload["attachmentIds"]; ok && rawIDs != nil {
		if ids, nerr := NormalizeAttachmentIDs(rawIDs, false); nerr != nil {
			return nil, nerr
		} else if len(ids) > 0 {
			paths, perr := d.store.ResolveAttachmentPaths(ctx, d.session.SessionID, ids)
			if perr != nil {
				return nil, perr
			}
			attachmentPaths = paths
		}
	}
	sess := d.currentSession(ctx)
	turnIn, err := SessionAttachmentTurnInput(sess, rawText, attachmentPaths)
	if err != nil {
		return nil, err
	}
	prompt := turnIn.Prompt
	imagePaths := append([]string(nil), turnIn.ImagePaths...)
	if len(imagePaths) == 0 && len(tc.ImagePaths) > 0 {
		imagePaths = append([]string(nil), tc.ImagePaths...)
	}
	if prompt == "" && len(imagePaths) == 0 {
		return nil, NewError("chat_turn_content_required", http.StatusUnprocessableEntity, nil)
	}

	model := strings.TrimSpace(asString(payload["model"]))
	if model == "" {
		model = strings.TrimSpace(asString(sess.Policy["model"]))
	}
	if model == "" && d.opts.ResolveDefaultModel != nil {
		model = strings.TrimSpace(d.opts.ResolveDefaultModel(d.provider))
	}

	approvalMode := "bypass"
	if !isSlash {
		if m := strings.ToLower(strings.TrimSpace(asString(sess.Policy["approvalMode"]))); m != "" {
			approvalMode = m
		}
	}
	approvalRes := ResolveNativeApprovalTransport(d.provider, approvalMode, d.approvalSpawners)
	if approvalRes.Support == "unsupported" {
		return nil, NewError("native_session_approval_bridge_unavailable", http.StatusNotImplemented, map[string]any{
			"provider":     d.provider,
			"approvalMode": approvalMode,
			"reason":       approvalRes.Reason,
		})
	}
	if approvalRes.Support == "native" && d.approvalSurface != nil {
		d.approvalSurface.BindRun(tc.RunID)
	}

	accounts := []string{strings.TrimSpace(sess.ExecutionAccountRef)}
	if d.opts.ResolveFallbackAccounts != nil {
		accounts = append(accounts, d.opts.ResolveFallbackAccounts(ctx, d.provider, sess.ExecutionAccountRef)...)
	}
	accounts = dedupeNonEmptyStrings(accounts)
	if len(accounts) == 0 {
		accounts = []string{""}
	}
	if len(accounts) > nativeMaxAccountAttempts {
		accounts = accounts[:nativeMaxAccountAttempts]
	}

	act := &nativeActiveRun{
		turnID: tc.TurnID,
		runID:  tc.RunID,
		done:   make(chan ProviderRunResult, 1),
		ready:  make(chan struct{}),
	}
	d.mu.Lock()
	d.active = act
	d.mu.Unlock()

	go d.executeWithRetries(ctx, act, tc, sess, prompt, imagePaths, model, approvalMode, isSlash, accounts)
	// 等到首帧进程真正启动并注册后再返回，避免出现「ListActiveRuns 已列出、
	// ResizeRun/WriteRunInput 却报 run_not_found」的可见性窗口。
	// ctx 取消时不继续等：驱动会按 ctx 终止启动，结算走原有失败路径。
	select {
	case <-act.ready:
	case <-ctx.Done():
	}

	return &ProviderRun{
		NativeTurnID: tc.RunID,
		Done:         act.done,
		Abandon: func(_ string) string {
			d.mu.Lock()
			h := act.handle
			d.mu.Unlock()
			if h != nil && h.Abort != nil {
				_ = h.Abort()
			}
			return "abandoned"
		},
	}, nil
}

func (d *NativeSessionDriver) executeWithRetries(
	ctx context.Context,
	act *nativeActiveRun,
	tc DriverTurnContext,
	sess *Session,
	prompt string,
	imagePaths []string,
	model string,
	approvalMode string,
	isSlash bool,
	accounts []string,
) {
	defer d.clearActive(act)
	if d.opts.OnSurfaceRunBound != nil && d.approvalSurface != nil {
		d.opts.OnSurfaceRunBound(tc.RunID, d.approvalSurface)
		defer d.opts.OnSurfaceRunUnbound(tc.RunID, d.approvalSurface)
	}

	assistantItemID := "native-assistant-" + tc.TurnID
	thinkingItemID := "native-thinking-" + tc.TurnID
	terminalItemID := "native-terminal-" + tc.RunID
	var assistantStarted, thinkingStarted, terminalStarted bool
	var snapshotMu sync.Mutex
	var fullContent, fullThinking, fullTerminal strings.Builder
	var lastUsage map[string]any
	startedAt := time.Now().UnixMilli()

	appendAssistantDelta := func(textDelta string) {
		if textDelta == "" {
			return
		}
		if !assistantStarted {
			assistantStarted = true
			d.emitTimelineEvent(ctx, "timeline.item.started", tc, assistantItemID, map[string]any{
				"item": map[string]any{
					"id":     assistantItemID,
					"turnId": tc.TurnID,
					"kind":   "message",
					"status": "running",
					"detail": map[string]any{"role": "assistant", "model": model},
				},
			})
		}
		snapshotMu.Lock()
		fullContent.WriteString(textDelta)
		snapshotMu.Unlock()
		d.emitTimelineEvent(ctx, "timeline.item.delta", tc, assistantItemID, map[string]any{
			"itemId": assistantItemID,
			"chunk":  textDelta,
		})
	}

	appendTerminalDelta := func(chunk string) {
		if chunk == "" {
			return
		}
		if !terminalStarted {
			terminalStarted = true
			d.emitTimelineEvent(ctx, "timeline.item.started", tc, terminalItemID, map[string]any{
				"item": map[string]any{
					"id":     terminalItemID,
					"turnId": tc.TurnID,
					"kind":   "terminal",
					"status": "running",
					"detail": map[string]any{"stream": "stdout", "terminalId": tc.RunID},
				},
			})
		}
		snapshotMu.Lock()
		fullTerminal.WriteString(chunk)
		snapshotMu.Unlock()
		d.emitTimelineEvent(ctx, "timeline.item.delta", tc, terminalItemID, map[string]any{
			"itemId": terminalItemID,
			"chunk":  chunk,
		})
	}

	completeTerminalItem := func(status string) {
		if !terminalStarted {
			return
		}
		snapshotMu.Lock()
		terminalText := fullTerminal.String()
		snapshotMu.Unlock()
		d.emitTimelineEvent(ctx, "timeline.item.completed", tc, terminalItemID, map[string]any{
			"item": map[string]any{
				"id":      terminalItemID,
				"turnId":  tc.TurnID,
				"kind":    "terminal",
				"status":  status,
				"content": terminalText,
				"detail":  map[string]any{"stream": "stdout", "terminalId": tc.RunID},
			},
		})
		terminalStarted = false
	}

	for attemptIdx, accountRef := range accounts {
		snapshotMu.Lock()
		hasPriorContent := fullContent.Len() > 0
		snapshotMu.Unlock()
		continuation := attemptIdx > 0 && hasPriorContent && d.getNativeSessionID() != ""
		attemptPrompt := prompt
		attemptImages := imagePaths
		if continuation {
			attemptPrompt = nativeContinuePrompt
			attemptImages = nil
		}
		handle, err := d.runner.Start(ctx, NativeRunRequest{
			Session:         sess,
			Provider:        d.provider,
			AccountRef:      accountRef,
			TurnID:          tc.TurnID,
			RunID:           tc.RunID,
			Prompt:          attemptPrompt,
			ImagePaths:      attemptImages,
			Model:           model,
			ApprovalMode:    approvalMode,
			NativeSessionID: d.getNativeSessionID(),
			Slash:           isSlash,
		})
		if err != nil {
			act.markReady()
			completeTerminalItem("failed")
			act.done <- ProviderRunResult{Err: err}
			return
		}
		d.mu.Lock()
		act.handle = handle
		disposed := d.disposed
		d.mu.Unlock()
		if disposed {
			// Dispose 早于 Start 返回时，abort 发生时还没有句柄可终止。
			// 这里补上「句柄迟到」的终止，否则进程会挂到服务关闭之后。
			if handle.Abort != nil {
				_ = handle.Abort()
			}
		}

		registeredID := ""
		if d.opts.OnRunRegistered != nil {
			registeredID = firstNonEmptyStr(handle.RunID, tc.RunID)
			getSnapshot := handle.GetContentSnapshot
			if getSnapshot == nil {
				getSnapshot = func() string {
					snapshotMu.Lock()
					defer snapshotMu.Unlock()
					if fullTerminal.Len() > 0 {
						return fullTerminal.String()
					}
					return fullContent.String()
				}
			}
			d.opts.OnRunRegistered(ActiveRunRegistration{
				RunID:              registeredID,
				Provider:           d.provider,
				AccountRef:         accountRef,
				SessionID:          d.session.SessionID,
				ProjectDirName:     strings.TrimSpace(asString(sess.Policy["projectDirName"])),
				ProjectPath:        strings.TrimSpace(sess.ProjectPath),
				StartedAt:          startedAt,
				InteractionMode:    firstNonEmptyStr(handle.InteractionMode, approvalMode, "default"),
				Mode:               "native-session",
				WriteInput:         handle.WriteInput,
				WriteSteer:         handle.WriteSteer,
				Resize:             handle.Resize,
				Abort:              handle.Abort,
				GetActivePrompt:    handle.GetActivePrompt,
				GetContentSnapshot: getSnapshot,
			})
		}
		act.markReady()
		unregisterAttempt := func() {
			if registeredID != "" && d.opts.OnRunUnregistered != nil {
				d.opts.OnRunUnregistered(registeredID)
				registeredID = ""
			}
		}

		var streamErrMsg string
		var exitResult NativeRunExit
		eventsCh := handle.Events
		sidsCh := handle.SessionIDs
		doneCh := handle.Done
		cancelCh := ctx.Done()

		// Done 只表示进程已退出；Events 的尾帧仍须经过下面唯一的事件处理分支。
		// 进程运行期间响应取消；已收到退出结果后完整收尾，不能因迟到取消丢终稿。
		running := true
		for running || eventsCh != nil {
			select {
			case sid, ok := <-sidsCh:
				if !ok {
					sidsCh = nil
					continue
				}
				if strings.TrimSpace(sid) != "" {
					d.bindNativeSessionID(ctx, sid)
				}
			case ev, ok := <-eventsCh:
				if !ok {
					eventsCh = nil
					continue
				}
				switch ev.Type {
				case "delta", "tool_use":
					appendAssistantDelta(ev.Delta)
				case "terminal_output":
					appendTerminalDelta(ev.Delta)
				case "thinking":
					if ev.Thinking == "" {
						continue
					}
					if !thinkingStarted {
						thinkingStarted = true
						d.emitTimelineEvent(ctx, "timeline.item.started", tc, thinkingItemID, map[string]any{
							"item": map[string]any{
								"id":     thinkingItemID,
								"turnId": tc.TurnID,
								"kind":   "reasoning",
								"status": "running",
							},
						})
					}
					fullThinking.WriteString(ev.Thinking)
					d.emitTimelineEvent(ctx, "timeline.item.delta", tc, thinkingItemID, map[string]any{
						"itemId": thinkingItemID,
						"chunk":  ev.Thinking,
					})
				case "result":
					if ev.Usage != nil {
						lastUsage = ev.Usage
					}
					snapshotMu.Lock()
					emptyAssistant := fullContent.Len() == 0
					snapshotMu.Unlock()
					if ev.Content != "" && emptyAssistant {
						assistantStarted = true
						snapshotMu.Lock()
						fullContent.WriteString(ev.Content)
						snapshotMu.Unlock()
						d.emitTimelineEvent(ctx, "timeline.item.started", tc, assistantItemID, map[string]any{
							"item": map[string]any{
								"id":     assistantItemID,
								"turnId": tc.TurnID,
								"kind":   "message",
								"status": "running",
								"detail": map[string]any{"role": "assistant", "model": model},
							},
						})
					}
				case "error":
					streamErrMsg = firstNonEmptyStr(ev.Message, "native_session_failed")
				}
			case exit := <-doneCh:
				exitResult = exit
				running = false
				doneCh = nil // 只接收一次退出结果，避免关闭后的 channel 在 drain 期间空转。
				cancelCh = nil
			case <-cancelCh:
				if handle.Abort != nil {
					_ = handle.Abort()
				}
				unregisterAttempt()
				completeTerminalItem("cancelled")
				act.done <- ProviderRunResult{Result: map[string]any{"status": "interrupted"}}
				return
			}
		}

		unregisterAttempt()

		if sid := strings.TrimSpace(exitResult.SessionID); sid != "" {
			d.bindNativeSessionID(ctx, sid)
		}
		if exitResult.ExitCode == 0 && exitResult.Err == nil && streamErrMsg == "" {
			if thinkingStarted {
				d.emitTimelineEvent(ctx, "timeline.item.completed", tc, thinkingItemID, map[string]any{
					"item": map[string]any{
						"id":      thinkingItemID,
						"turnId":  tc.TurnID,
						"kind":    "reasoning",
						"status":  "completed",
						"content": fullThinking.String(),
					},
				})
			}
			if assistantStarted {
				detail := map[string]any{"role": "assistant", "model": model}
				if lastUsage != nil {
					detail["metrics"] = map[string]any{"usage": lastUsage}
				}
				snapshotMu.Lock()
				contentStr := fullContent.String()
				snapshotMu.Unlock()
				d.emitTimelineEvent(ctx, "timeline.item.completed", tc, assistantItemID, map[string]any{
					"item": map[string]any{
						"id":      assistantItemID,
						"turnId":  tc.TurnID,
						"kind":    "message",
						"status":  "completed",
						"content": contentStr,
						"detail":  detail,
					},
				})
			}
			completeTerminalItem("completed")
			act.done <- ProviderRunResult{Result: map[string]any{"status": "completed"}}
			return
		}

		errDetail := firstNonEmptyStr(streamErrMsg, exitResult.Stderr)
		if exitResult.Err != nil && errDetail == "" {
			errDetail = exitResult.Err.Error()
		}
		codePtr := float64(exitResult.ExitCode)
		cls := sessionchat.ClassifyNativeSessionFailure(d.provider, &sessionchat.FailureError{
			Message: errDetail,
			Detail:  exitResult.Stderr,
		}, sessionchat.FailureOptions{ExitCode: &codePtr})
		if cls.RetryAnotherAccount && attemptIdx+1 < len(accounts) {
			nextRef := accounts[attemptIdx+1]
			noticeID := d.store.Store().NewID("notice")
			d.emitTimelineEvent(ctx, "timeline.item.completed", tc, noticeID, map[string]any{
				"item": map[string]any{
					"id":     noticeID,
					"turnId": tc.TurnID,
					"kind":   "notice",
					"status": "completed",
					"detail": map[string]any{"level": "info", "code": "account_switched", "accountRef": nextRef},
				},
			})
			_, _ = d.store.UpdateExecutionContext(ctx, d.session.SessionID, nextRef, nil, nil)
			continue
		}
		completeTerminalItem("failed")
		errCode := firstNonEmptyStr(cls.Code, "native_session_failed")
		act.done <- ProviderRunResult{Err: NewError(errCode, http.StatusBadGateway, map[string]any{
			"provider": d.provider,
			"detail":   errDetail,
		})}
		return
	}
}

// ImportHistory 从官方 CLI 本地会话文件幂等导入历史消息到 Canonical 时间线。
func (d *NativeSessionDriver) ImportHistory(ctx context.Context, force bool) (int, string) {
	sid := d.getNativeSessionID()
	if sid == "" {
		return 0, "no_session"
	}
	if !force {
		if page, err := d.store.ReadTimeline(ctx, d.session.SessionID, "", 20); err == nil && page != nil {
			for _, it := range page.Items {
				if it.Kind != "notice" {
					return 0, "timeline_not_empty"
				}
			}
		}
	}
	sess := d.currentSession(ctx)
	projectDirName := asString(sess.Policy["projectDirName"])
	snap, err := sessionread.ReadMessagesSnapshot(ctx, sessionread.Options{
		AIHomeDir:   d.opts.AIHomeDir,
		HostHomeDir: d.opts.HostHomeDir,
		AccountRef:  sess.ExecutionAccountRef,
	}, d.provider, sid, projectDirName)
	if err != nil {
		return 0, "import_failed"
	}
	if len(snap.Messages) == 0 {
		return 0, "empty_transcript"
	}
	src := EventSource{Provider: d.provider, RuntimeID: d.runtime.RuntimeScope}
	drafts := make([]EventDraft, 0, len(snap.Messages))
	for idx, rawMsg := range snap.Messages {
		var msg sessionread.Message
		if uerr := json.Unmarshal(rawMsg, &msg); uerr != nil {
			continue
		}
		role := strings.TrimSpace(msg.Role)
		if role != "user" && role != "assistant" {
			role = "assistant"
		}
		content := strings.TrimSpace(msg.Content)
		if content == "" {
			continue
		}
		itemID := fmt.Sprintf("native-import-%s-%d", sid, idx)
		turnID := fmt.Sprintf("native-turn-%s-%d", sid, idx/2)
		digest := sha1.Sum([]byte(fmt.Sprintf("%s:%d:%s:%s", sid, idx, role, content)))
		evID := "native-history:" + hex.EncodeToString(digest[:8])
		drafts = append(drafts, EventDraft{
			EventID: evID,
			Type:    "timeline.item.completed",
			TurnID:  turnID,
			ItemID:  itemID,
			Source:  src,
			Payload: map[string]any{
				"item": map[string]any{
					"id":        itemID,
					"turnId":    turnID,
					"kind":      "message",
					"status":    "completed",
					"createdAt": time.Now().UnixMilli(),
					"updatedAt": time.Now().UnixMilli(),
					"content":   content,
					"detail":    map[string]any{"role": role},
				},
			},
		})
	}
	res, err := d.store.ImportTimeline(ctx, d.session.SessionID, drafts)
	if err != nil || res == nil {
		return 0, "import_failed"
	}
	return len(res.Events), ""
}

func (d *NativeSessionDriver) readComposerCatalog(ctx context.Context) map[string]any {
	if d.opts.ReadModels == nil {
		return map[string]any{"models": []any{}, "defaultModel": ""}
	}
	ids := dedupeNonEmptyStrings(d.opts.ReadModels(ctx, d.provider, d.session.ExecutionAccountRef))
	models := make([]ComposerModelEntry, 0, len(ids))
	for _, id := range ids {
		models = append(models, ComposerModelEntry{
			ID:               id,
			Label:            id,
			SupportedEfforts: []string{},
			DefaultEffort:    "",
		})
	}
	defModel := ""
	if len(models) > 0 {
		defModel = models[0].ID
	}
	return map[string]any{"models": models, "defaultModel": defModel}
}

func (d *NativeSessionDriver) emitTimelineEvent(ctx context.Context, evType string, tc DriverTurnContext, itemID string, payload map[string]any) {
	if payload != nil {
		if item, ok := payload["item"].(map[string]any); ok && item != nil {
			now := time.Now().UnixMilli()
			if _, hasCreated := item["createdAt"]; !hasCreated {
				item["createdAt"] = now
			}
			if evType != "timeline.item.started" {
				if _, hasUpdated := item["updatedAt"]; !hasUpdated {
					item["updatedAt"] = now
				}
			}
			if _, hasDetail := item["detail"]; !hasDetail {
				item["detail"] = map[string]any{}
			}
		}
	}
	_, _ = d.store.AppendEvent(ctx, d.session.SessionID, EventDraft{
		Type:    evType,
		TurnID:  tc.TurnID,
		RunID:   tc.RunID,
		ItemID:  itemID,
		Source:  EventSource{Provider: d.provider, RuntimeID: d.runtime.RuntimeScope},
		Payload: payload,
	})
}

func (d *NativeSessionDriver) bindNativeSessionID(ctx context.Context, sid string) {
	clean := strings.TrimSpace(sid)
	if clean == "" {
		return
	}
	d.mu.Lock()
	d.nativeSessionID = clean
	d.mu.Unlock()
	_, _ = d.store.UpdateRuntimeBinding(ctx, d.session.SessionID, map[string]any{
		"nativeSessionId": clean,
		"fingerprint":     d.runtime.Fingerprint,
	}, nil)
}

func (d *NativeSessionDriver) getNativeSessionID() string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.nativeSessionID
}

func (d *NativeSessionDriver) clearActive(act *nativeActiveRun) {
	d.mu.Lock()
	if d.active == act {
		d.active = nil
	}
	d.mu.Unlock()
}

func (d *NativeSessionDriver) currentSession(ctx context.Context) *Session {
	if latest, err := d.store.GetSession(ctx, d.session.SessionID); err == nil && latest != nil {
		return latest
	}
	return d.session
}

type execNativeTurnRunner struct {
	aiHomeDir           string
	hostHomeDir         string
	approvalCallbackURL string
}

func (r *execNativeTurnRunner) Start(ctx context.Context, req NativeRunRequest) (*NativeRunHandle, error) {
	useInteractivePTY := req.Slash && pty.Available()
	var built sessionchat.Command
	var err error
	if strings.TrimSpace(req.NativeSessionID) != "" {
		built, err = sessionchat.BuildResumeCommand(req.Provider, sessionchat.ResumeOptions{
			Prompt:         req.Prompt,
			SessionID:      req.NativeSessionID,
			Model:          req.Model,
			ImagePaths:     req.ImagePaths,
			InteractiveCLI: useInteractivePTY,
			Platform:       runtime.GOOS,
		})
	} else {
		built, err = sessionchat.BuildStartCommand(req.Provider, sessionchat.StartOptions{
			Prompt:         req.Prompt,
			Model:          req.Model,
			ImagePaths:     req.ImagePaths,
			InteractiveCLI: useInteractivePTY,
			ProjectPath:    req.Session.ProjectPath,
			Platform:       runtime.GOOS,
		})
	}
	if err != nil {
		return nil, NewError(firstNonEmptyStr(sessionchat.ErrorCode(err), "native_command_build_failed"), http.StatusUnprocessableEntity, map[string]any{
			"message": err.Error(),
		})
	}
	binPath, err := providercli.ResolveBinary(req.Provider, built.CommandName)
	if err != nil {
		return nil, NewError("provider_cli_not_found", http.StatusServiceUnavailable, map[string]any{
			"provider": req.Provider,
			"message":  err.Error(),
		})
	}

	args := append([]string(nil), built.Args...)
	if runtimeDir := sessionread.ResolveAccountRuntimeDir(r.aiHomeDir, req.Provider, req.AccountRef); runtimeDir != "" {
		args = sessionchat.ApplyProviderConfigDirArgs(req.Provider, args, runtimeDir)
	}

	workDir := strings.TrimSpace(req.Session.ProjectPath)
	if workDir == "" {
		if dir, derr := ChatWorkingDirectory(r.aiHomeDir, req.Session.SessionID); derr == nil {
			workDir = dir
		}
	}

	if useInteractivePTY {
		return r.startInteractivePTY(ctx, req, binPath, args, workDir)
	}

	launchCleanup := func() {}
	if strings.EqualFold(req.Provider, "claude") {
		var updated []string
		updated, launchCleanup = configureClaudeApprovalArgs(
			r.aiHomeDir,
			r.approvalCallbackURL,
			req.RunID,
			req.ApprovalMode,
			args,
		)
		args = updated
	}

	return startNativeStreamProcess(ctx, req, binPath, args, workDir, launchCleanup)
}

func stringSliceContains(slice []string, target string) bool {
	for _, s := range slice {
		if s == target {
			return true
		}
	}
	return false
}

func dedupeNonEmptyStrings(in []string) []string {
	seen := make(map[string]struct{}, len(in))
	out := make([]string, 0, len(in))
	for _, s := range in {
		trimmed := strings.TrimSpace(s)
		if trimmed == "" {
			continue
		}
		if _, ok := seen[trimmed]; ok {
			continue
		}
		seen[trimmed] = struct{}{}
		out = append(out, trimmed)
	}
	return out
}

func dummyNativePathKeep() string { return filepath.Clean(".") }

func (r *execNativeTurnRunner) startInteractivePTY(
	ctx context.Context,
	req NativeRunRequest,
	binPath string,
	args []string,
	workDir string,
) (*NativeRunHandle, error) {
	runCtx, cancel := context.WithCancel(ctx)
	ptySess, err := pty.NewStarter().Start(runCtx, pty.Spec{
		Path: binPath,
		Args: args,
		Env:  os.Environ(),
		Dir:  workDir,
		Size: pty.Size{Rows: 30, Cols: 120},
	})
	if err != nil {
		cancel()
		return nil, err
	}

	eventsCh := make(chan NativeRunEvent, 64)
	sidsCh := make(chan string, 1)
	doneCh := make(chan NativeRunExit, 1)

	var ptyMu sync.Mutex
	var writeMu sync.Mutex
	closed := false
	markClosed := func() {
		ptyMu.Lock()
		closed = true
		ptyMu.Unlock()
	}
	isClosed := func() bool {
		ptyMu.Lock()
		defer ptyMu.Unlock()
		return closed
	}
	var closeOnce sync.Once
	closeTerminal := func() { closeOnce.Do(func() { _ = ptySess.Close() }) }
	var abortOnce sync.Once
	abort := func() {
		abortOnce.Do(func() {
			cancel()
			if killer, ok := ptySess.(interface{ Kill() error }); ok {
				_ = killer.Kill()
			}
			// 不等待持有 I/O 锁的写入者；关闭 PTY 先解除阻塞。
			closeTerminal()
			markClosed()
		})
	}
	stopCancellation := context.AfterFunc(runCtx, abort)

	go func() {
		defer close(doneCh)
		defer cancel()
		defer closeTerminal()
		defer stopCancellation()

		buf := make([]byte, 4096)
		var carry []byte
		for {
			n, rerr := ptySess.Read(buf)
			if n > 0 {
				chunk, nextCarry := splitCompleteUTF8(append(carry, buf[:n]...))
				carry = nextCarry
				if chunk != "" && !sendNativeRunEvent(runCtx, eventsCh, NativeRunEvent{
					Type: "terminal_output", Delta: chunk,
				}) {
					abort()
					break
				}
			}
			if rerr != nil {
				break
			}
		}
		if len(carry) > 0 {
			if !sendNativeRunEvent(runCtx, eventsCh, NativeRunEvent{
				Type: "terminal_output", Delta: string(carry),
			}) {
				abort()
			}
		}
		// 终端读端已结束后，子进程也必须有界退出；取消时 abort 会立即解除读写。
		exitTimer := time.AfterFunc(nativeStreamErrorSettleTimeout, abort)
		waitErr := ptySess.Wait()
		exitTimer.Stop()
		markClosed()
		closeTerminal()
		exitCode := 0
		if waitErr != nil {
			if ee, ok := waitErr.(*exec.ExitError); ok {
				exitCode = ee.ExitCode()
			} else {
				exitCode = 1
			}
		}
		close(eventsCh)
		close(sidsCh)
		doneCh <- NativeRunExit{
			ExitCode: exitCode,
			Err:      waitErr,
		}
	}()

	return &NativeRunHandle{
		RunID:           req.RunID,
		InteractionMode: firstNonEmptyStr(req.ApprovalMode, "default"),
		WriteInput: func(input string, appendNewline bool) error {
			writeMu.Lock()
			defer writeMu.Unlock()
			if isClosed() || runCtx.Err() != nil {
				return NewError("native_session_run_not_active", http.StatusConflict, nil)
			}
			payload := input
			if appendNewline && !strings.HasSuffix(payload, "\r") && !strings.HasSuffix(payload, "\n") {
				payload += "\r"
			}
			_, werr := ptySess.Write([]byte(payload))
			return werr
		},
		Resize: func(cols, rows int) error {
			if isClosed() || runCtx.Err() != nil {
				return NewError("native_session_run_not_active", http.StatusConflict, nil)
			}
			c := clampInt(cols, minRunTerminalCols, maxRunTerminalCols)
			rw := clampInt(rows, minRunTerminalRows, maxRunTerminalRows)
			return ptySess.Resize(pty.Size{Cols: uint16(c), Rows: uint16(rw)})
		},
		Abort:  func() error { abort(); return nil },
		Events: eventsCh, SessionIDs: sidsCh, Done: doneCh,
	}, nil
}

func splitCompleteUTF8(data []byte) (string, []byte) {
	if len(data) == 0 {
		return "", nil
	}
	// 保留末尾尚未构成完整 rune 的 UTF-8 前导字节到下一次读取。
	split := len(data)
	for split > 0 && len(data)-split < utf8.UTFMax {
		if utf8.RuneStart(data[split-1]) {
			if !utf8.FullRune(data[split-1:]) {
				split--
			}
			break
		}
		split--
	}
	return string(data[:split]), append([]byte(nil), data[split:]...)
}

func configureClaudeApprovalArgs(
	aiHomeDir string,
	approvalCallbackURL string,
	runID string,
	approvalMode string,
	args []string,
) ([]string, func()) {
	mode := strings.ToLower(strings.TrimSpace(approvalMode))
	if mode != "confirm" && mode != "plan" {
		return args, func() {}
	}
	permMode := "default"
	if mode == "plan" {
		permMode = "plan"
	}
	out := append(append([]string(nil), args...), "--permission-mode", permMode)
	cbURL := strings.TrimSpace(approvalCallbackURL)
	if cbURL == "" {
		return out, func() {}
	}
	// 审批工具就是宿主二进制自己的子命令：Claude 由它启动 MCP server，
	// 不再依赖 Node 脚本或 PATH 上的 node。
	toolExe, err := os.Executable()
	if err != nil || strings.TrimSpace(toolExe) == "" {
		return out, func() {}
	}
	rootDir := strings.TrimSpace(aiHomeDir)
	if rootDir == "" {
		rootDir = os.TempDir()
	}
	ctxDir := filepath.Join(rootDir, "run", "launch-context")
	if err := os.MkdirAll(ctxDir, 0o700); err != nil {
		return out, func() {}
	}
	ctxFile := filepath.Join(ctxDir, fmt.Sprintf("ctx-native-%s.json", randomControlID("lc")))
	ctxRaw, _ := json.Marshal(map[string]any{
		"approvalUrl": cbURL,
		"runId":       runID,
	})
	if err := os.WriteFile(ctxFile, ctxRaw, 0o600); err != nil {
		return out, func() {}
	}
	mcpCfg, _ := json.Marshal(map[string]any{
		"mcpServers": map[string]any{
			"aih": map[string]any{
				"command": toolExe,
				"args":    []string{"__mcp-approve"},
				"env": map[string]string{
					"AIH_LAUNCH_CONTEXT": ctxFile,
				},
			},
		},
	})
	out = append(out, "--permission-prompt-tool", "mcp__aih__approve", "--mcp-config", string(mcpCfg))
	return out, func() { _ = os.Remove(ctxFile) }
}

package chatruntime

import (
	"bufio"
	"context"
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/providercli"
	"github.com/madou1217/ai_home/internal/runtime/providercli/sessionchat"
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
	Choices       []NativeApprovalChoice
	RawPayload    map[string]any
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

// Request 创建待决审批交互并阻塞等待用户响应、取消或超时。
func (s *NativeApprovalSurface) Request(ctx context.Context, req NativeApprovalRequest) (map[string]any, error) {
	if s.store == nil {
		return nil, NewError("native_approval_store_unavailable", http.StatusInternalServerError, nil)
	}
	s.mu.Lock()
	runID := firstNonEmptyStr(req.RunID, s.runID)
	s.mu.Unlock()

	choices := make([]map[string]any, 0, len(req.Choices))
	for _, ch := range req.Choices {
		choices = append(choices, map[string]any{
			"id":     ch.ID,
			"label":  ch.Label,
			"intent": firstNonEmptyStr(ch.Intent, "neutral"),
		})
	}
	if len(choices) == 0 {
		choices = []map[string]any{
			{"id": "allow", "label": "允许一次", "intent": "accept"},
			{"id": "deny", "label": "拒绝", "intent": "deny"},
		}
	}
	payload := map[string]any{
		"toolName": firstNonEmptyStr(req.ToolName, "tool"),
		"choices":  choices,
		"presentation": map[string]any{
			"title":       firstNonEmptyStr(req.Title, "需要确认工具调用"),
			"description": req.Detail,
		},
	}
	for k, v := range req.RawPayload {
		payload[k] = v
	}

	inter, err := s.store.CreateInteraction(ctx, CreateInteractionInput{
		InteractionID: req.InteractionID,
		SessionID:     s.sessionID,
		ItemID:        firstNonEmptyStr(req.InteractionID, runID, req.TurnID),
		Kind:          "approval",
		Revision:      1,
		Payload:       payload,
	})
	if err != nil {
		return nil, err
	}
	entry := &nativePendingApproval{
		interaction: inter,
		onResolve:   req.OnResolve,
		done:        make(chan map[string]any, 1),
	}
	s.mu.Lock()
	s.pending[inter.InteractionID] = entry
	s.mu.Unlock()

	select {
	case dec := <-entry.done:
		return dec, nil
	case <-ctx.Done():
		s.mu.Lock()
		delete(s.pending, inter.InteractionID)
		s.mu.Unlock()
		return map[string]any{"behavior": "deny", "choiceId": "deny"}, ctx.Err()
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

	behavior := "deny"
	if choiceID == "allow" || choiceID == "allow_session" || choiceID == "install" || strings.HasPrefix(choiceID, "accept") {
		behavior = "allow"
	}
	decision := map[string]any{
		"choiceId": choiceID,
		"behavior": behavior,
	}

	coord := NewInteractionResolutionCoordinator(s.store, nil)
	out, err := coord.Resolve(ctx, interactionID, ResolveInteractionInput{
		SessionID:  s.sessionID,
		Kind:       "approval",
		Revision:   int(rev),
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

// Dispose 取消所有悬而未决的审批等待。
func (s *NativeApprovalSurface) Dispose() {
	s.mu.Lock()
	entries := make([]*nativePendingApproval, 0, len(s.pending))
	for k, e := range s.pending {
		entries = append(entries, e)
		delete(s.pending, k)
	}
	s.mu.Unlock()
	for _, e := range entries {
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
type NativeRunHandle struct {
	RunID      string
	WriteSteer func(content string) error
	Abort      func() error
	Events     <-chan NativeRunEvent
	SessionIDs <-chan string
	Done       <-chan NativeRunExit
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
	Runner                  NativeTurnRunner
	ResolveFallbackAccounts func(ctx context.Context, provider, currentRef string) []string
	ReadModels              func(ctx context.Context, provider, accountRef string) []string
	GetAdoptedRun           func(engineRunID string) *NativeRunHandle
	ApprovalSpawners        map[string]bool
	ResolveDefaultModel     func(provider string) string
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
			aiHomeDir:   opts.AIHomeDir,
			hostHomeDir: opts.HostHomeDir,
		}
	}
	spawners := opts.ApprovalSpawners
	if spawners == nil {
		spawners = map[string]bool{spawnerNativeStream: true}
	}
	nativeSessionID := strings.TrimSpace(asString(opts.Session.RuntimeBinding["nativeSessionId"]))
	return &NativeSessionDriver{
		opts:             opts,
		session:          opts.Session,
		runtime:          opts.Runtime,
		store:            opts.Store,
		provider:         prov,
		approvalSurface:  NewNativeApprovalSurface(opts.Store, opts.Session.SessionID, prov, opts.Runtime.RuntimeScope),
		runner:           runner,
		approvalSpawners: spawners,
		nativeSessionID:  nativeSessionID,
	}, nil
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
	}
	d.mu.Lock()
	d.active = act
	d.mu.Unlock()

	go d.executeWithRetries(ctx, act, tc, sess, prompt, imagePaths, model, approvalMode, isSlash, accounts)

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

	assistantItemID := "native-assistant-" + tc.TurnID
	thinkingItemID := "native-thinking-" + tc.TurnID
	var assistantStarted, thinkingStarted bool
	var fullContent, fullThinking strings.Builder
	var lastUsage map[string]any

	for attemptIdx, accountRef := range accounts {
		continuation := attemptIdx > 0 && fullContent.Len() > 0 && d.getNativeSessionID() != ""
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
			act.done <- ProviderRunResult{Err: err}
			return
		}
		d.mu.Lock()
		act.handle = handle
		d.mu.Unlock()

		var streamErrMsg string
		var exitResult NativeRunExit
		eventsCh := handle.Events
		sidsCh := handle.SessionIDs
		doneCh := handle.Done

		running := true
		for running {
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
					textDelta := ev.Delta
					if textDelta == "" {
						continue
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
					fullContent.WriteString(textDelta)
					d.emitTimelineEvent(ctx, "timeline.item.delta", tc, assistantItemID, map[string]any{
						"itemId": assistantItemID,
						"chunk":  textDelta,
					})
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
					if ev.Content != "" && fullContent.Len() == 0 {
						assistantStarted = true
						fullContent.WriteString(ev.Content)
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
			case <-ctx.Done():
				if handle.Abort != nil {
					_ = handle.Abort()
				}
				act.done <- ProviderRunResult{Result: map[string]any{"status": "interrupted"}}
				return
			}
		}

		// 清空剩余通道缓冲事件
		for eventsCh != nil {
			ev, ok := <-eventsCh
			if !ok {
				break
			}
			if ev.Type == "delta" && ev.Delta != "" {
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
				fullContent.WriteString(ev.Delta)
				d.emitTimelineEvent(ctx, "timeline.item.delta", tc, assistantItemID, map[string]any{
					"itemId": assistantItemID,
					"chunk":  ev.Delta,
				})
			} else if ev.Type == "result" && ev.Usage != nil {
				lastUsage = ev.Usage
			} else if ev.Type == "error" && streamErrMsg == "" {
				streamErrMsg = ev.Message
			}
		}

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
				d.emitTimelineEvent(ctx, "timeline.item.completed", tc, assistantItemID, map[string]any{
					"item": map[string]any{
						"id":      assistantItemID,
						"turnId":  tc.TurnID,
						"kind":    "message",
						"status":  "completed",
						"content": fullContent.String(),
						"detail":  detail,
					},
				})
			}
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
	aiHomeDir   string
	hostHomeDir string
}

func (r *execNativeTurnRunner) Start(ctx context.Context, req NativeRunRequest) (*NativeRunHandle, error) {
	var built sessionchat.Command
	var err error
	if strings.TrimSpace(req.NativeSessionID) != "" {
		built, err = sessionchat.BuildResumeCommand(req.Provider, sessionchat.ResumeOptions{
			Prompt:     req.Prompt,
			SessionID:  req.NativeSessionID,
			Model:      req.Model,
			ImagePaths: req.ImagePaths,
			Platform:   runtime.GOOS,
		})
	} else {
		built, err = sessionchat.BuildStartCommand(req.Provider, sessionchat.StartOptions{
			Prompt:      req.Prompt,
			Model:       req.Model,
			ImagePaths:  req.ImagePaths,
			ProjectPath: req.Session.ProjectPath,
			Platform:    runtime.GOOS,
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
	runCtx, cancel := context.WithCancel(ctx)
	cmd := exec.CommandContext(runCtx, binPath, args...)
	if dir := strings.TrimSpace(req.Session.ProjectPath); dir != "" {
		cmd.Dir = dir
	} else if dir, derr := ChatWorkingDirectory(r.aiHomeDir, req.Session.SessionID); derr == nil {
		cmd.Dir = dir
	}
	cmd.Env = os.Environ()

	var stdinPipe io.WriteCloser
	usesStreamJSON := sessionchat.ClaudeUsesStreamJSONInput(req.Provider, false, runtime.GOOS)
	if usesStreamJSON {
		var serr error
		stdinPipe, serr = cmd.StdinPipe()
		if serr != nil {
			cancel()
			return nil, serr
		}
	}
	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		cancel()
		return nil, err
	}

	eventsCh := make(chan NativeRunEvent, 64)
	sidsCh := make(chan string, 4)
	doneCh := make(chan NativeRunExit, 1)

	var stdinMu sync.Mutex
	sendStreamUserMessage := func(textMsg string, images []string) error {
		if stdinPipe == nil {
			return fmt.Errorf("stdin unavailable")
		}
		var imgs []sessionchat.ImageAttachment
		for _, p := range images {
			raw, rerr := os.ReadFile(p)
			if rerr != nil {
				continue
			}
			imgs = append(imgs, sessionchat.ImageAttachment{
				MediaType: sessionchat.DetectImageMediaType(p),
				Base64:    base64.StdEncoding.EncodeToString(raw),
			})
		}
		line := sessionchat.BuildClaudeStreamJSONUserMessage(textMsg, imgs)
		stdinMu.Lock()
		defer stdinMu.Unlock()
		_, werr := io.WriteString(stdinPipe, line+"\n")
		return werr
	}

	if usesStreamJSON {
		_ = sendStreamUserMessage(req.Prompt, req.ImagePaths)
	}

	go func() {
		defer close(eventsCh)
		defer close(sidsCh)

		var stderrBuf strings.Builder
		stderrDone := make(chan struct{})
		go func() {
			defer close(stderrDone)
			sc := bufio.NewScanner(stderrPipe)
			sc.Buffer(make([]byte, 0, 16*1024), 1024*1024)
			for sc.Scan() {
				if stderrBuf.Len() < 64*1024 {
					stderrBuf.WriteString(sc.Text())
					stderrBuf.WriteByte('\n')
				}
			}
		}()

		state := &NativeStreamState{}
		sc := bufio.NewScanner(stdoutPipe)
		sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
		for sc.Scan() {
			chunks := ParseNativeStreamLine(req.Provider, sc.Text(), state)
			for _, ch := range chunks {
				if ch.Type == "session-created" && ch.SessionID != "" {
					select {
					case sidsCh <- ch.SessionID:
					default:
					}
					continue
				}
				eventsCh <- NativeRunEvent{
					Type:     ch.Type,
					Delta:    ch.Delta,
					Thinking: ch.Thinking,
					Content:  ch.Content,
					Message:  ch.Message,
					Usage:    ch.Usage,
				}
				if ch.ClaudeResultError && cmd.Process != nil {
					_ = cmd.Process.Kill()
				}
			}
		}

		<-stderrDone
		waitErr := cmd.Wait()
		exitCode := 0
		if waitErr != nil {
			if ee, ok := waitErr.(*exec.ExitError); ok {
				exitCode = ee.ExitCode()
			} else {
				exitCode = 1
			}
		}
		doneCh <- NativeRunExit{
			ExitCode:  exitCode,
			SessionID: state.SessionID,
			Stderr:    stderrBuf.String(),
			Err:       waitErr,
		}
		close(doneCh)
	}()

	return &NativeRunHandle{
		RunID: req.RunID,
		WriteSteer: func(content string) error {
			if !usesStreamJSON {
				return NewError("native_steer_unsupported", http.StatusConflict, nil)
			}
			return sendStreamUserMessage(content, nil)
		},
		Abort: func() error {
			cancel()
			if stdinPipe != nil {
				_ = stdinPipe.Close()
			}
			return nil
		},
		Events:     eventsCh,
		SessionIDs: sidsCh,
		Done:       doneCh,
	}, nil
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

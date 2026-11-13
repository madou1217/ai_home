package chatruntime

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"sync"
)

const cliChoiceFieldID = "choice"

var validCLIPromptKinds = map[string]struct{}{
	"plan-choice": {},
	"choice":      {},
	"confirm":     {},
	"acknowledge": {},
}

// NativeInteractionID 按 [provider, sessionId, nativeThreadId, nativeRequestId] 四元组生成确定性交互 ID。
func NativeInteractionID(provider, sessionID, nativeThreadID, nativeRequestID string) (string, error) {
	parts := []string{
		strings.TrimSpace(provider),
		strings.TrimSpace(sessionID),
		strings.TrimSpace(nativeThreadID),
		strings.TrimSpace(nativeRequestID),
	}
	for _, p := range parts {
		if p == "" {
			return "", NewError("native_interaction_identity_incomplete", 500, nil)
		}
	}
	raw, err := json.Marshal(parts)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(raw)
	return "interaction-" + parts[0] + "-" + hex.EncodeToString(sum[:]), nil
}

// CLIPromptOption 描述 Codex CLI 终端交互选项。
type CLIPromptOption struct {
	Value       string `json:"value"`
	Title       string `json:"title"`
	Description string `json:"description,omitempty"`
}

// AdaptCLIPromptInput 描述将 CLI prompt 映射为 Canonical Interaction 的参数。
type AdaptCLIPromptInput struct {
	CorrelationID   string
	SessionID       string
	NativeSessionID string
	PromptRevision  int
	Prompt          map[string]any
}

// CLIInteractionRoute 保存内存交互 ID 到原生 CLI prompt 的映射信息。
type CLIInteractionRoute struct {
	InteractionID  string
	CorrelationID  string
	SessionID      string
	Kind           string
	PromptID       string
	PromptRevision int
	Choices        map[string]struct{}
}

// AdaptedCLIPrompt 包含归一化后的创建载荷和内存路由条目。
type AdaptedCLIPrompt struct {
	Interaction CreateInteractionInput
	Route       *CLIInteractionRoute
}

// AdaptCLIPrompt 将终端 CLI 提问结构映射为 Canonical Question / PlanConfirmation 交互。
func AdaptCLIPrompt(in AdaptCLIPromptInput) (*AdaptedCLIPrompt, error) {
	prompt, err := validateCLIPrompt(in.Prompt)
	if err != nil {
		return nil, err
	}
	sid, err := RequiredText(in.SessionID, "cli_interaction_session_required")
	if err != nil {
		return nil, NewError("cli_interaction_session_required", 422, nil)
	}
	nsid, err := RequiredText(in.NativeSessionID, "cli_interaction_native_session_required")
	if err != nil {
		return nil, NewError("cli_interaction_native_session_required", 422, nil)
	}
	corrID, err := RequiredText(in.CorrelationID, "cli_interaction_correlation_required")
	if err != nil {
		return nil, NewError("cli_interaction_correlation_required", 422, nil)
	}
	if in.PromptRevision < 1 {
		return nil, NewError("cli_interaction_revision_invalid", 422, nil)
	}
	nativeReqID := corrID + ":" + prompt.promptID + ":" + itoa64(int64(in.PromptRevision))
	intID, err := NativeInteractionID("codex", sid, nsid, nativeReqID)
	if err != nil {
		return nil, err
	}
	kind := "question"
	title := "CLI 需要你的选择"
	if prompt.kind == "plan-choice" {
		kind = "plan_confirmation"
		title = "CLI 计划确认"
	}
	optsAny := make([]any, 0, len(prompt.options))
	choices := make(map[string]struct{}, len(prompt.options))
	for _, opt := range prompt.options {
		m := map[string]any{
			"value": opt.Value,
			"label": opt.Title,
		}
		if opt.Description != "" {
			m["description"] = opt.Description
		}
		optsAny = append(optsAny, m)
		choices[opt.Value] = struct{}{}
	}
	return &AdaptedCLIPrompt{
		Interaction: CreateInteractionInput{
			InteractionID: intID,
			SessionID:     sid,
			ItemID:        "cli-prompt:" + prompt.promptID + ":" + itoa64(int64(in.PromptRevision)),
			Kind:          kind,
			Revision:      1,
			Payload: map[string]any{
				"presentation": map[string]any{
					"title":   title,
					"message": prompt.question,
				},
				"fields": []any{
					map[string]any{
						"id":         cliChoiceFieldID,
						"label":      prompt.question,
						"type":       "single_select",
						"required":   true,
						"allowOther": false,
						"secret":     false,
						"options":    optsAny,
					},
				},
				"actions":           []any{"submit"},
				"answerShape":       "answers",
				"confirmUnanswered": false,
			},
		},
		Route: &CLIInteractionRoute{
			InteractionID:  intID,
			CorrelationID:  corrID,
			SessionID:      sid,
			Kind:           kind,
			PromptID:       prompt.promptID,
			PromptRevision: in.PromptRevision,
			Choices:        choices,
		},
	}, nil
}

// ExtractCLIChoice 从用户提交的 interaction.answer 中校验并提取单一枚举选择值。
func ExtractCLIChoice(cmd *Command, route *CLIInteractionRoute) (string, error) {
	if cmd == nil || cmd.Type != "interaction.answer" {
		return "", NewError("cli_interaction_action_unsupported", 422, nil)
	}
	action, _ := cmd.Payload["action"].(string)
	if action != "submit" {
		return "", NewError("cli_interaction_action_unsupported", 422, nil)
	}
	answer, ok := cmd.Payload["answer"].(map[string]any)
	if !ok || answer == nil {
		return "", NewError("cli_interaction_answer_invalid", 422, nil)
	}
	raw := answer[cliChoiceFieldID]
	var values []any
	switch v := raw.(type) {
	case []any:
		values = v
	case []string:
		for _, s := range v {
			values = append(values, s)
		}
	default:
		values = []any{raw}
	}
	if len(values) != 1 {
		return "", NewError("cli_interaction_answer_invalid", 422, nil)
	}
	choice, err := RequiredText(values[0], "cli_interaction_answer_invalid")
	if err != nil {
		return "", NewError("cli_interaction_answer_invalid", 422, nil)
	}
	if _, allowed := route.Choices[choice]; !allowed {
		return "", NewError("cli_interaction_choice_not_available", 422, nil)
	}
	return choice, nil
}

type validatedCLIPrompt struct {
	provider string
	kind     string
	promptID string
	question string
	options  []CLIPromptOption
}

func validateCLIPrompt(raw map[string]any) (*validatedCLIPrompt, error) {
	if raw == nil {
		return nil, NewError("cli_interaction_prompt_invalid", 422, nil)
	}
	provider := strings.ToLower(strings.TrimSpace(asString(raw["provider"])))
	kind := strings.TrimSpace(asString(raw["kind"]))
	if _, validKind := validCLIPromptKinds[kind]; provider != "codex" || !validKind {
		return nil, NewError("cli_interaction_prompt_invalid", 422, nil)
	}
	promptID, err := boundedCLIText(raw["promptId"], 256)
	if err != nil {
		return nil, err
	}
	question, err := boundedCLIText(raw["question"], 2000)
	if err != nil {
		return nil, err
	}
	rawOpts, ok := raw["options"].([]any)
	if !ok {
		if mOpts, ok2 := raw["options"].([]map[string]any); ok2 {
			rawOpts = make([]any, len(mOpts))
			for i, m := range mOpts {
				rawOpts[i] = m
			}
		}
	}
	if len(rawOpts) == 0 || len(rawOpts) > 20 {
		return nil, NewError("cli_interaction_prompt_invalid", 422, nil)
	}
	seen := make(map[string]struct{}, len(rawOpts))
	opts := make([]CLIPromptOption, 0, len(rawOpts))
	for _, item := range rawOpts {
		m, ok := item.(map[string]any)
		if !ok || m == nil {
			return nil, NewError("cli_interaction_prompt_invalid", 422, nil)
		}
		val, err := boundedCLIText(m["value"], 128)
		if err != nil {
			return nil, err
		}
		title, err := boundedCLIText(m["title"], 500)
		if err != nil {
			return nil, err
		}
		if _, dup := seen[val]; dup {
			return nil, NewError("cli_interaction_prompt_invalid", 422, nil)
		}
		seen[val] = struct{}{}
		desc := strings.TrimSpace(asString(m["description"]))
		if descRunes := []rune(desc); len(descRunes) > 2000 {
			desc = string(descRunes[:2000])
		}
		opts = append(opts, CLIPromptOption{Value: val, Title: title, Description: desc})
	}
	return &validatedCLIPrompt{
		provider: provider,
		kind:     kind,
		promptID: promptID,
		question: question,
		options:  opts,
	}, nil
}

func boundedCLIText(raw any, maxLen int) (string, error) {
	s := strings.TrimSpace(asString(raw))
	if s == "" || len([]rune(s)) > maxLen {
		return "", NewError("cli_interaction_prompt_invalid", 422, nil)
	}
	return s, nil
}

// SyncCLIInteractionInput 描述本地 CLI RPC 交互状态同步请求。
type SyncCLIInteractionInput struct {
	CorrelationID      string         `json:"correlationId"`
	AccountRef         string         `json:"accountRef"`
	Session            map[string]any `json:"session"`
	Prompt             map[string]any `json:"prompt"`
	PromptRevision     int            `json:"promptRevision"`
	ResolvedDeliveryID string         `json:"resolvedDeliveryId"`
	ClearedPromptID    string         `json:"clearedPromptId"`
	ClearedPromptRev   int            `json:"clearedPromptRevision"`
}

type cliInteractionDelivery struct {
	deliveryID  string
	commandID   string
	choiceValue string
	claim       *Interaction
	route       *CLIInteractionRoute
}

// CLIInteractionCoordinator 维护非托管 Codex CLI 终端交互与 Canonical WebUI 的双向状态桥。
type CLIInteractionCoordinator struct {
	store          *PublishingStore
	resolveSession func(ctx context.Context, in CreateSessionInput) (*ResolveSessionResult, error)
	idFactory      func(string) string

	mu                  sync.Mutex
	routes              map[string]*CLIInteractionRoute
	activeByCorrelation map[string]*CLIInteractionRoute
	deliveries          map[string]*cliInteractionDelivery
}

// NewCLIInteractionCoordinator 构造 CLI 交互桥协调器。
func NewCLIInteractionCoordinator(
	store *PublishingStore,
	resolveSession func(ctx context.Context, in CreateSessionInput) (*ResolveSessionResult, error),
	idFactory func(string) string,
) *CLIInteractionCoordinator {
	if idFactory == nil {
		idFactory = DefaultIDFactory
	}
	return &CLIInteractionCoordinator{
		store:               store,
		resolveSession:      resolveSession,
		idFactory:           idFactory,
		routes:              make(map[string]*CLIInteractionRoute),
		activeByCorrelation: make(map[string]*CLIInteractionRoute),
		deliveries:          make(map[string]*cliInteractionDelivery),
	}
}

// Sync 同步本地 CLI 的提问展示、清除及指令确认投递回执。
func (c *CLIInteractionCoordinator) Sync(ctx context.Context, in SyncCLIInteractionInput) (map[string]any, error) {
	if c == nil || c.store == nil {
		return nil, NewError("chat_runtime_unavailable", 503, nil)
	}
	corrID := strings.TrimSpace(in.CorrelationID)
	if corrID == "" {
		return nil, NewError("cli_interaction_correlation_required", 422, nil)
	}
	nativeSess := in.Session
	if strings.ToLower(strings.TrimSpace(asString(nativeSess["provider"]))) != "codex" {
		return nil, NewError("cli_interaction_provider_invalid", 422, nil)
	}

	var resolvedSess *Session
	if in.Prompt != nil {
		var err error
		resolvedSess, err = c.ensureCanonicalSession(ctx, nativeSess, in.AccountRef)
		if err != nil {
			return nil, err
		}
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	if strings.TrimSpace(in.ResolvedDeliveryID) != "" {
		c.acknowledgeDeliveryLocked(ctx, corrID, in.ResolvedDeliveryID)
	}
	if strings.TrimSpace(in.ClearedPromptID) != "" {
		c.clearPromptLocked(ctx, corrID, in.ClearedPromptID, in.ClearedPromptRev)
	}

	var promptChanged bool
	var registeredSID string
	if in.Prompt != nil && resolvedSess != nil {
		nsid := strings.TrimSpace(asString(nativeSess["sessionId"]))
		adapted, err := AdaptCLIPrompt(AdaptCLIPromptInput{
			CorrelationID:   corrID,
			SessionID:       resolvedSess.SessionID,
			NativeSessionID: nsid,
			PromptRevision:  in.PromptRevision,
			Prompt:          in.Prompt,
		})
		if err != nil {
			return nil, err
		}
		prev := c.activeByCorrelation[corrID]
		if prev != nil && prev.InteractionID == adapted.Route.InteractionID {
			registeredSID = prev.SessionID
		} else {
			if prev != nil && prev.InteractionID != adapted.Route.InteractionID {
				c.settleElsewhereLocked(ctx, prev)
			}
			ex, err := c.store.Store().Interactions.Get(ctx, adapted.Route.InteractionID)
			if err != nil {
				return nil, err
			}
			if ex == nil {
				if _, err := c.store.CreateInteraction(ctx, adapted.Interaction); err != nil {
					return nil, err
				}
			}
			c.routes[adapted.Route.InteractionID] = adapted.Route
			c.activeByCorrelation[corrID] = adapted.Route
			promptChanged = true
			registeredSID = adapted.Route.SessionID
		}
	}

	out := map[string]any{"ok": true}
	if promptChanged {
		out["promptChanged"] = true
		out["sessionId"] = registeredSID
	}
	if del := c.deliveries[corrID]; del != nil {
		out["command"] = map[string]any{
			"deliveryId":     del.deliveryID,
			"promptId":       del.route.PromptID,
			"promptRevision": del.route.PromptRevision,
			"choiceValue":    del.choiceValue,
		}
	}
	return out, nil
}

// Dispatch 若用户响应了已注册的 CLI 交互则认领并排入投递队列；否则返回 handled=false。
func (c *CLIInteractionCoordinator) Dispatch(ctx context.Context, sessionID string, input map[string]any) (map[string]any, bool, error) {
	if c == nil || c.store == nil {
		return nil, false, nil
	}
	payload, _ := input["payload"].(map[string]any)
	intID := strings.TrimSpace(asString(payload["interactionId"]))

	c.mu.Lock()
	route := c.routes[intID]
	c.mu.Unlock()
	if route == nil {
		return nil, false, nil
	}
	if route.SessionID != sessionID {
		return nil, true, NewError("stale_interaction", 409, nil)
	}

	merged := CloneMap(input)
	merged["sessionId"] = sessionID
	cmd, err := NormalizeCommandInput(merged)
	if err != nil {
		return nil, true, err
	}
	if existing, err := c.store.GetCommand(ctx, cmd.CommandID); err != nil {
		return nil, true, err
	} else if existing != nil {
		acc, err := c.store.AcceptCommand(ctx, commandToMap(cmd), nil)
		if err != nil {
			return nil, true, err
		}
		return cliCommandResponse(acc.Command, true, acc.Command.Result), true, nil
	}

	rev, _ := coerceInt(cmd.Payload["revision"])
	current, err := c.store.ValidateInteraction(ctx, intID, ResolveInteractionInput{
		SessionID: sessionID,
		Revision:  rev,
		Kind:      route.Kind,
	})
	if err != nil {
		return nil, true, err
	}
	choiceValue, err := ExtractCLIChoice(cmd, route)
	if err != nil {
		return nil, true, err
	}
	persisted := ProjectInteractionCommandForPersistence(cmd, current)
	accepted, err := c.store.AcceptCommand(ctx, commandToMap(persisted), nil)
	if err != nil {
		return nil, true, err
	}
	if accepted.Duplicate {
		return cliCommandResponse(accepted.Command, true, accepted.Command.Result), true, nil
	}

	claim, err := c.store.ClaimInteractionResolution(ctx, intID, ResolveInteractionInput{
		SessionID: sessionID,
		Revision:  rev,
		Kind:      route.Kind,
		Resolution: map[string]any{
			"action": "submit",
			"answer": cmd.Payload["answer"],
		},
	})
	if err != nil {
		return nil, true, err
	}

	c.mu.Lock()
	c.deliveries[route.CorrelationID] = &cliInteractionDelivery{
		deliveryID:  c.idFactory("cli-delivery"),
		commandID:   cmd.CommandID,
		choiceValue: choiceValue,
		claim:       claim,
		route:       route,
	}
	c.mu.Unlock()
	return cliCommandResponse(accepted.Command, false, map[string]any{"queued": true}), true, nil
}

func (c *CLIInteractionCoordinator) ensureCanonicalSession(ctx context.Context, nativeSess map[string]any, accountRef string) (*Session, error) {
	nsid := strings.TrimSpace(asString(nativeSess["sessionId"]))
	if nsid == "" {
		return nil, NewError("cli_interaction_native_session_required", 422, nil)
	}
	existing, err := c.store.FindSessionByNativeIdentity(ctx, "codex", nsid)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		return existing, nil
	}
	execRef := strings.TrimSpace(accountRef)
	if execRef == "" {
		return nil, NewError("cli_interaction_account_required", 422, nil)
	}
	if c.resolveSession == nil {
		return nil, NewError("chat_runtime_unavailable", 503, nil)
	}
	res, err := c.resolveSession(ctx, CreateSessionInput{
		Provider:            "codex",
		NativeSessionID:     nsid,
		ExecutionAccountRef: execRef,
		ProjectPath:         strings.TrimSpace(asString(nativeSess["projectPath"])),
		Policy:              map[string]any{},
	})
	if err != nil {
		return nil, err
	}
	return res.Session, nil
}

func (c *CLIInteractionCoordinator) clearPromptLocked(ctx context.Context, corrID, promptID string, promptRev int) bool {
	route := c.activeByCorrelation[corrID]
	if route == nil || route.PromptID != strings.TrimSpace(promptID) {
		return false
	}
	if promptRev > 0 && route.PromptRevision != promptRev {
		return false
	}
	c.settleElsewhereLocked(ctx, route)
	return true
}

func (c *CLIInteractionCoordinator) settleElsewhereLocked(ctx context.Context, route *CLIInteractionRoute) {
	del := c.deliveries[route.CorrelationID]
	if del != nil && del.route.InteractionID == route.InteractionID {
		_, _ = c.store.FinishInteractionResolution(ctx, del.claim)
		_, _ = c.store.CompleteCommand(ctx, del.commandID, "completed", map[string]any{"resolvedElsewhere": true})
		delete(c.deliveries, route.CorrelationID)
	} else {
		_, _ = c.store.AcknowledgeExternalInteraction(ctx, route.InteractionID)
	}
	delete(c.routes, route.InteractionID)
	if c.activeByCorrelation[route.CorrelationID] == route {
		delete(c.activeByCorrelation, route.CorrelationID)
	}
}

func (c *CLIInteractionCoordinator) acknowledgeDeliveryLocked(ctx context.Context, corrID, deliveryID string) bool {
	del := c.deliveries[corrID]
	if del == nil || del.deliveryID != strings.TrimSpace(deliveryID) {
		return false
	}
	_, _ = c.store.FinishInteractionResolution(ctx, del.claim)
	_, _ = c.store.CompleteCommand(ctx, del.commandID, "completed", map[string]any{"delivered": true})
	delete(c.deliveries, corrID)
	delete(c.routes, del.route.InteractionID)
	if c.activeByCorrelation[corrID] == del.route {
		delete(c.activeByCorrelation, corrID)
	}
	return true
}

func cliCommandResponse(cmd *Command, duplicate bool, result any) map[string]any {
	res := result
	if res == nil && cmd != nil {
		res = cmd.Result
	}
	return map[string]any{
		"sessionId":   cmd.SessionID,
		"commandId":   cmd.CommandID,
		"acceptedSeq": cmd.AcceptedSeq,
		"duplicate":   duplicate,
		"result":      res,
	}
}

package chatruntime

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fakeDriver struct {
	mu            sync.Mutex
	startFn       func(ctx context.Context, tc DriverTurnContext) (*ProviderRun, error)
	interruptFn   func(ctx context.Context, tc DriverTurnContext) error
	recoverFn     func(ctx context.Context, in RecoverTurnInput) (*ProviderRun, error)
	compactFn     func(ctx context.Context, tc DriverTurnContext) (*ProviderRun, error)
	slashFn       func(ctx context.Context, tc DriverTurnContext) (*ProviderRun, error)
	slashMode     string
	dynamicMap    map[string]CommandHandler
	disposedCount atomic.Int32
	starts        []DriverTurnContext
}

func (f *fakeDriver) StartTurn(ctx context.Context, tc DriverTurnContext) (*ProviderRun, error) {
	f.mu.Lock()
	f.starts = append(f.starts, tc)
	fn := f.startFn
	f.mu.Unlock()
	if fn != nil {
		return fn(ctx, tc)
	}
	ch := make(chan ProviderRunResult, 1)
	ch <- ProviderRunResult{Result: map[string]any{"ok": true}}
	close(ch)
	return &ProviderRun{Done: ch}, nil
}

func (f *fakeDriver) InterruptTurn(ctx context.Context, tc DriverTurnContext) error {
	if f.interruptFn != nil {
		return f.interruptFn(ctx, tc)
	}
	return nil
}

func (f *fakeDriver) RecoverTurn(ctx context.Context, in RecoverTurnInput) (*ProviderRun, error) {
	if f.recoverFn != nil {
		return f.recoverFn(ctx, in)
	}
	return nil, NewError("chat_turn_recovery_unsupported", 422, nil)
}

func (f *fakeDriver) CompactThread(ctx context.Context, tc DriverTurnContext) (*ProviderRun, error) {
	if f.compactFn != nil {
		return f.compactFn(ctx, tc)
	}
	ch := make(chan ProviderRunResult, 1)
	ch <- ProviderRunResult{Result: map[string]any{"compacted": true}}
	close(ch)
	return &ProviderRun{Done: ch}, nil
}

func (f *fakeDriver) SlashMode() string { return f.slashMode }

func (f *fakeDriver) ExecuteSlash(ctx context.Context, tc DriverTurnContext) (*ProviderRun, error) {
	if f.slashFn != nil {
		return f.slashFn(ctx, tc)
	}
	return f.StartTurn(ctx, tc)
}

func (f *fakeDriver) HandlerFor(commandType string) CommandHandler {
	if f.dynamicMap == nil {
		return nil
	}
	return f.dynamicMap[commandType]
}

func (f *fakeDriver) Dispose() bool {
	f.disposedCount.Add(1)
	return true
}

type fakeRuntimeResolver struct {
	mu      sync.Mutex
	resolve func(ctx context.Context, provider string, opts RuntimeResolveOptions) (RuntimeDescriptor, error)
	calls   int
}

func (r *fakeRuntimeResolver) Resolve(ctx context.Context, provider string, opts RuntimeResolveOptions) (RuntimeDescriptor, error) {
	r.mu.Lock()
	r.calls++
	fn := r.resolve
	r.mu.Unlock()
	if fn != nil {
		return fn(ctx, provider, opts)
	}
	return RuntimeDescriptor{
		Provider:     provider,
		RuntimeScope: opts.RuntimeScope,
		Fingerprint:  "fp-1",
		Generation:   1,
	}, nil
}

type fakeDriverRegistry struct {
	mu      sync.Mutex
	resolve func(ctx context.Context, provider string, opts DriverResolveOptions) (*DriverEntry, error)
	calls   int
}

func (r *fakeDriverRegistry) Resolve(ctx context.Context, provider string, opts DriverResolveOptions) (*DriverEntry, error) {
	r.mu.Lock()
	r.calls++
	fn := r.resolve
	r.mu.Unlock()
	if fn != nil {
		return fn(ctx, provider, opts)
	}
	return &DriverEntry{
		Driver:       &fakeDriver{},
		Capabilities: map[string]any{"capabilities": map[string]any{"turn.submit": map[string]any{"support": "native"}}},
	}, nil
}

func openPhaseBPublisher(t *testing.T) (*Store, *PublishingStore, *EventHub, *TraceLifecycle, *atomic.Int64) {
	t.Helper()
	store, clock := openTestStore(t)
	hub := NewEventHub()
	var traces []TraceSnapshot
	var traceMu sync.Mutex
	lifecycle := NewTraceLifecycle(func(attrs map[string]any) *ChatRuntimeTrace {
		return NewChatRuntimeTrace(attrs, func() int64 { return clock.Add(10) }, nil)
	}, func(snap TraceSnapshot) {
		traceMu.Lock()
		traces = append(traces, snap)
		traceMu.Unlock()
	})
	pub := NewPublishingStore(PublishingStoreOptions{
		Store:    store,
		EventHub: hub,
		OnCommandPersisted: func(commandID string, trace *TraceRecord) {
			lifecycle.MarkCommandPersisted(commandID, trace)
		},
		OnEventPublished: func(ev EventEnvelope) {
			lifecycle.ObservePublishedEvent(ev)
		},
	})
	t.Cleanup(func() {
		lifecycle.Close()
		_ = pub.Close()
	})
	return store, pub, hub, lifecycle, clock
}

func TestEventHubPublisherTraceExtensionsAndPrewarm(t *testing.T) {
	ctx := context.Background()
	_, pub, hub, lifecycle, _ := openPhaseBPublisher(t)

	sess, err := pub.CreateSession(ctx, CreateSessionInput{
		SessionID:           "sess-pub",
		Provider:            "codex",
		ExecutionAccountRef: "acct_123456789012",
		ProjectPath:         "/tmp/repo",
	})
	if err != nil {
		t.Fatalf("CreateSession failed: %v", err)
	}

	var mu sync.Mutex
	var got []EventEnvelope
	unsub, err := hub.Subscribe(sess.SessionID, func(ev EventEnvelope) {
		mu.Lock()
		got = append(got, ev)
		mu.Unlock()
	})
	if err != nil {
		t.Fatalf("Subscribe failed: %v", err)
	}
	// Panic listener must not prevent subsequent listeners from receiving events.
	unsubPanic, err := hub.Subscribe(sess.SessionID, func(EventEnvelope) { panic("boom") })
	if err != nil {
		t.Fatalf("Subscribe panic listener failed: %v", err)
	}
	if hub.ListenerCount(sess.SessionID) != 2 {
		t.Fatalf("expected 2 listeners, got %d", hub.ListenerCount(sess.SessionID))
	}

	ev, err := pub.AppendEvent(ctx, sess.SessionID, EventDraft{
		Type:    "turn.queued",
		TurnID:  "turn-1",
		RunID:   "run-1",
		Source:  EventSource{Provider: "codex", RuntimeID: "rt-1"},
		Payload: map[string]any{"state": "starting"},
	})
	if err != nil {
		t.Fatalf("AppendEvent failed: %v", err)
	}
	if ev.Seq != 2 {
		t.Fatalf("expected seq 2, got %d", ev.Seq)
	}
	// Direct transient transport event (seq == 0)
	pub.PublishDirectly(EventEnvelope{
		Schema:    EventSchema,
		EventID:   "evt-stream-err",
		SessionID: sess.SessionID,
		Seq:       0,
		Type:      "stream.error",
		At:        ev.At,
		Source:    EventSource{Provider: "codex", RuntimeID: "rt-1"},
		Payload:   map[string]any{"error": map[string]any{"code": "stream_lost", "message": "lost"}},
	})

	mu.Lock()
	count := len(got)
	mu.Unlock()
	if count != 2 {
		t.Fatalf("expected 2 published events (persisted + direct), got %d", count)
	}
	unsubPanic()
	unsub()
	if hub.ListenerCount(sess.SessionID) != 0 {
		t.Fatalf("expected 0 listeners after unsub, got %d", hub.ListenerCount(sess.SessionID))
	}

	// ExtensionPipeline
	var disposedReason string
	var observerErrors int
	pipeline, err := NewExtensionPipeline(ExtensionPipelineOptions{
		OnObserverError: func(error, map[string]any, ExtensionContext) { observerErrors++ },
		Extensions: []*Extension{
			{
				PrepareNextTurn: func(_ context.Context, cmd *Command, _ ExtensionContext) (*Command, error) {
					cp := CloneCommand(cmd)
					cp.Payload["content"] = asString(cp.Payload["content"]) + " [ext]"
					return cp, nil
				},
				Observe: func(map[string]any, ExtensionContext) { panic("observer panic") },
				Dispose: func(reason string) { disposedReason = reason },
			},
		},
	})
	if err != nil {
		t.Fatalf("NewExtensionPipeline failed: %v", err)
	}
	outCmd, err := pipeline.RunPrepareNextTurn(ctx, &Command{
		CommandID: "c1", SessionID: sess.SessionID, Type: "turn.submit",
		Payload: map[string]any{"content": "hi"},
	}, ExtensionContext{SessionID: sess.SessionID})
	if err != nil || outCmd.Payload["content"] != "hi [ext]" {
		t.Fatalf("PrepareNextTurn mismatch: out=%#v err=%v", outCmd, err)
	}
	pipeline.Observe(map[string]any{"type": "test"}, ExtensionContext{SessionID: sess.SessionID})
	if observerErrors != 1 {
		t.Fatalf("expected 1 observer error callback, got %d", observerErrors)
	}
	pipeline.Close()
	if disposedReason != "unregister" {
		t.Fatalf("expected unregister dispose reason, got %q", disposedReason)
	}

	// Prewarm lifecycle (ready + failed)
	rec := lifecycle.Start(map[string]any{"sessionId": sess.SessionID})
	rec.Mark("command_dispatched", nil)
	rec.BindRun("run-1")
	rec.ObserveProviderEvent(EventSource{Provider: "codex"})
	rec.Finish(map[string]any{"ok": true})

	entry := WithRuntimePrewarmLifecycle(DriverEntry{
		Handlers: map[string]CommandHandler{
			"runtime.prewarm": func(context.Context, CommandHandlerContext) (map[string]any, error) {
				return map[string]any{"warmed": true}, nil
			},
		},
	})
	res, err := entry.Handlers["runtime.prewarm"](ctx, CommandHandlerContext{
		SessionID: sess.SessionID,
		Store:     pub,
	})
	if err != nil || res["warmed"] != true {
		t.Fatalf("prewarm ready failed: res=%#v err=%v", res, err)
	}
	failEntry := WithRuntimePrewarmLifecycle(DriverEntry{
		Handlers: map[string]CommandHandler{
			"runtime.prewarm": func(context.Context, CommandHandlerContext) (map[string]any, error) {
				return nil, NewError("codex_app_server_spawn_failed", 503, nil)
			},
		},
	})
	if _, err := failEntry.Handlers["runtime.prewarm"](ctx, CommandHandlerContext{
		SessionID: sess.SessionID,
		Store:     pub,
	}); err == nil {
		t.Fatal("expected prewarm error")
	}
	evs, err := pub.ListEvents(ctx, sess.SessionID, 0, nil, 50)
	if err != nil {
		t.Fatalf("ListEvents failed: %v", err)
	}
	var sawStarted, sawReady, sawFailed bool
	for _, item := range evs {
		switch item.Type {
		case "runtime.prewarm.started":
			sawStarted = true
		case "runtime.prewarm.ready":
			sawReady = true
		case "runtime.prewarm.failed":
			sawFailed = true
			if msg := asString(item.Payload["message"]); msg == "" {
				t.Fatalf("expected user-facing failure message in prewarm failed")
			}
		}
	}
	if !sawStarted || !sawReady || !sawFailed {
		t.Fatalf("missing prewarm events: started=%v ready=%v failed=%v", sawStarted, sawReady, sawFailed)
	}
}

func TestSessionActorTurnLifecycleSlashPolicyAndInteractions(t *testing.T) {
	ctx := context.Background()
	_, pub, _, _, _ := openPhaseBPublisher(t)

	sess, err := pub.CreateSession(ctx, CreateSessionInput{
		SessionID:           "sess-actor",
		Provider:            "codex",
		ExecutionAccountRef: "gateway",
		ProjectPath:         "",
		Policy:              map[string]any{"title": "新会话"},
	})
	if err != nil {
		t.Fatalf("CreateSession failed: %v", err)
	}

	releaseFirst := make(chan struct{})
	var failNext atomic.Bool
	drv := &fakeDriver{
		startFn: func(_ context.Context, tc DriverTurnContext) (*ProviderRun, error) {
			ch := make(chan ProviderRunResult, 1)
			go func() {
				<-releaseFirst
				if failNext.Load() {
					ch <- ProviderRunResult{Err: NewError("upstream_boom", 502, nil)}
				} else {
					ch <- ProviderRunResult{Result: map[string]any{"ok": true}}
				}
				close(ch)
			}()
			return &ProviderRun{Done: ch}, nil
		},
		interruptFn: func(_ context.Context, _ DriverTurnContext) error {
			return errors.New("interrupt_rejected")
		},
		dynamicMap: map[string]CommandHandler{
			"interaction.answer": func(ctx context.Context, hctx CommandHandlerContext) (map[string]any, error) {
				coord := NewInteractionResolutionCoordinator(hctx.Store, nil)
				intID, _ := hctx.Command.Payload["interactionId"].(string)
				rev, _ := coerceInt(hctx.Command.Payload["revision"])
				out, err := coord.Resolve(ctx, intID, ResolveInteractionInput{
					SessionID: hctx.SessionID,
					Kind:      "question",
					Revision:  rev,
					Resolution: map[string]any{
						"action": hctx.Command.Payload["action"],
						"answer": hctx.Command.Payload["answer"],
					},
				}, func(*Interaction) (map[string]any, error) {
					return map[string]any{"forwarded": true}, nil
				})
				if err != nil {
					return nil, err
				}
				return out.Response, nil
			},
		},
	}

	ext, err := NewExtensionPipeline(ExtensionPipelineOptions{
		Extensions: []*Extension{{
			PrepareNextTurn: func(_ context.Context, cmd *Command, _ ExtensionContext) (*Command, error) {
				if asString(cmd.Payload["content"]) == "trigger-bad-prepare" {
					return nil, NewError("prep_denied", 422, nil)
				}
				return cmd, nil
			},
		}},
	})
	if err != nil {
		t.Fatalf("NewExtensionPipeline failed: %v", err)
	}

	actor := NewSessionActor(SessionActorOptions{
		SessionID:  sess.SessionID,
		Store:      pub,
		Driver:     drv,
		Extensions: ext,
	})
	defer actor.Dispose()

	// 1. Submit first turn (auto-title should update "新会话" -> content)
	resp, err := actor.Dispatch(ctx, map[string]any{
		"commandId": "cmd-1",
		"sessionId": sess.SessionID,
		"type":      "turn.submit",
		"payload":   map[string]any{"content": "Explain Go concurrency cleanly", "model": "gpt-5"},
	})
	if err != nil {
		t.Fatalf("turn.submit failed: %v", err)
	}
	if resp["duplicate"] != false {
		t.Fatalf("expected non-duplicate response: %#v", resp)
	}
	// Duplicate idempotency
	dupResp, err := actor.Dispatch(ctx, map[string]any{
		"commandId": "cmd-1",
		"sessionId": sess.SessionID,
		"type":      "turn.submit",
		"payload":   map[string]any{"content": "Explain Go concurrency cleanly", "model": "gpt-5"},
	})
	if err != nil || dupResp["duplicate"] != true {
		t.Fatalf("expected duplicate response: %#v err=%v", dupResp, err)
	}
	// Interrupt error rolls back to running
	if _, err := actor.Dispatch(ctx, map[string]any{
		"commandId": "cmd-int",
		"sessionId": sess.SessionID,
		"type":      "turn.interrupt",
		"payload":   map[string]any{"reason": "user_stop"},
	}); err == nil {
		t.Fatal("expected interrupt rejection error")
	}
	midSess, _ := pub.GetSession(ctx, sess.SessionID)
	if midSess.State != "running" || midSess.Policy["title"] != "Explain Go concurrency cleanly" {
		t.Fatalf("unexpected state/title after rollback: %#v", midSess)
	}

	close(releaseFirst)
	if err := actor.WaitForIdle(ctx); err != nil {
		t.Fatalf("WaitForIdle failed: %v", err)
	}

	// 2. Policy set & slash commands (/plan, /goal, /goal clear, /compact)
	if _, err := actor.Dispatch(ctx, map[string]any{
		"commandId": "cmd-plan",
		"sessionId": sess.SessionID,
		"type":      "slash.execute",
		"payload":   map[string]any{"name": "/plan", "arguments": ""},
	}); err != nil {
		t.Fatalf("slash /plan failed: %v", err)
	}
	if _, err := actor.Dispatch(ctx, map[string]any{
		"commandId": "cmd-goal",
		"sessionId": sess.SessionID,
		"type":      "slash.execute",
		"payload":   map[string]any{"name": "/goal", "arguments": "Ship runtime"},
	}); err != nil {
		t.Fatalf("slash /goal failed: %v", err)
	}
	if _, err := actor.Dispatch(ctx, map[string]any{
		"commandId": "cmd-sysprompt",
		"sessionId": sess.SessionID,
		"type":      "session.policy.set",
		"payload":   map[string]any{"key": "autoCompactPercent", "value": 75},
	}); err != nil {
		t.Fatalf("policy autoCompactPercent failed: %v", err)
	}
	// Rejected preparation persists failed command cleanly
	if _, err := actor.Dispatch(ctx, map[string]any{
		"commandId": "cmd-bad-prep",
		"sessionId": sess.SessionID,
		"type":      "turn.submit",
		"payload":   map[string]any{"content": "trigger-bad-prepare"},
	}); err == nil {
		t.Fatal("expected prep_denied error")
	}
	// Retry failed turn & Interaction secret masking
	failNext.Store(true)
	_, _ = actor.Dispatch(ctx, map[string]any{
		"commandId": "cmd-fail-2",
		"sessionId": sess.SessionID,
		"type":      "turn.submit",
		"payload":   map[string]any{"content": "Fail then retry"},
	})
	_ = actor.WaitForIdle(ctx)
	snap, _ := pub.GetSnapshot(ctx, sess.SessionID)
	if snap.FailedTurn == nil || !snap.FailedTurn.Retryable {
		t.Fatalf("expected retryable failed turn, got %#v", snap.FailedTurn)
	}
	failNext.Store(false)
	if _, err := actor.Dispatch(ctx, map[string]any{
		"commandId": "cmd-retry-2",
		"sessionId": sess.SessionID,
		"type":      "turn.retry",
		"payload":   map[string]any{"sourceTurnId": snap.FailedTurn.TurnID},
	}); err != nil {
		t.Fatalf("turn.retry failed: %v", err)
	}
	_ = actor.WaitForIdle(ctx)

	inter, err := pub.CreateInteraction(ctx, CreateInteractionInput{
		InteractionID: "int-secret",
		SessionID:     sess.SessionID,
		ItemID:        "item-q-1",
		Kind:          "question",
		Revision:      1,
		Payload: map[string]any{
			"presentation": map[string]any{"title": "Auth", "message": "Token"},
			"fields": []any{
				map[string]any{"id": "token", "label": "API Key", "type": "text", "required": true, "allowOther": false, "secret": true},
			},
			"actions":           []any{"submit"},
			"answerShape":       "answers",
			"confirmUnanswered": false,
		},
	})
	if err != nil {
		t.Fatalf("CreateInteraction failed: %v", err)
	}
	if _, err := actor.Dispatch(ctx, map[string]any{
		"commandId": "cmd-ans",
		"sessionId": sess.SessionID,
		"type":      "interaction.answer",
		"payload": map[string]any{
			"interactionId": inter.InteractionID,
			"revision":      1,
			"action":        "submit",
			"answer":        map[string]any{"token": "sk-secret-value"},
		},
	}); err != nil {
		t.Fatalf("interaction.answer failed: %v", err)
	}
	persistedCmd, _ := pub.GetCommand(ctx, "cmd-ans")
	ansMap, _ := persistedCmd.Payload["answer"].(map[string]any)
	if ansMap["token"] == "sk-secret-value" {
		t.Fatalf("expected secret answer to be masked in persisted command, got %#v", ansMap)
	}
}

func TestActorRegistrySingleflightAndAutomaticQueue(t *testing.T) {
	ctx := context.Background()
	_, pub, _, _, _ := openPhaseBPublisher(t)

	sess, err := pub.CreateSession(ctx, CreateSessionInput{
		SessionID:           "sess-reg",
		Provider:            "codex",
		ExecutionAccountRef: "acct_abcdefgh1234",
		ProjectPath:         "/tmp/work",
	})
	if err != nil {
		t.Fatalf("CreateSession failed: %v", err)
	}

	gen := atomic.Int64{}
	gen.Store(1)
	res := &fakeRuntimeResolver{
		resolve: func(_ context.Context, provider string, opts RuntimeResolveOptions) (RuntimeDescriptor, error) {
			g := gen.Load()
			return RuntimeDescriptor{
				Provider:     provider,
				RuntimeScope: opts.RuntimeScope,
				Fingerprint:  "fp-" + itoa64(g),
				Generation:   g,
			}, nil
		},
	}
	gate := make(chan struct{})
	dreg := &fakeDriverRegistry{
		resolve: func(_ context.Context, _ string, _ DriverResolveOptions) (*DriverEntry, error) {
			<-gate
			return &DriverEntry{
				Driver:       &fakeDriver{},
				Capabilities: map[string]any{"v": 1},
				CapabilitiesFor: func(s *Session) map[string]any {
					m := ""
					if s != nil {
						m, _ = s.Policy["model"].(string)
					}
					return map[string]any{"dynamicModel": m}
				},
			}, nil
		},
	}
	reg := NewActorRegistry(ActorRegistryOptions{
		Store:           pub,
		RuntimeResolver: res,
		DriverRegistry:  dreg,
	})
	defer reg.Close()

	// Concurrent Acquire deduplicates to single Prepare
	var wg sync.WaitGroup
	actors := make([]*SessionActor, 5)
	errs := make([]error, 5)
	for i := 0; i < 5; i++ {
		idx := i
		wg.Add(1)
		go func() {
			defer wg.Done()
			actors[idx], errs[idx] = reg.Acquire(ctx, sess, nil)
		}()
	}
	close(gate)
	wg.Wait()
	for i := 0; i < 5; i++ {
		if errs[i] != nil || actors[i] != actors[0] {
			t.Fatalf("concurrent Acquire mismatch[%d]: actor=%v err=%v", i, actors[i], errs[i])
		}
	}
	if dreg.calls != 1 {
		t.Fatalf("expected 1 singleflight driver resolution, got %d", dreg.calls)
	}

	_, _ = pub.UpdatePolicy(ctx, sess.SessionID, map[string]any{"model": "gpt-5.4"})
	caps := reg.GetCapabilities(ctx, sess.SessionID)
	if caps["dynamicModel"] != "gpt-5.4" {
		t.Fatalf("expected dynamic capabilities model gpt-5.4, got %#v", caps)
	}

	// Cross-target drift rejected during recovery
	sBound, _ := pub.GetSession(ctx, sess.SessionID)
	if err := AssertRecoverableRuntime(sBound, RuntimeDescriptor{Provider: "codex", RuntimeScope: "acct_other_123456"}, &RecoveryState{Recoverable: true}); err == nil {
		t.Fatal("expected drift rejection during recovery")
	}

	// Generation bump retires idle actor on next Acquire
	gen.Store(2)
	s2, err := pub.GetSession(ctx, sess.SessionID)
	if err != nil {
		t.Fatalf("GetSession failed: %v", err)
	}
	nextActor, err := reg.Acquire(ctx, s2, nil)
	if err != nil || nextActor == actors[0] {
		t.Fatalf("expected new actor after generation bump, err=%v", err)
	}

	// AutomaticQueueCoordinator
	var mu sync.Mutex
	var dispatched []map[string]any
	dispatchedCh := make(chan map[string]any, 4)
	auto := NewAutomaticQueueCoordinator(AutomaticQueueCoordinatorOptions{
		Store: pub,
		DispatchCommand: func(_ context.Context, _ string, input map[string]any) (map[string]any, error) {
			mu.Lock()
			dispatched = append(dispatched, input)
			mu.Unlock()
			dispatchedCh <- input
			return map[string]any{"result": map[string]any{"ok": true}}, nil
		},
	})
	defer auto.Close()

	// Setup active turn + queued after_tool_boundary + queued after_turn
	qSteer, err := pub.Enqueue(ctx, sess.SessionID, EnqueueInput{
		CommandID: "q-cmd-steer",
		Policy:    "after_tool_boundary",
		Payload:   map[string]any{"content": "steer now"},
	})
	if err != nil {
		t.Fatalf("Enqueue steer failed: %v", err)
	}
	qAfter, err := pub.Enqueue(ctx, sess.SessionID, EnqueueInput{
		CommandID: "q-cmd-after",
		Policy:    "after_turn",
		Payload:   map[string]any{"content": "follow up"},
	})
	if err != nil {
		t.Fatalf("Enqueue after failed: %v", err)
	}
	_, err = pub.BeginTurn(ctx, sess.SessionID, BeginTurnInput{
		ActiveTurn: &ActiveTurn{TurnID: "t-auto", RunID: "r-auto", State: "running"},
		Event: EventDraft{
			Type:    "turn.started",
			TurnID:  "t-auto",
			RunID:   "r-auto",
			Source:  EventSource{Provider: "codex", RuntimeID: "rt"},
			Payload: map[string]any{"state": "running"},
		},
		ResumeQueue: true,
	})
	if err != nil {
		t.Fatalf("BeginTurn failed: %v", err)
	}
	_, err = pub.TransitionTurnPhase(ctx, sess.SessionID, "running", &ActiveTurn{TurnID: "t-auto", RunID: "r-auto", State: "running"}, EventDraft{
		Type:    "turn.started",
		TurnID:  "t-auto",
		RunID:   "r-auto",
		Source:  EventSource{Provider: "codex", RuntimeID: "rt"},
		Payload: map[string]any{"state": "running"},
	})
	if err != nil {
		t.Fatalf("TransitionTurnPhase failed: %v", err)
	}
	toolEvt, err := pub.AppendEvent(ctx, sess.SessionID, EventDraft{
		Type:   "timeline.item.completed",
		TurnID: "t-auto",
		RunID:  "r-auto",
		ItemID: "tool-1",
		Source: EventSource{Provider: "codex", RuntimeID: "rt"},
		Payload: map[string]any{
			"item": map[string]any{
				"id":        "tool-1",
				"kind":      "tool",
				"status":    "completed",
				"createdAt": int64(10),
				"detail":    map[string]any{"name": "bash", "callId": "call-1"},
			},
		},
	})
	if err != nil {
		t.Fatalf("AppendEvent failed: %v", err)
	}
	if !auto.Observe(toolEvt) {
		t.Fatal("expected tool boundary action queued")
	}
	select {
	case cmd := <-dispatchedCh:
		if cmd["type"] != "turn.intervene" {
			t.Fatalf("expected turn.intervene, got %#v", cmd)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for turn.intervene")
	}

	settled, err := pub.SettleTurn(ctx, sess.SessionID, SettleTurnInput{
		Event: EventDraft{
			Type:    "turn.completed",
			TurnID:  "t-auto",
			RunID:   "r-auto",
			Source:  EventSource{Provider: "codex", RuntimeID: "rt"},
			Payload: map[string]any{"state": "idle"},
		},
	})
	if err != nil {
		t.Fatalf("SettleTurn failed: %v", err)
	}
	if !auto.Observe(settled.Event) {
		t.Fatalf("expected after_turn dispatch for queue %s / %s", qSteer.QueueID, qAfter.QueueID)
	}
	select {
	case cmd := <-dispatchedCh:
		if cmd["type"] != "queue.dispatch" {
			t.Fatalf("expected queue.dispatch, got %#v", cmd)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for queue.dispatch")
	}
}

func TestRecoveryCoordinatorSessionCoordinatorsAndCLIInteractions(t *testing.T) {
	ctx := context.Background()
	store, pub, _, _, _ := openPhaseBPublisher(t)

	// 1. RecoveryCoordinator
	sRec, err := pub.CreateSession(ctx, CreateSessionInput{
		SessionID:           "sess-recover",
		Provider:            "codex",
		ExecutionAccountRef: "acct_123456789012",
		ProjectPath:         "/tmp/p",
		NativeSessionID:     "native-thread-1",
	})
	if err != nil {
		t.Fatalf("CreateSession failed: %v", err)
	}
	_, err = pub.BeginTurn(ctx, sRec.SessionID, BeginTurnInput{
		ActiveTurn: &ActiveTurn{TurnID: "turn-rec", RunID: "run-rec", State: "running"},
		Event: EventDraft{
			Type:    "turn.queued",
			TurnID:  "turn-rec",
			RunID:   "run-rec",
			Source:  EventSource{Provider: "codex", RuntimeID: "rt"},
			Payload: map[string]any{"state": "starting"},
		},
	})
	if err != nil {
		t.Fatalf("BeginTurn failed: %v", err)
	}
	reg := NewActorRegistry(ActorRegistryOptions{
		Store:           pub,
		RuntimeResolver: &fakeRuntimeResolver{},
		DriverRegistry: &fakeDriverRegistry{
			resolve: func(context.Context, string, DriverResolveOptions) (*DriverEntry, error) {
				return &DriverEntry{
					Driver: &fakeDriver{
						recoverFn: func(_ context.Context, in RecoverTurnInput) (*ProviderRun, error) {
							ch := make(chan ProviderRunResult, 1)
							ch <- ProviderRunResult{Result: map[string]any{"ok": true}}
							close(ch)
							return &ProviderRun{NativeTurnID: "nt-1", Done: ch}, nil
						},
					},
				}, nil
			},
		},
	})
	defer reg.Close()

	recCoord := NewRecoveryCoordinator(reg, pub)
	states := recCoord.Start(ctx)
	if len(states) != 1 || !states[0].Recoverable {
		t.Fatalf("expected 1 recoverable session, got %#v", states)
	}
	if err := recCoord.WaitForSession(ctx, sRec.SessionID); err != nil {
		t.Fatalf("WaitForSession failed: %v", err)
	}
	if !reg.Has(sRec.SessionID) {
		t.Fatal("expected actor acquired for recovered session")
	}

	// 2. ChatSessionCoordinator + legacy import & cleanup
	homeDir := t.TempDir()
	chatDir := filepath.Join(homeDir, ".ai_home", "chat-sessions")
	if err := os.MkdirAll(chatDir, 0o755); err != nil {
		t.Fatalf("MkdirAll failed: %v", err)
	}
	legacyBytes, _ := json.Marshal(LegacyChatSession{
		ID:        "legacy-abc",
		Title:     "Old chat",
		Provider:  "claude",
		Model:     "claude-sonnet-4",
		CreatedAt: 1000,
		UpdatedAt: 2000,
		Messages:  []LegacyChatMessage{{Role: "user", Content: "hi", Timestamp: 1100}},
	})
	if err := os.WriteFile(filepath.Join(chatDir, "legacy-abc.json"), legacyBytes, 0o600); err != nil {
		t.Fatalf("WriteFile legacy failed: %v", err)
	}
	chatCoord := NewChatSessionCoordinator(ChatSessionCoordinatorOptions{
		Store:       pub,
		Actors:      reg,
		HostHomeDir: homeDir,
		CreateSession: func(ctx context.Context, in CreateSessionInput) (*Session, error) {
			return pub.CreateSession(ctx, in)
		},
	})
	imported, err := chatCoord.Open(ctx, OpenChatSessionInput{
		ChatSessionID:       "legacy-abc",
		Provider:            "claude",
		ExecutionAccountRef: "gateway",
	})
	if err != nil {
		t.Fatalf("Open legacy failed: %v", err)
	}
	tl, _ := pub.ReadTimeline(ctx, imported.SessionID, "", 10)
	if len(tl.Items) != 1 || tl.Items[0].ID != imported.SessionID+"-legacy-0" {
		t.Fatalf("expected imported legacy message, got %#v", tl.Items)
	}
	if !chatCoord.CleanupLegacySource(imported) {
		t.Fatal("expected legacy file cleanup to return true")
	}

	// 3. SessionResolutionCoordinator
	resCoord := NewSessionResolutionCoordinator(SessionResolutionCoordinatorOptions{
		Actors:    reg,
		Publisher: pub,
		Store:     store,
	})
	resolved, err := resCoord.Resolve(ctx, CreateSessionInput{
		Provider:            "codex",
		NativeSessionID:     "native-work-1",
		ExecutionAccountRef: "acct_work_12345678",
		ProjectPath:         "/tmp/repo2",
	})
	if err != nil || resolved.Status != "created" {
		t.Fatalf("Resolve create failed: %#v err=%v", resolved, err)
	}
	rebound, err := resCoord.Resolve(ctx, CreateSessionInput{
		Provider:            "codex",
		NativeSessionID:     "native-work-1",
		ExecutionAccountRef: "acct_work_87654321",
		ProjectPath:         "/tmp/repo2",
	})
	if err != nil || rebound.Status != "adopted" || rebound.Session.ExecutionAccountRef != "acct_work_87654321" {
		t.Fatalf("Resolve rebind failed: %#v err=%v", rebound, err)
	}

	// 4. CLIInteractionCoordinator
	cliCoord := NewCLIInteractionCoordinator(pub, resCoord.Resolve, nil)
	syncRes, err := cliCoord.Sync(ctx, SyncCLIInteractionInput{
		CorrelationID:  "corr-1",
		AccountRef:     "acct_cli_12345678",
		PromptRevision: 1,
		Session:        map[string]any{"provider": "codex", "sessionId": "native-cli-99", "projectPath": "/tmp/cli"},
		Prompt: map[string]any{
			"provider": "codex",
			"kind":     "choice",
			"promptId": "p-1",
			"question": "Pick option?",
			"options": []any{
				map[string]any{"value": "yes", "title": "Yes"},
				map[string]any{"value": "no", "title": "No"},
			},
		},
	})
	if err != nil || syncRes["promptChanged"] != true {
		t.Fatalf("CLI Sync failed: %#v err=%v", syncRes, err)
	}
	cliSID := asString(syncRes["sessionId"])
	snapCLI, _ := pub.GetSnapshot(ctx, cliSID)
	if len(snapCLI.Interactions) != 1 {
		t.Fatalf("expected 1 active CLI interaction, got %#v", snapCLI.Interactions)
	}
	dispRes, handled, err := cliCoord.Dispatch(ctx, cliSID, map[string]any{
		"commandId": "cli-ans-1",
		"type":      "interaction.answer",
		"payload": map[string]any{
			"interactionId": snapCLI.Interactions[0].InteractionID,
			"revision":      1,
			"action":        "submit",
			"answer":        map[string]any{"choice": "yes"},
		},
	})
	if err != nil || !handled || dispRes["duplicate"] != false {
		t.Fatalf("CLI Dispatch failed: %#v handled=%v err=%v", dispRes, handled, err)
	}
	pollRes, err := cliCoord.Sync(ctx, SyncCLIInteractionInput{
		CorrelationID: "corr-1",
		Session:       map[string]any{"provider": "codex", "sessionId": "native-cli-99"},
	})
	if err != nil {
		t.Fatalf("CLI Sync poll failed: %v", err)
	}
	cmdPoll, _ := pollRes["command"].(map[string]any)
	if cmdPoll["choiceValue"] != "yes" {
		t.Fatalf("expected choiceValue yes in poll, got %#v", pollRes)
	}
	if _, err := cliCoord.Sync(ctx, SyncCLIInteractionInput{
		CorrelationID:      "corr-1",
		Session:            map[string]any{"provider": "codex", "sessionId": "native-cli-99"},
		ResolvedDeliveryID: asString(cmdPoll["deliveryId"]),
	}); err != nil {
		t.Fatalf("CLI Sync ack failed: %v", err)
	}
}

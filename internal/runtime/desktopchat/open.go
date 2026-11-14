package desktopchat

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/chatruntime"
)

func (bridge *Bridge) open(ctx context.Context, m message) error {
	bridge.mu.Lock()
	if bridge.closed {
		bridge.mu.Unlock()
		return failure("chat_bridge_closed")
	}
	if existing := bridge.requests[m.requestID]; existing != nil {
		done := existing.done
		bridge.mu.Unlock()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-done:
			bridge.mu.Lock()
			err := existing.err
			bridge.mu.Unlock()
			return err
		}
	}
	count := len(bridge.requests)
	for request := range bridge.inflight {
		if bridge.requests[request.requestID] != request {
			count++
		}
	}
	if count >= bridge.maxSessions {
		bridge.mu.Unlock()
		err := failure("chat_session_limit")
		bridge.emitError(nil, m, err)
		return err
	}
	requestCtx, cancel := context.WithCancel(bridge.ctx)
	request := &requestState{requestID: m.requestID, generation: m.generation, ctx: requestCtx, cancel: cancel, done: make(chan struct{})}
	bridge.requests[m.requestID] = request
	bridge.inflight[request] = struct{}{}
	bridge.mu.Unlock()
	err := bridge.openSession(ctx, m, request)
	bridge.mu.Lock()
	request.err = err
	if err != nil && bridge.requests[m.requestID] == request {
		delete(bridge.requests, m.requestID)
	}
	suppressed := request.suppressed
	delete(bridge.inflight, request)
	close(request.done)
	bridge.mu.Unlock()
	if err != nil {
		cancel()
	}
	if suppressed {
		return nil
	}
	if err != nil && !errors.Is(err, context.Canceled) {
		bridge.emitError(request, m, err)
	}
	return err
}
func (bridge *Bridge) openSession(ctx context.Context, m message, request *requestState) error {
	op, finish, err := bridge.operation(ctx, request.ctx)
	if err != nil {
		return err
	}
	defer finish()
	target, err := bridge.resolve(op, m.target)
	if err != nil {
		return err
	}
	if err = op.Err(); err != nil {
		return err
	}
	target.Provider = strings.TrimSpace(target.Provider)
	target.Model = strings.TrimSpace(target.Model)
	target.ExecutionAccountRef = strings.TrimSpace(target.ExecutionAccountRef)
	if target.Provider == "" || target.Model == "" {
		return failure("chat_target_unconfigured")
	}
	if target.ExecutionAccountRef == "" || chatruntime.IsGatewayRuntimeScope(target.ExecutionAccountRef) {
		target.ExecutionAccountRef = chatruntime.GatewayRuntimeScope
	}
	var session *chatruntime.Session
	if strings.TrimSpace(target.ProjectPath) == "" {
		session, err = bridge.client.OpenChatSession(op, chatruntime.OpenChatSessionInput{Provider: target.Provider, ExecutionAccountRef: target.ExecutionAccountRef})
	} else {
		session, err = bridge.client.CreateSession(op, chatruntime.CreateSessionInput{Provider: target.Provider, ExecutionAccountRef: target.ExecutionAccountRef, ProjectPath: target.ProjectPath, Policy: map[string]any{"approvalMode": "confirm", "model": target.Model}})
	}
	if err != nil {
		return err
	}
	if session == nil || strings.TrimSpace(session.SessionID) == "" {
		return failure("chat_runtime_session_invalid")
	}
	if session.Provider != target.Provider || session.ExecutionAccountRef != target.ExecutionAccountRef {
		return failure("chat_runtime_session_mismatch")
	}
	// Do not mutate the Service's returned session or capability/policy maps.
	copySession := *session
	copySession.Policy = chatruntime.CloneMap(session.Policy)
	entryCtx, entryCancel := context.WithCancel(request.ctx)
	entry := &sessionState{request: request, session: &copySession, ctx: entryCtx, cancel: entryCancel, wake: make(chan struct{}, 1), done: make(chan struct{}), model: target.Model}
	bridge.mu.Lock()
	if bridge.closed || request.suppressed || bridge.requests[m.requestID] != request || op.Err() != nil {
		bridge.mu.Unlock()
		entryCancel()
		// Creation may have committed before cancellation. Retain that canonical
		// session; only discard this bridge's late binding, never delete its history.
		return context.Canceled
	}
	if bridge.sessions[session.SessionID] != nil {
		bridge.mu.Unlock()
		entryCancel()
		return failure("chat_runtime_session_mismatch")
	}
	request.entry = entry
	bridge.sessions[session.SessionID] = entry
	bridge.mu.Unlock()
	unsubscribe, err := bridge.client.Subscribe(session.SessionID, func(event chatruntime.EventEnvelope) { bridge.enqueueEvent(entry, event) })
	if err != nil {
		return bridge.openFailed(entry, err)
	}
	entry.mu.Lock()
	closed := entry.closed
	if !closed {
		entry.unsubscribe = unsubscribe
	}
	entry.mu.Unlock()
	if closed {
		if unsubscribe != nil {
			unsubscribe()
		}
		return context.Canceled
	}
	replay, err := bridge.client.ReadEvents(op, session.SessionID, 0)
	if err != nil {
		return bridge.openFailed(entry, err)
	}
	if replay == nil {
		return bridge.openFailed(entry, failure("chat_runtime_event_stream_invalid"))
	}
	if replay.Gap {
		if replay.Snapshot == nil || replay.Snapshot.SessionID != session.SessionID {
			return bridge.openFailed(entry, failure("chat_runtime_snapshot_cursor_mismatch"))
		}
		raw, _ := json.Marshal(replay.Snapshot)
		var payload map[string]any
		_ = json.Unmarshal(raw, &payload)
		bridge.enqueueEvent(entry, chatruntime.EventEnvelope{Schema: chatruntime.EventSchema, EventID: "desktop-snapshot-" + session.SessionID, SessionID: session.SessionID, Seq: replay.Snapshot.ThroughSeq, Type: "session.snapshot.reset", At: time.Now().UnixMilli(), Source: chatruntime.EventSource{Provider: session.Provider, RuntimeID: "aih-chat-runtime"}, Payload: payload})
	}
	for _, event := range replay.Events {
		bridge.enqueueEvent(entry, event)
	}
	entry.mu.Lock()
	if entry.closed || entry.ctx.Err() != nil || op.Err() != nil {
		entry.mu.Unlock()
		return bridge.openFailed(entry, context.Canceled)
	}
	sort.SliceStable(entry.queue, func(i, j int) bool { return entry.queue[i].event.Seq < entry.queue[j].event.Seq })
	entry.ready = true
	entry.mu.Unlock()
	go bridge.pump(entry)
	return nil
}
func (bridge *Bridge) openFailed(entry *sessionState, err error) error {
	bridge.mu.Lock()
	if bridge.sessions[entry.session.SessionID] == entry {
		delete(bridge.sessions, entry.session.SessionID)
	}
	bridge.mu.Unlock()
	bridge.detach(entry)
	return err
}

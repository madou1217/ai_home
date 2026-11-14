package desktopchat

import (
	"context"
	"encoding/json"
	"sort"

	"github.com/madou1217/ai_home/internal/runtime/chatruntime"
)

func (bridge *Bridge) enqueueEvent(entry *sessionState, event chatruntime.EventEnvelope) {
	if event.SessionID != entry.session.SessionID {
		return
	}
	entry.mu.Lock()
	closed := entry.closed || entry.fatal != nil
	entry.mu.Unlock()
	if closed {
		return
	}
	if event.Schema != chatruntime.EventSchema || event.EventID == "" || event.Seq < 0 || event.Seq > maxSafeInteger || event.Payload == nil {
		bridge.failStream(entry, failure("chat_runtime_event_invalid"))
		return
	}
	if _, ok := chatruntime.ValidEventTypes[event.Type]; !ok {
		bridge.failStream(entry, failure("chat_runtime_event_type_invalid"))
		return
	}
	if event.Type == "session.snapshot.reset" {
		seq, ok := safeInteger(event.Payload["throughSeq"])
		if !ok || seq != event.Seq {
			bridge.failStream(entry, failure("chat_runtime_snapshot_cursor_mismatch"))
			return
		}
	}
	if event.Seq == 0 && event.Type != "stream.error" && event.Type != "session.snapshot.reset" {
		bridge.failStream(entry, failure("chat_runtime_event_seq_invalid"))
		return
	}
	encoded, err := json.Marshal(event)
	if err != nil || len(encoded) > bridge.maxBytes {
		bridge.failStream(entry, failure("chat_event_buffer_overflow"))
		return
	}
	// The publisher owns its map; callbacks must enqueue a detached copy.
	var owned chatruntime.EventEnvelope
	if json.Unmarshal(encoded, &owned) != nil {
		bridge.failStream(entry, failure("chat_runtime_event_invalid"))
		return
	}
	entry.mu.Lock()
	if entry.closed || entry.fatal != nil {
		entry.mu.Unlock()
		return
	}
	if len(entry.queue) >= bridge.maxEvents || entry.queueBytes+len(encoded) > bridge.maxBytes {
		entry.mu.Unlock()
		bridge.failStream(entry, failure("chat_event_buffer_overflow"))
		return
	}
	entry.queue = append(entry.queue, queuedEvent{event: owned, bytes: len(encoded)})
	entry.queueBytes += len(encoded)
	if owned.Seq > entry.observedSeq {
		entry.observedSeq = owned.Seq
	}
	entry.mu.Unlock()
	notify(entry.wake)
}
func (bridge *Bridge) failStream(entry *sessionState, err error) {
	entry.mu.Lock()
	if !entry.closed && entry.fatal == nil {
		entry.fatal = err
	}
	entry.mu.Unlock()
	notify(entry.wake)
}
func (bridge *Bridge) pump(entry *sessionState) {
	defer close(entry.done)
	for {
		entry.mu.Lock()
		if entry.closed {
			entry.mu.Unlock()
			return
		}
		if entry.fatal != nil {
			err := entry.fatal
			entry.mu.Unlock()
			bridge.streamFailed(entry, err)
			return
		}
		if !entry.ready || len(entry.queue) == 0 {
			entry.mu.Unlock()
			select {
			case <-entry.ctx.Done():
				return
			case <-entry.wake:
			}
			continue
		}
		sort.SliceStable(entry.queue, func(i, j int) bool { return entry.queue[i].event.Seq < entry.queue[j].event.Seq })
		next := entry.queue[0]
		event := next.event
		if event.Type != "session.snapshot.reset" && event.Type != "stream.error" && event.Seq > entry.lastSeq+1 {
			after := entry.lastSeq
			entry.mu.Unlock()
			if err := bridge.recoverGap(entry, after); err != nil {
				bridge.streamFailed(entry, err)
				return
			}
			continue
		}
		if entry.pending != nil && commandEvent(event.Type) && (event.Type == "stream.error" || event.Seq >= entry.pending.fromSeq) {
			entry.mu.Unlock()
			select {
			case <-entry.ctx.Done():
				return
			case <-entry.wake:
			}
			continue
		}
		entry.queue[0] = queuedEvent{}
		entry.queue = entry.queue[1:]
		entry.queueBytes -= next.bytes
		if event.Type != "session.snapshot.reset" && event.Seq > 0 && event.Seq <= entry.lastSeq {
			entry.mu.Unlock()
			continue
		}
		if event.Seq > 0 {
			entry.lastSeq = event.Seq
		}
		binding := entry.active
		message := map[string]any{"type": "chat.event", "requestId": entry.request.requestID, "sessionId": entry.session.SessionID, "event": event}
		if commandEvent(event.Type) && binding != nil && (event.Type == "stream.error" || event.Seq >= binding.fromSeq) {
			message["commandId"] = binding.id
			message["generation"] = binding.generation
		}
		if terminalEvent(event.Type) && binding != nil && event.Seq >= binding.fromSeq {
			entry.lastTerminalID = binding.id
			entry.lastTerminalGeneration = binding.generation
			entry.active = nil
			entry.interruptRequested = false
		}
		sessionClosed := event.Type == "session.closed"
		if sessionClosed {
			entry.active = nil
		}
		entry.mu.Unlock()
		if err := bridge.enqueueOutput(entry.request, message); err != nil {
			bridge.streamFailed(entry, err)
			return
		}
		if event.Type == "stream.error" {
			bridge.streamFailed(entry, failure("chat_runtime_stream_failed"))
			return
		}
		if sessionClosed {
			bridge.mu.Lock()
			if bridge.sessions[entry.session.SessionID] == entry {
				delete(bridge.sessions, entry.session.SessionID)
			}
			if bridge.requests[entry.request.requestID] == entry.request {
				delete(bridge.requests, entry.request.requestID)
			}
			bridge.mu.Unlock()
			bridge.detach(entry)
			return
		}
	}
}
func (bridge *Bridge) streamFailed(entry *sessionState, err error) {
	entry.mu.Lock()
	m := message{requestID: entry.request.requestID, sessionID: entry.session.SessionID, generation: entry.request.generation, hasGeneration: true}
	binding := entry.active
	if entry.pending != nil {
		binding = entry.pending
	}
	if binding != nil {
		m.commandID = binding.id
		m.generation = binding.generation
	}
	entry.mu.Unlock()
	bridge.mu.Lock()
	if bridge.sessions[entry.session.SessionID] == entry {
		delete(bridge.sessions, entry.session.SessionID)
	}
	if bridge.requests[m.requestID] == entry.request {
		delete(bridge.requests, m.requestID)
	}
	bridge.mu.Unlock()
	bridge.detach(entry)
	bridge.emitError(entry.request, m, err)
}

func (bridge *Bridge) enqueueOutput(request *requestState, message map[string]any) error {
	if bridge.ctx.Err() != nil {
		return context.Canceled
	}
	raw, err := json.Marshal(message)
	if err != nil {
		return failure("chat_runtime_event_invalid")
	}
	var copy map[string]any
	if json.Unmarshal(raw, &copy) != nil {
		return failure("chat_runtime_event_invalid")
	}
	bridge.outputMu.Lock()
	defer bridge.outputMu.Unlock()
	if bridge.ctx.Err() != nil {
		return context.Canceled
	}
	if len(bridge.output) >= bridge.maxEvents || bridge.outputBytes+len(raw) > bridge.maxBytes {
		return failure("chat_event_buffer_overflow")
	}
	bridge.output = append(bridge.output, delivery{request: request, message: copy, bytes: len(raw)})
	bridge.outputBytes += len(raw)
	notify(bridge.outputWake)
	return nil
}
func (bridge *Bridge) emitError(request *requestState, m message, err error) {
	if bridge == nil || bridge.ctx.Err() != nil {
		return
	}
	if enqueueErr := bridge.enqueueOutput(request, messageError(m, err)); enqueueErr != nil {
		// Explicit failure, not silent event loss. Retain one bounded terminal error
		// after dropping queued output, and fail closed for all affected sessions.
		bridge.outputMu.Lock()
		bridge.output = nil
		bridge.outputBytes = 0
		bridge.outputMu.Unlock()
		_ = bridge.enqueueOutput(request, messageError(m, failure("chat_event_buffer_overflow")))
		bridge.mu.Lock()
		entries := make([]*sessionState, 0, len(bridge.sessions))
		for _, entry := range bridge.sessions {
			entries = append(entries, entry)
		}
		bridge.mu.Unlock()
		for _, entry := range entries {
			bridge.failStream(entry, failure("chat_event_buffer_overflow"))
		}
	}
}
func (bridge *Bridge) deliver() {
	defer close(bridge.outputDone)
	for {
		if bridge.ctx.Err() != nil {
			return
		}
		bridge.outputMu.Lock()
		if len(bridge.output) == 0 {
			bridge.outputMu.Unlock()
			select {
			case <-bridge.ctx.Done():
				return
			case <-bridge.outputWake:
			}
			continue
		}
		item := bridge.output[0]
		bridge.output[0] = delivery{}
		bridge.output = bridge.output[1:]
		bridge.outputBytes -= item.bytes
		bridge.outputMu.Unlock()
		bridge.mu.Lock()
		skip := bridge.closed || (item.request != nil && item.request.suppressed)
		bridge.mu.Unlock()
		if skip {
			continue
		}
		func() {
			defer func() {
				if recover() != nil {
					bridge.cancel()
					go func() { _ = bridge.Close() }()
				}
			}()
			bridge.emit(item.message)
		}()
	}
}

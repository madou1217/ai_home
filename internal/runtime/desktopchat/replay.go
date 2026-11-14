package desktopchat

import (
	"context"
	"encoding/json"
	"sort"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/chatruntime"
)

// A live EventHub notification is a wake-up, not proof that every prior callback
// was delivered. Fill gaps from the same authoritative Service without polling
// all sessions or constructing a second provider request.
func (bridge *Bridge) recoverGap(entry *sessionState, after int64) error {
	ctx, cancel := context.WithTimeout(entry.ctx, bridge.operationTimeout)
	defer cancel()
	replay, err := bridge.client.ReadEvents(ctx, entry.session.SessionID, after)
	if err != nil {
		return err
	}
	if replay == nil {
		return failure("chat_runtime_event_stream_invalid")
	}
	events := replay.Events
	if replay.Gap {
		if replay.Snapshot == nil || replay.Snapshot.SessionID != entry.session.SessionID || replay.Snapshot.ThroughSeq < after {
			return failure("chat_runtime_snapshot_cursor_mismatch")
		}
		raw, err := json.Marshal(replay.Snapshot)
		if err != nil {
			return err
		}
		var payload map[string]any
		if json.Unmarshal(raw, &payload) != nil {
			return failure("chat_runtime_event_invalid")
		}
		events = []chatruntime.EventEnvelope{{Schema: chatruntime.EventSchema, EventID: "desktop-reset-" + entry.session.SessionID, SessionID: entry.session.SessionID, Seq: replay.Snapshot.ThroughSeq, Type: "session.snapshot.reset", At: time.Now().UnixMilli(), Source: chatruntime.EventSource{Provider: entry.session.Provider, RuntimeID: "aih-chat-runtime"}, Payload: payload}}
	}
	if len(events) == 0 || (!replay.Gap && events[0].Seq != after+1) {
		return failure("chat_runtime_event_gap")
	}
	additions := make([]queuedEvent, 0, len(events))
	total := 0
	for _, event := range events {
		if event.SessionID != entry.session.SessionID || event.Schema != chatruntime.EventSchema {
			return failure("chat_runtime_event_invalid")
		}
		raw, err := json.Marshal(event)
		if err != nil {
			return err
		}
		total += len(raw)
		if len(additions) >= bridge.maxEvents || total > bridge.maxBytes {
			return failure("chat_event_buffer_overflow")
		}
		var owned chatruntime.EventEnvelope
		if json.Unmarshal(raw, &owned) != nil {
			return failure("chat_runtime_event_invalid")
		}
		additions = append(additions, queuedEvent{event: owned, bytes: len(raw)})
	}
	entry.mu.Lock()
	defer entry.mu.Unlock()
	if entry.closed || entry.ctx.Err() != nil {
		return context.Canceled
	}
	seen := make(map[int64]bool, len(additions))
	merged := make([]queuedEvent, 0, len(additions)+len(entry.queue))
	bytes := 0
	appendUnique := func(item queuedEvent) {
		if item.event.Seq > 0 && seen[item.event.Seq] {
			return
		}
		if item.event.Seq > 0 {
			seen[item.event.Seq] = true
		}
		merged = append(merged, item)
		bytes += item.bytes
	}
	for _, item := range additions {
		appendUnique(item)
	}
	through := after
	if replay.Gap {
		through = replay.Snapshot.ThroughSeq
	}
	for _, item := range entry.queue {
		if item.event.Seq <= through && item.event.Type != "stream.error" {
			continue
		}
		appendUnique(item)
	}
	if len(merged) > bridge.maxEvents || bytes > bridge.maxBytes {
		return failure("chat_event_buffer_overflow")
	}
	sort.SliceStable(merged, func(i, j int) bool { return merged[i].event.Seq < merged[j].event.Seq })
	entry.queue = merged
	entry.queueBytes = bytes
	for _, item := range merged {
		if item.event.Seq > entry.observedSeq {
			entry.observedSeq = item.event.Seq
		}
	}
	return nil
}

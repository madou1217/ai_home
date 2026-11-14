package desktopchat

import (
	"context"

	"github.com/madou1217/ai_home/internal/runtime/chatruntime"
)

func (bridge *Bridge) submit(ctx context.Context, m message) error {
	entry, err := bridge.session(m)
	if err != nil {
		return err
	}
	entry.mu.Lock()
	if entry.closed {
		entry.mu.Unlock()
		return context.Canceled
	}
	if !entry.ready {
		entry.mu.Unlock()
		return failure("chat_session_not_ready")
	}
	if entry.pending != nil {
		entry.mu.Unlock()
		return failure("chat_command_busy")
	}
	if m.generation < entry.lastGeneration {
		entry.mu.Unlock()
		return failure("chat_command_generation_stale")
	}
	pending := &commandBinding{id: m.commandID, generation: m.generation, fromSeq: entry.observedSeq + 1}
	entry.pending = pending
	entry.mu.Unlock()
	op, finish, err := bridge.operation(ctx, entry.ctx)
	if err != nil {
		entry.mu.Lock()
		if entry.pending == pending {
			entry.pending = nil
		}
		entry.mu.Unlock()
		notify(entry.wake)
		return err
	}
	defer finish()
	failed := true
	dispatched := false
	defer func() {
		if failed {
			entry.mu.Lock()
			// Preserve the pending command identity until the stream worker emits its
			// one fatal error; clearing it first loses commandId/generation on timeout
			// or malformed dispatch acknowledgements.
			if dispatched && op.Err() != nil && !entry.closed && entry.fatal == nil {
				entry.fatal = failure("chat_command_cancelled")
			}
			if entry.pending == pending && entry.fatal == nil {
				entry.pending = nil
			}
			kept := entry.queue[:0]
			bytes := 0
			for _, queued := range entry.queue {
				if commandEvent(queued.event.Type) && (queued.event.Type == "stream.error" || queued.event.Seq >= pending.fromSeq) {
					continue
				}
				kept = append(kept, queued)
				bytes += queued.bytes
			}
			for index := len(kept); index < len(entry.queue); index++ {
				entry.queue[index] = queuedEvent{}
			}
			entry.queue = kept
			entry.queueBytes = bytes
			entry.mu.Unlock()
			notify(entry.wake)
		}
	}()

	payload := map[string]any{"content": m.text, "model": entry.model}
	if m.reference != nil {
		upload, cleanup, refErr := bridge.attachment(m.reference)
		if refErr != nil {
			return refErr
		}
		defer cleanup()
		attachments, uploadErr := bridge.client.UploadAttachments(op, entry.session.SessionID, []chatruntime.AttachmentUploadInput{upload})
		if uploadErr != nil {
			return uploadErr
		}
		if len(attachments) != 1 || attachments[0].AttachmentID == "" || attachments[0].SessionID != entry.session.SessionID {
			return failure("chat_file_reference_upload_invalid")
		}
		payload["attachmentIds"] = []string{attachments[0].AttachmentID}
	}
	dispatched = true
	result, err := bridge.client.DispatchCommand(op, entry.session.SessionID, map[string]any{"commandId": m.commandID, "type": "turn.submit", "payload": payload})
	if err != nil {
		entry.mu.Lock()
		fatal := entry.fatal != nil
		entry.mu.Unlock()
		if fatal || entry.ctx.Err() != nil || op.Err() != nil {
			return context.Canceled
		}
		return err
	}
	accepted, ok := safeInteger(result["acceptedSeq"])
	if !ok {
		bridge.failStream(entry, failure("chat_command_seq_invalid"))
		return context.Canceled
	}
	if text(result["sessionId"]) != entry.session.SessionID || text(result["commandId"]) != m.commandID {
		bridge.failStream(entry, failure("chat_runtime_command_mismatch"))
		return context.Canceled
	}
	if _, ok = result["duplicate"].(bool); !ok {
		bridge.failStream(entry, failure("chat_runtime_command_duplicate_invalid"))
		return context.Canceled
	}
	entry.mu.Lock()
	if entry.closed || entry.pending != pending || entry.ctx.Err() != nil {
		entry.mu.Unlock()
		return context.Canceled
	}
	pending.fromSeq = accepted
	entry.active = pending
	if duplicate, _ := result["duplicate"].(bool); duplicate && entry.lastTerminalID == pending.id && entry.lastTerminalGeneration == pending.generation {
		entry.active = nil
	}
	entry.lastGeneration = m.generation
	entry.pending = nil
	entry.interruptRequested = false
	stopRequested := pending.stopRequested
	entry.mu.Unlock()
	failed = false
	notify(entry.wake)
	if stopRequested {
		// Reuse the admitted operation for the deferred stop; MaxSessions may be one.
		return bridge.interruptDispatch(op, entry, pending)
	}
	return nil
}
func (bridge *Bridge) stop(ctx context.Context, m message) error {
	entry, err := bridge.session(m)
	if err != nil {
		return err
	}
	entry.mu.Lock()
	if pending := entry.pending; pending != nil {
		if pending.id != m.commandID {
			entry.mu.Unlock()
			return failure("chat_command_identity_mismatch")
		}
		if pending.generation != m.generation {
			entry.mu.Unlock()
			return failure("chat_command_generation_stale")
		}
		pending.stopRequested = true
		entry.mu.Unlock()
		return nil
	}
	active := entry.active
	if active != nil && active.id != m.commandID {
		entry.mu.Unlock()
		return failure("chat_command_identity_mismatch")
	}
	if m.generation != entry.lastGeneration {
		entry.mu.Unlock()
		return failure("chat_command_generation_stale")
	}
	entry.mu.Unlock()
	if active == nil {
		return nil
	}
	return bridge.interrupt(ctx, entry, active)
}
func (bridge *Bridge) interrupt(ctx context.Context, entry *sessionState, command *commandBinding) error {
	op, finish, err := bridge.operation(ctx, entry.ctx)
	if err != nil {
		return err
	}
	defer finish()
	return bridge.interruptDispatch(op, entry, command)
}
func (bridge *Bridge) interruptDispatch(ctx context.Context, entry *sessionState, command *commandBinding) error {
	entry.mu.Lock()
	if entry.closed || entry.active != command || entry.interruptRequested {
		entry.mu.Unlock()
		return nil
	}
	entry.interruptRequested = true
	entry.mu.Unlock()
	_, err := bridge.client.DispatchCommand(ctx, entry.session.SessionID, map[string]any{"commandId": command.id + ":interrupt", "type": "turn.interrupt", "payload": map[string]any{"reason": "user_stop"}})
	if err != nil {
		entry.mu.Lock()
		if entry.active == command {
			entry.interruptRequested = false
		}
		entry.mu.Unlock()
	}
	return err
}

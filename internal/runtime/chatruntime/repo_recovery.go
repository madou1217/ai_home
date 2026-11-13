package chatruntime

import (
	"context"
	"database/sql"
	"maps"
	"net/http"
	"strings"
)

// RecoveryState 描述单个会话在重启恢复检查点的视图。
type RecoveryState struct {
	Recoverable  bool          `json:"recoverable"`
	Session      *Session      `json:"session"`
	ActiveTurn   *ActiveTurn   `json:"activeTurn"`
	Queue        *QueueEntry   `json:"queue"`
	Interactions []Interaction `json:"interactions"`
}

// CompleteRecoveryInput 描述运行重连恢复时的附加绑定。
type CompleteRecoveryInput struct {
	NativeTurnID string
}

// RecoveryRepository 处理重启断线检测、可恢复标识以及孤儿状态收敛。
type RecoveryRepository struct {
	db       *Database
	events   *EventRepository
	sessions *SessionRepository
}

func newRecoveryRepository(db *Database, events *EventRepository, sessions *SessionRepository) *RecoveryRepository {
	return &RecoveryRepository{db: db, events: events, sessions: sessions}
}

func (r *RecoveryRepository) ListCandidates(ctx context.Context) ([]Session, error) {
	var out []Session
	err := r.db.withRead(ctx, func(db *sql.DB) error {
		rows, err := db.QueryContext(ctx, `
			SELECT sessions.session_id, sessions.provider, sessions.execution_account_ref,
			       sessions.project_path, sessions.state, sessions.runtime_binding_json,
			       sessions.capability_snapshot_json, sessions.policy_json, sessions.active_turn_json,
			       sessions.last_event_seq, sessions.created_at, sessions.updated_at
			FROM chat_runtime_sessions AS sessions
			WHERE sessions.active_turn_json IS NOT NULL
			   OR EXISTS (
			     SELECT 1 FROM chat_runtime_commands AS commands
			     WHERE commands.session_id = sessions.session_id AND commands.status = 'accepted'
			   )
			   OR EXISTS (
			     SELECT 1 FROM chat_runtime_queue AS queue
			     WHERE queue.session_id = sessions.session_id AND queue.state IN ('leased', 'running')
			   )
			   OR EXISTS (
			     SELECT 1 FROM chat_runtime_interactions AS interactions
			     WHERE interactions.session_id = sessions.session_id AND interactions.state IN ('pending', 'resolving')
			   )
			ORDER BY sessions.updated_at, sessions.session_id
		`)
		if err != nil {
			return err
		}
		defer rows.Close()
		out = []Session{}
		for rows.Next() {
			s, err := scanSessionRow(rows)
			if err != nil {
				return err
			}
			if s != nil {
				out = append(out, *s)
			}
		}
		return rows.Err()
	})
	return out, err
}

func (r *RecoveryRepository) Begin(ctx context.Context, sessionID string) (*RecoveryState, error) {
	var out *RecoveryState
	err := r.db.withTx(ctx, func(tx *sql.Tx) error {
		if err := r.resetResolvingInteractionsTx(ctx, tx, sessionID); err != nil {
			return err
		}
		session, err := r.sessions.requireTx(ctx, tx, sessionID)
		if err != nil {
			return err
		}
		if err := r.failAcceptedCommandsTx(ctx, tx, sessionID, restartFailurePayload()); err != nil {
			return err
		}
		if session.ActiveTurn == nil {
			out, err = r.convergeOrphansTx(ctx, tx, session)
			return err
		}
		activeTurn := CloneActiveTurn(session.ActiveTurn)
		activeTurn.State = "recovering"
		activeTurn.InterruptRequested = activeTurn.InterruptRequested || session.State == "interrupting"
		if err := r.updateSessionStateTx(ctx, tx, sessionID, "recovering", activeTurn); err != nil {
			return err
		}
		if err := r.appendRunEventTx(ctx, tx, session, activeTurn, "run.detached", map[string]any{
			"reason": "server_restart",
		}); err != nil {
			return err
		}
		out, err = r.describeTx(ctx, tx, sessionID, true)
		return err
	})
	return out, err
}

func (r *RecoveryRepository) Complete(ctx context.Context, sessionID string, input CompleteRecoveryInput) (*RecoveryState, error) {
	var out *RecoveryState
	err := r.db.withTx(ctx, func(tx *sql.Tx) error {
		session, err := r.requireActiveSessionTx(ctx, tx, sessionID)
		if err != nil {
			return err
		}
		queue, err := r.activeQueueTx(ctx, tx, sessionID)
		if err != nil {
			return err
		}
		if queue != nil && queue.Status == "leased" {
			if _, err := r.updateQueueTx(ctx, tx, queue, "running", nil); err != nil {
				return err
			}
		}
		interactions, err := r.pendingInteractionsTx(ctx, tx, sessionID)
		if err != nil {
			return err
		}
		state := "running"
		if session.ActiveTurn.InterruptRequested {
			state = "interrupting"
		} else if len(interactions) > 0 {
			state = "waiting_input"
		}
		activeTurn := CloneActiveTurn(session.ActiveTurn)
		activeTurn.State = state
		if nID := strings.TrimSpace(input.NativeTurnID); nID != "" {
			activeTurn.NativeTurnID = nID
		}
		if err := r.updateSessionStateTx(ctx, tx, sessionID, state, activeTurn); err != nil {
			return err
		}
		payload := map[string]any{"state": state}
		if activeTurn.NativeTurnID != "" {
			payload["nativeTurnId"] = activeTurn.NativeTurnID
		}
		if err := r.appendRunEventTx(ctx, tx, session, activeTurn, "run.reattached", payload); err != nil {
			return err
		}
		out, err = r.describeTx(ctx, tx, sessionID, true)
		return err
	})
	return out, err
}

func (r *RecoveryRepository) Fail(ctx context.Context, sessionID string, errInput any) (*Session, error) {
	var out *Session
	err := r.db.withTx(ctx, func(tx *sql.Tx) error {
		session, err := r.sessions.requireTx(ctx, tx, sessionID)
		if err != nil {
			return err
		}
		activeTurn := session.ActiveTurn
		now := r.db.clock()
		normErr := normalizeRecoveryError(errInput)
		var terminal EventDraft
		if activeTurn != nil {
			terminal = EventDraft{
				Type:    "run.lost",
				TurnID:  activeTurn.TurnID,
				RunID:   activeTurn.RunID,
				At:      &now,
				Source:  runtimeEventSource(session.Provider, session.RuntimeBinding),
				Payload: map[string]any{"error": normErr},
			}
			if err := r.events.turnMetrics.finishInTx(ctx, tx, sessionID, terminal); err != nil {
				return err
			}
			if _, err := settleTurnTimelineTx(ctx, tx, r.events, r.db, sessionID, terminal); err != nil {
				return err
			}
		}
		if err := r.failAcceptedCommandsTx(ctx, tx, sessionID, restartFailurePayload()); err != nil {
			return err
		}
		if err := r.failActiveQueuesTx(ctx, tx, sessionID, normErr); err != nil {
			return err
		}
		if _, err := r.expirePendingInTx(ctx, tx, sessionID, "run_lost"); err != nil {
			return err
		}
		nextState := "idle"
		if session.State == "closed" {
			nextState = "closed"
		}
		if err := r.updateSessionStateTx(ctx, tx, sessionID, nextState, nil); err != nil {
			return err
		}
		if err := r.pauseQueueTx(ctx, tx, session); err != nil {
			return err
		}
		if activeTurn != nil {
			if _, err := r.events.appendInTx(ctx, tx, sessionID, terminal, true, nil); err != nil {
				return err
			}
		}
		out, err = r.sessions.requireTx(ctx, tx, sessionID)
		return err
	})
	return out, err
}

func (r *RecoveryRepository) Describe(ctx context.Context, sessionID string, recoverable bool) (*RecoveryState, error) {
	var out *RecoveryState
	err := r.db.withRead(ctx, func(db *sql.DB) error {
		session, err := scanSessionRow(querySessionByID(ctx, db, sessionID))
		if err != nil {
			return err
		}
		if session == nil {
			return NewError("chat_session_not_found", http.StatusNotFound, nil)
		}
		queues, err := activeQueuesQuerier(ctx, db, sessionID)
		if err != nil {
			return err
		}
		if len(queues) > 1 {
			return NewError("chat_recovery_queue_ambiguous", http.StatusConflict, map[string]any{"sessionId": sessionID})
		}
		var activeQueue *QueueEntry
		if len(queues) == 1 {
			q := queues[0]
			activeQueue = &q
		}
		interactions, err := pendingInteractionsQuerier(ctx, db, sessionID)
		if err != nil {
			return err
		}
		out = &RecoveryState{
			Recoverable:  recoverable,
			Session:      session,
			ActiveTurn:   CloneActiveTurn(session.ActiveTurn),
			Queue:        activeQueue,
			Interactions: interactions,
		}
		return nil
	})
	return out, err
}

func (r *RecoveryRepository) describeTx(ctx context.Context, tx *sql.Tx, sessionID string, recoverable bool) (*RecoveryState, error) {
	session, err := r.sessions.requireTx(ctx, tx, sessionID)
	if err != nil {
		return nil, err
	}
	queue, err := r.activeQueueTx(ctx, tx, sessionID)
	if err != nil {
		return nil, err
	}
	interactions, err := r.pendingInteractionsTx(ctx, tx, sessionID)
	if err != nil {
		return nil, err
	}
	return &RecoveryState{
		Recoverable:  recoverable,
		Session:      session,
		ActiveTurn:   CloneActiveTurn(session.ActiveTurn),
		Queue:        queue,
		Interactions: interactions,
	}, nil
}

func (r *RecoveryRepository) convergeOrphansTx(ctx context.Context, tx *sql.Tx, session *Session) (*RecoveryState, error) {
	queues, err := r.activeQueuesTx(ctx, tx, session.SessionID)
	if err != nil {
		return nil, err
	}
	for i := range queues {
		if queues[i].Status == "leased" {
			if _, err := r.updateQueueTx(ctx, tx, &queues[i], "queued", nil); err != nil {
				return nil, err
			}
		} else {
			if _, err := r.updateQueueTx(ctx, tx, &queues[i], "failed", restartFailurePayload()); err != nil {
				return nil, err
			}
		}
	}
	expired, err := r.expirePendingInTx(ctx, tx, session.SessionID, "run_lost")
	if err != nil {
		return nil, err
	}
	lost := session.State != "idle" || len(queues) > 0 || expired > 0
	nextState := "idle"
	if session.State == "closed" {
		nextState = "closed"
	}
	if err := r.updateSessionStateTx(ctx, tx, session.SessionID, nextState, nil); err != nil {
		return nil, err
	}
	if lost {
		if err := r.pauseQueueTx(ctx, tx, session); err != nil {
			return nil, err
		}
		if err := r.appendRunEventTx(ctx, tx, session, nil, "run.lost", map[string]any{"error": restartFailurePayload()}); err != nil {
			return nil, err
		}
	}
	return r.describeTx(ctx, tx, session.SessionID, false)
}

func (r *RecoveryRepository) expirePendingInTx(ctx context.Context, tx *sql.Tx, sessionID, reason string) (int, error) {
	interactions, err := r.pendingInteractionsTx(ctx, tx, sessionID)
	if err != nil {
		return 0, err
	}
	resJSON, _ := CanonicalJSON(map[string]any{"reason": reason})
	now := r.db.clock()
	for _, item := range interactions {
		if _, err := tx.ExecContext(ctx, `
			UPDATE chat_runtime_interactions
			SET state = 'expired', resolution_json = ?, updated_at = ?
			WHERE interaction_id = ? AND state IN ('pending', 'resolving')
		`, resJSON, now, item.InteractionID); err != nil {
			return 0, err
		}
		expired, err := getInteractionTx(ctx, tx, item.InteractionID)
		if err != nil {
			return 0, err
		}
		if expired != nil {
			if _, err := r.events.appendInTx(ctx, tx, sessionID, EventDraft{
				Type:    "interaction.expired",
				ItemID:  expired.ItemID,
				Source:  EventSource{Provider: "aih", RuntimeID: "chat-runtime"},
				Payload: map[string]any{"interaction": interactionToMap(expired)},
			}, true, nil); err != nil {
				return 0, err
			}
		}
	}
	return len(interactions), nil
}

func (r *RecoveryRepository) failAcceptedCommandsTx(ctx context.Context, tx *sql.Tx, sessionID string, result map[string]any) error {
	resJSON, err := CanonicalJSON(result)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `
		UPDATE chat_runtime_commands
		SET status = 'failed', result_json = ?, updated_at = ?
		WHERE session_id = ? AND status = 'accepted'
		  AND type NOT IN ('session.fork', 'turn.regenerate')
	`, resJSON, r.db.clock(), sessionID)
	return err
}

func (r *RecoveryRepository) resetResolvingInteractionsTx(ctx context.Context, tx *sql.Tx, sessionID string) error {
	_, err := tx.ExecContext(ctx, `
		UPDATE chat_runtime_interactions
		SET state = 'pending', resolution_json = NULL, updated_at = ?
		WHERE session_id = ? AND state = 'resolving'
	`, r.db.clock(), sessionID)
	return err
}

func (r *RecoveryRepository) updateSessionStateTx(ctx context.Context, tx *sql.Tx, sessionID, state string, activeTurn *ActiveTurn) error {
	var turnJSON sql.NullString
	if activeTurn != nil {
		encoded, err := CanonicalJSON(activeTurn)
		if err != nil {
			return err
		}
		turnJSON = sql.NullString{String: encoded, Valid: true}
	}
	_, err := tx.ExecContext(ctx, `
		UPDATE chat_runtime_sessions SET state = ?, active_turn_json = ?, updated_at = ? WHERE session_id = ?
	`, state, turnJSON, r.db.clock(), sessionID)
	return err
}

func (r *RecoveryRepository) failActiveQueuesTx(ctx context.Context, tx *sql.Tx, sessionID string, errObj map[string]any) error {
	queues, err := r.activeQueuesTx(ctx, tx, sessionID)
	if err != nil {
		return err
	}
	for i := range queues {
		if _, err := r.updateQueueTx(ctx, tx, &queues[i], "failed", errObj); err != nil {
			return err
		}
	}
	return nil
}

func (r *RecoveryRepository) pauseQueueTx(ctx context.Context, tx *sql.Tx, session *Session) error {
	control := map[string]any{}
	if existing, ok := session.Policy["queueControl"].(map[string]any); ok {
		maps.Copy(control, existing)
	}
	control["paused"] = true
	control["reason"] = "run_lost"
	_, err := r.sessions.updatePolicyInTx(ctx, tx, session.SessionID, map[string]any{"queueControl": control})
	return err
}

func (r *RecoveryRepository) updateQueueTx(ctx context.Context, tx *sql.Tx, queue *QueueEntry, state string, result map[string]any) (*QueueEntry, error) {
	clearLease := state == "queued"
	var leaseArg, boundaryArg, resArg sql.NullString
	if !clearLease {
		leaseArg = nullableText(queue.LeaseID)
		boundaryArg = nullableText(queue.BoundaryItemID)
	}
	if result != nil {
		encoded, err := CanonicalJSON(result)
		if err != nil {
			return nil, err
		}
		resArg = sql.NullString{String: encoded, Valid: true}
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE chat_runtime_queue
		SET state = ?, lease_id = ?, boundary_item_id = ?, result_json = ?, updated_at = ?
		WHERE queue_id = ?
	`, state, leaseArg, boundaryArg, resArg, r.db.clock(), queue.QueueID); err != nil {
		return nil, err
	}
	updated, err := getQueueTx(ctx, tx, queue.QueueID)
	if err != nil {
		return nil, err
	}
	if updated != nil {
		if _, err := r.events.appendInTx(ctx, tx, updated.SessionID, EventDraft{
			Type:    "queue.item.updated",
			Source:  EventSource{Provider: "aih", RuntimeID: "chat-runtime"},
			Payload: map[string]any{"entry": queueEntryToMap(updated)},
		}, true, nil); err != nil {
			return nil, err
		}
	}
	return updated, nil
}

func (r *RecoveryRepository) appendRunEventTx(ctx context.Context, tx *sql.Tx, session *Session, activeTurn *ActiveTurn, evType string, payload map[string]any) error {
	draft := EventDraft{
		Type:    evType,
		Source:  runtimeEventSource(session.Provider, session.RuntimeBinding),
		Payload: payload,
	}
	if activeTurn != nil {
		draft.TurnID = activeTurn.TurnID
		draft.RunID = activeTurn.RunID
	}
	_, err := r.events.appendInTx(ctx, tx, session.SessionID, draft, true, nil)
	return err
}

func (r *RecoveryRepository) requireActiveSessionTx(ctx context.Context, tx *sql.Tx, sessionID string) (*Session, error) {
	session, err := r.sessions.requireTx(ctx, tx, sessionID)
	if err != nil {
		return nil, err
	}
	if session.ActiveTurn == nil {
		return nil, NewError("chat_recovery_turn_missing", http.StatusConflict, nil)
	}
	return session, nil
}

func (r *RecoveryRepository) activeQueueTx(ctx context.Context, tx *sql.Tx, sessionID string) (*QueueEntry, error) {
	queues, err := r.activeQueuesTx(ctx, tx, sessionID)
	if err != nil {
		return nil, err
	}
	if len(queues) > 1 {
		return nil, NewError("chat_recovery_queue_ambiguous", http.StatusConflict, map[string]any{"sessionId": sessionID})
	}
	if len(queues) == 0 {
		return nil, nil
	}
	q := queues[0]
	return &q, nil
}

func (r *RecoveryRepository) activeQueuesTx(ctx context.Context, tx *sql.Tx, sessionID string) ([]QueueEntry, error) {
	rows, err := tx.QueryContext(ctx, `
		SELECT queue_id, session_id, command_id, position, policy, payload_json, state, lease_id, boundary_item_id, result_json, created_at, updated_at
		FROM chat_runtime_queue WHERE session_id = ? AND state IN ('leased', 'running') ORDER BY position
	`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanQueueRows(rows)
}

func activeQueuesQuerier(ctx context.Context, db *sql.DB, sessionID string) ([]QueueEntry, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT queue_id, session_id, command_id, position, policy, payload_json, state, lease_id, boundary_item_id, result_json, created_at, updated_at
		FROM chat_runtime_queue WHERE session_id = ? AND state IN ('leased', 'running') ORDER BY position
	`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanQueueRows(rows)
}

func (r *RecoveryRepository) pendingInteractionsTx(ctx context.Context, tx *sql.Tx, sessionID string) ([]Interaction, error) {
	rows, err := tx.QueryContext(ctx, `
		SELECT interaction_id, session_id, item_id, kind, revision, payload_json, state, resolution_json, created_at, updated_at
		FROM chat_runtime_interactions WHERE session_id = ? AND state IN ('pending', 'resolving')
		ORDER BY created_at, interaction_id
	`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanInteractionRows(rows)
}

func pendingInteractionsQuerier(ctx context.Context, db *sql.DB, sessionID string) ([]Interaction, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT interaction_id, session_id, item_id, kind, revision, payload_json, state, resolution_json, created_at, updated_at
		FROM chat_runtime_interactions WHERE session_id = ? AND state IN ('pending', 'resolving')
		ORDER BY created_at, interaction_id
	`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanInteractionRows(rows)
}

func restartFailurePayload() map[string]any {
	return map[string]any{
		"code":    "chat_command_interrupted_by_restart",
		"message": "Command outcome is unknown after server restart",
	}
}

func normalizeRecoveryError(errInput any) map[string]any {
	diag := SanitizeCanonicalDiagnostic(errInput, DiagnosticOptions{
		FallbackCode:    "chat_run_lost",
		FallbackMessage: "Run could not be recovered",
	})
	out := map[string]any{
		"code":    diag.Code,
		"message": diag.Message,
	}
	if m, ok := errInput.(map[string]any); ok && m["nativeCleanup"] != nil {
		if sanitized := SanitizeDiagnosticDetails(m["nativeCleanup"], DiagnosticOptions{}); sanitized != nil {
			out["nativeCleanup"] = sanitized
		}
	}
	return out
}

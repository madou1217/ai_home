package chatruntime

import (
	"context"
	"database/sql"
	"maps"
	"net/http"
	"sort"
	"strings"
)

// AcceptCommandResult 描述幂等命令受理结果。
type AcceptCommandResult struct {
	Duplicate bool     `json:"duplicate"`
	Command   *Command `json:"command"`
}

// FailedTurnLookup 描述最新失败轮次与对应原始提交指令。
type FailedTurnLookup struct {
	Failure *FailedTurn
	Command *Command
}

// CommandRepository 负责 chat_runtime_commands 的幂等写入与完成更新。
type CommandRepository struct {
	db *Database
}

func newCommandRepository(db *Database) *CommandRepository {
	return &CommandRepository{db: db}
}

func (r *CommandRepository) Accept(ctx context.Context, input map[string]any) (*AcceptCommandResult, error) {
	cmd, err := NormalizeCommandInput(input)
	if err != nil {
		return nil, err
	}
	var out *AcceptCommandResult
	err = r.db.withTx(ctx, func(tx *sql.Tx) error {
		existing, err := r.getTx(ctx, tx, cmd.CommandID)
		if err != nil {
			return err
		}
		if existing != nil {
			if existing.SessionID != cmd.SessionID || existing.Type != cmd.Type || !CanonicalJSONEquals(existing.Payload, cmd.Payload) {
				return NewError("chat_command_id_conflict", http.StatusConflict, map[string]any{"commandId": cmd.CommandID})
			}
			out = &AcceptCommandResult{Duplicate: true, Command: existing}
			return nil
		}
		var lastSeq int64
		if err := tx.QueryRowContext(ctx, `SELECT last_event_seq FROM chat_runtime_sessions WHERE session_id = ?`, cmd.SessionID).Scan(&lastSeq); err != nil {
			if err == sql.ErrNoRows {
				return NewError("chat_session_not_found", http.StatusNotFound, nil)
			}
			return err
		}
		now := r.db.clock()
		payloadJSON, err := CanonicalJSON(cmd.Payload)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO chat_runtime_commands (
				command_id, session_id, type, payload_json, status, result_json,
				accepted_seq, created_at, updated_at
			) VALUES (?, ?, ?, ?, 'accepted', NULL, ?, ?, ?)
		`, cmd.CommandID, cmd.SessionID, cmd.Type, payloadJSON, lastSeq, now, now); err != nil {
			return err
		}
		created, err := r.getTx(ctx, tx, cmd.CommandID)
		if err != nil {
			return err
		}
		out = &AcceptCommandResult{Duplicate: false, Command: created}
		return nil
	})
	return out, err
}

func (r *CommandRepository) Get(ctx context.Context, commandID string) (*Command, error) {
	var out *Command
	err := r.db.withRead(ctx, func(db *sql.DB) error {
		var err error
		out, err = queryCommandByID(ctx, db, commandID)
		return err
	})
	return out, err
}

func (r *CommandRepository) getTx(ctx context.Context, tx *sql.Tx, commandID string) (*Command, error) {
	return queryCommandByID(ctx, tx, commandID)
}

func (r *CommandRepository) Complete(ctx context.Context, commandID, status string, result map[string]any) (*Command, error) {
	if status != "completed" && status != "failed" {
		return nil, NewError("invalid_chat_command_status", http.StatusConflict, map[string]any{"status": status})
	}
	if result == nil {
		result = map[string]any{}
	}
	resJSON, err := CanonicalJSON(result)
	if err != nil {
		return nil, err
	}
	var out *Command
	err = r.db.withTx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, `
			UPDATE chat_runtime_commands SET status = ?, result_json = ?, updated_at = ?
			WHERE command_id = ? AND status = 'accepted'
		`, status, resJSON, r.db.clock(), commandID)
		if err != nil {
			return err
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			return NewError("stale_chat_command", http.StatusConflict, nil)
		}
		out, err = queryCommandByID(ctx, tx, commandID)
		return err
	})
	return out, err
}

func queryCommandByID(ctx context.Context, q rowQuerier, commandID string) (*Command, error) {
	row := q.QueryRowContext(ctx, `
		SELECT command_id, session_id, type, payload_json, status, result_json, accepted_seq, created_at, updated_at
		FROM chat_runtime_commands WHERE command_id = ?
	`, commandID)
	return scanCommandRow(row)
}

func scanCommandRow(row rowScanner) (*Command, error) {
	var (
		cmd         Command
		payloadJSON string
		resultJSON  sql.NullString
	)
	if err := row.Scan(
		&cmd.CommandID, &cmd.SessionID, &cmd.Type, &payloadJSON,
		&cmd.Status, &resultJSON, &cmd.AcceptedSeq, &cmd.CreatedAt, &cmd.UpdatedAt,
	); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	cmd.Payload = parseJSONObject(payloadJSON)
	if resultJSON.Valid && strings.TrimSpace(resultJSON.String) != "" && strings.TrimSpace(resultJSON.String) != "null" {
		cmd.Result = parseJSONObject(resultJSON.String)
	}
	return &cmd, nil
}

// FailedTurnRepository 从事件与指令日志推导失败/重试状态。
type FailedTurnRepository struct {
	db *Database
}

func newFailedTurnRepository(db *Database) *FailedTurnRepository {
	return &FailedTurnRepository{db: db}
}

func (r *FailedTurnRepository) Read(ctx context.Context, sessionID string) (*FailedTurnLookup, error) {
	var out *FailedTurnLookup
	err := r.db.withRead(ctx, func(db *sql.DB) error {
		var err error
		out, err = r.readWithQuerier(ctx, db, sessionID)
		return err
	})
	return out, err
}

func (r *FailedTurnRepository) readWithQuerier(ctx context.Context, q rowQuerier, sessionID string) (*FailedTurnLookup, error) {
	var (
		evType      string
		turnID      sql.NullString
		at          int64
		payloadJSON string
	)
	err := q.QueryRowContext(ctx, `
		SELECT type, turn_id, at, payload_json FROM chat_runtime_events
		WHERE session_id = ? AND type IN (
			'turn.queued', 'turn.started', 'turn.failed', 'turn.completed', 'turn.interrupted', 'run.lost'
		) ORDER BY seq DESC LIMIT 1
	`, sessionID).Scan(&evType, &turnID, &at, &payloadJSON)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if (evType != "turn.failed" && evType != "run.lost") || strings.TrimSpace(turnID.String) == "" {
		return nil, nil
	}
	cmd, err := r.findSubmissionWithQuerier(ctx, q, sessionID, turnID.String)
	if err != nil {
		return nil, err
	}
	payload := parseJSONObject(payloadJSON)
	outcomeUnknown := evType == "run.lost" || payload["outcomeUnknown"] == true
	errObj, _ := payload["error"].(map[string]any)
	if len(errObj) == 0 {
		errObj = map[string]any{"code": "chat_turn_failed", "message": "本轮执行失败"}
	}
	return &FailedTurnLookup{
		Failure: &FailedTurn{
			TurnID:         turnID.String,
			FailedAt:       at,
			Error:          errObj,
			Retryable:      cmd != nil && !outcomeUnknown,
			OutcomeUnknown: outcomeUnknown,
		},
		Command: cmd,
	}, nil
}

func (r *FailedTurnRepository) Get(ctx context.Context, sessionID string) (*FailedTurn, error) {
	lookup, err := r.Read(ctx, sessionID)
	if err != nil || lookup == nil {
		return nil, err
	}
	return lookup.Failure, nil
}

func (r *FailedTurnRepository) RequireSubmission(ctx context.Context, sessionID, sourceTurnID string) (*Command, error) {
	var cmd *Command
	err := r.db.withRead(ctx, func(db *sql.DB) error {
		var state string
		if err := db.QueryRowContext(ctx, `SELECT state FROM chat_runtime_sessions WHERE session_id = ?`, sessionID).Scan(&state); err != nil && err != sql.ErrNoRows {
			return err
		}
		lookup, err := r.readWithQuerier(ctx, db, sessionID)
		if err != nil {
			return err
		}
		if state != "idle" || lookup == nil || lookup.Failure == nil || lookup.Failure.TurnID != sourceTurnID || !lookup.Failure.Retryable || lookup.Command == nil {
			return NewError("chat_retry_not_available", http.StatusConflict, nil)
		}
		cmd = lookup.Command
		return nil
	})
	return cmd, err
}

func (r *FailedTurnRepository) FindSubmission(ctx context.Context, sessionID, turnID string) (*Command, error) {
	var cmd *Command
	err := r.db.withRead(ctx, func(db *sql.DB) error {
		var err error
		cmd, err = r.findSubmissionWithQuerier(ctx, db, sessionID, turnID)
		return err
	})
	return cmd, err
}

func (r *FailedTurnRepository) findSubmissionWithQuerier(ctx context.Context, q rowQuerier, sessionID, turnID string) (*Command, error) {
	var queuedJSON sql.NullString
	err := q.QueryRowContext(ctx, `
		SELECT payload_json FROM chat_runtime_events
		WHERE session_id = ? AND turn_id = ? AND type = 'turn.queued'
		ORDER BY seq LIMIT 1
	`, sessionID, turnID).Scan(&queuedJSON)
	if err != nil && err != sql.ErrNoRows {
		return nil, err
	}
	sourceID := ""
	if queuedJSON.Valid {
		sourceID = strings.TrimSpace(asString(parseJSONObject(queuedJSON.String)["submissionCommandId"]))
	}
	if sourceID != "" {
		return scanCommandRow(q.QueryRowContext(ctx, `
			SELECT command_id, session_id, type, payload_json, status, result_json, accepted_seq, created_at, updated_at
			FROM chat_runtime_commands
			WHERE session_id = ? AND command_id = ? AND type = 'turn.submit'
		`, sessionID, sourceID))
	}
	return scanCommandRow(q.QueryRowContext(ctx, `
		SELECT command_id, session_id, type, payload_json, status, result_json, accepted_seq, created_at, updated_at
		FROM chat_runtime_commands
		WHERE session_id = ? AND type = 'turn.submit' AND json_extract(result_json, '$.turnId') = ?
		ORDER BY created_at DESC LIMIT 1
	`, sessionID, turnID))
}

// QueueRepository 管理 chat_runtime_queue 排队、租约、调整顺序与结算。
type QueueRepository struct {
	db        *Database
	events    *EventRepository
	idFactory func(string) string
}

func newQueueRepository(db *Database, events *EventRepository, idFactory func(string) string) *QueueRepository {
	return &QueueRepository{db: db, events: events, idFactory: idFactory}
}

// EnqueueInput 描述入队参数。
type EnqueueInput struct {
	QueueID   string
	CommandID string
	Policy    string
	Payload   map[string]any
}

// LeaseQueueInput 描述排队租约筛选参数。
type LeaseQueueInput struct {
	LeaseID        string
	QueueID        string
	Policy         string
	BoundaryItemID string
}

func (r *QueueRepository) Enqueue(ctx context.Context, sessionID string, input EnqueueInput) (*QueueEntry, error) {
	cmdID, err := RequiredText(input.CommandID, "chat_queue_command_id_required")
	if err != nil {
		return nil, err
	}
	policy, err := RequiredText(input.Policy, "chat_queue_policy_required")
	if err != nil {
		return nil, err
	}
	if _, ok := ValidQueuePolicies[policy]; !ok {
		return nil, ErrInvalid("invalid_chat_queue_policy")
	}
	queueID := strings.TrimSpace(input.QueueID)
	if queueID == "" {
		queueID = r.idFactory("queue")
	}
	payload := CloneMap(input.Payload)
	payloadJSON, err := CanonicalJSON(payload)
	if err != nil {
		return nil, err
	}

	var out *QueueEntry
	err = r.db.withTx(ctx, func(tx *sql.Tx) error {
		if err := requireSessionExistsTx(ctx, tx, sessionID); err != nil {
			return err
		}
		var pos int
		if err := tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(position), 0) + 1 FROM chat_runtime_queue WHERE session_id = ?`, sessionID).Scan(&pos); err != nil {
			return err
		}
		now := r.db.clock()
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO chat_runtime_queue (
				queue_id, session_id, command_id, position, policy, payload_json, state,
				lease_id, boundary_item_id, result_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, 'queued', NULL, NULL, NULL, ?, ?)
		`, queueID, sessionID, cmdID, pos, policy, payloadJSON, now, now); err != nil {
			return err
		}
		out, err = getQueueTx(ctx, tx, queueID)
		if err != nil {
			return err
		}
		return r.appendEventTx(ctx, tx, sessionID, "queue.item.added", map[string]any{"entry": queueEntryToMap(out)})
	})
	return out, err
}

func (r *QueueRepository) Edit(ctx context.Context, queueID string, patch map[string]any) (*QueueEntry, error) {
	var out *QueueEntry
	err := r.db.withTx(ctx, func(tx *sql.Tx) error {
		item, err := requireQueuedTx(ctx, tx, queueID)
		if err != nil {
			return err
		}
		payload := CloneMap(item.Payload)
		maps.Copy(payload, CloneMap(patch))
		payloadJSON, err := CanonicalJSON(payload)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE chat_runtime_queue SET payload_json = ?, updated_at = ?
			WHERE queue_id = ? AND state = 'queued'
		`, payloadJSON, r.db.clock(), item.QueueID); err != nil {
			return err
		}
		out, err = getQueueTx(ctx, tx, item.QueueID)
		if err != nil {
			return err
		}
		return r.appendEventTx(ctx, tx, item.SessionID, "queue.item.updated", map[string]any{"entry": queueEntryToMap(out)})
	})
	return out, err
}

func (r *QueueRepository) Remove(ctx context.Context, queueID string) (*QueueEntry, error) {
	var out *QueueEntry
	err := r.db.withTx(ctx, func(tx *sql.Tx) error {
		item, err := requireQueuedTx(ctx, tx, queueID)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM chat_runtime_queue WHERE queue_id = ? AND state = 'queued'`, item.QueueID); err != nil {
			return err
		}
		out = item
		return r.appendEventTx(ctx, tx, item.SessionID, "queue.item.removed", map[string]any{"queueId": item.QueueID})
	})
	return out, err
}

func (r *QueueRepository) Move(ctx context.Context, queueID, beforeQueueID string) (*QueueEntry, error) {
	var out *QueueEntry
	err := r.db.withTx(ctx, func(tx *sql.Tx) error {
		item, err := requireQueuedTx(ctx, tx, queueID)
		if err != nil {
			return err
		}
		var before *QueueEntry
		if strings.TrimSpace(beforeQueueID) != "" {
			before, err = requireQueuedTx(ctx, tx, beforeQueueID)
			if err != nil {
				return err
			}
			if before.SessionID != item.SessionID {
				return NewError("chat_queue_move_target_invalid", http.StatusConflict, nil)
			}
			if before.QueueID == item.QueueID {
				out = item
				return nil
			}
		}
		rows, err := listQueueTx(ctx, tx, item.SessionID, false)
		if err != nil {
			return err
		}
		queuedRows := make([]QueueEntry, 0, len(rows))
		for _, row := range rows {
			if row.Status == "queued" {
				queuedRows = append(queuedRows, row)
			}
		}
		beforeID := ""
		if before != nil {
			beforeID = before.QueueID
		}
		orderedIDs := reorderQueueIDs(queuedRows, item.QueueID, beforeID)
		if err := rewriteQueuePositionsTx(ctx, tx, queuedRows, orderedIDs, r.db.clock); err != nil {
			return err
		}
		movePayload := map[string]any{"queueId": item.QueueID}
		if before != nil {
			movePayload["beforeQueueId"] = before.QueueID
		}
		if err := r.appendEventTx(ctx, tx, item.SessionID, "queue.item.moved", movePayload); err != nil {
			return err
		}
		out, err = getQueueTx(ctx, tx, item.QueueID)
		return err
	})
	return out, err
}

func (r *QueueRepository) Lease(ctx context.Context, sessionID string, input LeaseQueueInput) (*QueueEntry, error) {
	leaseID, err := RequiredText(input.LeaseID, "chat_queue_lease_id_required")
	if err != nil {
		return nil, err
	}
	var out *QueueEntry
	err = r.db.withTx(ctx, func(tx *sql.Tx) error {
		if err := requireSessionExistsTx(ctx, tx, sessionID); err != nil {
			return err
		}
		sel, err := selectQueueLeaseTx(ctx, tx, sessionID, input)
		if err != nil || sel == nil || sel.Row == nil {
			return err
		}
		res, err := tx.ExecContext(ctx, `
			UPDATE chat_runtime_queue
			SET state = 'leased', lease_id = ?, boundary_item_id = ?, updated_at = ?
			WHERE queue_id = ? AND state = 'queued'
		`, leaseID, nullableText(sel.BoundaryItemID), r.db.clock(), sel.Row.QueueID)
		if err != nil {
			return err
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			return nil
		}
		out, err = getQueueTx(ctx, tx, sel.Row.QueueID)
		if err != nil {
			return err
		}
		return r.appendEventTx(ctx, tx, sessionID, "queue.item.dispatched", map[string]any{"entry": queueEntryToMap(out)})
	})
	return out, err
}

func (r *QueueRepository) LeaseNext(ctx context.Context, sessionID string, input LeaseQueueInput) (*QueueEntry, error) {
	return r.Lease(ctx, sessionID, input)
}

func (r *QueueRepository) MarkRunning(ctx context.Context, queueID, leaseID string) (*QueueEntry, error) {
	return r.transition(ctx, queueID, leaseID, "leased", "running", nil, false)
}

func (r *QueueRepository) markRunningInTx(ctx context.Context, tx *sql.Tx, queueID, leaseID string) (*QueueEntry, error) {
	return r.transitionInTx(ctx, tx, queueID, leaseID, "leased", "running", nil, false)
}

func (r *QueueRepository) Settle(ctx context.Context, queueID, leaseID, outcome string, result map[string]any) (*QueueEntry, error) {
	if outcome != "completed" && outcome != "failed" {
		return nil, NewError("invalid_queue_transition", http.StatusConflict, map[string]any{"outcome": outcome})
	}
	return r.transition(ctx, queueID, leaseID, "running", outcome, result, true)
}

func (r *QueueRepository) settleInTx(ctx context.Context, tx *sql.Tx, queueID, leaseID, outcome string, result map[string]any) (*QueueEntry, error) {
	if outcome != "completed" && outcome != "failed" {
		return nil, NewError("invalid_queue_transition", http.StatusConflict, map[string]any{"outcome": outcome})
	}
	return r.transitionInTx(ctx, tx, queueID, leaseID, "running", outcome, result, true)
}

func (r *QueueRepository) transition(ctx context.Context, queueID, leaseID, from, to string, result map[string]any, hasResult bool) (*QueueEntry, error) {
	var out *QueueEntry
	err := r.db.withTx(ctx, func(tx *sql.Tx) error {
		var err error
		out, err = r.transitionInTx(ctx, tx, queueID, leaseID, from, to, result, hasResult)
		return err
	})
	return out, err
}

func (r *QueueRepository) transitionInTx(ctx context.Context, tx *sql.Tx, queueID, leaseID, from, to string, result map[string]any, hasResult bool) (*QueueEntry, error) {
	item, err := getQueueTx(ctx, tx, queueID)
	if err != nil {
		return nil, err
	}
	if item == nil || item.Status != from || item.LeaseID != leaseID {
		return nil, NewError("invalid_queue_transition", http.StatusConflict, map[string]any{"from": from, "to": to})
	}
	var persistedResult sql.NullString
	if to == "completed" || to == "failed" {
		projected := ProjectCanonicalQueueResult(to, result)
		encoded, err := CanonicalJSON(projected)
		if err != nil {
			return nil, err
		}
		persistedResult = sql.NullString{String: encoded, Valid: true}
	} else if hasResult && result != nil {
		encoded, err := CanonicalJSON(result)
		if err != nil {
			return nil, err
		}
		persistedResult = sql.NullString{String: encoded, Valid: true}
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE chat_runtime_queue SET state = ?, result_json = ?, updated_at = ?
		WHERE queue_id = ? AND state = ? AND lease_id = ?
	`, to, persistedResult, r.db.clock(), queueID, from, leaseID); err != nil {
		return nil, err
	}
	updated, err := getQueueTx(ctx, tx, queueID)
	if err != nil {
		return nil, err
	}
	if err := r.appendEventTx(ctx, tx, updated.SessionID, "queue.item.updated", map[string]any{"entry": queueEntryToMap(updated)}); err != nil {
		return nil, err
	}
	return updated, nil
}

func (r *QueueRepository) List(ctx context.Context, sessionID string, activeOnly bool) ([]QueueEntry, error) {
	var out []QueueEntry
	err := r.db.withRead(ctx, func(db *sql.DB) error {
		var err error
		out, err = listQueueQuerier(ctx, db, sessionID, activeOnly)
		return err
	})
	return out, err
}

func (r *QueueRepository) Get(ctx context.Context, queueID string) (*QueueEntry, error) {
	var out *QueueEntry
	err := r.db.withRead(ctx, func(db *sql.DB) error {
		var err error
		out, err = getQueueQuerier(ctx, db, queueID)
		return err
	})
	return out, err
}

func (r *QueueRepository) appendEventTx(ctx context.Context, tx *sql.Tx, sessionID, evType string, payload map[string]any) error {
	_, err := r.events.appendInTx(ctx, tx, sessionID, EventDraft{
		Type:    evType,
		Source:  EventSource{Provider: "aih", RuntimeID: "chat-runtime"},
		Payload: payload,
	}, true, nil)
	return err
}

type queueLeaseSelection struct {
	BoundaryItemID string
	Row            *QueueEntry
}

func selectQueueLeaseTx(ctx context.Context, tx *sql.Tx, sessionID string, input LeaseQueueInput) (*queueLeaseSelection, error) {
	var policy string
	if strings.TrimSpace(input.Policy) != "" {
		policy = strings.TrimSpace(input.Policy)
		if _, ok := ValidQueuePolicies[policy]; !ok {
			return nil, ErrInvalid("invalid_chat_queue_policy")
		}
	}
	boundaryItemID := strings.TrimSpace(input.BoundaryItemID)
	if boundaryItemID != "" {
		var dummy string
		err := tx.QueryRowContext(ctx, `
			SELECT queue_id FROM chat_runtime_queue WHERE session_id = ? AND boundary_item_id = ? LIMIT 1
		`, sessionID, boundaryItemID).Scan(&dummy)
		if err == nil {
			return &queueLeaseSelection{BoundaryItemID: boundaryItemID, Row: nil}, nil
		}
		if err != sql.ErrNoRows {
			return nil, err
		}
	}
	conds := []string{"session_id = ?", "state = 'queued'"}
	args := []any{sessionID}
	if qID := strings.TrimSpace(input.QueueID); qID != "" {
		conds = append(conds, "queue_id = ?")
		args = append(args, qID)
	}
	if policy != "" {
		conds = append(conds, "policy = ?")
		args = append(args, policy)
	}
	query := `SELECT queue_id, session_id, command_id, position, policy, payload_json, state, lease_id, boundary_item_id, result_json, created_at, updated_at
		FROM chat_runtime_queue WHERE ` + strings.Join(conds, " AND ") + ` ORDER BY position LIMIT 1`
	entry, err := scanQueueRow(tx.QueryRowContext(ctx, query, args...))
	if err != nil {
		return nil, err
	}
	return &queueLeaseSelection{BoundaryItemID: boundaryItemID, Row: entry}, nil
}

func requireSessionExistsTx(ctx context.Context, tx *sql.Tx, sessionID string) error {
	var id string
	if err := tx.QueryRowContext(ctx, `SELECT session_id FROM chat_runtime_sessions WHERE session_id = ?`, sessionID).Scan(&id); err != nil {
		if err == sql.ErrNoRows {
			return NewError("chat_session_not_found", http.StatusNotFound, nil)
		}
		return err
	}
	return nil
}

func requireQueuedTx(ctx context.Context, tx *sql.Tx, queueID string) (*QueueEntry, error) {
	id, err := RequiredText(queueID, "chat_queue_id_required")
	if err != nil {
		return nil, err
	}
	item, err := getQueueTx(ctx, tx, id)
	if err != nil {
		return nil, err
	}
	if item == nil {
		return nil, NewError("chat_queue_item_not_found", http.StatusNotFound, nil)
	}
	if item.Status != "queued" {
		return nil, NewError("chat_queue_item_not_queued", http.StatusConflict, map[string]any{"queueId": id})
	}
	return item, nil
}

func getQueueTx(ctx context.Context, tx *sql.Tx, queueID string) (*QueueEntry, error) {
	return getQueueQuerier(ctx, tx, queueID)
}

func getQueueQuerier(ctx context.Context, q rowQuerier, queueID string) (*QueueEntry, error) {
	return scanQueueRow(q.QueryRowContext(ctx, `
		SELECT queue_id, session_id, command_id, position, policy, payload_json, state, lease_id, boundary_item_id, result_json, created_at, updated_at
		FROM chat_runtime_queue WHERE queue_id = ?
	`, queueID))
}

func listQueueTx(ctx context.Context, tx *sql.Tx, sessionID string, activeOnly bool) ([]QueueEntry, error) {
	active := ""
	if activeOnly {
		active = "AND state IN ('queued', 'leased', 'running')"
	}
	rows, err := tx.QueryContext(ctx, `
		SELECT queue_id, session_id, command_id, position, policy, payload_json, state, lease_id, boundary_item_id, result_json, created_at, updated_at
		FROM chat_runtime_queue WHERE session_id = ? `+active+` ORDER BY position
	`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanQueueRows(rows)
}

func listQueueQuerier(ctx context.Context, db *sql.DB, sessionID string, activeOnly bool) ([]QueueEntry, error) {
	active := ""
	if activeOnly {
		active = "AND state IN ('queued', 'leased', 'running')"
	}
	rows, err := db.QueryContext(ctx, `
		SELECT queue_id, session_id, command_id, position, policy, payload_json, state, lease_id, boundary_item_id, result_json, created_at, updated_at
		FROM chat_runtime_queue WHERE session_id = ? `+active+` ORDER BY position
	`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanQueueRows(rows)
}

func scanQueueRows(rows *sql.Rows) ([]QueueEntry, error) {
	out := []QueueEntry{}
	for rows.Next() {
		item, err := scanQueueRow(rows)
		if err != nil {
			return nil, err
		}
		if item != nil {
			out = append(out, *item)
		}
	}
	return out, rows.Err()
}

func scanQueueRow(row rowScanner) (*QueueEntry, error) {
	var (
		e              QueueEntry
		payloadJSON    string
		leaseID        sql.NullString
		boundaryItemID sql.NullString
		resultJSON     sql.NullString
	)
	if err := row.Scan(
		&e.QueueID, &e.SessionID, &e.CommandID, &e.Position, &e.Policy, &payloadJSON,
		&e.Status, &leaseID, &boundaryItemID, &resultJSON, &e.CreatedAt, &e.UpdatedAt,
	); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	e.Payload = parseJSONObject(payloadJSON)
	e.LeaseID = leaseID.String
	e.BoundaryItemID = boundaryItemID.String
	if resultJSON.Valid && strings.TrimSpace(resultJSON.String) != "" && strings.TrimSpace(resultJSON.String) != "null" {
		e.Result = parseJSONObject(resultJSON.String)
	}
	return &e, nil
}

func queueEntryToMap(e *QueueEntry) map[string]any {
	m := map[string]any{
		"queueId":   e.QueueID,
		"sessionId": e.SessionID,
		"commandId": e.CommandID,
		"position":  e.Position,
		"policy":    e.Policy,
		"payload":   CloneMap(e.Payload),
		"status":    e.Status,
		"createdAt": e.CreatedAt,
		"updatedAt": e.UpdatedAt,
	}
	if e.LeaseID != "" {
		m["leaseId"] = e.LeaseID
	}
	if e.BoundaryItemID != "" {
		m["boundaryItemId"] = e.BoundaryItemID
	}
	if e.Result != nil {
		m["result"] = CloneMap(e.Result)
	}
	return m
}

func reorderQueueIDs(rows []QueueEntry, queueID, beforeQueueID string) []string {
	ids := make([]string, 0, len(rows))
	for _, r := range rows {
		if r.QueueID != queueID {
			ids = append(ids, r.QueueID)
		}
	}
	index := len(ids)
	if beforeQueueID != "" {
		for i, id := range ids {
			if id == beforeQueueID {
				index = i
				break
			}
		}
	}
	out := make([]string, 0, len(ids)+1)
	out = append(out, ids[:index]...)
	out = append(out, queueID)
	out = append(out, ids[index:]...)
	return out
}

func rewriteQueuePositionsTx(ctx context.Context, tx *sql.Tx, rows []QueueEntry, orderedIDs []string, clock func() int64) error {
	positions := make([]int, len(rows))
	for i, r := range rows {
		positions[i] = r.Position
	}
	sort.Ints(positions)
	now := clock()
	for _, r := range rows {
		if _, err := tx.ExecContext(ctx, `UPDATE chat_runtime_queue SET position = ?, updated_at = ? WHERE queue_id = ?`, -r.Position, now, r.QueueID); err != nil {
			return err
		}
	}
	for i, id := range orderedIDs {
		if _, err := tx.ExecContext(ctx, `UPDATE chat_runtime_queue SET position = ?, updated_at = ? WHERE queue_id = ?`, positions[i], now, id); err != nil {
			return err
		}
	}
	return nil
}

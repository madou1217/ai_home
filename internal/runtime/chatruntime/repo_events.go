package chatruntime

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"strings"
)

const PrewarmRetainedEventWindow int64 = 1000

// EventBounds 描述会话持久化事件序列上下界与计数。
type EventBounds struct {
	FirstSeq *int64 `json:"firstSeq"`
	LastSeq  int64  `json:"lastSeq"`
	Count    int64  `json:"count"`
}

// EventRepository 负责 chat_runtime_events 的追加、重放查询与时间线分页。
type EventRepository struct {
	db          *Database
	idFactory   func(prefix string) string
	turnMetrics *TurnMetricsRepository
}

func newEventRepository(db *Database, idFactory func(string) string) *EventRepository {
	repo := &EventRepository{db: db, idFactory: idFactory}
	repo.turnMetrics = newTurnMetricsRepository(db, repo)
	return repo
}

func (r *EventRepository) Append(ctx context.Context, sessionID string, draft EventDraft) (EventEnvelope, error) {
	var out EventEnvelope
	err := r.db.withTx(ctx, func(tx *sql.Tx) error {
		var err error
		out, err = r.appendInTx(ctx, tx, sessionID, draft, true, nil)
		return err
	})
	return out, err
}

func (r *EventRepository) appendInTx(ctx context.Context, tx *sql.Tx, sessionID string, draft EventDraft, measureTurn bool, guard *ToolHistoryIntegrityGuard) (EventEnvelope, error) {
	if IsTransportEvent(draft.Type) {
		return EventEnvelope{}, NewError("chat_transport_event_not_persistable", http.StatusUnprocessableEntity, map[string]any{"type": draft.Type})
	}
	var lastSeq int64
	err := tx.QueryRowContext(ctx, `SELECT last_event_seq FROM chat_runtime_sessions WHERE session_id = ?`, sessionID).Scan(&lastSeq)
	if err == sql.ErrNoRows {
		return EventEnvelope{}, NewError("chat_session_not_found", http.StatusNotFound, nil)
	}
	if err != nil {
		return EventEnvelope{}, err
	}
	seq := lastSeq + 1
	eventID := strings.TrimSpace(draft.EventID)
	if eventID == "" {
		eventID = r.idFactory("event")
	}
	at := r.db.clock()
	if draft.At != nil {
		at = *draft.At
	}
	itemID := draft.ItemID
	if itemID == "" {
		itemID = resolveDraftItemID(draft.Payload)
	}
	env, err := NormalizeEventEnvelope(EventEnvelope{
		Schema:    EventSchema,
		EventID:   eventID,
		SessionID: sessionID,
		Seq:       seq,
		Type:      draft.Type,
		At:        at,
		TurnID:    draft.TurnID,
		RunID:     draft.RunID,
		ItemID:    itemID,
		Source:    draft.Source,
		Payload:   draft.Payload,
	})
	if err != nil {
		return EventEnvelope{}, err
	}
	if guard == nil {
		guard = newToolHistoryIntegrityGuard(r.db, sessionID)
	}
	if err := guard.Assert(ctx, tx, []EventDraft{{
		EventID: env.EventID,
		Type:    env.Type,
		TurnID:  env.TurnID,
		RunID:   env.RunID,
		ItemID:  env.ItemID,
		Source:  env.Source,
		Payload: env.Payload,
	}}); err != nil {
		return EventEnvelope{}, err
	}
	srcJSON, err := CanonicalJSON(env.Source)
	if err != nil {
		return EventEnvelope{}, err
	}
	payloadJSON, err := CanonicalJSON(env.Payload)
	if err != nil {
		return EventEnvelope{}, err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO chat_runtime_events (
			event_id, session_id, seq, schema, type, at, turn_id, run_id,
			item_id, source_json, payload_json
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, env.EventID, env.SessionID, env.Seq, env.Schema, env.Type, env.At,
		nullableText(env.TurnID), nullableText(env.RunID), nullableText(env.ItemID),
		srcJSON, payloadJSON); err != nil {
		return EventEnvelope{}, err
	}

	if strings.HasPrefix(env.Type, "runtime.prewarm.") {
		if _, err := tx.ExecContext(ctx, `UPDATE chat_runtime_sessions SET last_event_seq = ? WHERE session_id = ?`, seq, sessionID); err != nil {
			return EventEnvelope{}, err
		}
		if _, err := tx.ExecContext(ctx, `
			DELETE FROM chat_runtime_events WHERE session_id = ? AND seq <= ? AND type LIKE 'runtime.prewarm.%'
		`, sessionID, seq-PrewarmRetainedEventWindow); err != nil {
			return EventEnvelope{}, err
		}
	} else {
		if _, err := tx.ExecContext(ctx, `UPDATE chat_runtime_sessions SET last_event_seq = ?, updated_at = ? WHERE session_id = ?`, seq, env.At, sessionID); err != nil {
			return EventEnvelope{}, err
		}
	}

	if measureTurn {
		if err := r.turnMetrics.observeInTx(ctx, tx, env); err != nil {
			return EventEnvelope{}, err
		}
		switch env.Type {
		case "session.goal.updated", "session.goal.cleared", "turn.metrics.updated",
			"timeline.item.started", "timeline.item.completed",
			"turn.failed", "turn.interrupted", "run.lost":
			if err := projectChatContextInTx(ctx, tx, r, env); err != nil {
				return EventEnvelope{}, err
			}
		}
	}
	return env, nil
}

func (r *EventRepository) List(ctx context.Context, sessionID string, after int64, through *int64, limit int) ([]EventEnvelope, error) {
	if after < 0 {
		after = 0
	}
	if limit <= 0 {
		limit = 100
	} else if limit > 1000 {
		limit = 1000
	}
	var out []EventEnvelope
	err := r.db.withRead(ctx, func(db *sql.DB) error {
		var (
			rows *sql.Rows
			err  error
		)
		if through != nil && *through >= 0 {
			rows, err = db.QueryContext(ctx, `
				SELECT event_id, session_id, seq, schema, type, at, turn_id, run_id, item_id, source_json, payload_json
				FROM chat_runtime_events
				WHERE session_id = ? AND seq > ? AND seq <= ? ORDER BY seq LIMIT ?
			`, sessionID, after, *through, limit)
		} else {
			rows, err = db.QueryContext(ctx, `
				SELECT event_id, session_id, seq, schema, type, at, turn_id, run_id, item_id, source_json, payload_json
				FROM chat_runtime_events
				WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?
			`, sessionID, after, limit)
		}
		if err != nil {
			return err
		}
		defer rows.Close()
		out, err = scanEventRows(rows)
		return err
	})
	return out, err
}

func (r *EventRepository) ListAll(ctx context.Context, sessionID string) ([]EventEnvelope, error) {
	var out []EventEnvelope
	err := r.db.withRead(ctx, func(db *sql.DB) error {
		rows, err := db.QueryContext(ctx, `
			SELECT event_id, session_id, seq, schema, type, at, turn_id, run_id, item_id, source_json, payload_json
			FROM chat_runtime_events WHERE session_id = ? ORDER BY seq
		`, sessionID)
		if err != nil {
			return err
		}
		defer rows.Close()
		out, err = scanEventRows(rows)
		return err
	})
	return out, err
}

func (r *EventRepository) ReadTimelinePage(ctx context.Context, sessionID, before string, limit int) ([]EventEnvelope, bool, error) {
	if limit <= 0 {
		limit = 30
	} else if limit > 100 {
		limit = 100
	}
	var events []EventEnvelope
	var hasMore bool
	err := r.db.withRead(ctx, func(db *sql.DB) error {
		var beforeSeq sql.NullInt64
		if trimmed := strings.TrimSpace(before); trimmed != "" {
			if err := db.QueryRowContext(ctx, `
				SELECT MIN(seq) FROM chat_runtime_events
				WHERE session_id = ? AND item_id = ? AND type LIKE 'timeline.item.%%'
			`, sessionID, trimmed).Scan(&beforeSeq); err != nil {
				return err
			}
			if !beforeSeq.Valid {
				return NewError("chat_timeline_cursor_not_found", http.StatusBadRequest, nil)
			}
		}
		rows, err := db.QueryContext(ctx, `
			SELECT item_id, MIN(seq) AS first_seq
			FROM chat_runtime_events
			WHERE session_id = ? AND item_id IS NOT NULL AND type LIKE 'timeline.item.%'
			GROUP BY item_id
			HAVING ? IS NULL OR MIN(seq) < ?
			ORDER BY first_seq DESC LIMIT ?
		`, sessionID, beforeSeq, beforeSeq, limit+1)
		if err != nil {
			return err
		}
		var itemIDs []string
		for rows.Next() {
			var itemID sql.NullString
			var firstSeq int64
			if err := rows.Scan(&itemID, &firstSeq); err != nil {
				_ = rows.Close()
				return err
			}
			if strings.TrimSpace(itemID.String) != "" {
				itemIDs = append(itemIDs, itemID.String)
			}
		}
		_ = rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		if len(itemIDs) > limit {
			hasMore = true
			itemIDs = itemIDs[:limit]
		}
		if len(itemIDs) == 0 {
			events = []EventEnvelope{}
			return nil
		}
		placeholders := make([]string, len(itemIDs))
		args := make([]any, 0, len(itemIDs)+1)
		args = append(args, sessionID)
		for i, id := range itemIDs {
			placeholders[i] = "?"
			args = append(args, id)
		}
		evRows, err := db.QueryContext(ctx, fmt.Sprintf(`
			SELECT event_id, session_id, seq, schema, type, at, turn_id, run_id, item_id, source_json, payload_json
			FROM chat_runtime_events
			WHERE session_id = ? AND item_id IN (%s) AND type LIKE 'timeline.item.%%'
			ORDER BY seq
		`, strings.Join(placeholders, ", ")), args...)
		if err != nil {
			return err
		}
		defer evRows.Close()
		events, err = scanEventRows(evRows)
		return err
	})
	return events, hasMore, err
}

func (r *EventRepository) GetBounds(ctx context.Context, sessionID string) (EventBounds, error) {
	var out EventBounds
	err := r.db.withRead(ctx, func(db *sql.DB) error {
		var firstSeq sql.NullInt64
		var lastSeq sql.NullInt64
		if err := db.QueryRowContext(ctx, `
			SELECT MIN(seq), MAX(seq), COUNT(*) FROM chat_runtime_events WHERE session_id = ?
		`, sessionID).Scan(&firstSeq, &lastSeq, &out.Count); err != nil {
			return err
		}
		if firstSeq.Valid {
			v := firstSeq.Int64
			out.FirstSeq = &v
		}
		if lastSeq.Valid {
			out.LastSeq = lastSeq.Int64
		}
		return nil
	})
	return out, err
}

func scanEventRows(rows *sql.Rows) ([]EventEnvelope, error) {
	out := []EventEnvelope{}
	for rows.Next() {
		var (
			ev          EventEnvelope
			turnID      sql.NullString
			runID       sql.NullString
			itemID      sql.NullString
			sourceJSON  string
			payloadJSON string
		)
		if err := rows.Scan(
			&ev.EventID, &ev.SessionID, &ev.Seq, &ev.Schema, &ev.Type, &ev.At,
			&turnID, &runID, &itemID, &sourceJSON, &payloadJSON,
		); err != nil {
			return nil, err
		}
		ev.TurnID = turnID.String
		ev.RunID = runID.String
		ev.ItemID = itemID.String
		srcMap := parseJSONObject(sourceJSON)
		ev.Source = EventSource{
			Provider:      asString(srcMap["provider"]),
			RuntimeID:     asString(srcMap["runtimeId"]),
			NativeEventID: asString(srcMap["nativeEventId"]),
		}
		ev.Payload = parseJSONObject(payloadJSON)
		norm, err := NormalizeEventEnvelope(ev)
		if err != nil {
			return nil, err
		}
		out = append(out, norm)
	}
	return out, rows.Err()
}

func resolveDraftItemID(payload map[string]any) string {
	if payload == nil {
		return ""
	}
	if item, ok := payload["item"].(map[string]any); ok && item != nil {
		return asString(item["id"])
	}
	return asString(payload["itemId"])
}

func nullableText(s string) sql.NullString {
	if strings.TrimSpace(s) == "" {
		return sql.NullString{}
	}
	return sql.NullString{String: s, Valid: true}
}

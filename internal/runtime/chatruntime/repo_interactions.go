package chatruntime

import (
	"context"
	"database/sql"
	"net/http"
	"strings"
)

var validInteractionKinds = map[string]struct{}{
	"question":          {},
	"approval":          {},
	"plan_confirmation": {},
}

// CreateInteractionInput 描述创建交互请求。
type CreateInteractionInput struct {
	InteractionID string
	SessionID     string
	ItemID        string
	Kind          string
	Revision      int
	Payload       map[string]any
}

// ResolveInteractionInput 描述校验或提交交互解决结果参数。
type ResolveInteractionInput struct {
	SessionID  string
	Kind       string
	Revision   int
	Resolution map[string]any
}

// InteractionRepository 管理 chat_runtime_interactions 的创建、二阶段认领与解决。
type InteractionRepository struct {
	db        *Database
	events    *EventRepository
	idFactory func(string) string
}

func newInteractionRepository(db *Database, events *EventRepository, idFactory func(string) string) *InteractionRepository {
	return &InteractionRepository{db: db, events: events, idFactory: idFactory}
}

func (r *InteractionRepository) Create(ctx context.Context, input CreateInteractionInput) (*Interaction, error) {
	kind, err := RequiredText(input.Kind, "chat_interaction_kind_required")
	if err != nil {
		return nil, err
	}
	if _, ok := validInteractionKinds[kind]; !ok {
		return nil, NewError("invalid_chat_interaction_kind", http.StatusUnprocessableEntity, map[string]any{"kind": kind})
	}
	sessionID, err := RequiredText(input.SessionID, "chat_session_id_required")
	if err != nil {
		return nil, err
	}
	itemID, err := RequiredText(input.ItemID, "chat_interaction_item_id_required")
	if err != nil {
		return nil, err
	}
	rev := input.Revision
	if rev == 0 {
		rev = 1
	}
	if rev < 1 {
		return nil, ErrInvalid("invalid_interaction_revision")
	}
	payload, err := NormalizeCanonicalInteractionPayload(kind, input.Payload)
	if err != nil {
		return nil, err
	}
	payloadJSON, err := CanonicalJSON(payload)
	if err != nil {
		return nil, err
	}
	id := strings.TrimSpace(input.InteractionID)
	if id == "" {
		id = r.idFactory("interaction")
	}

	var out *Interaction
	err = r.db.withTx(ctx, func(tx *sql.Tx) error {
		now := r.db.clock()
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO chat_runtime_interactions (
				interaction_id, session_id, item_id, kind, revision, payload_json,
				state, resolution_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)
		`, id, sessionID, itemID, kind, rev, payloadJSON, now, now); err != nil {
			return err
		}
		out, err = getInteractionTx(ctx, tx, id)
		if err != nil {
			return err
		}
		return r.appendEventTx(ctx, tx, out.SessionID, "interaction.requested", out)
	})
	return out, err
}

func (r *InteractionRepository) Resolve(ctx context.Context, interactionID string, input ResolveInteractionInput) (*Interaction, error) {
	var out *Interaction
	err := r.db.withTx(ctx, func(tx *sql.Tx) error {
		current, err := r.validateQuerier(ctx, tx, interactionID, input)
		if err != nil {
			return err
		}
		resJSON, err := CanonicalJSON(input.Resolution)
		if err != nil {
			return err
		}
		res, err := tx.ExecContext(ctx, `
			UPDATE chat_runtime_interactions
			SET state = 'answered', resolution_json = ?, updated_at = ?
			WHERE interaction_id = ? AND revision = ? AND state = 'pending'
		`, resJSON, r.db.clock(), current.InteractionID, current.Revision)
		if err != nil {
			return err
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			return NewError("stale_interaction", http.StatusConflict, nil)
		}
		out, err = getInteractionTx(ctx, tx, current.InteractionID)
		if err != nil {
			return err
		}
		return r.appendResolutionEventsTx(ctx, tx, out)
	})
	return out, err
}

func (r *InteractionRepository) ClaimResolution(ctx context.Context, interactionID string, input ResolveInteractionInput) (*Interaction, error) {
	sessionID, err := RequiredText(input.SessionID, "chat_session_id_required")
	if err != nil {
		return nil, err
	}
	var out *Interaction
	err = r.db.withTx(ctx, func(tx *sql.Tx) error {
		current, err := r.validateQuerier(ctx, tx, interactionID, input)
		if err != nil {
			return err
		}
		resJSON, err := CanonicalJSON(input.Resolution)
		if err != nil {
			return err
		}
		res, err := tx.ExecContext(ctx, `
			UPDATE chat_runtime_interactions
			SET state = 'resolving', resolution_json = ?, updated_at = ?
			WHERE interaction_id = ? AND session_id = ? AND revision = ? AND state = 'pending'
		`, resJSON, r.db.clock(), current.InteractionID, sessionID, current.Revision)
		if err != nil {
			return err
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			return NewError("stale_interaction", http.StatusConflict, nil)
		}
		out, err = getInteractionTx(ctx, tx, current.InteractionID)
		if err != nil {
			return err
		}
		return r.appendEventTx(ctx, tx, out.SessionID, "interaction.updated", out)
	})
	return out, err
}

func (r *InteractionRepository) FinishResolution(ctx context.Context, claim *Interaction) (*Interaction, error) {
	if claim == nil {
		return nil, NewError("stale_interaction", http.StatusConflict, nil)
	}
	var out *Interaction
	err := r.db.withTx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, `
			UPDATE chat_runtime_interactions SET state = 'answered', updated_at = ?
			WHERE interaction_id = ? AND session_id = ? AND revision = ? AND state = 'resolving'
		`, r.db.clock(), claim.InteractionID, claim.SessionID, claim.Revision)
		if err != nil {
			return err
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			current, err := getInteractionTx(ctx, tx, claim.InteractionID)
			if err != nil {
				return err
			}
			if current != nil && current.SessionID == claim.SessionID && current.Revision == claim.Revision &&
				current.State == "answered" && CanonicalJSONEquals(current.Resolution, claim.Resolution) {
				out = current
				return nil
			}
			return NewError("stale_interaction", http.StatusConflict, nil)
		}
		out, err = getInteractionTx(ctx, tx, claim.InteractionID)
		if err != nil {
			return err
		}
		return r.appendResolutionEventsTx(ctx, tx, out)
	})
	return out, err
}

func (r *InteractionRepository) ReleaseResolution(ctx context.Context, claim *Interaction) (*Interaction, error) {
	if claim == nil {
		return nil, nil
	}
	var out *Interaction
	err := r.db.withTx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, `
			UPDATE chat_runtime_interactions
			SET state = 'pending', resolution_json = NULL, updated_at = ?
			WHERE interaction_id = ? AND session_id = ? AND revision = ? AND state = 'resolving'
		`, r.db.clock(), claim.InteractionID, claim.SessionID, claim.Revision)
		if err != nil {
			return err
		}
		n, _ := res.RowsAffected()
		out, err = getInteractionTx(ctx, tx, claim.InteractionID)
		if err != nil || n == 0 || out == nil {
			return err
		}
		return r.appendEventTx(ctx, tx, out.SessionID, "interaction.updated", out)
	})
	return out, err
}

func (r *InteractionRepository) AcknowledgeExternal(ctx context.Context, interactionID string) (*Interaction, error) {
	var out *Interaction
	err := r.db.withTx(ctx, func(tx *sql.Tx) error {
		current, err := getInteractionTx(ctx, tx, interactionID)
		if err != nil {
			return err
		}
		if current == nil || (current.State != "pending" && current.State != "resolving") {
			out = current
			return nil
		}
		fallbackRes, _ := CanonicalJSON(map[string]any{"reason": "resolved_elsewhere"})
		res, err := tx.ExecContext(ctx, `
			UPDATE chat_runtime_interactions
			SET state = 'answered',
				resolution_json = CASE WHEN state = 'pending' THEN ? ELSE resolution_json END,
				updated_at = ?
			WHERE interaction_id = ? AND state IN ('pending', 'resolving')
		`, fallbackRes, r.db.clock(), current.InteractionID)
		if err != nil {
			return err
		}
		n, _ := res.RowsAffected()
		out, err = getInteractionTx(ctx, tx, current.InteractionID)
		if err != nil || n == 0 || out == nil {
			return err
		}
		return r.appendEventTx(ctx, tx, out.SessionID, "interaction.resolved", out)
	})
	return out, err
}

// Expire 将仍处于挂起/结算中的交互标记为 expired，并追加 interaction.expired 事件。
func (r *InteractionRepository) Expire(ctx context.Context, interactionID, reason string) (*Interaction, error) {
	reason = strings.TrimSpace(reason)
	if reason == "" {
		reason = "expired"
	}
	var out *Interaction
	err := r.db.withTx(ctx, func(tx *sql.Tx) error {
		current, err := getInteractionTx(ctx, tx, interactionID)
		if err != nil {
			return err
		}
		if current == nil || (current.State != "pending" && current.State != "resolving") {
			out = current
			return nil
		}
		expiredRes, _ := CanonicalJSON(map[string]any{"reason": reason})
		res, err := tx.ExecContext(ctx, `
			UPDATE chat_runtime_interactions
			SET state = 'expired',
				resolution_json = ?,
				updated_at = ?
			WHERE interaction_id = ? AND state IN ('pending', 'resolving')
		`, expiredRes, r.db.clock(), current.InteractionID)
		if err != nil {
			return err
		}
		n, _ := res.RowsAffected()
		out, err = getInteractionTx(ctx, tx, current.InteractionID)
		if err != nil || n == 0 || out == nil {
			return err
		}
		return r.appendEventTx(ctx, tx, out.SessionID, "interaction.expired", out)
	})
	return out, err
}

func (r *InteractionRepository) Validate(ctx context.Context, interactionID string, input ResolveInteractionInput) (*Interaction, error) {
	var out *Interaction
	err := r.db.withRead(ctx, func(db *sql.DB) error {
		var err error
		out, err = r.validateQuerier(ctx, db, interactionID, input)
		return err
	})
	return out, err
}

func (r *InteractionRepository) validateQuerier(ctx context.Context, q rowQuerier, interactionID string, input ResolveInteractionInput) (*Interaction, error) {
	if input.Revision < 1 {
		return nil, ErrInvalid("invalid_interaction_revision")
	}
	current, err := getInteractionQuerier(ctx, q, interactionID)
	if err != nil {
		return nil, err
	}
	if current == nil || current.State != "pending" || current.Revision != input.Revision {
		return nil, NewError("stale_interaction", http.StatusConflict, map[string]any{
			"interactionId": interactionID,
			"revision":      input.Revision,
		})
	}
	if sID := strings.TrimSpace(input.SessionID); sID != "" && current.SessionID != sID {
		return nil, NewError("stale_interaction", http.StatusConflict, map[string]any{
			"interactionId": interactionID,
			"revision":      input.Revision,
		})
	}
	if kind := strings.TrimSpace(input.Kind); kind != "" && current.Kind != kind {
		return nil, NewError("chat_interaction_kind_mismatch", http.StatusConflict, map[string]any{
			"actual":        current.Kind,
			"expected":      kind,
			"interactionId": interactionID,
		})
	}
	return current, nil
}

func (r *InteractionRepository) Get(ctx context.Context, interactionID string) (*Interaction, error) {
	var out *Interaction
	err := r.db.withRead(ctx, func(db *sql.DB) error {
		var err error
		out, err = getInteractionQuerier(ctx, db, interactionID)
		return err
	})
	return out, err
}

func (r *InteractionRepository) ListActive(ctx context.Context, sessionID string) ([]Interaction, error) {
	var out []Interaction
	err := r.db.withRead(ctx, func(db *sql.DB) error {
		rows, err := db.QueryContext(ctx, `
			SELECT interaction_id, session_id, item_id, kind, revision, payload_json, state, resolution_json, created_at, updated_at
			FROM chat_runtime_interactions
			WHERE session_id = ? AND state IN ('pending', 'resolving')
			ORDER BY created_at, interaction_id
		`, sessionID)
		if err != nil {
			return err
		}
		defer rows.Close()
		out, err = scanInteractionRows(rows)
		return err
	})
	return out, err
}

func (r *InteractionRepository) appendResolutionEventsTx(ctx context.Context, tx *sql.Tx, interaction *Interaction) error {
	if err := r.appendEventTx(ctx, tx, interaction.SessionID, "interaction.resolved", interaction); err != nil {
		return err
	}
	if draft := CreateInteractionAnswerTimelineEvent(interaction); draft != nil {
		_, err := r.events.appendInTx(ctx, tx, interaction.SessionID, *draft, true, nil)
		return err
	}
	return nil
}

func (r *InteractionRepository) appendEventTx(ctx context.Context, tx *sql.Tx, sessionID, evType string, interaction *Interaction) error {
	_, err := r.events.appendInTx(ctx, tx, sessionID, EventDraft{
		Type:    evType,
		ItemID:  interaction.ItemID,
		Source:  EventSource{Provider: "aih", RuntimeID: "chat-runtime"},
		Payload: map[string]any{"interaction": interactionToMap(interaction)},
	}, true, nil)
	return err
}

func getInteractionTx(ctx context.Context, tx *sql.Tx, interactionID string) (*Interaction, error) {
	return getInteractionQuerier(ctx, tx, interactionID)
}

func getInteractionQuerier(ctx context.Context, q rowQuerier, interactionID string) (*Interaction, error) {
	return scanInteractionRow(q.QueryRowContext(ctx, `
		SELECT interaction_id, session_id, item_id, kind, revision, payload_json, state, resolution_json, created_at, updated_at
		FROM chat_runtime_interactions WHERE interaction_id = ?
	`, interactionID))
}

func scanInteractionRows(rows *sql.Rows) ([]Interaction, error) {
	out := []Interaction{}
	for rows.Next() {
		item, err := scanInteractionRow(rows)
		if err != nil {
			return nil, err
		}
		if item != nil {
			out = append(out, *item)
		}
	}
	return out, rows.Err()
}

func scanInteractionRow(row rowScanner) (*Interaction, error) {
	var (
		item           Interaction
		payloadJSON    string
		resolutionJSON sql.NullString
	)
	if err := row.Scan(
		&item.InteractionID, &item.SessionID, &item.ItemID, &item.Kind, &item.Revision,
		&payloadJSON, &item.State, &resolutionJSON, &item.CreatedAt, &item.UpdatedAt,
	); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	item.Payload = parseJSONObject(payloadJSON)
	if resolutionJSON.Valid && strings.TrimSpace(resolutionJSON.String) != "" && strings.TrimSpace(resolutionJSON.String) != "null" {
		item.Resolution = parseJSONObject(resolutionJSON.String)
	}
	return &item, nil
}

func interactionToMap(item *Interaction) map[string]any {
	m := map[string]any{
		"interactionId": item.InteractionID,
		"sessionId":     item.SessionID,
		"itemId":        item.ItemID,
		"kind":          item.Kind,
		"revision":      item.Revision,
		"payload":       CloneMap(item.Payload),
		"state":         item.State,
		"createdAt":     item.CreatedAt,
		"updatedAt":     item.UpdatedAt,
	}
	if item.Resolution != nil {
		m["resolution"] = CloneMap(item.Resolution)
	}
	return m
}

package chatruntime

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"
)

// TurnMetricsRepository 在同一事务内累积活跃轮次首字延迟（TTFT）、耗时与 token 用量。
type TurnMetricsRepository struct {
	db     *Database
	events *EventRepository
}

func newTurnMetricsRepository(db *Database, events *EventRepository) *TurnMetricsRepository {
	return &TurnMetricsRepository{db: db, events: events}
}

func (r *TurnMetricsRepository) observeInTx(ctx context.Context, tx *sql.Tx, event EventEnvelope) error {
	if event.TurnID == "" || (!strings.HasPrefix(event.Type, "timeline.item.") && event.Type != "turn.metrics.updated") {
		return nil
	}
	var state string
	var activeTurnJSON sql.NullString
	err := tx.QueryRowContext(ctx, `SELECT state, active_turn_json FROM chat_runtime_sessions WHERE session_id = ?`, event.SessionID).Scan(&state, &activeTurnJSON)
	if err != nil || !activeTurnJSON.Valid || strings.TrimSpace(activeTurnJSON.String) == "" {
		return err
	}
	var active ActiveTurn
	if err := json.Unmarshal([]byte(activeTurnJSON.String), &active); err != nil || active.TurnID != event.TurnID {
		return nil
	}

	if event.Type == "turn.metrics.updated" {
		metrics := CloneMap(mapOrNil(event.Payload["metrics"]))
		totals := mapOrNil(event.Payload["totals"])
		baseline := CloneMap(active.UsageTotals)
		if len(baseline) == 0 {
			baseline, err = r.previousUsageTotalsTx(ctx, tx, event)
			if err != nil {
				return err
			}
		}
		for _, field := range []string{"inputTokens", "outputTokens"} {
			totalVal, hasTotal := toFiniteNonNegFloat(totals[field])
			metricVal, hasMetric := toFiniteNonNegFloat(metrics[field])
			if !hasTotal || !hasMetric {
				continue
			}
			prevVal, hasPrev := toFiniteNonNegFloat(baseline[field])
			var delta float64
			if !hasPrev || totalVal < prevVal {
				delta = metricVal
			} else {
				delta = totalVal - prevVal
			}
			prevActiveVal, hasActiveVal := toFiniteNonNegFloat(mapOrNil(active.Metrics)[field])
			if delta == 0 && !hasActiveVal {
				delete(metrics, field)
			} else {
				metrics[field] = preserveNumericType(prevActiveVal + delta)
			}
		}
		nextTotals := CloneMap(active.UsageTotals)
		for k, v := range totals {
			nextTotals[k] = v
		}
		active.UsageTotals = nextTotals
		nextMetrics := CloneMap(active.Metrics)
		for k, v := range metrics {
			nextMetrics[k] = v
		}
		active.Metrics = nextMetrics
	} else {
		if active.FirstTokenAt != nil || !r.hasVisibleOutputTx(ctx, tx, event) {
			return nil
		}
		ft := event.At
		if active.StartedAt > ft {
			ft = active.StartedAt
		}
		active.FirstTokenAt = &ft
	}

	encoded, err := CanonicalJSON(active)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE chat_runtime_sessions SET active_turn_json = ? WHERE session_id = ?`, encoded, event.SessionID); err != nil {
		return err
	}
	_, err = r.events.appendInTx(ctx, tx, event.SessionID, EventDraft{
		Type:   "turn.phase.changed",
		TurnID: active.TurnID,
		RunID:  active.RunID,
		At:     &event.At,
		Source: event.Source,
		Payload: map[string]any{
			"state":      state,
			"activeTurn": structToMap(active),
		},
	}, false, nil)
	return err
}

func (r *TurnMetricsRepository) previousUsageTotalsTx(ctx context.Context, tx *sql.Tx, event EventEnvelope) (map[string]any, error) {
	var payloadJSON string
	err := tx.QueryRowContext(ctx, `
		SELECT payload_json FROM chat_runtime_events
		WHERE session_id = ? AND type = 'turn.metrics.updated' AND turn_id != ?
		ORDER BY seq DESC LIMIT 1
	`, event.SessionID, event.TurnID).Scan(&payloadJSON)
	if err == sql.ErrNoRows {
		return map[string]any{}, nil
	}
	if err != nil {
		return nil, err
	}
	payload := parseJSONObject(payloadJSON)
	return CloneMap(mapOrNil(payload["totals"])), nil
}

func (r *TurnMetricsRepository) hasVisibleOutputTx(ctx context.Context, tx *sql.Tx, event EventEnvelope) bool {
	if rawItem, ok := event.Payload["item"].(map[string]any); ok && rawItem != nil {
		return isOutputTimelineMap(rawItem) && strings.TrimSpace(asString(rawItem["content"])) != ""
	}
	if event.Type != "timeline.item.delta" || strings.TrimSpace(asString(event.Payload["chunk"])) == "" {
		return false
	}
	var payloadJSON string
	err := tx.QueryRowContext(ctx, `
		SELECT payload_json FROM chat_runtime_events
		WHERE session_id = ? AND item_id = ? AND type IN ('timeline.item.started', 'timeline.item.updated', 'timeline.item.completed')
		ORDER BY seq DESC LIMIT 1
	`, event.SessionID, event.ItemID).Scan(&payloadJSON)
	if err != nil {
		return false
	}
	payload := parseJSONObject(payloadJSON)
	item, _ := payload["item"].(map[string]any)
	return isOutputTimelineMap(item)
}

func (r *TurnMetricsRepository) finishInTx(ctx context.Context, tx *sql.Tx, sessionID string, terminal EventDraft) error {
	var activeTurnJSON sql.NullString
	err := tx.QueryRowContext(ctx, `SELECT active_turn_json FROM chat_runtime_sessions WHERE session_id = ?`, sessionID).Scan(&activeTurnJSON)
	if err != nil || !activeTurnJSON.Valid || strings.TrimSpace(activeTurnJSON.String) == "" {
		return err
	}
	var active ActiveTurn
	if err := json.Unmarshal([]byte(activeTurnJSON.String), &active); err != nil {
		return nil
	}
	if active.TurnID != terminal.TurnID || active.StartedAt == 0 {
		return nil
	}
	completedAt := r.db.clock()
	if terminal.At != nil {
		completedAt = *terminal.At
	}
	durationMs := max(int64(0), completedAt-active.StartedAt)
	metrics := CloneMap(active.Metrics)
	metrics["durationMs"] = durationMs
	var ttftVal *int64
	if active.FirstTokenAt != nil {
		v := min(durationMs, max(int64(0), *active.FirstTokenAt-active.StartedAt))
		ttftVal = &v
		metrics["ttftMs"] = v
	}
	if ttftVal != nil {
		if outTok, ok := toFiniteNonNegFloat(metrics["outputTokens"]); ok && outTok > 0 {
			decodeMs := durationMs - *ttftVal
			if decodeMs >= 500 {
				metrics["tokensPerSec"] = outTok / (float64(decodeMs) / 1000.0)
			}
		}
	}

	items, err := readTurnTimelineTx(ctx, tx, sessionID, active.TurnID)
	if err != nil {
		return err
	}
	var targetIdx = -1
	var lastAnswer = -1
	var lastReasoning = -1
	for i, item := range items {
		if item.Kind == "message" && asString(item.Detail["role"]) == "assistant" {
			lastAnswer = i
		} else if item.Kind == "reasoning" {
			lastReasoning = i
		}
	}
	if lastAnswer >= 0 {
		targetIdx = lastAnswer
	} else {
		targetIdx = lastReasoning
	}
	if targetIdx < 0 {
		return nil
	}
	targetID := items[targetIdx].ID
	status := "completed"
	if terminal.Type == "turn.failed" || terminal.Type == "run.lost" {
		status = "failed"
	} else if terminal.Type == "turn.interrupted" {
		status = "cancelled"
	}

	for _, item := range items {
		if !isOutputTimelineItem(item) {
			continue
		}
		if item.ID != targetID && (item.Status == "completed" || item.Status == "failed" || item.Status == "cancelled") {
			continue
		}
		nextItem := item
		nextItem.Status = status
		nextItem.UpdatedAt = &completedAt
		nextItem.Detail = CloneMap(item.Detail)
		if item.ID == targetID {
			nextItem.Detail["metrics"] = metrics
		}
		if _, err := r.events.appendInTx(ctx, tx, sessionID, EventDraft{
			Type:    "timeline.item.completed",
			TurnID:  active.TurnID,
			RunID:   active.RunID,
			At:      &completedAt,
			Source:  terminal.Source,
			Payload: map[string]any{"item": itemToMap(nextItem)},
		}, false, nil); err != nil {
			return err
		}
	}
	return nil
}

func isOutputTimelineMap(item map[string]any) bool {
	if item == nil {
		return false
	}
	kind := asString(item["kind"])
	if kind == "reasoning" {
		return true
	}
	detail, _ := item["detail"].(map[string]any)
	return kind == "message" && asString(detail["role"]) == "assistant"
}

func isOutputTimelineItem(item TimelineItem) bool {
	if item.Kind == "reasoning" {
		return true
	}
	return item.Kind == "message" && asString(item.Detail["role"]) == "assistant"
}

func mapOrNil(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

package chatruntime

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"
)

var (
	timelineOpenStatuses = map[string]struct{}{
		"pending": {}, "running": {}, "waiting_input": {},
	}
	timelineExecutionKinds = map[string]struct{}{
		"tool": {}, "shell": {}, "file_change": {}, "subagent": {}, "command": {}, "terminal": {},
	}
)

// ProjectTimeline 把有序时间线事件流归约为最终条目切片（保留首次出现顺序）。
func ProjectTimeline(events []EventEnvelope) []TimelineItem {
	order := make([]string, 0)
	items := make(map[string]TimelineItem)
	for _, ev := range events {
		switch ev.Type {
		case "timeline.item.delta":
			id := asString(ev.Payload["itemId"])
			cur, exists := items[id]
			if !exists {
				continue
			}
			prev := ""
			if cur.Content != nil {
				prev = *cur.Content
			}
			nextContent := prev + asString(ev.Payload["chunk"])
			cur.Content = &nextContent
			items[id] = cur
		case "timeline.item.started", "timeline.item.updated", "timeline.item.completed":
			raw, ok := ev.Payload["item"].(map[string]any)
			if !ok || raw == nil {
				continue
			}
			parsed, err := itemFromMap(raw)
			if err != nil {
				continue
			}
			if _, exists := items[parsed.ID]; !exists {
				order = append(order, parsed.ID)
			}
			items[parsed.ID] = parsed
		}
	}
	out := make([]TimelineItem, 0, len(order))
	for _, id := range order {
		if item, exists := items[id]; exists {
			out = append(out, item)
		}
	}
	return out
}

func readTurnTimelineTx(ctx context.Context, tx *sql.Tx, sessionID, turnID string) ([]TimelineItem, error) {
	rows, err := tx.QueryContext(ctx, `
		SELECT type, payload_json FROM chat_runtime_events
		WHERE session_id = ? AND turn_id = ? AND type LIKE 'timeline.item.%' ORDER BY seq
	`, sessionID, turnID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var events []EventEnvelope
	for rows.Next() {
		var evType, payloadJSON string
		if err := rows.Scan(&evType, &payloadJSON); err != nil {
			return nil, err
		}
		events = append(events, EventEnvelope{
			Type:    evType,
			Payload: parseJSONObject(payloadJSON),
		})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return ProjectTimeline(events), nil
}

func settleTurnTimelineTx(ctx context.Context, tx *sql.Tx, events *EventRepository, db *Database, sessionID string, terminal EventDraft) (bool, error) {
	if terminal.TurnID == "" {
		return false, nil
	}
	items, err := readTurnTimelineTx(ctx, tx, sessionID, terminal.TurnID)
	if err != nil {
		return false, err
	}
	at := db.clock()
	if terminal.At != nil {
		at = *terminal.At
	}
	outcomeUnknown := false
	for _, item := range items {
		if _, isOpen := timelineOpenStatuses[item.Status]; !isOpen {
			continue
		}
		nextStatus := "failed"
		if _, isExec := timelineExecutionKinds[item.Kind]; isExec {
			nextStatus = "unknown"
		} else if terminal.Type == "turn.completed" {
			nextStatus = "completed"
		} else if terminal.Type == "turn.interrupted" {
			nextStatus = "cancelled"
		}
		if nextStatus == "unknown" {
			outcomeUnknown = true
		}
		settled := item
		settled.Status = nextStatus
		settled.UpdatedAt = &at
		if _, err := events.appendInTx(ctx, tx, sessionID, EventDraft{
			Type:    "timeline.item.completed",
			TurnID:  terminal.TurnID,
			RunID:   terminal.RunID,
			At:      &at,
			Source:  terminal.Source,
			Payload: map[string]any{"item": itemToMap(settled)},
		}, false, nil); err != nil {
			return false, err
		}
	}
	return outcomeUnknown, nil
}

// CompactTimelineItem 对 shell / file_change 剔除与主字段完全重复的派生字段，减小持久化体积。
func CompactTimelineItem(item map[string]any) map[string]any {
	if item == nil {
		return nil
	}
	kind := asString(item["kind"])
	detail, _ := item["detail"].(map[string]any)
	if detail == nil {
		return item
	}
	switch kind {
	case "shell":
		contentStr, isStr := item["content"].(string)
		if !isStr || asString(detail["output"]) != contentStr || detail["output"] == nil {
			return item
		}
		out := CloneMap(item)
		nextDetail := CloneMap(detail)
		delete(nextDetail, "output")
		out["detail"] = nextDetail
		return out
	case "file_change":
		var diffs []string
		switch typed := detail["changes"].(type) {
		case []any:
			for _, raw := range typed {
				if c, ok := raw.(map[string]any); ok && c != nil {
					if d, isStr := c["diff"].(string); isStr && d != "" {
						diffs = append(diffs, d)
					}
				}
			}
		case []map[string]any:
			for _, c := range typed {
				if c != nil {
					if d, isStr := c["diff"].(string); isStr && d != "" {
						diffs = append(diffs, d)
					}
				}
			}
		default:
			return item
		}
		derived := strings.Join(diffs, "\n")
		_, hasDiff := detail["diff"]
		dropDiff := hasDiff && asString(detail["diff"]) == derived
		contentStr, hasContentStr := item["content"].(string)
		dropContent := hasContentStr && contentStr == derived
		if !dropDiff && !dropContent {
			return item
		}
		out := CloneMap(item)
		if dropContent {
			delete(out, "content")
		}
		if dropDiff {
			nextDetail := CloneMap(detail)
			delete(nextDetail, "diff")
			out["detail"] = nextDetail
		}
		return out
	default:
		return item
	}
}

// TimelineImportRepository 负责原生历史事件的幂等导入与实测指标保护。
type TimelineImportRepository struct {
	db     *Database
	events *EventRepository
}

func newTimelineImportRepository(db *Database, events *EventRepository) *TimelineImportRepository {
	return &TimelineImportRepository{db: db, events: events}
}

// ImportResult 返回一次历史导入的新增事件与跳过计数。
type ImportResult struct {
	Events  []EventEnvelope `json:"events"`
	Skipped int             `json:"skipped"`
}

func (r *TimelineImportRepository) Import(ctx context.Context, sessionID string, drafts []EventDraft) (*ImportResult, error) {
	if drafts == nil {
		return nil, NewError("chat_history_events_invalid", http.StatusUnprocessableEntity, nil)
	}
	var res *ImportResult
	err := r.db.withTx(ctx, func(tx *sql.Tx) error {
		var err error
		res, err = r.importInTx(ctx, tx, sessionID, drafts)
		return err
	})
	return res, err
}

func (r *TimelineImportRepository) importInTx(ctx context.Context, tx *sql.Tx, sessionID string, drafts []EventDraft) (*ImportResult, error) {
	id, err := RequiredText(sessionID, "chat_session_id_required")
	if err != nil {
		return nil, err
	}
	var exists int
	if err := tx.QueryRowContext(ctx, `SELECT 1 FROM chat_runtime_sessions WHERE session_id = ?`, id).Scan(&exists); err == sql.ErrNoRows {
		return nil, NewError("chat_session_not_found", http.StatusNotFound, nil)
	} else if err != nil {
		return nil, err
	}

	guard := newToolHistoryIntegrityGuard(r.db, id)
	if err := guard.Assert(ctx, tx, drafts); err != nil {
		return nil, err
	}

	imported := make([]EventEnvelope, 0)
	skipped := 0
	for _, draft := range drafts {
		evID := strings.TrimSpace(draft.EventID)
		if evID == "" {
			return nil, NewError("chat_history_event_id_required", http.StatusUnprocessableEntity, nil)
		}
		var owner string
		err := tx.QueryRowContext(ctx, `SELECT session_id FROM chat_runtime_events WHERE event_id = ?`, evID).Scan(&owner)
		if err != nil && err != sql.ErrNoRows {
			return nil, err
		}
		if owner != "" {
			if owner != id {
				return nil, NewError("chat_history_event_conflict", http.StatusConflict, map[string]any{"eventId": evID})
			}
			skipped++
			continue
		}
		prepared, err := r.preserveMeasuredMetadataTx(ctx, tx, id, draft)
		if err != nil {
			return nil, err
		}
		if r.isStaleRepeatTx(ctx, tx, id, prepared) {
			skipped++
			continue
		}
		ev, err := r.events.appendInTx(ctx, tx, id, prepared, false, guard)
		if err != nil {
			return nil, err
		}
		imported = append(imported, ev)
	}
	return &ImportResult{Events: imported, Skipped: skipped}, nil
}

func (r *TimelineImportRepository) isStaleRepeatTx(ctx context.Context, tx *sql.Tx, sessionID string, draft EventDraft) bool {
	if !strings.HasPrefix(draft.EventID, "history-") {
		return false
	}
	item, _ := draft.Payload["item"].(map[string]any)
	if item == nil {
		return false
	}
	itemID := asString(item["id"])
	if itemID == "" {
		return false
	}
	var latestEvID, latestType, latestPayloadJSON string
	err := tx.QueryRowContext(ctx, `
		SELECT event_id, type, payload_json FROM chat_runtime_events
		WHERE session_id = ? AND item_id = ? AND type LIKE 'timeline.item.%'
		ORDER BY seq DESC LIMIT 1
	`, sessionID, itemID).Scan(&latestEvID, &latestType, &latestPayloadJSON)
	if err != nil || !strings.HasPrefix(latestEvID, "history-") || latestType != draft.Type {
		return false
	}
	stored := parseJSONObject(latestPayloadJSON)
	return sameIgnoringUpdatedAt(stored, draft.Payload)
}

func sameIgnoringUpdatedAt(a, b map[string]any) bool {
	strip := func(payload map[string]any) string {
		cp := CloneMap(payload)
		if item, ok := cp["item"].(map[string]any); ok && item != nil {
			itemCp := CloneMap(item)
			delete(itemCp, "updatedAt")
			cp["item"] = itemCp
		}
		s, _ := CanonicalJSON(cp)
		return s
	}
	return strip(a) == strip(b)
}

func (r *TimelineImportRepository) preserveMeasuredMetadataTx(ctx context.Context, tx *sql.Tx, sessionID string, draft EventDraft) (EventDraft, error) {
	item, _ := draft.Payload["item"].(map[string]any)
	if item == nil {
		return draft, nil
	}
	itemID := asString(item["id"])
	var prevJSON string
	err := tx.QueryRowContext(ctx, `
		SELECT payload_json FROM chat_runtime_events
		WHERE session_id = ? AND item_id = ? AND type IN ('timeline.item.started', 'timeline.item.updated', 'timeline.item.completed')
		ORDER BY seq DESC LIMIT 1
	`, sessionID, itemID).Scan(&prevJSON)
	if err == sql.ErrNoRows {
		return draft, nil
	}
	if err != nil {
		return draft, err
	}
	var prevPayload map[string]any
	if err := json.Unmarshal([]byte(prevJSON), &prevPayload); err != nil {
		return draft, nil
	}
	measured, _ := prevPayload["item"].(map[string]any)
	if measured == nil {
		return draft, nil
	}
	measuredStatus := asString(measured["status"])
	incomingStatus := asString(item["status"])
	_, measuredOpen := timelineOpenStatuses[measuredStatus]
	_, incomingOpen := timelineOpenStatuses[incomingStatus]
	if !measuredOpen && (incomingOpen || incomingStatus == "unknown") {
		out := draft
		out.Type = "timeline.item.completed"
		if t := asString(measured["turnId"]); t != "" {
			out.TurnID = t
		}
		out.Payload = map[string]any{"item": CloneMap(measured)}
		return out, nil
	}
	nextItem := CloneMap(item)
	if t := asString(measured["turnId"]); t != "" {
		nextItem["turnId"] = t
	}
	measuredDetail, _ := measured["detail"].(map[string]any)
	nextDetail := CloneMap(mapOrNil(item["detail"]))
	if measuredDetail != nil {
		if inh, _ := measuredDetail["inherited"].(bool); inh {
			nextDetail["inherited"] = true
		}
		if m := asString(measuredDetail["model"]); m != "" {
			nextDetail["model"] = m
		}
		if e := asString(measuredDetail["effort"]); e != "" {
			nextDetail["effort"] = e
		}
		if metrics, ok := measuredDetail["metrics"]; ok && metrics != nil {
			nextDetail["metrics"] = cloneAny(metrics)
			nextItem["status"] = measured["status"]
			if uAt, ok := measured["updatedAt"]; ok && uAt != nil {
				nextItem["updatedAt"] = uAt
			}
		}
	}
	nextItem["detail"] = nextDetail
	out := draft
	if t := asString(measured["turnId"]); t != "" {
		out.TurnID = t
	}
	nextPayload := CloneMap(draft.Payload)
	nextPayload["item"] = nextItem
	out.Payload = nextPayload
	return out, nil
}

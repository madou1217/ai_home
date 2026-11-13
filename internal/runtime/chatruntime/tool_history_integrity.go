package chatruntime

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"
)

var toolIntegrityKinds = map[string]struct{}{
	"tool":        {},
	"shell":       {},
	"file_change": {},
}

// ToolHistoryIntegrityGuard 保证会话内 tool/shell/file_change 的 callId 与 itemId 严格一一对应。
type ToolHistoryIntegrityGuard struct {
	db                  *Database
	sessionID           string
	itemsByCallID       map[string]string
	callIDsByItem       map[string]string
	legacyUnpairedItems map[string]struct{}
	loaded              bool
}

func newToolHistoryIntegrityGuard(db *Database, sessionID string) *ToolHistoryIntegrityGuard {
	return &ToolHistoryIntegrityGuard{db: db, sessionID: sessionID}
}

func (g *ToolHistoryIntegrityGuard) Assert(ctx context.Context, tx *sql.Tx, drafts []EventDraft) error {
	var items []map[string]any
	for _, d := range drafts {
		if d.Payload == nil {
			continue
		}
		if item, ok := d.Payload["item"].(map[string]any); ok && item != nil {
			if _, isTool := toolIntegrityKinds[asString(item["kind"])]; isTool {
				items = append(items, item)
			}
		}
	}
	if len(items) == 0 {
		return nil
	}
	if !g.loaded {
		if err := g.loadPersistedOwners(ctx, tx); err != nil {
			return err
		}
	}
	nextByCall := make(map[string]string, len(g.itemsByCallID))
	for k, v := range g.itemsByCallID {
		nextByCall[k] = v
	}
	nextByItem := make(map[string]string, len(g.callIDsByItem))
	for k, v := range g.callIDsByItem {
		nextByItem[k] = v
	}
	for _, item := range items {
		itemID := strings.TrimSpace(asString(item["id"]))
		detail, _ := item["detail"].(map[string]any)
		callID := strings.TrimSpace(asString(detail["callId"]))
		if callID == "" {
			if _, legacy := g.legacyUnpairedItems[itemID]; legacy {
				continue
			}
			return NewError("chat_tool_history_call_id_required", http.StatusUnprocessableEntity, map[string]any{
				"itemId": itemID,
				"kind":   asString(item["kind"]),
			})
		}
		if err := claimToolOwnership(nextByCall, nextByItem, callID, itemID); err != nil {
			return err
		}
	}
	g.itemsByCallID = nextByCall
	g.callIDsByItem = nextByItem
	return nil
}

func (g *ToolHistoryIntegrityGuard) loadPersistedOwners(ctx context.Context, tx *sql.Tx) error {
	g.itemsByCallID = make(map[string]string)
	g.callIDsByItem = make(map[string]string)
	g.legacyUnpairedItems = make(map[string]struct{})

	rows, err := tx.QueryContext(ctx, `
		SELECT item_id, payload_json FROM chat_runtime_events
		WHERE session_id = ? AND type IN ('timeline.item.started', 'timeline.item.updated', 'timeline.item.completed')
		ORDER BY seq
	`, g.sessionID)
	if err != nil {
		return err
	}
	defer rows.Close()

	for rows.Next() {
		var rowItemID sql.NullString
		var payloadJSON string
		if err := rows.Scan(&rowItemID, &payloadJSON); err != nil {
			return err
		}
		var payload map[string]any
		if err := json.Unmarshal([]byte(payloadJSON), &payload); err != nil || payload == nil {
			continue
		}
		item, _ := payload["item"].(map[string]any)
		if item == nil {
			continue
		}
		if _, isTool := toolIntegrityKinds[asString(item["kind"])]; !isTool {
			continue
		}
		detail, _ := item["detail"].(map[string]any)
		callID := strings.TrimSpace(asString(detail["callId"]))
		itemID := strings.TrimSpace(rowItemID.String)
		if itemID == "" {
			itemID = strings.TrimSpace(asString(item["id"]))
		}
		if callID == "" {
			if _, paired := g.callIDsByItem[itemID]; !paired {
				g.legacyUnpairedItems[itemID] = struct{}{}
			}
			continue
		}
		if err := claimToolOwnership(g.itemsByCallID, g.callIDsByItem, callID, itemID); err != nil {
			return err
		}
		delete(g.legacyUnpairedItems, itemID)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	g.loaded = true
	return nil
}

func claimToolOwnership(itemsByCallID, callIDsByItem map[string]string, callID, itemID string) error {
	if owner, exists := itemsByCallID[callID]; exists && owner != itemID {
		return NewError("chat_tool_history_call_id_conflict", http.StatusConflict, map[string]any{
			"callId":      callID,
			"itemId":      itemID,
			"ownerItemId": owner,
		})
	}
	if ownerCall, exists := callIDsByItem[itemID]; exists && ownerCall != callID {
		return NewError("chat_tool_history_item_call_id_conflict", http.StatusConflict, map[string]any{
			"callId":      callID,
			"itemId":      itemID,
			"ownerCallId": ownerCall,
		})
	}
	itemsByCallID[callID] = itemID
	callIDsByItem[itemID] = callID
	return nil
}

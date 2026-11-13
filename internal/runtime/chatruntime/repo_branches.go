package chatruntime

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
)

// NativeResponseItemEvidence 描述单条 Responses 原生证据。
type NativeResponseItemEvidence struct {
	ThreadID string
	TurnID   string
	Item     map[string]any
}

// NativeHistoryBoundaryEvidence 描述原生回合覆盖状态检查点。
type NativeHistoryBoundaryEvidence struct {
	ThreadID string
	TurnID   string
	Boundary string
}

// NativeThreadItemEvidence 描述单条原生 ThreadItem 证据。
type NativeThreadItemEvidence struct {
	ThreadID     string
	TurnID       string
	Item         map[string]any
	RawMessageID string
}

// NativeThreadItemRecord 是读回的 ThreadItem 与可选原消息 ID。
type NativeThreadItemRecord struct {
	Item         map[string]any `json:"item"`
	RawMessageID string         `json:"rawMessageId,omitempty"`
}

// HistorySeed 描述派生子会话的初始历史种子与重放输入。
type HistorySeed struct {
	ResponseItems      []map[string]any          `json:"responseItems"`
	MessageSubmissions map[string]map[string]any `json:"messageSubmissions"`
	Regeneration       map[string]any            `json:"regeneration"`
}

// HistoryPrefix 表示 Chat 分支截取后的前缀条目及原生响应项。
type HistoryPrefix struct {
	Items         []TimelineItem
	ResponseItems []map[string]any
	Submission    map[string]any
}

// HistoryReversibility 描述单条或整段前缀历史是否可无损重建。
type HistoryReversibility struct {
	Reversible bool
	Kind       string
	Reason     string
	ItemID     string
}

var skippableNoticeCodes = map[string]struct{}{
	"contextCompaction": {},
	"context_compacted": {},
	"codex_warning":     {},
}

var branchNextStates = map[string]map[string]struct{}{
	"prepared":       {"fork_pending": {}},
	"fork_pending":   {"forked": {}},
	"forked":         {"inject_pending": {}, "ready": {}},
	"inject_pending": {"ready": {}},
}

// IsSkippableNotice 判断提示类条目是否属于分支重建可安全略过的非注入提示。
func IsSkippableNotice(item TimelineItem) bool {
	code := strings.TrimSpace(asString(item.Detail["code"]))
	_, ok := skippableNoticeCodes[code]
	return ok
}

// AssessHistoryItem 评估单个时间线条目在私有原生证据支持下是否可无损重建。
func AssessHistoryItem(item TimelineItem, nativeItem map[string]any) HistoryReversibility {
	kind := strings.TrimSpace(item.Kind)
	switch kind {
	case "message":
		role := strings.TrimSpace(asString(item.Detail["role"]))
		if role != "user" && role != "assistant" {
			return HistoryReversibility{Kind: "message", Reason: "role_not_supported"}
		}
		if item.Status != "completed" {
			return HistoryReversibility{Kind: "message", Reason: "message_not_completed"}
		}
		if rawInputs, ok := item.Detail["inputs"].([]any); ok {
			for _, raw := range rawInputs {
				inMap, _ := raw.(map[string]any)
				inKind := strings.TrimSpace(asString(inMap["kind"]))
				if inKind != "" && inKind != "image" && inKind != "skill" && inKind != "mention" {
					return HistoryReversibility{Kind: "message", Reason: "input_not_supported"}
				}
			}
		}
		return HistoryReversibility{Reversible: true}
	case "notice":
		if IsSkippableNotice(item) {
			return HistoryReversibility{Reversible: true}
		}
		return HistoryReversibility{Kind: kind, Reason: "native_item_shape_not_persisted"}
	case "reasoning":
		if item.Status == "completed" && nativeItem != nil && asString(nativeItem["type"]) == "reasoning" && asString(nativeItem["id"]) == item.ID {
			return HistoryReversibility{Reversible: true}
		}
		return HistoryReversibility{Kind: kind, Reason: "native_item_shape_not_persisted"}
	case "error":
		return HistoryReversibility{Kind: kind, Reason: "native_item_shape_not_persisted"}
	case "tool":
		callID := strings.TrimSpace(asString(item.Detail["callId"]))
		name := strings.TrimSpace(asString(item.Detail["name"]))
		if callID == "" || name == "" {
			return HistoryReversibility{Kind: "tool", Reason: "call_identity_missing"}
		}
		if item.Status != "completed" {
			return HistoryReversibility{Kind: "tool", Reason: "tool_result_unknown"}
		}
		res, exists := item.Detail["result"]
		if !exists || res == nil {
			return HistoryReversibility{Kind: "tool", Reason: "tool_result_missing"}
		}
		if _, isStr := res.(string); !isStr {
			return HistoryReversibility{Kind: "tool", Reason: "tool_result_not_text"}
		}
		return HistoryReversibility{Kind: "tool", Reason: "raw_call_shape_not_persisted"}
	default:
		return HistoryReversibility{Kind: kind, Reason: "kind_not_supported"}
	}
}

// AssessHistoryPrefix 验证整段前缀是否均处于可逆历史边界。
func AssessHistoryPrefix(items []TimelineItem, readNative func(itemID string) map[string]any) HistoryReversibility {
	for _, item := range items {
		var nativeItem map[string]any
		if readNative != nil {
			nativeItem = readNative(item.ID)
		}
		res := AssessHistoryItem(item, nativeItem)
		if !res.Reversible {
			res.ItemID = item.ID
			return res
		}
	}
	return HistoryReversibility{Reversible: true}
}

// NativeResponseItemRepository 管理私有原生 Responses 证据与覆盖标记。
type NativeResponseItemRepository struct {
	db       *Database
	sessions *SessionRepository
}

func newNativeResponseItemRepository(db *Database, sessions *SessionRepository) *NativeResponseItemRepository {
	return &NativeResponseItemRepository{db: db, sessions: sessions}
}

func (r *NativeResponseItemRepository) Record(ctx context.Context, sessionID string, ev NativeResponseItemEvidence) error {
	return r.db.withTx(ctx, func(tx *sql.Tx) error {
		if err := r.requireThreadTx(ctx, tx, sessionID, ev.ThreadID); err != nil {
			return err
		}
		return r.recordInTx(ctx, tx, sessionID, ev)
	})
}

func (r *NativeResponseItemRepository) recordInTx(ctx context.Context, tx *sql.Tx, sessionID string, ev NativeResponseItemEvidence) error {
	if ev.Item == nil || strings.TrimSpace(asString(ev.Item["type"])) == "" || strings.TrimSpace(asString(ev.Item["id"])) == "" {
		return ErrInvalid("chat_native_history_item_invalid")
	}
	if asString(ev.Item["type"]) == "reasoning" {
		if _, ok := ev.Item["summary"].([]any); !ok {
			if _, okStr := ev.Item["summary"].([]map[string]any); !okStr {
				return ErrInvalid("chat_native_history_item_invalid")
			}
		}
		if enc, exists := ev.Item["encrypted_content"]; exists && enc != nil {
			if _, ok := enc.(string); !ok {
				return ErrInvalid("chat_native_history_item_invalid")
			}
		}
	}
	itemID := asString(ev.Item["id"])
	prevThread, prevTurn, prevJSON, found, err := r.readRowTx(ctx, tx, sessionID, itemID)
	if err != nil {
		return err
	}
	if found {
		prevItem := parseJSONObject(prevJSON)
		if !CanonicalJSONEquals(prevItem, ev.Item) || prevThread != ev.ThreadID || prevTurn != ev.TurnID {
			return NewError("chat_native_history_item_conflict", http.StatusConflict, nil)
		}
		return nil
	}
	serialized, err := CanonicalJSON(ev.Item)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO chat_runtime_native_response_items
		  (session_id, item_id, native_thread_id, native_turn_id, ordinal, response_item_json)
		VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(ordinal), 0) + 1
		  FROM chat_runtime_native_response_items WHERE session_id = ?), ?)
	`, sessionID, itemID, ev.ThreadID, ev.TurnID, sessionID, serialized)
	return err
}

func (r *NativeResponseItemRepository) Read(ctx context.Context, sessionID, itemID string) (map[string]any, error) {
	var out map[string]any
	err := r.db.withRead(ctx, func(db *sql.DB) error {
		var raw string
		err := db.QueryRowContext(ctx, `
			SELECT response_item_json FROM chat_runtime_native_response_items WHERE session_id = ? AND item_id = ?
		`, sessionID, itemID).Scan(&raw)
		if err == sql.ErrNoRows {
			return nil
		}
		if err != nil {
			return err
		}
		out = parseJSONObject(raw)
		return nil
	})
	return out, err
}

func (r *NativeResponseItemRepository) readRowTx(ctx context.Context, q rowQuerier, sessionID, itemID string) (string, string, string, bool, error) {
	var threadID, turnID, raw string
	err := q.QueryRowContext(ctx, `
		SELECT native_thread_id, native_turn_id, response_item_json
		FROM chat_runtime_native_response_items WHERE session_id = ? AND item_id = ?
	`, sessionID, itemID).Scan(&threadID, &turnID, &raw)
	if err == sql.ErrNoRows {
		return "", "", "", false, nil
	}
	if err != nil {
		return "", "", "", false, err
	}
	return threadID, turnID, raw, true, nil
}

func (r *NativeResponseItemRepository) ReadTurn(ctx context.Context, sessionID, threadID, turnID string) ([]map[string]any, error) {
	if threadID == "" || turnID == "" {
		return nil, ErrInvalid("chat_native_history_turn_required")
	}
	var out []map[string]any
	err := r.db.withRead(ctx, func(db *sql.DB) error {
		rows, err := db.QueryContext(ctx, `
			SELECT response_item_json FROM chat_runtime_native_response_items
			WHERE session_id = ? AND native_thread_id = ? AND native_turn_id = ? AND ordinal IS NOT NULL
			ORDER BY ordinal
		`, sessionID, threadID, turnID)
		if err != nil {
			return err
		}
		defer rows.Close()
		out = []map[string]any{}
		for rows.Next() {
			var raw string
			if err := rows.Scan(&raw); err != nil {
				return err
			}
			out = append(out, parseJSONObject(raw))
		}
		return rows.Err()
	})
	return out, err
}

func (r *NativeResponseItemRepository) MarkCoverage(ctx context.Context, sessionID string, ev NativeHistoryBoundaryEvidence) (string, error) {
	var state string
	err := r.db.withTx(ctx, func(tx *sql.Tx) error {
		if err := r.requireThreadTx(ctx, tx, sessionID, ev.ThreadID); err != nil {
			return err
		}
		if ev.TurnID == "" || (ev.Boundary != "started" && ev.Boundary != "completed" && ev.Boundary != "gap") {
			return ErrInvalid("chat_native_history_boundary_invalid")
		}
		var prev sql.NullString
		if err := tx.QueryRowContext(ctx, `
			SELECT state FROM chat_runtime_native_history_coverage
			WHERE session_id = ? AND native_thread_id = ? AND native_turn_id = ?
		`, sessionID, ev.ThreadID, ev.TurnID).Scan(&prev); err != nil && err != sql.ErrNoRows {
			return err
		}
		var dummy int
		err := tx.QueryRowContext(ctx, `
			SELECT 1 FROM chat_runtime_native_response_items
			WHERE session_id = ? AND native_thread_id = ? AND native_turn_id = ? AND ordinal IS NOT NULL LIMIT 1
		`, sessionID, ev.ThreadID, ev.TurnID).Scan(&dummy)
		captured := err == nil
		if err != nil && err != sql.ErrNoRows {
			return err
		}
		switch ev.Boundary {
		case "gap":
			state = "incomplete"
		case "started":
			if prev.Valid && prev.String != "" {
				state = prev.String
			} else {
				state = "recording"
			}
		case "completed":
			if captured && (prev.String == "recording" || prev.String == "complete") {
				state = "complete"
			} else {
				state = "incomplete"
			}
		}
		_, err = tx.ExecContext(ctx, `
			INSERT INTO chat_runtime_native_history_coverage (session_id, native_thread_id, native_turn_id, state)
			VALUES (?, ?, ?, ?)
			ON CONFLICT(session_id, native_thread_id, native_turn_id) DO UPDATE SET state = excluded.state
		`, sessionID, ev.ThreadID, ev.TurnID, state)
		return err
	})
	return state, err
}

func (r *NativeResponseItemRepository) Coverage(ctx context.Context, sessionID, threadID, turnID string) (string, error) {
	var state string
	err := r.db.withRead(ctx, func(db *sql.DB) error {
		var s sql.NullString
		err := db.QueryRowContext(ctx, `
			SELECT state FROM chat_runtime_native_history_coverage
			WHERE session_id = ? AND native_thread_id = ? AND native_turn_id = ?
		`, sessionID, threadID, turnID).Scan(&s)
		if err == sql.ErrNoRows {
			return nil
		}
		if err != nil {
			return err
		}
		state = s.String
		return nil
	})
	return state, err
}

func (r *NativeResponseItemRepository) requireThreadTx(ctx context.Context, tx *sql.Tx, sessionID, threadID string) error {
	s, err := r.sessions.requireTx(ctx, tx, sessionID)
	if err != nil {
		return err
	}
	if asString(s.RuntimeBinding["nativeSessionId"]) != threadID {
		return NewError("chat_native_history_thread_mismatch", http.StatusConflict, nil)
	}
	return nil
}

// NativeThreadItemRepository 管理实时原生 ThreadItem 身份映射。
type NativeThreadItemRepository struct {
	db            *Database
	responseItems *NativeResponseItemRepository
}

func newNativeThreadItemRepository(db *Database, responseItems *NativeResponseItemRepository) *NativeThreadItemRepository {
	return &NativeThreadItemRepository{db: db, responseItems: responseItems}
}

func (r *NativeThreadItemRepository) Record(ctx context.Context, sessionID string, ev NativeThreadItemEvidence) error {
	return r.db.withTx(ctx, func(tx *sql.Tx) error {
		if err := r.responseItems.requireThreadTx(ctx, tx, sessionID, ev.ThreadID); err != nil {
			return err
		}
		return r.recordInTx(ctx, tx, sessionID, ev)
	})
}

func (r *NativeThreadItemRepository) recordInTx(ctx context.Context, tx *sql.Tx, sessionID string, ev NativeThreadItemEvidence) error {
	itemID := asString(ev.Item["id"])
	itemType := asString(ev.Item["type"])
	if ev.TurnID == "" || itemID == "" || itemType == "" {
		return ErrInvalid("chat_native_thread_item_invalid")
	}
	var exThread, exTurn, exJSON string
	var exRawMsg sql.NullString
	err := tx.QueryRowContext(ctx, `
		SELECT native_thread_id, native_turn_id, item_json, raw_message_id
		FROM chat_runtime_native_thread_items WHERE session_id = ? AND item_id = ?
	`, sessionID, itemID).Scan(&exThread, &exTurn, &exJSON, &exRawMsg)
	if err != nil && err != sql.ErrNoRows {
		return err
	}
	if err == nil {
		if exThread != ev.ThreadID || exTurn != ev.TurnID ||
			asString(parseJSONObject(exJSON)["type"]) != itemType ||
			(exRawMsg.Valid && exRawMsg.String != "" && ev.RawMessageID != "" && exRawMsg.String != ev.RawMessageID) {
			return NewError("chat_native_thread_item_conflict", http.StatusConflict, nil)
		}
	}
	if ev.RawMessageID != "" {
		rThread, rTurn, rJSON, rFound, err := r.responseItems.readRowTx(ctx, tx, sessionID, ev.RawMessageID)
		if err != nil {
			return err
		}
		if !rFound || itemType != "userMessage" || rThread != ev.ThreadID || rTurn != ev.TurnID || asString(parseJSONObject(rJSON)["role"]) != "user" {
			return NewError("chat_native_message_link_invalid", http.StatusConflict, nil)
		}
		var otherID string
		err = tx.QueryRowContext(ctx, `
			SELECT item_id FROM chat_runtime_native_thread_items
			WHERE session_id = ? AND raw_message_id = ? AND item_id != ?
		`, sessionID, ev.RawMessageID, itemID).Scan(&otherID)
		if err == nil {
			return NewError("chat_native_message_link_conflict", http.StatusConflict, nil)
		}
		if err != sql.ErrNoRows {
			return err
		}
	}
	itemJSON, err := CanonicalJSON(ev.Item)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO chat_runtime_native_thread_items
		  (session_id, native_thread_id, native_turn_id, item_id, item_json, raw_message_id, ordinal)
		VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(ordinal), 0) + 1 FROM chat_runtime_native_thread_items WHERE session_id = ?))
		ON CONFLICT(session_id, item_id) DO UPDATE SET item_json = excluded.item_json,
		  raw_message_id = COALESCE(excluded.raw_message_id, raw_message_id)
	`, sessionID, ev.ThreadID, ev.TurnID, itemID, itemJSON, nullableText(ev.RawMessageID), sessionID)
	return err
}

func (r *NativeThreadItemRepository) ReadTurn(ctx context.Context, sessionID, threadID, turnID string) ([]NativeThreadItemRecord, error) {
	var out []NativeThreadItemRecord
	err := r.db.withRead(ctx, func(db *sql.DB) error {
		rows, err := db.QueryContext(ctx, `
			SELECT item_json, raw_message_id FROM chat_runtime_native_thread_items
			WHERE session_id = ? AND native_thread_id = ? AND native_turn_id = ? ORDER BY ordinal
		`, sessionID, threadID, turnID)
		if err != nil {
			return err
		}
		defer rows.Close()
		out = []NativeThreadItemRecord{}
		for rows.Next() {
			var rawJSON string
			var rawMsg sql.NullString
			if err := rows.Scan(&rawJSON, &rawMsg); err != nil {
				return err
			}
			out = append(out, NativeThreadItemRecord{
				Item:         parseJSONObject(rawJSON),
				RawMessageID: rawMsg.String,
			})
		}
		return rows.Err()
	})
	return out, err
}

// SessionBranchRepository 处理 Chat 模式的确定性分支与重新生成（写入 history_seeds）。
type SessionBranchRepository struct {
	store *Store
}

func newSessionBranchRepository(store *Store) *SessionBranchRepository {
	return &SessionBranchRepository{store: store}
}

func (r *SessionBranchRepository) Create(ctx context.Context, cmd *Command) (*Session, error) {
	if cmd == nil {
		return nil, ErrInvalid("chat_command_required")
	}
	var out *Session
	err := r.store.db.withTx(ctx, func(tx *sql.Tx) error {
		source, err := r.store.Sessions.requireTx(ctx, tx, cmd.SessionID)
		if err != nil {
			return err
		}
		if !IsChatSession(source) {
			return ErrInvalid("chat_branch_mode_unsupported")
		}
		sessionID := BranchSessionID(cmd.CommandID)
		existing, err := r.store.Sessions.getTx(ctx, tx, sessionID)
		if err != nil {
			return err
		}
		if existing != nil {
			lineage, _ := existing.Policy["lineage"].(map[string]any)
			if asString(lineage["parentSessionId"]) != source.SessionID || asString(lineage["commandId"]) != cmd.CommandID {
				return NewError("chat_branch_identity_conflict", http.StatusConflict, nil)
			}
			out = existing
			return nil
		}
		if source.State != "idle" || source.ActiveTurn != nil {
			return NewError("chat_branch_source_busy", http.StatusConflict, nil)
		}
		regenerate := cmd.Type == "turn.regenerate"
		sourceItemID := asString(cmd.Payload["sourceItemId"])
		prefix, err := buildChatHistoryPrefixWithQuerier(ctx, tx, r.store, source, sourceItemID, regenerate)
		if err != nil {
			return err
		}
		childPolicy := stripDerivedPolicyFields(source.Policy)
		childPolicy["contextState"] = map[string]any{}
		titleBase := strings.TrimSpace(asString(source.Policy["title"]))
		if titleBase == "" {
			titleBase = "对话"
		}
		suffix := "分支"
		if regenerate {
			suffix = "重新生成"
		}
		childPolicy["title"] = titleBase + " · " + suffix
		childPolicy["lineage"] = map[string]any{
			"parentSessionId": source.SessionID,
			"sourceItemId":    sourceItemID,
			"operation":       cmd.Type,
			"commandId":       cmd.CommandID,
		}
		child, err := r.store.Sessions.createInTx(ctx, tx, CreateSessionInput{
			SessionID:           sessionID,
			Provider:            source.Provider,
			ExecutionAccountRef: source.ExecutionAccountRef,
			ProjectPath:         "",
			CapabilitySnapshot:  source.CapabilitySnapshot,
			Policy:              childPolicy,
		})
		if err != nil {
			return err
		}

		msgSubmissions := map[string]any{}
		drafts := make([]EventDraft, 0, len(prefix.Items))
		idMap := make(map[string]string, len(prefix.Items))
		nativeID := asString(source.RuntimeBinding["nativeSessionId"])
		if nativeID == "" {
			nativeID = "inherited-seed"
		}
		for idx, orig := range prefix.Items {
			id := fmt.Sprintf("%s-seed-%d", sessionID, idx)
			idMap[orig.ID] = id
			if orig.Kind == "message" && asString(orig.Detail["role"]) == "user" {
				sub, err := messageSubmissionWithQuerier(ctx, tx, r.store, source, orig)
				if err != nil {
					return err
				}
				clonedSub, err := r.cloneSubmissionTx(ctx, tx, source.SessionID, sessionID, sub)
				if err != nil {
					return err
				}
				msgSubmissions[id] = clonedSub
			}
			at := orig.CreatedAt
			if orig.UpdatedAt != nil {
				at = *orig.UpdatedAt
			}
			itemCopy := orig
			itemCopy.TurnID = ""
			itemCopy.ID = id
			itemCopy.Detail = CloneMap(orig.Detail)
			itemCopy.Detail["inherited"] = true
			drafts = append(drafts, EventDraft{
				EventID: id + "-event",
				Type:    "timeline.item.completed",
				At:      &at,
				Source:  EventSource{Provider: source.Provider, RuntimeID: "aih:history-seed"},
				Payload: map[string]any{"item": itemToMap(itemCopy)},
			})
		}

		responseItems := make([]map[string]any, 0, len(prefix.ResponseItems))
		for _, item := range prefix.ResponseItems {
			next := CloneMap(item)
			if newID, ok := idMap[asString(item["id"])]; ok {
				next["id"] = newID
			}
			responseItems = append(responseItems, next)
			if asString(next["type"]) == "reasoning" {
				if err := r.store.NativeResponseItems.recordInTx(ctx, tx, sessionID, NativeResponseItemEvidence{
					ThreadID: nativeID,
					Item:     next,
				}); err != nil {
					return err
				}
			}
		}

		var clonedRegen any
		if prefix.Submission != nil {
			clonedRegen, err = r.cloneSubmissionTx(ctx, tx, source.SessionID, sessionID, prefix.Submission)
			if err != nil {
				return err
			}
		}
		respJSON, _ := json.Marshal(responseItems)
		subsJSON, _ := json.Marshal(msgSubmissions)
		regenJSON, _ := json.Marshal(clonedRegen)
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO chat_runtime_history_seeds
			  (session_id, response_items_json, message_submissions_json, regeneration_json)
			VALUES (?, ?, ?, ?)
		`, sessionID, string(respJSON), string(subsJSON), string(regenJSON)); err != nil {
			return err
		}
		if _, err := r.store.TimelineImports.importInTx(ctx, tx, sessionID, drafts); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE chat_runtime_sessions SET updated_at = ? WHERE session_id = ?`, r.store.db.clock(), sessionID); err != nil {
			return err
		}
		out, err = r.store.Sessions.requireTx(ctx, tx, child.SessionID)
		return err
	})
	return out, err
}

func (r *SessionBranchRepository) cloneSubmissionTx(ctx context.Context, tx *sql.Tx, sourceID, childID string, payload map[string]any) (map[string]any, error) {
	cloned := CloneMap(payload)
	attIDs, _ := NormalizeAttachmentIDs(payload["attachmentIds"], false)
	if len(attIDs) > 0 {
		nextIDs, err := r.store.Attachments.cloneInTx(ctx, tx, sourceID, childID, attIDs)
		if err != nil {
			return nil, err
		}
		cloned["attachmentIds"] = toAnyStringSlice(nextIDs)
	}
	return cloned, nil
}

func (r *SessionBranchRepository) Read(ctx context.Context, sessionID string) (*HistorySeed, error) {
	var out *HistorySeed
	err := r.store.db.withRead(ctx, func(db *sql.DB) error {
		var err error
		out, err = readHistorySeedQuerier(ctx, db, sessionID)
		return err
	})
	return out, err
}

func (r *SessionBranchRepository) ReadMessageSubmission(ctx context.Context, sessionID, itemID string) (map[string]any, error) {
	seed, err := r.Read(ctx, sessionID)
	if err != nil || seed == nil {
		return nil, err
	}
	if sub, ok := seed.MessageSubmissions[itemID]; ok {
		return CloneMap(sub), nil
	}
	return nil, nil
}

func readHistorySeedQuerier(ctx context.Context, q rowQuerier, sessionID string) (*HistorySeed, error) {
	var respJSON, subsJSON, regenJSON string
	err := q.QueryRowContext(ctx, `
		SELECT response_items_json, message_submissions_json, regeneration_json
		FROM chat_runtime_history_seeds WHERE session_id = ?
	`, sessionID).Scan(&respJSON, &subsJSON, &regenJSON)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	seed := &HistorySeed{
		ResponseItems:      []map[string]any{},
		MessageSubmissions: map[string]map[string]any{},
	}
	_ = json.Unmarshal([]byte(respJSON), &seed.ResponseItems)
	_ = json.Unmarshal([]byte(subsJSON), &seed.MessageSubmissions)
	if strings.TrimSpace(regenJSON) != "" && strings.TrimSpace(regenJSON) != "null" {
		_ = json.Unmarshal([]byte(regenJSON), &seed.Regeneration)
	}
	return seed, nil
}

type queryRunner interface {
	rowQuerier
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

func buildChatHistoryPrefixWithQuerier(ctx context.Context, q queryRunner, store *Store, session *Session, sourceItemID string, regenerate bool) (*HistoryPrefix, error) {
	events, err := listAllEventsQuerier(ctx, q, session.SessionID)
	if err != nil {
		return nil, err
	}
	items := ProjectTimeline(events)
	index := -1
	for i := range items {
		if items[i].ID == sourceItemID {
			index = i
			break
		}
	}
	if index < 0 || items[index].Kind != "message" || items[index].Status != "completed" {
		return nil, NewError("chat_branch_message_unavailable", http.StatusConflict, nil)
	}
	target := items[index]
	cut := index + 1
	var regenSubmission map[string]any
	if regenerate {
		if asString(target.Detail["role"]) != "assistant" {
			return nil, ErrInvalid("chat_regenerate_answer_required")
		}
		userIdx := -1
		for i := index - 1; i >= 0; i-- {
			if items[i].Kind == "message" && asString(items[i].Detail["role"]) == "user" {
				userIdx = i
				break
			}
		}
		if userIdx < 0 {
			return nil, NewError("chat_regenerate_input_missing", http.StatusConflict, nil)
		}
		cut = userIdx
		regenSubmission, err = messageSubmissionWithQuerier(ctx, q, store, session, items[userIdx])
		if err != nil {
			return nil, err
		}
	}
	prefix := items[:cut]
	nativeMap := map[string]map[string]any{}
	for _, item := range prefix {
		if item.Kind == "reasoning" {
			_, _, rawJSON, found, err := store.NativeResponseItems.readRowTx(ctx, q, session.SessionID, item.ID)
			if err != nil {
				return nil, err
			}
			if found {
				nativeMap[item.ID] = parseJSONObject(rawJSON)
			}
		}
	}
	rev := AssessHistoryPrefix(prefix, func(id string) map[string]any { return nativeMap[id] })
	if !rev.Reversible {
		details := map[string]any{"kind": rev.Kind, "reason": rev.Reason}
		if rev.ItemID != "" {
			details["itemId"] = rev.ItemID
		}
		return nil, NewError("chat_branch_history_unsupported", http.StatusUnprocessableEntity, details)
	}

	responseItems := make([]map[string]any, 0, len(prefix))
	for _, item := range prefix {
		switch item.Kind {
		case "message":
			msg, err := buildResponseMessageWithQuerier(ctx, q, store, session, item)
			if err != nil {
				return nil, err
			}
			responseItems = append(responseItems, msg)
		case "reasoning":
			responseItems = append(responseItems, nativeMap[item.ID])
		case "notice":
			if IsSkippableNotice(item) {
				continue
			}
			return nil, NewError("chat_branch_history_unsupported", http.StatusUnprocessableEntity, map[string]any{"kind": item.Kind})
		default:
			return nil, NewError("chat_branch_history_unsupported", http.StatusUnprocessableEntity, map[string]any{"kind": item.Kind})
		}
	}
	return &HistoryPrefix{
		Items:         prefix,
		ResponseItems: responseItems,
		Submission:    regenSubmission,
	}, nil
}

func messageSubmissionWithQuerier(ctx context.Context, q rowQuerier, store *Store, session *Session, item TimelineItem) (map[string]any, error) {
	seed, err := readHistorySeedQuerier(ctx, q, session.SessionID)
	if err != nil {
		return nil, err
	}
	if seed != nil {
		if sub, ok := seed.MessageSubmissions[item.ID]; ok && sub != nil {
			return CloneMap(sub), nil
		}
	}
	if item.TurnID != "" {
		cmd, err := store.FailedTurns.findSubmissionWithQuerier(ctx, q, session.SessionID, item.TurnID)
		if err != nil {
			return nil, err
		}
		if cmd != nil && cmd.Payload != nil {
			return CloneMap(cmd.Payload), nil
		}
	}
	if inputs, ok := item.Detail["inputs"].([]any); ok && len(inputs) > 0 {
		return nil, NewError("chat_branch_attachment_source_missing", http.StatusConflict, nil)
	}
	content := ""
	if item.Content != nil {
		content = *item.Content
	}
	out := map[string]any{"content": content}
	if m := strings.TrimSpace(asString(session.Policy["model"])); m != "" {
		out["model"] = m
	}
	if r := strings.TrimSpace(asString(session.Policy["reasoningEffort"])); r != "" {
		out["reasoningEffort"] = r
	}
	return out, nil
}

func buildResponseMessageWithQuerier(ctx context.Context, q rowQuerier, store *Store, session *Session, item TimelineItem) (map[string]any, error) {
	role := asString(item.Detail["role"])
	if role != "user" {
		text := ""
		if item.Content != nil {
			text = *item.Content
		}
		return map[string]any{
			"type":    "message",
			"id":      item.ID,
			"role":    role,
			"content": []any{map[string]any{"type": "output_text", "text": text}},
		}, nil
	}
	sub, err := messageSubmissionWithQuerier(ctx, q, store, session, item)
	if err != nil {
		return nil, err
	}
	attIDs, _ := NormalizeAttachmentIDs(sub["attachmentIds"], false)
	var paths []string
	if len(attIDs) > 0 {
		if err := resolveAttachmentPathsQuerier(ctx, q, session.SessionID, attIDs, &paths); err != nil {
			return nil, err
		}
	}
	turnInput, err := SessionAttachmentTurnInput(session, asString(sub["content"]), paths)
	if err != nil {
		return nil, err
	}
	parts := make([]any, 0, 1+len(turnInput.ImagePaths))
	if turnInput.Prompt != "" {
		parts = append(parts, map[string]any{"type": "input_text", "text": turnInput.Prompt})
	}
	for _, imgPath := range turnInput.ImagePaths {
		raw, err := os.ReadFile(imgPath)
		if err != nil {
			return nil, NewError("chat_attachment_not_found", http.StatusNotFound, nil)
		}
		mime := GuessImageMimeType(imgPath)
		parts = append(parts, map[string]any{
			"type":      "input_image",
			"image_url": fmt.Sprintf("data:%s;base64,%s", mime, base64.StdEncoding.EncodeToString(raw)),
		})
	}
	return map[string]any{
		"type":    "message",
		"id":      item.ID,
		"role":    "user",
		"content": parts,
	}, nil
}

func listAllEventsQuerier(ctx context.Context, q queryRunner, sessionID string) ([]EventEnvelope, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT event_id, session_id, seq, schema, type, at, turn_id, run_id, item_id, source_json, payload_json
		FROM chat_runtime_events WHERE session_id = ? ORDER BY seq
	`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanEventRows(rows)
}

func stripDerivedPolicyFields(policy map[string]any) map[string]any {
	out := CloneMap(policy)
	delete(out, "legacySessionId")
	delete(out, "lineage")
	delete(out, "archived")
	delete(out, "contextState")
	delete(out, "queueControl")
	return out
}

// BranchOperation 描述工作区分支两阶段原子检查点。
type BranchOperation struct {
	SessionID           string         `json:"sessionId"`
	CommandID           string         `json:"commandId"`
	ExecutionAccountRef string         `json:"executionAccountRef"`
	SourceThreadID      string         `json:"sourceThreadId"`
	Plan                map[string]any `json:"plan"`
	State               string         `json:"state"`
	Receipt             map[string]any `json:"receipt"`
}

// NativeBranchPort 抽象原生线程分叉、注入及断线恢复证据查询接口。
type NativeBranchPort interface {
	Fork(ctx context.Context, op *BranchOperation) (map[string]any, error)
	RecoverFork(ctx context.Context, op *BranchOperation) (map[string]any, error)
	Inject(ctx context.Context, op *BranchOperation) error
	RecoverInjection(ctx context.Context, op *BranchOperation) (string, error)
}

// BranchOperationRepository 持久化原生分叉检查点，防止断线重复创建/重复注入。
type BranchOperationRepository struct {
	store *Store
}

func newBranchOperationRepository(store *Store) *BranchOperationRepository {
	return &BranchOperationRepository{store: store}
}

func (r *BranchOperationRepository) Prepare(ctx context.Context, cmd *Command, plan map[string]any) (*BranchOperation, error) {
	if cmd == nil || plan == nil {
		return nil, NewError("chat_branch_operation_identity_conflict", http.StatusConflict, nil)
	}
	var out *BranchOperation
	err := r.store.db.withTx(ctx, func(tx *sql.Tx) error {
		accepted, err := r.store.Commands.getTx(ctx, tx, cmd.CommandID)
		if err != nil {
			return err
		}
		source, err := r.store.Sessions.requireTx(ctx, tx, cmd.SessionID)
		if err != nil {
			return err
		}
		if accepted == nil || accepted.SessionID != cmd.SessionID || accepted.Type != cmd.Type ||
			(cmd.Type != "session.fork" && cmd.Type != "turn.regenerate") ||
			!CanonicalJSONEquals(accepted.Payload, cmd.Payload) {
			return NewError("chat_branch_operation_identity_conflict", http.StatusConflict, nil)
		}
		itemsSlice, hasItems := plan["items"].([]any)
		if !hasItems {
			if mSlice, ok := plan["items"].([]map[string]any); ok {
				itemsSlice = make([]any, len(mSlice))
				for i, item := range mSlice {
					itemsSlice[i] = item
				}
				hasItems = true
			}
		}
		if !hasItems || asString(plan["threadId"]) != asString(source.RuntimeBinding["nativeSessionId"]) ||
			asString(plan["sourceItemId"]) != asString(cmd.Payload["sourceItemId"]) {
			return NewError("chat_branch_operation_identity_conflict", http.StatusConflict, nil)
		}
		lastTurnID := asString(plan["lastTurnId"])
		beforeTurnID := asString(plan["beforeTurnId"])
		if (lastTurnID != "") == (beforeTurnID != "") || (lastTurnID != "" && len(itemsSlice) > 0) {
			return NewError("chat_branch_operation_identity_conflict", http.StatusConflict, nil)
		}
		if forkThreadID := asString(plan["forkThreadId"]); forkThreadID != "" && forkThreadID != asString(plan["threadId"]) {
			lineage, _ := source.Policy["lineage"].(map[string]any)
			parentCmdID := asString(lineage["commandId"])
			parentSessionID := asString(lineage["parentSessionId"])
			var parent *BranchOperation
			if parentCmdID != "" && parentSessionID != "" {
				parent, err = readBranchOpQuerier(ctx, tx, parentSessionID, parentCmdID)
				if err != nil {
					return err
				}
			}
			if parent == nil || asString(parent.Receipt["threadId"]) != asString(plan["threadId"]) ||
				firstNonEmpty(asString(parent.Plan["forkThreadId"]), asString(parent.Plan["threadId"])) != forkThreadID ||
				asString(parent.Plan["beforeTurnId"]) != beforeTurnID ||
				parent.ExecutionAccountRef != source.ExecutionAccountRef {
				return NewError("chat_branch_operation_identity_conflict", http.StatusConflict, nil)
			}
		}
		existing, err := readBranchOpQuerier(ctx, tx, cmd.SessionID, cmd.CommandID)
		if err != nil {
			return err
		}
		if existing != nil {
			if err := r.requireSourceTx(ctx, tx, existing); err != nil {
				return err
			}
			if !CanonicalJSONEquals(existing.Plan, plan) {
				return NewError("chat_branch_operation_identity_conflict", http.StatusConflict, nil)
			}
			out = existing
			return nil
		}
		if accepted.Status != "accepted" || source.State != "idle" || source.ActiveTurn != nil {
			return NewError("chat_branch_source_busy", http.StatusConflict, nil)
		}
		planJSON, err := json.Marshal(plan)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO chat_runtime_branch_operations
			  (command_id, session_id, execution_account_ref, source_native_thread_id, plan_json, state, updated_at)
			VALUES (?, ?, ?, ?, ?, 'prepared', ?)
		`, cmd.CommandID, source.SessionID, source.ExecutionAccountRef, asString(plan["threadId"]), string(planJSON), r.store.db.clock()); err != nil {
			return err
		}
		out, err = readBranchOpQuerier(ctx, tx, source.SessionID, cmd.CommandID)
		return err
	})
	return out, err
}

func (r *BranchOperationRepository) Read(ctx context.Context, sessionID, commandID string) (*BranchOperation, error) {
	var out *BranchOperation
	err := r.store.db.withRead(ctx, func(db *sql.DB) error {
		var err error
		out, err = readBranchOpQuerier(ctx, db, sessionID, commandID)
		return err
	})
	return out, err
}

func (r *BranchOperationRepository) Advance(ctx context.Context, sessionID, commandID, from, to string, receipt map[string]any) (*BranchOperation, error) {
	var out *BranchOperation
	err := r.store.db.withTx(ctx, func(tx *sql.Tx) error {
		op, err := readBranchOpQuerier(ctx, tx, sessionID, commandID)
		if err != nil {
			return err
		}
		if op == nil {
			return NewError("chat_branch_operation_identity_conflict", http.StatusConflict, nil)
		}
		if err := r.requireSourceTx(ctx, tx, op); err != nil {
			return err
		}
		allowedNext := branchNextStates[from]
		if op.State != from || allowedNext == nil {
			return NewError("chat_branch_operation_stale", http.StatusConflict, nil)
		}
		if _, ok := allowedNext[to]; !ok {
			return NewError("chat_branch_operation_stale", http.StatusConflict, nil)
		}
		nextReceipt := receipt
		if nextReceipt == nil {
			nextReceipt = op.Receipt
		}
		if to == "fork_pending" && nextReceipt != nil {
			return NewError("chat_branch_operation_identity_conflict", http.StatusConflict, nil)
		}
		if to != "fork_pending" && (nextReceipt == nil || asString(nextReceipt["threadId"]) == "" || asString(nextReceipt["threadId"]) == op.SourceThreadID) {
			return NewError("chat_branch_operation_identity_conflict", http.StatusConflict, nil)
		}
		if nextReceipt != nil && asString(nextReceipt["sourceThreadId"]) != op.SourceThreadID {
			return NewError("chat_branch_operation_identity_conflict", http.StatusConflict, nil)
		}
		if op.Receipt != nil && !CanonicalJSONEquals(op.Receipt, nextReceipt) {
			return NewError("chat_branch_operation_identity_conflict", http.StatusConflict, nil)
		}
		itemsCount := planItemsLen(op.Plan["items"])
		if to == "inject_pending" && itemsCount == 0 {
			return NewError("chat_branch_injection_unexpected", http.StatusConflict, nil)
		}
		if to == "ready" && from == "forked" && itemsCount > 0 {
			return NewError("chat_branch_injection_required", http.StatusConflict, nil)
		}
		var receiptArg sql.NullString
		if nextReceipt != nil {
			encoded, err := json.Marshal(nextReceipt)
			if err != nil {
				return err
			}
			receiptArg = sql.NullString{String: string(encoded), Valid: true}
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE chat_runtime_branch_operations
			SET state = ?, native_receipt_json = ?, updated_at = ?
			WHERE session_id = ? AND command_id = ? AND state = ?
		`, to, receiptArg, r.store.db.clock(), sessionID, commandID, from); err != nil {
			return err
		}
		out, err = readBranchOpQuerier(ctx, tx, sessionID, commandID)
		return err
	})
	return out, err
}

func (r *BranchOperationRepository) requireSourceTx(ctx context.Context, tx *sql.Tx, op *BranchOperation) error {
	source, err := r.store.Sessions.requireTx(ctx, tx, op.SessionID)
	if err != nil {
		return err
	}
	if source.ExecutionAccountRef != op.ExecutionAccountRef || asString(source.RuntimeBinding["nativeSessionId"]) != op.SourceThreadID {
		return NewError("chat_branch_operation_identity_conflict", http.StatusConflict, nil)
	}
	return nil
}

// PrepareNativeBranch 以持久检查点驱动原生物理线程分支与补注流程。
func PrepareNativeBranch(ctx context.Context, repo *BranchOperationRepository, cmd *Command, plan map[string]any, native NativeBranchPort) (*BranchOperation, error) {
	op, err := repo.Prepare(ctx, cmd, plan)
	if err != nil {
		return nil, err
	}
	advance := func(to string, receipt map[string]any) error {
		next, err := repo.Advance(ctx, cmd.SessionID, cmd.CommandID, op.State, to, receipt)
		if err != nil {
			return err
		}
		op = next
		return nil
	}
	switch op.State {
	case "prepared":
		if err := advance("fork_pending", nil); err != nil {
			return nil, err
		}
		receipt, err := native.Fork(ctx, op)
		if err != nil {
			receipt, _ = native.RecoverFork(ctx, op)
		}
		if receipt == nil {
			return nil, NewError("chat_branch_fork_outcome_unknown", http.StatusConflict, map[string]any{"retryable": false})
		}
		if err := advance("forked", receipt); err != nil {
			return nil, err
		}
	case "fork_pending":
		receipt, err := native.RecoverFork(ctx, op)
		if err != nil || receipt == nil {
			return nil, NewError("chat_branch_fork_outcome_unknown", http.StatusConflict, map[string]any{"retryable": false})
		}
		if err := advance("forked", receipt); err != nil {
			return nil, err
		}
	}

	switch op.State {
	case "forked":
		if planItemsLen(op.Plan["items"]) == 0 {
			if err := advance("ready", nil); err != nil {
				return nil, err
			}
		} else {
			if err := advance("inject_pending", nil); err != nil {
				return nil, err
			}
			if err := native.Inject(ctx, op); err != nil {
				status, recErr := native.RecoverInjection(ctx, op)
				if recErr != nil || status != "complete" {
					return nil, NewError("chat_branch_injection_outcome_unknown", http.StatusConflict, map[string]any{"retryable": false})
				}
			}
			if err := advance("ready", nil); err != nil {
				return nil, err
			}
		}
	case "inject_pending":
		status, err := native.RecoverInjection(ctx, op)
		if err != nil || status != "complete" {
			return nil, NewError("chat_branch_injection_outcome_unknown", http.StatusConflict, map[string]any{"retryable": false})
		}
		if err := advance("ready", nil); err != nil {
			return nil, err
		}
	}
	return op, nil
}

func readBranchOpQuerier(ctx context.Context, q rowQuerier, sessionID, commandID string) (*BranchOperation, error) {
	var (
		op          BranchOperation
		planJSON    string
		receiptJSON sql.NullString
	)
	err := q.QueryRowContext(ctx, `
		SELECT session_id, command_id, execution_account_ref, source_native_thread_id, plan_json, state, native_receipt_json
		FROM chat_runtime_branch_operations WHERE session_id = ? AND command_id = ?
	`, sessionID, commandID).Scan(&op.SessionID, &op.CommandID, &op.ExecutionAccountRef, &op.SourceThreadID, &planJSON, &op.State, &receiptJSON)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	op.Plan = parseJSONObject(planJSON)
	if receiptJSON.Valid && strings.TrimSpace(receiptJSON.String) != "" {
		op.Receipt = parseJSONObject(receiptJSON.String)
	}
	return &op, nil
}

func planItemsLen(v any) int {
	switch s := v.(type) {
	case []any:
		return len(s)
	case []map[string]any:
		return len(s)
	default:
		return 0
	}
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

// WorkBranchCapture 描述工作区会话分叉捕获的快照投影。
type WorkBranchCapture struct {
	Items              []map[string]any          `json:"items"`
	Submissions        map[string]map[string]any `json:"submissions"`
	Interactions       []Interaction             `json:"interactions"`
	Regeneration       map[string]any            `json:"regeneration"`
	AnchorItemID       string                    `json:"anchorItemId"`
	ProjectPath        string                    `json:"projectPath"`
	Policy             map[string]any            `json:"policy"`
	CapabilitySnapshot map[string]any            `json:"capabilitySnapshot"`
	RuntimeBinding     map[string]any            `json:"runtimeBinding"`
}

// WorkBranchRepository 管理工作区（Work）会话的投影采集、去重检查和事务提交。
type WorkBranchRepository struct {
	store *Store
}

func newWorkBranchRepository(store *Store) *WorkBranchRepository {
	return &WorkBranchRepository{store: store}
}

func (r *WorkBranchRepository) Capture(ctx context.Context, cmd *Command) (*WorkBranchCapture, error) {
	if cmd == nil {
		return nil, ErrInvalid("chat_command_required")
	}
	var out *WorkBranchCapture
	err := r.store.db.withRead(ctx, func(db *sql.DB) error {
		source, err := scanSessionRow(querySessionByID(ctx, db, cmd.SessionID))
		if err != nil {
			return err
		}
		if source == nil {
			return NewError("chat_session_not_found", http.StatusNotFound, nil)
		}
		if source.State != "idle" || source.ActiveTurn != nil {
			return NewError("chat_branch_source_busy", http.StatusConflict, nil)
		}
		events, err := listAllEventsQuerier(ctx, db, source.SessionID)
		if err != nil {
			return err
		}
		timeline := ProjectTimeline(events)
		sourceItemID := asString(cmd.Payload["sourceItemId"])
		cut := -1
		for i := range timeline {
			if timeline[i].ID == sourceItemID {
				cut = i
				break
			}
		}
		if cut < 0 {
			return NewError("chat_branch_message_unavailable", http.StatusConflict, nil)
		}
		target := timeline[cut]
		role := asString(target.Detail["role"])
		if target.Kind != "message" || target.Status != "completed" ||
			asString(target.Detail["phase"]) == "interaction_answer" ||
			(role != "user" && role != "assistant") {
			return NewError("chat_branch_message_unavailable", http.StatusConflict, nil)
		}
		regenerate := cmd.Type == "turn.regenerate"
		userIdx := -1
		if regenerate {
			for i := cut - 1; i >= 0; i-- {
				if timeline[i].Kind == "message" && asString(timeline[i].Detail["role"]) == "user" &&
					asString(timeline[i].Detail["phase"]) != "interaction_answer" {
					userIdx = i
					break
				}
			}
			if role != "assistant" || userIdx < 0 {
				return NewError("chat_regenerate_input_missing", http.StatusConflict, nil)
			}
		}
		var regen map[string]any
		if regenerate {
			regen, err = messageSubmissionWithQuerier(ctx, db, r.store, source, timeline[userIdx])
			if err != nil {
				return err
			}
		}
		sliceEnd := cut + 1
		anchorID := target.ID
		if regenerate {
			sliceEnd = userIdx
			anchorID = timeline[userIdx].ID
		}
		items := timeline[:sliceEnd]
		submissions := map[string]map[string]any{}
		itemMaps := make([]map[string]any, 0, len(items))
		itemIDs := make(map[string]struct{}, len(items))
		for _, item := range items {
			itemIDs[item.ID] = struct{}{}
			itemMaps = append(itemMaps, itemToMap(item))
			if item.Kind == "message" && asString(item.Detail["role"]) == "user" && asString(item.Detail["phase"]) != "interaction_answer" {
				sub, err := messageSubmissionWithQuerier(ctx, db, r.store, source, item)
				if err != nil {
					return err
				}
				submissions[item.ID] = sub
			}
		}
		for _, sub := range submissions {
			attIDs, _ := NormalizeAttachmentIDs(sub["attachmentIds"], false)
			var dummy []string
			if len(attIDs) > 0 {
				if err := resolveAttachmentPathsQuerier(ctx, db, source.SessionID, attIDs, &dummy); err != nil {
					return err
				}
			}
		}
		if regen != nil {
			attIDs, _ := NormalizeAttachmentIDs(regen["attachmentIds"], false)
			var dummy []string
			if len(attIDs) > 0 {
				if err := resolveAttachmentPathsQuerier(ctx, db, source.SessionID, attIDs, &dummy); err != nil {
					return err
				}
			}
		}
		rows, err := db.QueryContext(ctx, `
			SELECT interaction_id, session_id, item_id, kind, revision, payload_json, state, resolution_json, created_at, updated_at
			FROM chat_runtime_interactions WHERE session_id = ? ORDER BY created_at, interaction_id
		`, source.SessionID)
		if err != nil {
			return err
		}
		allInteractions, err := scanInteractionRows(rows)
		_ = rows.Close()
		if err != nil {
			return err
		}
		selectedInteractions := make([]Interaction, 0)
		for _, inter := range allInteractions {
			answerItemID := fmt.Sprintf("interaction-answer:%s:%d", inter.InteractionID, inter.Revision)
			_, hasItem := itemIDs[inter.ItemID]
			_, hasAnswer := itemIDs[answerItemID]
			if !hasItem && !hasAnswer {
				continue
			}
			if inter.State == "pending" || inter.State == "resolving" {
				return NewError("chat_branch_interaction_pending", http.StatusConflict, nil)
			}
			selectedInteractions = append(selectedInteractions, inter)
		}
		out = &WorkBranchCapture{
			Items:              itemMaps,
			Submissions:        submissions,
			Interactions:       selectedInteractions,
			Regeneration:       regen,
			AnchorItemID:       anchorID,
			ProjectPath:        source.ProjectPath,
			Policy:             CloneMap(source.Policy),
			CapabilitySnapshot: CloneMap(source.CapabilitySnapshot),
			RuntimeBinding:     CloneMap(source.RuntimeBinding),
		}
		return nil
	})
	return out, err
}

func (r *WorkBranchRepository) Existing(ctx context.Context, cmd *Command) (*Session, error) {
	if cmd == nil {
		return nil, nil
	}
	var out *Session
	err := r.store.db.withRead(ctx, func(db *sql.DB) error {
		var err error
		out, err = r.existingWithQuerier(ctx, db, cmd)
		return err
	})
	return out, err
}

func (r *WorkBranchRepository) existingWithQuerier(ctx context.Context, q rowQuerier, cmd *Command) (*Session, error) {
	child, err := scanSessionRow(querySessionByID(ctx, q, BranchSessionID(cmd.CommandID)))
	if err != nil || child == nil {
		return nil, err
	}
	source, err := scanSessionRow(querySessionByID(ctx, q, cmd.SessionID))
	if err != nil {
		return nil, err
	}
	if source == nil {
		return nil, NewError("chat_session_not_found", http.StatusNotFound, nil)
	}
	lineage, _ := child.Policy["lineage"].(map[string]any)
	if asString(lineage["commandId"]) != cmd.CommandID ||
		asString(lineage["parentSessionId"]) != source.SessionID ||
		asString(lineage["sourceItemId"]) != asString(cmd.Payload["sourceItemId"]) ||
		asString(lineage["operation"]) != cmd.Type ||
		child.ExecutionAccountRef != source.ExecutionAccountRef ||
		child.Provider != source.Provider {
		return nil, NewError("chat_branch_identity_conflict", http.StatusConflict, nil)
	}
	return child, nil
}

func (r *WorkBranchRepository) Commit(ctx context.Context, cmd *Command) (*Session, error) {
	if cmd == nil {
		return nil, ErrInvalid("chat_command_required")
	}
	var out *Session
	err := r.store.db.withTx(ctx, func(tx *sql.Tx) error {
		existing, err := r.existingWithQuerier(ctx, tx, cmd)
		if err != nil {
			return err
		}
		if existing != nil {
			out = existing
			return nil
		}
		op, err := readBranchOpQuerier(ctx, tx, cmd.SessionID, cmd.CommandID)
		if err != nil {
			return err
		}
		projMap, _ := op.Plan["projection"].(map[string]any)
		if op == nil || op.State != "ready" || projMap == nil {
			return NewError("chat_branch_operation_not_ready", http.StatusConflict, nil)
		}
		if err := r.store.BranchOperations.requireSourceTx(ctx, tx, op); err != nil {
			return err
		}
		accepted, err := r.store.Commands.getTx(ctx, tx, cmd.CommandID)
		if err != nil {
			return err
		}
		if accepted == nil || accepted.SessionID != cmd.SessionID || accepted.Type != cmd.Type || !CanonicalJSONEquals(accepted.Payload, cmd.Payload) {
			return NewError("chat_branch_operation_identity_conflict", http.StatusConflict, nil)
		}
		source, err := r.store.Sessions.requireTx(ctx, tx, cmd.SessionID)
		if err != nil {
			return err
		}
		projPolicy, _ := projMap["policy"].(map[string]any)
		childPolicy := stripDerivedPolicyFields(projPolicy)
		ctxState := map[string]any{}
		if origCtx, ok := projPolicy["contextState"].(map[string]any); ok && origCtx["goal"] != nil {
			ctxState["goal"] = cloneAny(origCtx["goal"])
			if gs := asString(origCtx["goalSource"]); gs != "" {
				ctxState["goalSource"] = gs
			}
		}
		childPolicy["contextState"] = ctxState
		titleBase := strings.TrimSpace(asString(childPolicy["title"]))
		if titleBase == "" {
			titleBase = "工作会话"
		}
		suffix := "分支"
		if cmd.Type == "turn.regenerate" {
			suffix = "重新生成"
		}
		childPolicy["title"] = titleBase + " · " + suffix
		childPolicy["lineage"] = map[string]any{
			"parentSessionId": source.SessionID,
			"sourceItemId":    asString(cmd.Payload["sourceItemId"]),
			"operation":       cmd.Type,
			"commandId":       cmd.CommandID,
		}
		childBinding := CloneMap(mapOrNil(projMap["runtimeBinding"]))
		childBinding["nativeSessionId"] = asString(op.Receipt["threadId"])
		sessionID := BranchSessionID(cmd.CommandID)
		if _, err := r.store.Sessions.createInTx(ctx, tx, CreateSessionInput{
			SessionID:           sessionID,
			Provider:            source.Provider,
			ExecutionAccountRef: op.ExecutionAccountRef,
			ProjectPath:         asString(projMap["projectPath"]),
			CapabilitySnapshot:  mapOrNil(projMap["capabilitySnapshot"]),
			RuntimeBinding:      childBinding,
			Policy:              childPolicy,
		}); err != nil {
			return err
		}

		submissions := map[string]any{}
		if origSubs, ok := projMap["submissions"].(map[string]any); ok {
			for itemID, rawSub := range origSubs {
				if subMap, ok := rawSub.(map[string]any); ok {
					clonedSub, err := r.store.Branches.cloneSubmissionTx(ctx, tx, source.SessionID, sessionID, subMap)
					if err != nil {
						return err
					}
					submissions[itemID] = clonedSub
				}
			}
		}
		var clonedRegen any
		if regenMap, ok := projMap["regeneration"].(map[string]any); ok && regenMap != nil {
			clonedRegen, err = r.store.Branches.cloneSubmissionTx(ctx, tx, source.SessionID, sessionID, regenMap)
			if err != nil {
				return err
			}
		}
		subsJSON, _ := json.Marshal(submissions)
		regenJSON, _ := json.Marshal(clonedRegen)
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO chat_runtime_history_seeds
			  (session_id, response_items_json, message_submissions_json, regeneration_json)
			VALUES (?, '[]', ?, ?)
		`, sessionID, string(subsJSON), string(regenJSON)); err != nil {
			return err
		}

		interactionIDMap, err := r.copyInteractionsTx(ctx, tx, projMap["interactions"], sessionID, source.Provider)
		if err != nil {
			return err
		}
		rawItems, _ := projMap["items"].([]any)
		drafts := make([]EventDraft, 0, len(rawItems))
		for idx, rawItem := range rawItems {
			itemMap, ok := rawItem.(map[string]any)
			if !ok {
				continue
			}
			itemCopy := CloneMap(itemMap)
			detail := CloneMap(mapOrNil(itemCopy["detail"]))
			detail["inherited"] = true
			if origInterID := asString(detail["interactionId"]); origInterID != "" {
				if newID, exists := interactionIDMap[origInterID]; exists {
					detail["interactionId"] = newID
				}
			}
			itemCopy["detail"] = detail
			at, _ := asSafeInt64(itemCopy["updatedAt"])
			if at == 0 {
				at, _ = asSafeInt64(itemCopy["createdAt"])
			}
			drafts = append(drafts, EventDraft{
				EventID: fmt.Sprintf("%s-inherited-%d", sessionID, idx),
				Type:    "timeline.item.completed",
				At:      &at,
				TurnID:  asString(itemCopy["turnId"]),
				Source:  EventSource{Provider: source.Provider, RuntimeID: "aih:native-branch"},
				Payload: map[string]any{"item": itemCopy},
			})
		}
		if _, err := r.store.TimelineImports.importInTx(ctx, tx, sessionID, drafts); err != nil {
			return err
		}
		if err := r.copyNativeEvidenceTx(ctx, tx, op, sessionID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE chat_runtime_sessions SET updated_at = ? WHERE session_id = ?`, r.store.db.clock(), sessionID); err != nil {
			return err
		}
		out, err = r.store.Sessions.requireTx(ctx, tx, sessionID)
		return err
	})
	return out, err
}

func (r *WorkBranchRepository) copyInteractionsTx(ctx context.Context, tx *sql.Tx, rawInteractions any, childID, provider string) (map[string]string, error) {
	ids := map[string]string{}
	list, _ := rawInteractions.([]any)
	for _, raw := range list {
		origMap, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		state := asString(origMap["state"])
		if state == "pending" || state == "resolving" {
			return nil, NewError("chat_branch_interaction_pending", http.StatusConflict, nil)
		}
		origID := asString(origMap["interactionId"])
		nextID := fmt.Sprintf("%s-interaction-%d", childID, len(ids))
		ids[origID] = nextID
		rev := 1
		if parsedRev, ok := asPositiveSafeInt64(origMap["revision"]); ok {
			rev = int(parsedRev)
		}
		cAt, _ := asSafeInt64(origMap["createdAt"])
		uAt, _ := asSafeInt64(origMap["updatedAt"])
		payloadJSON, _ := json.Marshal(mapOrNil(origMap["payload"]))
		resJSON, _ := json.Marshal(origMap["resolution"])
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO chat_runtime_interactions
			  (interaction_id, session_id, item_id, kind, revision, payload_json, state, resolution_json, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`, nextID, childID, asString(origMap["itemId"]), asString(origMap["kind"]), rev, string(payloadJSON), state, string(resJSON), cAt, uAt); err != nil {
			return nil, err
		}
		interCopy := CloneMap(origMap)
		interCopy["sessionId"] = childID
		interCopy["interactionId"] = nextID
		if _, err := r.store.Events.appendInTx(ctx, tx, childID, EventDraft{
			Type:    "interaction.resolved",
			ItemID:  asString(origMap["itemId"]),
			Source:  EventSource{Provider: provider, RuntimeID: "aih:native-branch"},
			Payload: map[string]any{"interaction": interCopy},
		}, false, nil); err != nil {
			return nil, err
		}
	}
	return ids, nil
}

func (r *WorkBranchRepository) copyNativeEvidenceTx(ctx context.Context, tx *sql.Tx, op *BranchOperation, childID string) error {
	nativeTurns, ok := op.Plan["nativeTurns"].([]any)
	if !ok {
		return NewError("chat_branch_native_evidence_required", http.StatusConflict, nil)
	}
	threadID := asString(op.Receipt["threadId"])
	for _, rawTurn := range nativeTurns {
		turnMap, ok := rawTurn.(map[string]any)
		if !ok {
			continue
		}
		turnID := asString(turnMap["id"])
		items, _ := turnMap["items"].([]any)
		for _, rawItem := range items {
			if itemMap, ok := rawItem.(map[string]any); ok {
				if err := r.store.NativeResponseItems.recordInTx(ctx, tx, childID, NativeResponseItemEvidence{
					ThreadID: threadID,
					TurnID:   turnID,
					Item:     itemMap,
				}); err != nil {
					return err
				}
			}
		}
		threadItems, _ := turnMap["threadItems"].([]any)
		for _, rawTI := range threadItems {
			if tiMap, ok := rawTI.(map[string]any); ok {
				itemMap, _ := tiMap["item"].(map[string]any)
				if err := r.store.NativeThreadItems.recordInTx(ctx, tx, childID, NativeThreadItemEvidence{
					ThreadID:     threadID,
					TurnID:       turnID,
					Item:         itemMap,
					RawMessageID: asString(tiMap["rawMessageId"]),
				}); err != nil {
					return err
				}
			}
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO chat_runtime_native_history_coverage (session_id, native_thread_id, native_turn_id, state)
			VALUES (?, ?, ?, ?)
		`, childID, threadID, turnID, asString(turnMap["coverage"])); err != nil {
			return err
		}
	}
	return nil
}

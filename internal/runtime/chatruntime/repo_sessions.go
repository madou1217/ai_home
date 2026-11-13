package chatruntime

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

const (
	defaultSessionListLimit = 100
	maxSessionListLimit     = 500
)

// NativeThreadReplacement 描述原生线程替换校验的期望前置身份。
type NativeThreadReplacement struct {
	RunID        string
	NativeTurnID string
	ThreadID     string
}

// SessionRepository 负责 chat_runtime_sessions 的持久化查询与更新。
type SessionRepository struct {
	db        *Database
	events    *EventRepository
	idFactory func(prefix string) string
}

func newSessionRepository(db *Database, events *EventRepository, idFactory func(string) string) *SessionRepository {
	return &SessionRepository{db: db, events: events, idFactory: idFactory}
}

type sessionDraft struct {
	sessionID           string
	provider            string
	executionAccountRef string
	projectPath         string
	state               string
	runtimeBinding      map[string]any
	nativeSessionID     string
	capabilitySnapshot  map[string]any
	policy              map[string]any
	now                 int64
}

func (r *SessionRepository) Create(ctx context.Context, input CreateSessionInput) (*Session, error) {
	res, err := r.persist(ctx, input, false)
	if err != nil {
		return nil, err
	}
	return res.Session, nil
}

func (r *SessionRepository) Resolve(ctx context.Context, input CreateSessionInput) (*ResolveSessionResult, error) {
	return r.persist(ctx, input, true)
}

func (r *SessionRepository) persist(ctx context.Context, input CreateSessionInput, allowAdoption bool) (*ResolveSessionResult, error) {
	draft, err := r.buildDraft(input)
	if err != nil {
		return nil, err
	}
	var out *ResolveSessionResult
	err = r.db.withTx(ctx, func(tx *sql.Tx) error {
		if allowAdoption && draft.nativeSessionID != "" {
			existing, err := r.findByNativeIdentityTx(ctx, tx, draft.provider, draft.nativeSessionID)
			if err != nil {
				return err
			}
			if existing != nil {
				out = &ResolveSessionResult{Status: "adopted", Session: existing}
				return nil
			}
		}
		created, err := r.insertInTx(ctx, tx, draft)
		if err != nil {
			return err
		}
		out = &ResolveSessionResult{Status: "created", Session: created}
		return nil
	})
	if err != nil {
		return nil, mapSessionCreateError(err, draft.sessionID)
	}
	return out, nil
}

func (r *SessionRepository) createInTx(ctx context.Context, tx *sql.Tx, input CreateSessionInput) (*Session, error) {
	draft, err := r.buildDraft(input)
	if err != nil {
		return nil, err
	}
	created, err := r.insertInTx(ctx, tx, draft)
	if err != nil {
		return nil, mapSessionCreateError(err, draft.sessionID)
	}
	return created, nil
}

func (r *SessionRepository) buildDraft(input CreateSessionInput) (*sessionDraft, error) {
	state := strings.TrimSpace(input.State)
	if state == "" {
		state = "idle"
	}
	validState, err := validateSessionStorageState(state)
	if err != nil {
		return nil, err
	}
	provider, err := RequiredText(input.Provider, "chat_session_provider_required")
	if err != nil {
		return nil, err
	}
	execRef, err := RequiredText(input.ExecutionAccountRef, "chat_session_execution_account_required")
	if err != nil {
		return nil, err
	}
	sessionID := strings.TrimSpace(input.SessionID)
	if sessionID == "" {
		sessionID = r.idFactory("session")
	}
	binding := CloneMap(input.RuntimeBinding)
	nativeID := strings.TrimSpace(input.NativeSessionID)
	if nativeID == "" {
		nativeID = strings.TrimSpace(asString(binding["nativeSessionId"]))
	} else {
		binding["nativeSessionId"] = nativeID
	}
	return &sessionDraft{
		sessionID:           sessionID,
		provider:            provider,
		executionAccountRef: execRef,
		projectPath:         strings.TrimSpace(input.ProjectPath),
		state:               validState,
		runtimeBinding:      binding,
		nativeSessionID:     nativeID,
		capabilitySnapshot:  CloneMap(input.CapabilitySnapshot),
		policy:              CloneMap(input.Policy),
		now:                 r.db.clock(),
	}, nil
}

func (r *SessionRepository) insertInTx(ctx context.Context, tx *sql.Tx, draft *sessionDraft) (*Session, error) {
	bindingText, err := CanonicalJSON(draft.runtimeBinding)
	if err != nil {
		return nil, err
	}
	capText, err := CanonicalJSON(draft.capabilitySnapshot)
	if err != nil {
		return nil, err
	}
	policyText, err := CanonicalJSON(draft.policy)
	if err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO chat_runtime_sessions (
			session_id, provider, execution_account_ref, project_path, state, runtime_binding_json,
			capability_snapshot_json, policy_json, active_turn_json,
			last_event_seq, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)
	`, draft.sessionID, draft.provider, draft.executionAccountRef, draft.projectPath, draft.state,
		bindingText, capText, policyText, draft.now, draft.now); err != nil {
		return nil, err
	}
	_, err = r.events.appendInTx(ctx, tx, draft.sessionID, EventDraft{
		Type:   "session.created",
		Source: runtimeEventSource(draft.provider, draft.runtimeBinding),
		Payload: map[string]any{
			"sessionId":   draft.sessionID,
			"state":       draft.state,
			"projectPath": draft.projectPath,
		},
	}, false, nil)
	if err != nil {
		return nil, err
	}
	return r.getTx(ctx, tx, draft.sessionID)
}

func (r *SessionRepository) FindByNativeIdentity(ctx context.Context, provider, nativeSessionID string) (*Session, error) {
	prov, err := RequiredText(provider, "chat_session_provider_required")
	if err != nil {
		return nil, err
	}
	nat := strings.TrimSpace(nativeSessionID)
	if nat == "" {
		return nil, nil
	}
	var out *Session
	err = r.db.withRead(ctx, func(db *sql.DB) error {
		row := db.QueryRowContext(ctx, fmt.Sprintf(`
			SELECT session_id, provider, execution_account_ref, project_path, state, runtime_binding_json,
			       capability_snapshot_json, policy_json, active_turn_json, last_event_seq, created_at, updated_at
			FROM chat_runtime_sessions
			WHERE provider = ? AND %s = ?
			ORDER BY updated_at DESC, session_id LIMIT 1
		`, nativeSessionIDExpr), prov, nat)
		var scanErr error
		out, scanErr = scanSessionRow(row)
		return scanErr
	})
	return out, err
}

func (r *SessionRepository) findByNativeIdentityTx(ctx context.Context, tx *sql.Tx, provider, nativeSessionID string) (*Session, error) {
	row := tx.QueryRowContext(ctx, fmt.Sprintf(`
		SELECT session_id, provider, execution_account_ref, project_path, state, runtime_binding_json,
		       capability_snapshot_json, policy_json, active_turn_json, last_event_seq, created_at, updated_at
		FROM chat_runtime_sessions
		WHERE provider = ? AND %s = ?
		ORDER BY updated_at DESC, session_id LIMIT 1
	`, nativeSessionIDExpr), provider, nativeSessionID)
	return scanSessionRow(row)
}

func (r *SessionRepository) Get(ctx context.Context, sessionID string) (*Session, error) {
	id, err := RequiredText(sessionID, "chat_session_id_required")
	if err != nil {
		return nil, err
	}
	var out *Session
	err = r.db.withRead(ctx, func(db *sql.DB) error {
		out, err = scanSessionRow(querySessionByID(ctx, db, id))
		return err
	})
	return out, err
}

func (r *SessionRepository) Require(ctx context.Context, sessionID string) (*Session, error) {
	sess, err := r.Get(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	if sess == nil {
		return nil, NewError("chat_session_not_found", http.StatusNotFound, nil)
	}
	return sess, nil
}

func (r *SessionRepository) requireTx(ctx context.Context, tx *sql.Tx, sessionID string) (*Session, error) {
	id, err := RequiredText(sessionID, "chat_session_id_required")
	if err != nil {
		return nil, err
	}
	sess, err := scanSessionRow(querySessionByID(ctx, tx, id))
	if err != nil {
		return nil, err
	}
	if sess == nil {
		return nil, NewError("chat_session_not_found", http.StatusNotFound, nil)
	}
	return sess, nil
}

func (r *SessionRepository) getTx(ctx context.Context, tx *sql.Tx, sessionID string) (*Session, error) {
	return scanSessionRow(querySessionByID(ctx, tx, sessionID))
}

func (r *SessionRepository) List(ctx context.Context, filter ListSessionsFilter) ([]Session, error) {
	var clauses []string
	var args []any
	addEq := func(col, val string) bool {
		t := strings.TrimSpace(val)
		if t == "" {
			return false
		}
		clauses = append(clauses, col+" = ?")
		args = append(args, t)
		return true
	}
	addEq("provider", filter.Provider)
	if filter.ChatOnly {
		clauses = append(clauses, "project_path = ''")
	}
	addEq("execution_account_ref", filter.ExecutionAccountRef)
	addEq("project_path", filter.ProjectPath)
	hasExactNative := addEq(nativeSessionIDExpr, filter.NativeSessionID)

	where := ""
	if len(clauses) > 0 {
		where = "WHERE " + strings.Join(clauses, " AND ")
	}
	limit := defaultSessionListLimit
	if hasExactNative {
		limit = 1
	} else if filter.Limit > 0 {
		limit = min(maxSessionListLimit, max(1, filter.Limit))
	}
	args = append(args, limit)

	var out []Session
	err := r.db.withRead(ctx, func(db *sql.DB) error {
		rows, err := db.QueryContext(ctx, fmt.Sprintf(`
			SELECT session_id, provider, execution_account_ref, project_path, state, runtime_binding_json,
			       capability_snapshot_json, policy_json, active_turn_json, last_event_seq, created_at, updated_at
			FROM chat_runtime_sessions %s ORDER BY updated_at DESC, session_id LIMIT ?
		`, where), args...)
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

func (r *SessionRepository) Delete(ctx context.Context, sessionID string) (*Session, []string, error) {
	var deleted *Session
	var paths []string
	err := r.db.withTx(ctx, func(tx *sql.Tx) error {
		sess, err := r.requireTx(ctx, tx, sessionID)
		if err != nil {
			return err
		}
		rows, err := tx.QueryContext(ctx, `SELECT file_path FROM chat_runtime_attachments WHERE session_id = ?`, sess.SessionID)
		if err != nil {
			return err
		}
		for rows.Next() {
			var p string
			if err := rows.Scan(&p); err != nil {
				_ = rows.Close()
				return err
			}
			if t := strings.TrimSpace(p); t != "" {
				paths = append(paths, t)
			}
		}
		_ = rows.Close()
		if _, err := tx.ExecContext(ctx, `DELETE FROM chat_runtime_sessions WHERE session_id = ?`, sess.SessionID); err != nil {
			return err
		}
		deleted = sess
		return nil
	})
	return deleted, paths, err
}

func (r *SessionRepository) UpdateRuntimeBinding(ctx context.Context, sessionID string, patch map[string]any, replacement *NativeThreadReplacement) (*Session, error) {
	var updated *Session
	err := r.db.withTx(ctx, func(tx *sql.Tx) error {
		sess, err := r.requireTx(ctx, tx, sessionID)
		if err != nil {
			return err
		}
		binding := CloneMap(sess.RuntimeBinding)
		for k, v := range patch {
			binding[k] = cloneAny(v)
		}
		if replacement != nil {
			nextNative := strings.TrimSpace(asString(patch["nativeSessionId"]))
			curNative := strings.TrimSpace(asString(sess.RuntimeBinding["nativeSessionId"]))
			if sess.ActiveTurn == nil ||
				sess.ActiveTurn.RunID != replacement.RunID ||
				sess.ActiveTurn.NativeTurnID != replacement.NativeTurnID ||
				curNative != replacement.ThreadID ||
				nextNative == "" || nextNative == replacement.ThreadID {
				return NewError("chat_native_thread_replacement_stale", http.StatusConflict, nil)
			}
			cp := CloneActiveTurn(sess.ActiveTurn)
			cp.NativeTurnID = ""
			if err := r.updateStateTx(ctx, tx, sess.SessionID, sess.State, cp); err != nil {
				return err
			}
		}
		bindingText, err := CanonicalJSON(binding)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE chat_runtime_sessions SET runtime_binding_json = ?, updated_at = ? WHERE session_id = ?
		`, bindingText, r.db.clock(), sess.SessionID); err != nil {
			return err
		}
		evType := "session.runtime.bound"
		if strings.TrimSpace(asString(sess.RuntimeBinding["nativeSessionId"])) != "" {
			evType = "session.runtime.rebound"
		}
		if _, err := r.events.appendInTx(ctx, tx, sess.SessionID, EventDraft{
			Type:    evType,
			Source:  runtimeEventSource(sess.Provider, binding),
			Payload: map[string]any{"runtimeBinding": binding},
		}, false, nil); err != nil {
			return err
		}
		updated, err = r.requireTx(ctx, tx, sess.SessionID)
		return err
	})
	return updated, err
}

func (r *SessionRepository) UpdateExecutionContext(ctx context.Context, sessionID, execAccountRef string, runtimeBinding, capSnapshot map[string]any) (*Session, error) {
	ref, err := RequiredText(execAccountRef, "chat_session_execution_account_required")
	if err != nil {
		return nil, err
	}
	var updated *Session
	err = r.db.withTx(ctx, func(tx *sql.Tx) error {
		sess, err := r.requireTx(ctx, tx, sessionID)
		if err != nil {
			return err
		}
		binding := CloneMap(sess.RuntimeBinding)
		if runtimeBinding != nil {
			binding = CloneMap(runtimeBinding)
		}
		caps := CloneMap(sess.CapabilitySnapshot)
		if capSnapshot != nil {
			caps = CloneMap(capSnapshot)
		}
		bText, err := CanonicalJSON(binding)
		if err != nil {
			return err
		}
		cText, err := CanonicalJSON(caps)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE chat_runtime_sessions
			SET execution_account_ref = ?, runtime_binding_json = ?, capability_snapshot_json = ?, updated_at = ?
			WHERE session_id = ?
		`, ref, bText, cText, r.db.clock(), sess.SessionID); err != nil {
			return err
		}
		if _, err := r.events.appendInTx(ctx, tx, sess.SessionID, EventDraft{
			Type:    "session.runtime.rebound",
			Source:  runtimeEventSource(sess.Provider, binding),
			Payload: map[string]any{"runtimeBinding": binding},
		}, false, nil); err != nil {
			return err
		}
		updated, err = r.requireTx(ctx, tx, sess.SessionID)
		return err
	})
	return updated, err
}

func (r *SessionRepository) UpdateCapabilitySnapshot(ctx context.Context, sessionID string, caps map[string]any) (*Session, error) {
	var updated *Session
	snapText, err := CanonicalJSON(CloneMap(caps))
	if err != nil {
		return nil, err
	}
	err = r.db.withTx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, `UPDATE chat_runtime_sessions SET capability_snapshot_json = ? WHERE session_id = ?`, snapText, sessionID)
		if err != nil {
			return err
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			return NewError("chat_session_not_found", http.StatusNotFound, nil)
		}
		updated, err = r.requireTx(ctx, tx, sessionID)
		return err
	})
	return updated, err
}

func (r *SessionRepository) UpdatePolicy(ctx context.Context, sessionID string, patch map[string]any) (*Session, error) {
	var updated *Session
	err := r.db.withTx(ctx, func(tx *sql.Tx) error {
		var err error
		updated, err = r.updatePolicyInTx(ctx, tx, sessionID, patch)
		return err
	})
	return updated, err
}

func (r *SessionRepository) updatePolicyInTx(ctx context.Context, tx *sql.Tx, sessionID string, patch map[string]any) (*Session, error) {
	sess, err := r.requireTx(ctx, tx, sessionID)
	if err != nil {
		return nil, err
	}
	policy := CloneMap(sess.Policy)
	for k, v := range patch {
		policy[k] = cloneAny(v)
	}
	policyText, err := CanonicalJSON(policy)
	if err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE chat_runtime_sessions SET policy_json = ?, updated_at = ? WHERE session_id = ?
	`, policyText, r.db.clock(), sess.SessionID); err != nil {
		return nil, err
	}
	if _, err := r.events.appendInTx(ctx, tx, sess.SessionID, EventDraft{
		Type:    "session.policy.changed",
		Source:  runtimeEventSource(sess.Provider, sess.RuntimeBinding),
		Payload: map[string]any{"policy": policy},
	}, false, nil); err != nil {
		return nil, err
	}
	return r.requireTx(ctx, tx, sess.SessionID)
}

func (r *SessionRepository) UpdateState(ctx context.Context, sessionID, state string, activeTurn *ActiveTurn) (*Session, error) {
	var updated *Session
	err := r.db.withTx(ctx, func(tx *sql.Tx) error {
		if err := r.updateStateTx(ctx, tx, sessionID, state, activeTurn); err != nil {
			return err
		}
		var err error
		updated, err = r.requireTx(ctx, tx, sessionID)
		return err
	})
	return updated, err
}

func (r *SessionRepository) updateStateTx(ctx context.Context, tx *sql.Tx, sessionID, state string, activeTurn *ActiveTurn) error {
	validState, err := validateSessionStorageState(state)
	if err != nil {
		return err
	}
	var activeTurnParam sql.NullString
	if activeTurn != nil {
		text, err := CanonicalJSON(activeTurn)
		if err != nil {
			return err
		}
		activeTurnParam = sql.NullString{String: text, Valid: true}
	}
	res, err := tx.ExecContext(ctx, `
		UPDATE chat_runtime_sessions SET state = ?, active_turn_json = ?, updated_at = ? WHERE session_id = ?
	`, validState, activeTurnParam, r.db.clock(), sessionID)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return NewError("chat_session_not_found", http.StatusNotFound, nil)
	}
	return nil
}

func (r *SessionRepository) UpdateActiveTurnAnchor(ctx context.Context, sessionID, runID, nativeTurnID, clientUserMsgID string) (*Session, error) {
	rID, err := RequiredText(runID, "chat_run_id_required")
	if err != nil {
		return nil, err
	}
	nTurnID, err := RequiredText(nativeTurnID, "chat_native_turn_id_required")
	if err != nil {
		return nil, err
	}
	cMsgID, err := RequiredText(clientUserMsgID, "chat_client_user_message_id_required")
	if err != nil {
		return nil, err
	}
	var updated *Session
	err = r.db.withTx(ctx, func(tx *sql.Tx) error {
		sess, err := r.requireTx(ctx, tx, sessionID)
		if err != nil {
			return err
		}
		if sess.ActiveTurn == nil || sess.ActiveTurn.RunID != rID {
			return NewError("chat_turn_anchor_stale", http.StatusConflict, nil)
		}
		if sess.ActiveTurn.ClientUserMessageID != "" && sess.ActiveTurn.ClientUserMessageID != cMsgID {
			return NewError("chat_client_user_message_anchor_conflict", http.StatusConflict, nil)
		}
		if sess.ActiveTurn.NativeTurnID != "" && sess.ActiveTurn.NativeTurnID != nTurnID {
			return NewError("chat_native_turn_anchor_conflict", http.StatusConflict, nil)
		}
		nextTurn := CloneActiveTurn(sess.ActiveTurn)
		nextTurn.ClientUserMessageID = cMsgID
		nextTurn.NativeTurnID = nTurnID
		if err := r.updateStateTx(ctx, tx, sess.SessionID, sess.State, nextTurn); err != nil {
			return err
		}
		updated, err = r.requireTx(ctx, tx, sess.SessionID)
		return err
	})
	return updated, err
}

type rowQuerier interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

type rowScanner interface {
	Scan(dest ...any) error
}

func querySessionByID(ctx context.Context, q rowQuerier, id string) *sql.Row {
	return q.QueryRowContext(ctx, `
		SELECT session_id, provider, execution_account_ref, project_path, state, runtime_binding_json,
		       capability_snapshot_json, policy_json, active_turn_json, last_event_seq, created_at, updated_at
		FROM chat_runtime_sessions WHERE session_id = ?
	`, id)
}

func scanSessionRow(scanner rowScanner) (*Session, error) {
	var (
		sess           Session
		bindingJSON    string
		capJSON        string
		policyJSON     string
		activeTurnJSON sql.NullString
	)
	err := scanner.Scan(
		&sess.SessionID,
		&sess.Provider,
		&sess.ExecutionAccountRef,
		&sess.ProjectPath,
		&sess.State,
		&bindingJSON,
		&capJSON,
		&policyJSON,
		&activeTurnJSON,
		&sess.LastEventSeq,
		&sess.CreatedAt,
		&sess.UpdatedAt,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	sess.RuntimeBinding = parseJSONObject(bindingJSON)
	sess.CapabilitySnapshot = parseJSONObject(capJSON)
	sess.Policy = parseJSONObject(policyJSON)
	if activeTurnJSON.Valid && strings.TrimSpace(activeTurnJSON.String) != "" {
		var at ActiveTurn
		if err := json.Unmarshal([]byte(activeTurnJSON.String), &at); err != nil {
			return nil, err
		}
		sess.ActiveTurn = &at
	}
	return &sess, nil
}

func parseJSONObject(raw string) map[string]any {
	if strings.TrimSpace(raw) == "" {
		return map[string]any{}
	}
	var out map[string]any
	if err := json.Unmarshal([]byte(raw), &out); err != nil || out == nil {
		return map[string]any{}
	}
	return out
}

func validateSessionStorageState(state string) (string, error) {
	if _, ok := ValidSessionStates[state]; !ok {
		return "", NewError("invalid_chat_session_state", http.StatusConflict, map[string]any{"state": state})
	}
	return state, nil
}

func mapSessionCreateError(err error, sessionID string) error {
	if err == nil {
		return nil
	}
	if _, ok := AsRuntimeError(err); ok {
		return err
	}
	msg := err.Error()
	if strings.Contains(strings.ToUpper(msg), "CONSTRAINT") {
		return NewError("chat_session_id_conflict", http.StatusConflict, map[string]any{"sessionId": sessionID})
	}
	return err
}

func runtimeEventSource(provider string, binding map[string]any) EventSource {
	p := strings.TrimSpace(provider)
	if p == "" {
		p = "unknown"
	}
	rID := strings.TrimSpace(asString(binding["runtimeId"]))
	if rID == "" {
		rID = "unbound"
	}
	return EventSource{Provider: p, RuntimeID: rID}
}

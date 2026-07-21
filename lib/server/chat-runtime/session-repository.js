'use strict';

const { ChatRuntimeError, SESSION_STATES } = require('./contracts');
const { withTransaction } = require('./database');
const { jsonText, mapSession, requiredText } = require('./storage-utils');

const DEFAULT_SESSION_LIST_LIMIT = 100;
const MAX_SESSION_LIST_LIMIT = 500;
const NATIVE_SESSION_ID_EXPRESSION = `NULLIF(TRIM(CAST(json_extract(
  runtime_binding_json, '$.nativeSessionId'
) AS TEXT)), '')`;

class SessionRepository {
  constructor(context, events) {
    this.context = context;
    this.events = events;
  }

  create(input = {}) { return this.persist(input, false).session; }

  resolve(input = {}) { return this.persist(input, true); }

  persist(input, allowAdoption) {
    const draft = sessionDraft(input, this.context);
    try {
      return withTransaction(this.context.db, () => {
        const existing = allowAdoption && draft.nativeSessionId
          ? this.findByNativeIdentity(draft)
          : null;
        return existing
          ? { status: 'adopted', session: existing }
          : { status: 'created', session: this.insertInTransaction(draft) };
      });
    } catch (error) {
      throw mapCreateError(error, draft.sessionId);
    }
  }

  findByNativeIdentity(input = {}) {
    const provider = requiredText(input.provider, 'chat_session_provider_required');
    const nativeSessionId = nativeId(input);
    if (!nativeSessionId) return null;
    return mapSession(this.context.db.prepare(`
      SELECT * FROM chat_runtime_sessions
      WHERE provider = ?
        AND NULLIF(TRIM(CAST(json_extract(
          runtime_binding_json, '$.nativeSessionId'
        ) AS TEXT)), '') = ?
      ORDER BY updated_at DESC, session_id
      LIMIT 1
    `).get(provider, nativeSessionId));
  }

  insertInTransaction(draft) {
    this.context.db.prepare(`
      INSERT INTO chat_runtime_sessions (
        session_id, provider, execution_account_ref, project_path, state, runtime_binding_json,
        capability_snapshot_json, policy_json, active_turn_json,
        last_event_seq, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)
    `).run(
      draft.sessionId, draft.provider, draft.executionAccountRef, draft.projectPath, draft.state,
      jsonText(draft.runtimeBinding), jsonText(draft.capabilitySnapshot),
      jsonText(draft.policy), draft.now, draft.now
    );
    this.events.appendInTransaction(draft.sessionId, {
      type: 'session.created',
      source: runtimeSource(draft.provider, draft.runtimeBinding),
      payload: {
        sessionId: draft.sessionId, state: draft.state, projectPath: draft.projectPath
      }
    });
    return this.get(draft.sessionId);
  }

  get(sessionId) {
    const id = requiredText(sessionId, 'chat_session_id_required');
    return mapSession(this.context.db.prepare(`
      SELECT * FROM chat_runtime_sessions WHERE session_id = ?
    `).get(id));
  }

  list(filters = {}) {
    const clauses = [];
    const values = [];
    addFilter(clauses, values, 'provider', filters.provider);
    addFilter(clauses, values, 'project_path', filters.projectPath);
    const hasExactNativeIdentity = addFilter(
      clauses,
      values,
      NATIVE_SESSION_ID_EXPRESSION,
      filters.nativeSessionId
    );
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = sessionListLimit(filters.limit, hasExactNativeIdentity);
    return this.context.db.prepare(`
      SELECT * FROM chat_runtime_sessions ${where}
      ORDER BY updated_at DESC, session_id LIMIT ?
    `).all(...values, limit).map(mapSession);
  }

  require(sessionId) {
    const session = this.get(sessionId);
    if (!session) throw new ChatRuntimeError('chat_session_not_found', 404);
    return session;
  }

  updateRuntimeBinding(sessionId, patch = {}) {
    return withTransaction(this.context.db, () => {
      const session = this.require(sessionId);
      const runtimeBinding = { ...session.runtimeBinding, ...structuredClone(patch) };
      this.context.db.prepare(`
        UPDATE chat_runtime_sessions
        SET runtime_binding_json = ?, updated_at = ? WHERE session_id = ?
      `).run(jsonText(runtimeBinding), this.context.clock(), session.sessionId);
      this.events.appendInTransaction(session.sessionId, {
        type: session.runtimeBinding.nativeSessionId
          ? 'session.runtime.rebound'
          : 'session.runtime.bound',
        source: runtimeSource(session.provider, runtimeBinding),
        payload: { runtimeBinding }
      });
      return this.require(session.sessionId);
    });
  }

  updateExecutionContext(sessionId, input = {}) {
    const executionAccountRef = requiredText(
      input.executionAccountRef,
      'chat_session_execution_account_required'
    );
    return withTransaction(this.context.db, () => {
      const session = this.require(sessionId);
      const runtimeBinding = input.runtimeBinding
        ? structuredClone(input.runtimeBinding)
        : session.runtimeBinding;
      const capabilitySnapshot = input.capabilitySnapshot
        ? structuredClone(input.capabilitySnapshot)
        : session.capabilitySnapshot;
      this.context.db.prepare(`
        UPDATE chat_runtime_sessions
        SET execution_account_ref = ?, runtime_binding_json = ?,
            capability_snapshot_json = ?, updated_at = ?
        WHERE session_id = ?
      `).run(
        executionAccountRef,
        jsonText(runtimeBinding),
        jsonText(capabilitySnapshot),
        this.context.clock(),
        session.sessionId
      );
      this.events.appendInTransaction(session.sessionId, {
        type: 'session.runtime.rebound',
        source: runtimeSource(session.provider, runtimeBinding),
        payload: { runtimeBinding }
      });
      return this.require(session.sessionId);
    });
  }

  updatePolicy(sessionId, patch = {}) {
    return withTransaction(this.context.db, () => {
      const session = this.require(sessionId);
      const policy = { ...session.policy, ...structuredClone(patch) };
      this.context.db.prepare(`
        UPDATE chat_runtime_sessions
        SET policy_json = ?, updated_at = ? WHERE session_id = ?
      `).run(jsonText(policy), this.context.clock(), session.sessionId);
      this.events.appendInTransaction(session.sessionId, {
        type: 'session.policy.changed',
        source: runtimeSource(session.provider, session.runtimeBinding),
        payload: { policy }
      });
      return this.require(session.sessionId);
    });
  }

  updateState(sessionId, state, activeTurn) {
    validateState(state);
    const result = this.context.db.prepare(`
      UPDATE chat_runtime_sessions SET state = ?, active_turn_json = ?, updated_at = ?
      WHERE session_id = ?
    `).run(
      state,
      activeTurn === undefined || activeTurn === null ? null : jsonText(activeTurn),
      this.context.clock(),
      sessionId
    );
    if (!result.changes) throw new ChatRuntimeError('chat_session_not_found', 404);
    return this.require(sessionId);
  }

  updateActiveTurnAnchor(sessionId, input = {}) {
    const session = this.require(sessionId);
    const activeTurn = session.activeTurn;
    const runId = requiredText(input.runId, 'chat_run_id_required');
    const nativeTurnId = requiredText(input.nativeTurnId, 'chat_native_turn_id_required');
    const clientUserMessageId = requiredText(
      input.clientUserMessageId,
      'chat_client_user_message_id_required'
    );
    if (!activeTurn || activeTurn.runId !== runId) {
      throw new ChatRuntimeError('chat_turn_anchor_stale', 409);
    }
    if (
      activeTurn.clientUserMessageId
      && activeTurn.clientUserMessageId !== clientUserMessageId
    ) {
      throw new ChatRuntimeError('chat_client_user_message_anchor_conflict', 409);
    }
    if (activeTurn.nativeTurnId && activeTurn.nativeTurnId !== nativeTurnId) {
      throw new ChatRuntimeError('chat_native_turn_anchor_conflict', 409);
    }
    return this.updateState(sessionId, session.state, {
      ...activeTurn,
      clientUserMessageId,
      nativeTurnId
    });
  }
}

function sessionDraft(input, context) {
  const state = input.state || 'idle';
  validateState(state);
  return {
    sessionId: String(input.sessionId || '').trim() || context.idFactory('session'),
    provider: requiredText(input.provider, 'chat_session_provider_required'),
    executionAccountRef: requiredText(
      input.executionAccountRef,
      'chat_session_execution_account_required'
    ),
    projectPath: String(input.projectPath || '').trim(),
    state,
    runtimeBinding: input.runtimeBinding,
    nativeSessionId: nativeId(input),
    capabilitySnapshot: input.capabilitySnapshot,
    policy: input.policy,
    now: context.clock()
  };
}

function nativeId(input) {
  return String(input.nativeSessionId
    || input.runtimeBinding && input.runtimeBinding.nativeSessionId || '').trim();
}

function mapCreateError(error, sessionId) {
  const detail = `${error && error.code || ''} ${error && error.message || ''}`;
  if (detail.includes('CONSTRAINT') || detail.includes('constraint')) {
    return new ChatRuntimeError('chat_session_id_conflict', 409, { sessionId });
  }
  return error;
}

function runtimeSource(provider, binding = {}) {
  return {
    provider,
    runtimeId: String(binding && binding.runtimeId || 'unbound')
  };
}

function addFilter(clauses, values, column, input) {
  const value = String(input || '').trim();
  if (!value) return false;
  clauses.push(`${column} = ?`);
  values.push(value);
  return true;
}

function sessionListLimit(requestedLimit, hasExactNativeIdentity) {
  if (hasExactNativeIdentity) return 1;
  return Math.min(
    MAX_SESSION_LIST_LIMIT,
    Math.max(1, Number(requestedLimit) || DEFAULT_SESSION_LIST_LIMIT)
  );
}

function validateState(state) {
  if (!SESSION_STATES.has(state)) {
    throw new ChatRuntimeError('invalid_chat_session_state', 409, { state });
  }
}

module.exports = { SessionRepository };

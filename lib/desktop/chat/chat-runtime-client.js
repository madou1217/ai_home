'use strict';

const crypto = require('node:crypto');

const SESSIONS_PATH = '/v0/webui/chat/sessions';

class DesktopChatRuntimeError extends Error {
  constructor(code, statusCode = 0, details, requestId) {
    super(String(code || 'chat_runtime_failed'));
    this.name = 'DesktopChatRuntimeError';
    this.code = String(code || 'chat_runtime_failed');
    this.statusCode = Number.isSafeInteger(statusCode) ? statusCode : 0;
    if (details !== undefined) this.details = details;
    if (requestId !== undefined) this.requestId = requestId;
  }
}

function createDesktopChatRuntimeClient(options = {}) {
  const request = options.fetch;
  const openEvents = options.openEvents;
  if (typeof request !== 'function') throw new TypeError('desktop chat runtime client requires fetch');
  if (typeof openEvents !== 'function') throw new TypeError('desktop chat runtime client requires openEvents');
  const idFactory = typeof options.idFactory === 'function'
    ? options.idFactory
    : () => crypto.randomUUID();
  const streams = new Set();
  const pendingCommands = new Map();
  let closed = false;

  function nextId(kind) {
    const value = idFactory(kind);
    const id = String(value || '').trim();
    if (!id) throw new DesktopChatRuntimeError('chat_runtime_request_id_invalid');
    return id;
  }

  function ensureOpen() {
    if (closed) throw new DesktopChatRuntimeError('chat_runtime_client_closed');
  }

  async function createSession(target) {
    ensureOpen();
    if (!target || typeof target !== 'object' || Array.isArray(target)) {
      throw new DesktopChatRuntimeError('chat_runtime_session_target_invalid');
    }
    const payload = { ...target };
    const response = await requestJson(SESSIONS_PATH, jsonRequest('POST', payload));
    const session = asRecord(response.session, 'chat_runtime_session_invalid');
    return normalizeSession(session);
  }

  function start(sessionId, after = 0) {
    ensureOpen();
    const id = requiredText(sessionId, 'chat_runtime_session_id_invalid');
    const cursor = normalizeCursor(after);
    const requestId = nextId('events');
    const source = openEvents(`${SESSIONS_PATH}/${encodeURIComponent(id)}/events?after=${cursor}`);
    if (!source || typeof source !== 'object') throw new DesktopChatRuntimeError('chat_runtime_event_stream_invalid', 0, undefined, requestId);
    let currentCursor = cursor;
    let streamClosed = false;
    const eventListeners = new Set();
    const errorListeners = new Set();
    const wrapper = {
      sessionId: id,
      requestId,
      get cursor() { return currentCursor; },
      onmessage: null,
      onopen: null,
      onerror: null,
      onEvent(listener) { if (typeof listener === 'function') eventListeners.add(listener); return this; },
      onError(listener) { if (typeof listener === 'function') errorListeners.add(listener); return this; },
      close() {
        if (streamClosed) return;
        streamClosed = true;
        streams.delete(wrapper);
        try { source.close?.(); } catch (_error) { /* best effort */ }
      }
    };
    const emitError = (error) => {
      const normalized = normalizeTransportError(error, requestId);
      if (typeof wrapper.onerror === 'function') wrapper.onerror(normalized);
      for (const listener of errorListeners) listener(normalized);
    };
    source.onopen = (event) => { if (!streamClosed) wrapper.onopen?.(event); };
    source.onerror = (event) => { if (!streamClosed) emitError(event); };
    source.onmessage = (message) => {
      if (streamClosed) return;
      let event;
      try { event = parseEventMessage(message); } catch (error) { emitError(error); return; }
      if (!event || event.sessionId !== id) return;
      if (event.requestId !== undefined && event.requestId !== requestId) return;
      const seq = event.seq;
      // Canonical Chat Runtime events always carry a positive, integral
      // sequence. Transport-only frames are represented by stream errors and
      // never enter this event path, so malformed sequence values are dropped.
      if (!Number.isSafeInteger(seq) || seq <= 0 || seq <= currentCursor) return;
      currentCursor = seq;
      if (typeof wrapper.onmessage === 'function') wrapper.onmessage({ ...message, data: event });
      for (const listener of eventListeners) listener(event);
    };
    streams.add(wrapper);
    return wrapper;
  }

  async function sendTurn(sessionId, text, turnOptions = {}) {
    ensureOpen();
    const id = requiredText(sessionId, 'chat_runtime_session_id_invalid');
    const content = requiredText(text, 'chat_turn_content_required');
    const optionsRecord = turnOptions && typeof turnOptions === 'object' ? turnOptions : {};
    const commandId = requiredText(optionsRecord.commandId || nextId('command'), 'chat_command_id_invalid');
    const requestId = requiredText(optionsRecord.requestId || nextId('request'), 'chat_runtime_request_id_invalid');
    const payload = { ...(optionsRecord.payload && typeof optionsRecord.payload === 'object' ? optionsRecord.payload : {}), content };
    for (const key of ['model', 'reasoningEffort', 'attachmentIds']) {
      if (optionsRecord[key] !== undefined) payload[key] = optionsRecord[key];
    }
    return dispatch(id, commandId, requestId, { type: 'turn.submit', payload });
  }

  async function stopTurn(sessionId, commandId) {
    ensureOpen();
    const id = requiredText(sessionId, 'chat_runtime_session_id_invalid');
    const stopId = requiredText(commandId || nextId('stop'), 'chat_command_id_invalid');
    const requestId = nextId('request');
    return dispatch(id, stopId, requestId, {
      type: 'turn.interrupt', payload: { reason: 'user_stop' }
    });
  }

  function dispatch(sessionId, commandId, requestId, command) {
    const existing = pendingCommands.get(commandId);
    if (existing) {
      if (existing.sessionId !== sessionId || existing.fingerprint !== commandFingerprint(command)) {
        return Promise.reject(new DesktopChatRuntimeError('chat_runtime_command_idempotency_conflict', 409, undefined, requestId));
      }
      return existing.promise;
    }
    const promise = requestJson(`${SESSIONS_PATH}/${encodeURIComponent(sessionId)}/commands`, jsonRequest('POST', {
      requestId, commandId, sessionId, type: command.type, payload: command.payload
    }))
      .then((response) => normalizeCommandResult(response, sessionId, commandId, requestId))
      .finally(() => pendingCommands.delete(commandId));
    pendingCommands.set(commandId, { promise, sessionId, fingerprint: commandFingerprint(command) });
    return promise;
  }

  function close() {
    if (closed) return;
    closed = true;
    for (const stream of [...streams]) stream.close();
    pendingCommands.clear();
  }

  return { createSession, start, sendTurn, stopTurn, close };

  async function requestJson(path, init) {
    let response;
    try {
      response = await request(path, init);
    } catch (_error) {
      throw new DesktopChatRuntimeError('chat_runtime_transport_failed');
    }
    if (!response || typeof response !== 'object') throw new DesktopChatRuntimeError('chat_runtime_response_invalid');
    let payload;
    try { payload = await response.json(); } catch (_error) {
      throw new DesktopChatRuntimeError('chat_runtime_response_json_invalid', Number(response.status) || 0);
    }
    const body = asRecord(payload, 'chat_runtime_response_invalid');
    if (!response.ok) {
      throw new DesktopChatRuntimeError(
        typeof body.error === 'string' && body.error ? body.error : `chat_runtime_http_${response.status}`,
        Number(response.status) || 0,
        body.details,
        body.requestId
      );
    }
    if (body.ok !== true) throw new DesktopChatRuntimeError('chat_runtime_response_not_ok', Number(response.status) || 0, body.details, body.requestId);
    return body;
  }
}

function jsonRequest(method, body) {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function normalizeSession(source) {
  const sessionId = requiredText(source.sessionId, 'chat_runtime_session_id_invalid');
  const state = requiredState(source.state);
  const lastEventSeq = nonNegativeInteger(source.lastEventSeq, 'chat_runtime_session_seq_invalid');
  const createdAt = nonNegativeInteger(source.createdAt, 'chat_runtime_session_created_at_invalid');
  const updatedAt = nonNegativeInteger(source.updatedAt, 'chat_runtime_session_updated_at_invalid');
  const policy = asRecord(source.policy, 'chat_runtime_session_policy_invalid');
  const runtimeBinding = asRecord(source.runtimeBinding, 'chat_runtime_session_binding_invalid');
  const capabilitySnapshot = asRecord(source.capabilitySnapshot, 'chat_runtime_capabilities_invalid');
  return {
    ...source,
    sessionId,
    provider: requiredText(source.provider, 'chat_runtime_session_provider_invalid'),
    executionAccountRef: requiredText(source.executionAccountRef, 'chat_runtime_session_execution_account_invalid'),
    projectPath: typeof source.projectPath === 'string' ? source.projectPath : '',
    state,
    lastEventSeq,
    createdAt,
    updatedAt,
    policy,
    runtimeBinding,
    capabilitySnapshot
  };
}

function normalizeCommandResult(source, sessionId, commandId, requestId) {
  if (source.requestId !== undefined && source.requestId !== requestId) {
    throw new DesktopChatRuntimeError('chat_runtime_request_mismatch', 0, undefined, requestId);
  }
  if (source.sessionId !== sessionId) throw new DesktopChatRuntimeError('chat_runtime_session_mismatch', 0, undefined, requestId);
  if (source.commandId !== commandId) throw new DesktopChatRuntimeError('chat_runtime_command_mismatch', 0, undefined, requestId);
  if (!Number.isSafeInteger(source.acceptedSeq) || source.acceptedSeq < 0) throw new DesktopChatRuntimeError('chat_runtime_command_seq_invalid', 0, undefined, requestId);
  if (typeof source.duplicate !== 'boolean') throw new DesktopChatRuntimeError('chat_runtime_command_duplicate_invalid', 0, undefined, requestId);
  return { sessionId, commandId, acceptedSeq: source.acceptedSeq, duplicate: source.duplicate,
    ...(source.result === undefined ? {} : { result: source.result }), requestId };
}

function commandFingerprint(command) {
  return JSON.stringify([command.type, command.payload]);
}

function parseEventMessage(message) {
  const data = message && Object.prototype.hasOwnProperty.call(message, 'data') ? message.data : message;
  if (typeof data === 'string') {
    try { return JSON.parse(data); } catch (_error) { throw new DesktopChatRuntimeError('chat_runtime_event_json_invalid'); }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new DesktopChatRuntimeError('chat_runtime_event_invalid');
  return data;
}

function normalizeTransportError(error, requestId) {
  if (error instanceof DesktopChatRuntimeError) return error;
  const code = String(error && error.code || 'chat_runtime_event_stream_failed');
  return new DesktopChatRuntimeError(code, Number(error && error.statusCode) || 0, undefined, requestId);
}

function normalizeCursor(value) {
  const cursor = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new DesktopChatRuntimeError('chat_runtime_event_cursor_invalid');
  return cursor;
}

const SESSION_STATES = new Set([
  'idle', 'starting', 'running', 'waiting_input', 'interrupting',
  'completing', 'recovering', 'closed'
]);

function requiredState(value) {
  const state = requiredText(value, 'chat_runtime_state_invalid');
  if (!SESSION_STATES.has(state)) throw new DesktopChatRuntimeError('chat_runtime_state_invalid');
  return state;
}

function nonNegativeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) throw new DesktopChatRuntimeError(code);
  return value;
}

function requiredText(value, code) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new DesktopChatRuntimeError(code);
  return text;
}

function asRecord(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DesktopChatRuntimeError(code);
  return value;
}

module.exports = {
  SESSIONS_PATH,
  DesktopChatRuntimeError,
  createDesktopChatRuntimeClient
};

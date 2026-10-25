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
      try { event = parseEventMessage(message, id); } catch (error) { emitError(error); return; }
      if (!event) return;
      if (event.requestId !== undefined && event.requestId !== requestId) return;
      const seq = event.seq;
      if (seq > 0 && seq <= currentCursor) return;
      if (seq > 0) currentCursor = seq;
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
  const capabilitySnapshot = normalizeCapabilitySnapshot(source.capabilitySnapshot);
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

function parseEventMessage(message, sessionId) {
  const data = message && Object.prototype.hasOwnProperty.call(message, 'data') ? message.data : message;
  let value;
  if (typeof data === 'string') {
    try { value = JSON.parse(data); } catch (_error) { throw new DesktopChatRuntimeError('chat_runtime_event_json_invalid'); }
  } else {
    value = data;
  }
  return normalizeRuntimeEvent(value, sessionId);
}

const CHAT_RUNTIME_EVENT_SCHEMA = 'aih.chat.event.v1';
const EVENT_TYPES = new Set([
  'session.created', 'session.runtime.bound', 'session.runtime.rebound',
  'session.policy.changed', 'session.closed', 'session.snapshot.reset',
  'session.goal.updated', 'session.goal.cleared', 'turn.queued', 'turn.started',
  'turn.phase.changed', 'turn.interrupt.requested', 'turn.metrics.updated',
  'turn.interrupted', 'turn.completed', 'turn.failed', 'queue.item.added',
  'queue.item.updated', 'queue.item.moved', 'queue.item.removed',
  'queue.item.dispatched', 'timeline.item.started', 'timeline.item.delta',
  'timeline.item.updated', 'timeline.item.completed', 'interaction.requested',
  'interaction.updated', 'interaction.resolved', 'interaction.expired',
  'run.detached', 'run.reattached', 'run.adopted', 'run.lost',
  'runtime.prewarm.started', 'runtime.prewarm.ready', 'runtime.prewarm.failed',
  'stream.error'
]);

function normalizeRuntimeEvent(value, sessionId) {
  const event = asRecord(value, 'chat_runtime_event_invalid');
  if (event.schema !== CHAT_RUNTIME_EVENT_SCHEMA) throw new DesktopChatRuntimeError('chat_runtime_event_schema_invalid');
  const type = requiredText(event.type, 'chat_runtime_event_type_invalid');
  if (!EVENT_TYPES.has(type)) throw new DesktopChatRuntimeError('chat_runtime_event_type_invalid');
  if (requiredText(event.sessionId, 'chat_runtime_session_id_invalid') !== sessionId) return null;
  requiredText(event.eventId, 'chat_runtime_event_id_invalid');
  nonNegativeInteger(event.at, 'chat_runtime_event_at_invalid');
  const source = asRecord(event.source, 'chat_runtime_event_source_invalid');
  requiredText(source.provider, 'chat_runtime_event_provider_invalid');
  requiredText(source.runtimeId, 'chat_runtime_event_runtime_id_invalid');
  const payload = asRecord(event.payload, 'chat_runtime_event_payload_invalid');
  const seq = type === 'stream.error' || type === 'session.snapshot.reset'
    ? nonNegativeInteger(event.seq, 'chat_runtime_event_seq_invalid')
    : positiveInteger(event.seq, 'chat_runtime_event_seq_invalid');
  if (type === 'session.snapshot.reset' && payload.throughSeq !== seq) {
    throw new DesktopChatRuntimeError('chat_runtime_snapshot_cursor_mismatch');
  }
  return { ...event, type, seq, payload };
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

function positiveInteger(value, code) {
  const number = nonNegativeInteger(value, code);
  if (number === 0) throw new DesktopChatRuntimeError(code);
  return number;
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

const CAPABILITY_NAMES = new Set([
  'session.resume', 'timeline.reasoning', 'timeline.tool', 'timeline.diff',
  'mode.plan', 'interaction.question', 'interaction.approval',
  'interaction.plan_confirmation', 'turn.interrupt', 'turn.steer.current',
  'turn.steer.tool_boundary', 'turn.queue', 'slash.execute', 'terminal.stream',
  'run.adopt', 'session.goal'
]);
const CAPABILITY_SUPPORT = new Set(['native', 'emulated', 'unsupported', 'unknown']);
const CAPABILITY_FIELDS = new Set(['revision', 'capturedAt', 'capabilities', 'slashCommands', 'turnInterveneModes']);
const DESCRIPTOR_FIELDS = new Set(['support', 'reason', 'alternatives']);

function normalizeCapabilitySnapshot(value) {
  const source = asRecord(value, 'chat_runtime_capabilities_invalid');
  rejectUnknownFields(source, CAPABILITY_FIELDS, 'chat_runtime_capabilities_shape_invalid');
  const result = {};
  if (source.revision !== undefined) result.revision = requiredText(source.revision, 'chat_runtime_capabilities_revision_invalid');
  if (source.capturedAt !== undefined) result.capturedAt = nonNegativeInteger(source.capturedAt, 'chat_runtime_capabilities_captured_at_invalid');
  if (source.capabilities !== undefined) {
    const capabilities = asRecord(source.capabilities, 'chat_runtime_capability_map_invalid');
    const normalizedCapabilities = {};
    for (const [name, descriptor] of Object.entries(capabilities)) {
      if (!CAPABILITY_NAMES.has(name)) throw new DesktopChatRuntimeError('chat_runtime_capability_name_invalid');
      normalizedCapabilities[name] = normalizeCapabilityDescriptor(descriptor);
    }
    result.capabilities = normalizedCapabilities;
  }
  for (const key of ['slashCommands', 'turnInterveneModes']) {
    if (source[key] === undefined) continue;
    if (!Array.isArray(source[key])) throw new DesktopChatRuntimeError(`chat_runtime_capability_${key === 'slashCommands' ? 'slash_commands' : 'turn_intervene_modes'}_invalid`);
    const code = key === 'slashCommands'
      ? 'chat_runtime_capability_slash_commands_invalid'
      : 'chat_runtime_capability_turn_intervene_modes_invalid';
    result[key] = source[key].map((entry) => requiredText(entry, code));
  }
  return result;
}

function normalizeCapabilityDescriptor(value) {
  const source = asRecord(value, 'chat_runtime_capability_descriptor_invalid');
  rejectUnknownFields(source, DESCRIPTOR_FIELDS, 'chat_runtime_capability_descriptor_shape_invalid');
  const support = requiredText(source.support, 'chat_runtime_capability_support_invalid');
  if (!CAPABILITY_SUPPORT.has(support)) throw new DesktopChatRuntimeError('chat_runtime_capability_support_invalid');
  const descriptor = { support };
  if (source.reason !== undefined) descriptor.reason = requiredText(source.reason, 'chat_runtime_capability_reason_invalid');
  if (source.alternatives !== undefined) {
    if (!Array.isArray(source.alternatives)) throw new DesktopChatRuntimeError('chat_runtime_capability_alternatives_invalid');
    descriptor.alternatives = source.alternatives.map((entry) => requiredText(entry, 'chat_runtime_capability_alternatives_invalid'));
  }
  return descriptor;
}

function rejectUnknownFields(source, fields, code) {
  if (Object.keys(source).some((field) => !fields.has(field))) throw new DesktopChatRuntimeError(code);
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

'use strict';

const {
  CHAT_EVENT_SCHEMA,
  EVENT_TYPES,
  SESSION_STATES,
  TIMELINE_KINDS,
  TIMELINE_STATUSES,
  ChatRuntimeError
} = require('./contract-values');
const { normalizeCommand } = require('./command-contract');
const { projectCanonicalQueueResult } = require('./queue-result-contract');
const { normalizeTimelineDetail } = require('./timeline-detail-contract');

const QUEUE_ENTRY_EVENTS = new Set([
  'queue.item.added', 'queue.item.updated', 'queue.item.dispatched'
]);
const QUEUE_POLICIES = new Set(['after_tool_boundary', 'after_turn']);
const QUEUE_STATUSES = new Set(['queued', 'leased', 'running', 'completed', 'failed']);
const TIMELINE_ITEM_EVENTS = new Set([
  'timeline.item.started', 'timeline.item.updated', 'timeline.item.completed'
]);
const TIMELINE_DELTA_CHANNELS = new Set([
  'summary', 'content', 'plan', 'output', 'diff', 'progress'
]);

function requiredText(value, code) {
  const text = String(value || '').trim();
  if (!text) throw new ChatRuntimeError(code);
  return text;
}

function cloneRecord(value, code = 'invalid_chat_payload') {
  const record = value === undefined ? {} : value;
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new ChatRuntimeError(code);
  }
  try {
    return structuredClone(record);
  } catch (_error) {
    throw new ChatRuntimeError(code);
  }
}

function normalizeTimestamp(value, code) {
  const timestamp = Number(value);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new ChatRuntimeError(code);
  return timestamp;
}

function normalizeTimelineItem(input = {}) {
  const item = cloneRecord(input, 'invalid_timeline_item');
  const kind = requiredText(item.kind, 'timeline_kind_required');
  if (!TIMELINE_KINDS.has(kind)) {
    throw new ChatRuntimeError('unknown_timeline_kind', 422, { kind });
  }
  const status = requiredText(item.status, 'timeline_status_required');
  if (!TIMELINE_STATUSES.has(status)) {
    throw new ChatRuntimeError('invalid_timeline_status', 422, { status });
  }
  const normalized = {
    id: requiredText(item.id, 'timeline_item_id_required'),
    kind,
    createdAt: normalizeTimestamp(item.createdAt, 'timeline_created_at_invalid'),
    status,
    detail: normalizeTimelineDetail(kind, item.detail)
  };
  addOptionalText(normalized, item, 'turnId');
  addOptionalText(normalized, item, 'content');
  if (item.updatedAt !== undefined) {
    normalized.updatedAt = normalizeTimestamp(item.updatedAt, 'timeline_updated_at_invalid');
  }
  return normalized;
}

function normalizeEvent(input = {}) {
  const schema = input.schema || CHAT_EVENT_SCHEMA;
  if (schema !== CHAT_EVENT_SCHEMA) {
    throw new ChatRuntimeError('unsupported_chat_event_schema', 422, { schema });
  }
  const type = requiredText(input.type, 'chat_event_type_required');
  if (!EVENT_TYPES.has(type)) {
    throw new ChatRuntimeError('unknown_chat_event_type', 422, { type });
  }
  const event = {
    schema,
    eventId: requiredText(input.eventId, 'chat_event_id_required'),
    sessionId: requiredText(input.sessionId, 'chat_session_id_required'),
    seq: isTransportEvent(type)
      ? nonNegativeInteger(input.seq, 'chat_event_seq_invalid')
      : positiveInteger(input.seq, 'chat_event_seq_invalid'),
    type,
    at: normalizeTimestamp(input.at, 'chat_event_at_invalid')
  };
  ['turnId', 'runId', 'itemId'].forEach((key) => addOptionalText(event, input, key));
  event.source = normalizeSource(input.source);
  event.payload = normalizeEventPayload(type, input.payload, event.turnId);
  return event;
}

function isTransportEvent(type) {
  return type === 'stream.error' || type === 'session.snapshot.reset';
}

function normalizeEventPayload(type, value, eventTurnId) {
  const payload = cloneRecord(value);
  if (TIMELINE_ITEM_EVENTS.has(type)) {
    const item = normalizeTimelineItem(payload.item);
    if (eventTurnId && item.turnId && item.turnId !== eventTurnId) {
      throw new ChatRuntimeError('timeline_turn_id_mismatch', 422, {
        eventTurnId,
        itemTurnId: item.turnId
      });
    }
    return { item };
  }
  if (type === 'timeline.item.delta') {
    const detail = normalizeTimelineDeltaDetail(payload.detail);
    return {
      itemId: requiredText(payload.itemId, 'timeline_item_id_required'),
      chunk: String(payload.chunk === undefined ? '' : payload.chunk),
      ...(detail ? { detail } : {})
    };
  }
  if (QUEUE_ENTRY_EVENTS.has(type)) {
    return { entry: normalizeQueueEntry(payload.entry) };
  }
  if (type === 'session.snapshot.reset') return normalizeSnapshot(payload);
  return payload;
}

function normalizeTimelineDeltaDetail(value) {
  if (value === undefined) return null;
  const detail = cloneRecord(value, 'invalid_timeline_delta_detail');
  const channel = requiredText(detail.channel, 'timeline_delta_channel_required');
  if (!TIMELINE_DELTA_CHANNELS.has(channel)) {
    throw new ChatRuntimeError('unknown_timeline_delta_channel', 422, { channel });
  }
  const normalized = { channel };
  if (detail.index !== undefined) {
    normalized.index = nonNegativeInteger(detail.index, 'timeline_delta_index_invalid');
  }
  return normalized;
}

function normalizeSnapshot(input = {}) {
  const snapshot = {
    sessionId: requiredText(input.sessionId, 'chat_session_id_required'),
    state: validateState(input.state),
    throughSeq: nonNegativeInteger(input.throughSeq, 'chat_snapshot_seq_invalid'),
    policy: cloneRecord(input.policy)
  };
  ['runtimeBinding', 'capabilitySnapshot', 'activeTurn'].forEach((key) => {
    if (input[key] !== undefined && input[key] !== null) snapshot[key] = cloneRecord(input[key]);
  });
  snapshot.queue = cloneArray(input.queue).map(normalizeQueueEntry);
  snapshot.interactions = cloneArray(input.interactions);
  snapshot.timeline = cloneArray(input.timeline).map(normalizeTimelineItem);
  snapshot.timelineHasMore = input.timelineHasMore === true;
  snapshot.timelineNextBefore = normalizeTimelineCursor(input.timelineNextBefore);
  return snapshot;
}

function normalizeQueueEntry(input) {
  const entry = cloneRecord(input, 'invalid_chat_queue_entry');
  const policy = requiredText(entry.policy, 'chat_queue_policy_required');
  if (!QUEUE_POLICIES.has(policy)) {
    throw new ChatRuntimeError('invalid_chat_queue_policy', 422, { policy });
  }
  const status = requiredText(entry.status, 'chat_queue_status_required');
  if (!QUEUE_STATUSES.has(status)) {
    throw new ChatRuntimeError('invalid_chat_queue_status', 422, { status });
  }
  const normalized = {
    queueId: requiredText(entry.queueId, 'chat_queue_id_required'),
    sessionId: requiredText(entry.sessionId, 'chat_session_id_required'),
    commandId: requiredText(entry.commandId, 'chat_queue_command_id_required'),
    position: nonNegativeInteger(entry.position, 'chat_queue_position_invalid'),
    policy,
    payload: cloneRecord(entry.payload, 'invalid_chat_queue_payload'),
    status,
    createdAt: normalizeTimestamp(entry.createdAt, 'chat_queue_created_at_invalid'),
    updatedAt: normalizeTimestamp(entry.updatedAt, 'chat_queue_updated_at_invalid')
  };
  addOptionalText(normalized, entry, 'leaseId');
  addOptionalText(normalized, entry, 'boundaryItemId');
  const result = projectCanonicalQueueResult(status, entry.result);
  if (result !== undefined) normalized.result = result;
  return normalized;
}

function normalizeTimelineCursor(value) {
  if (value === undefined || value === null || value === '') return null;
  return requiredText(value, 'chat_timeline_cursor_invalid');
}

function normalizeSource(input) {
  const source = cloneRecord(input, 'chat_event_source_required');
  const result = {
    provider: requiredText(source.provider, 'chat_event_provider_required'),
    runtimeId: requiredText(source.runtimeId, 'chat_event_runtime_id_required')
  };
  addOptionalText(result, source, 'nativeEventId');
  return result;
}

function validateState(value) {
  const state = requiredText(value, 'chat_session_state_required');
  if (!SESSION_STATES.has(state)) {
    throw new ChatRuntimeError('invalid_chat_session_state', 422, { state });
  }
  return state;
}

function cloneArray(value) {
  return Array.isArray(value) ? structuredClone(value) : [];
}

function addOptionalText(target, source, key) {
  if (source[key] !== undefined) target[key] = String(source[key]);
}

function positiveInteger(value, code) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new ChatRuntimeError(code);
  return number;
}

function nonNegativeInteger(value, code) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new ChatRuntimeError(code);
  return number;
}

module.exports = {
  normalizeCommand,
  normalizeEvent,
  normalizeSnapshot,
  normalizeTimelineItem
};

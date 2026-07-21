import {
  assertSessionId,
  booleanValue,
  nonNegativeInteger,
  optionalText,
  positiveInteger,
  protocolFailure,
  record,
  sessionState,
  text,
} from './dto-guards';
import { parsePendingInteraction } from './interaction-parser';
import { assertExactFields } from './interaction-parser-fields';
import { parseRuntimeBinding } from './runtime-binding-parser';
import {
  parseActiveTurn,
  parseSessionQueueEntry,
  parseSessionSnapshot,
  parseTimelineItem,
} from './snapshot-parser';
import { parseCapabilitySnapshot } from './capability-parser';
import { CHAT_RUNTIME_EVENT_SCHEMA } from './types';
import type {
  ChatRuntimeEvent,
  ChatRuntimeEventType,
  TimelineDeltaChannel,
  TimelineDeltaDetail,
} from './types';

const EVENT_TYPES = new Set<ChatRuntimeEventType>([
  'session.created', 'session.runtime.bound', 'session.runtime.rebound',
  'session.policy.changed', 'session.closed', 'session.snapshot.reset',
  'turn.queued', 'turn.started', 'turn.phase.changed', 'turn.interrupt.requested',
  'turn.interrupted', 'turn.completed', 'turn.failed',
  'queue.item.added', 'queue.item.updated', 'queue.item.moved',
  'queue.item.removed', 'queue.item.dispatched',
  'timeline.item.started', 'timeline.item.delta', 'timeline.item.updated',
  'timeline.item.completed', 'interaction.requested', 'interaction.updated', 'interaction.resolved',
  'interaction.expired', 'run.detached', 'run.reattached', 'run.adopted', 'run.lost',
  'runtime.prewarm.started', 'runtime.prewarm.ready', 'runtime.prewarm.failed', 'stream.error',
]);
const RUNTIME_PROJECTION_TYPES = new Set<ChatRuntimeEventType>([
  'session.runtime.bound', 'session.runtime.rebound',
  'runtime.prewarm.started', 'runtime.prewarm.ready',
]);
const STREAM_ERROR_FIELDS = new Set(['error', 'message', 'retryable']);
const TIMELINE_DELTA_CHANNELS = new Set<TimelineDeltaChannel>([
  'summary', 'content', 'plan', 'output', 'diff', 'progress',
]);

export function parseChatRuntimeEvent(data: string, sessionId: string): ChatRuntimeEvent {
  let decoded: unknown;
  try {
    decoded = JSON.parse(data);
  } catch (_error) {
    protocolFailure('chat_runtime_event_json_invalid');
  }
  const source = record(decoded, 'chat_runtime_event_invalid');
  if (source.schema !== CHAT_RUNTIME_EVENT_SCHEMA) protocolFailure('chat_runtime_event_schema_invalid');
  const type = text(source.type, 'chat_runtime_event_type_invalid') as ChatRuntimeEventType;
  if (!EVENT_TYPES.has(type)) protocolFailure('chat_runtime_event_type_invalid');
  assertSessionId(source.sessionId, sessionId);
  const seq = validateSequence(source.seq, type);
  text(source.eventId, 'chat_runtime_event_id_invalid');
  nonNegativeInteger(source.at, 'chat_runtime_event_at_invalid');
  validateSource(source.source);
  const payload = validatePayload(type, source.payload, sessionId, source.turnId);
  if (type === 'session.snapshot.reset' && payload.throughSeq !== seq) {
    protocolFailure('chat_runtime_snapshot_cursor_mismatch');
  }
  return { ...source, payload } as unknown as ChatRuntimeEvent;
}

function validateSequence(value: unknown, type: ChatRuntimeEventType): number {
  if (type === 'stream.error' || type === 'session.snapshot.reset') {
    return nonNegativeInteger(value, 'chat_runtime_event_seq_invalid');
  }
  return positiveInteger(value, 'chat_runtime_event_seq_invalid');
}

function validateSource(value: unknown): void {
  const source = record(value, 'chat_runtime_event_source_invalid');
  text(source.provider, 'chat_runtime_event_provider_invalid');
  text(source.runtimeId, 'chat_runtime_event_runtime_id_invalid');
}

function validatePayload(
  type: ChatRuntimeEventType,
  value: unknown,
  sessionId: string,
  eventTurnId: unknown,
): Record<string, unknown> {
  const payload = record(value, 'chat_runtime_event_payload_invalid');
  if (type === 'session.snapshot.reset') {
    return parseSessionSnapshot(payload, sessionId) as unknown as Record<string, unknown>;
  }
  if (RUNTIME_PROJECTION_TYPES.has(type)) return validateRuntimeProjection(payload);
  if (type.startsWith('timeline.item.')) {
    return validateTimelinePayload(type, payload, eventTurnId);
  }
  if (type.startsWith('interaction.')) return validateInteractionPayload(payload, sessionId);
  if (type.startsWith('queue.item.')) return validateQueuePayload(type, payload, sessionId);
  return validateDomainPayload(type, payload);
}

function validateDomainPayload(
  type: ChatRuntimeEventType,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (type.startsWith('turn.') || type === 'run.adopted') {
    return validateStateProjectionPayload(payload);
  }
  if (type === 'run.reattached') {
    const nativeTurnId = optionalText(
      payload.nativeTurnId,
      'chat_runtime_active_native_turn_id_invalid',
    );
    return {
      ...payload,
      state: sessionState(payload.state),
      ...(nativeTurnId ? { nativeTurnId } : {}),
    };
  }
  if (type === 'run.detached') {
    return {
      ...payload,
      reason: text(payload.reason, 'chat_runtime_run_detached_reason_invalid'),
    };
  }
  if (type === 'run.lost') {
    return {
      ...payload,
      error: record(payload.error, 'chat_runtime_run_lost_error_invalid'),
    };
  }
  if (type === 'session.created') sessionState(payload.state);
  if (type === 'session.policy.changed') record(payload.policy, 'chat_runtime_policy_invalid');
  if (type === 'stream.error') return validateStreamError(payload);
  if (type === 'runtime.prewarm.failed') {
    return {
      ...payload,
      error: text(payload.error, 'chat_runtime_prewarm_error_invalid'),
    };
  }
  return payload;
}

function validateStateProjectionPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const state = sessionState(payload.state);
  if (payload.activeTurn === undefined) return { ...payload, state };
  if (payload.activeTurn === null) return { ...payload, state, activeTurn: null };
  return { ...payload, state, activeTurn: parseActiveTurn(payload.activeTurn) };
}

function validateStreamError(payload: Record<string, unknown>): Record<string, unknown> {
  if (Object.keys(payload).some((key) => !STREAM_ERROR_FIELDS.has(key))) {
    protocolFailure('chat_runtime_stream_error_invalid');
  }
  const retryable = payload.retryable === undefined
    ? undefined
    : booleanValue(payload.retryable, 'chat_runtime_stream_error_invalid');
  return {
    error: text(payload.error, 'chat_runtime_stream_error_invalid'),
    message: text(payload.message, 'chat_runtime_stream_message_invalid'),
    ...(retryable === undefined ? {} : { retryable }),
  };
}

function validateRuntimeProjection(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    ...payload,
    ...(payload.runtimeBinding === undefined ? {} : {
      runtimeBinding: parseRuntimeBinding(payload.runtimeBinding),
    }),
    ...(payload.capabilitySnapshot === undefined ? {} : {
      capabilitySnapshot: parseCapabilitySnapshot(payload.capabilitySnapshot),
    }),
  };
}

function validateTimelinePayload(
  type: ChatRuntimeEventType,
  payload: Record<string, unknown>,
  eventTurnId: unknown,
): Record<string, unknown> {
  if (type === 'timeline.item.delta') {
    assertExactFields(
      payload,
      ['itemId', 'chunk', 'detail'],
      'chat_runtime_timeline_payload_invalid',
    );
    const itemId = text(payload.itemId, 'chat_runtime_timeline_id_invalid');
    if (typeof payload.chunk !== 'string') protocolFailure('chat_runtime_timeline_chunk_invalid');
    const detail = payload.detail === undefined
      ? undefined
      : parseTimelineDeltaDetail(payload.detail);
    return { itemId, chunk: payload.chunk, ...(detail ? { detail } : {}) };
  }
  assertExactFields(payload, ['item'], 'chat_runtime_timeline_payload_invalid');
  const item = parseTimelineItem(payload.item);
  const turnId = optionalText(eventTurnId, 'chat_runtime_event_turn_id_invalid');
  if (turnId && item.turnId && turnId !== item.turnId) {
    protocolFailure('chat_runtime_timeline_turn_mismatch');
  }
  return { item };
}

function parseTimelineDeltaDetail(value: unknown): TimelineDeltaDetail {
  const source = record(value, 'chat_runtime_timeline_delta_detail_invalid');
  assertExactFields(
    source,
    ['channel', 'index'],
    'chat_runtime_timeline_delta_detail_invalid',
  );
  const channel = text(
    source.channel,
    'chat_runtime_timeline_delta_detail_invalid',
  ) as TimelineDeltaChannel;
  if (!TIMELINE_DELTA_CHANNELS.has(channel)) {
    protocolFailure('chat_runtime_timeline_delta_detail_invalid');
  }
  const index = source.index === undefined
    ? undefined
    : nonNegativeInteger(source.index, 'chat_runtime_timeline_delta_detail_invalid');
  return { channel, ...(index === undefined ? {} : { index }) };
}

function validateQueuePayload(
  type: ChatRuntimeEventType,
  payload: Record<string, unknown>,
  sessionId: string,
): Record<string, unknown> {
  if (type === 'queue.item.removed' || type === 'queue.item.moved') {
    const queueId = text(payload.queueId, 'chat_runtime_queue_id_invalid');
    if (type === 'queue.item.removed') return { queueId };
    const beforeQueueId = optionalText(
      payload.beforeQueueId,
      'chat_runtime_queue_before_id_invalid',
    );
    return { queueId, ...(beforeQueueId ? { beforeQueueId } : {}) };
  }
  return { entry: parseSessionQueueEntry(payload.entry, sessionId) };
}

function validateInteractionPayload(
  payload: Record<string, unknown>,
  sessionId: string,
): Record<string, unknown> {
  return {
    ...payload,
    interaction: parsePendingInteraction(payload.interaction, sessionId),
  };
}

import { parseCapabilitySnapshot } from './capability-parser';
import {
  assertSessionId,
  booleanValue,
  nonNegativeInteger,
  optionalText,
  protocolFailure,
  record,
  records,
  sessionState,
  text,
} from './dto-guards';
import { parsePendingInteraction } from './interaction-parser';
import { parseRuntimeBinding } from './runtime-binding-parser';
import { parseTimelineItem } from './timeline-item-parser';
import type {
  ActiveTurn,
  SessionQueueEntry,
  SessionSnapshot,
} from './types';

const QUEUE_POLICIES = new Set<SessionQueueEntry['policy']>([
  'after_tool_boundary', 'after_turn',
]);
const QUEUE_STATES = new Set<SessionQueueEntry['status']>([
  'queued', 'leased', 'running', 'completed', 'failed',
]);
export { parseTimelineItem } from './timeline-item-parser';

export function parseSessionSnapshot(value: unknown, expectedSessionId: string): SessionSnapshot {
  const source = record(value, 'chat_runtime_snapshot_invalid');
  const snapshot: SessionSnapshot = {
    sessionId: assertSessionId(source.sessionId, expectedSessionId),
    state: sessionState(source.state),
    throughSeq: nonNegativeInteger(source.throughSeq, 'chat_runtime_snapshot_seq_invalid'),
    policy: record(source.policy, 'chat_runtime_snapshot_policy_invalid'),
    queue: records(source.queue, 'chat_runtime_snapshot_queue_invalid')
      .map((entry) => parseSessionQueueEntry(entry, expectedSessionId)),
    interactions: records(source.interactions, 'chat_runtime_snapshot_interactions_invalid')
      .map((entry) => parsePendingInteraction(entry, expectedSessionId)),
    timeline: records(source.timeline, 'chat_runtime_snapshot_timeline_invalid')
      .map(parseTimelineItem),
    timelineHasMore: booleanValue(
      source.timelineHasMore,
      'chat_runtime_snapshot_timeline_has_more_invalid',
    ),
    timelineNextBefore: nullableCursor(source.timelineNextBefore),
  };
  return addOptionalSnapshotFields(snapshot, source);
}

export function parseSessionQueueEntry(
  value: unknown,
  sessionId: string,
): SessionQueueEntry {
  const source = record(value, 'chat_runtime_queue_entry_invalid');
  return {
    queueId: text(source.queueId, 'chat_runtime_queue_id_invalid'),
    sessionId: assertSessionId(source.sessionId, sessionId),
    commandId: text(source.commandId, 'chat_runtime_queue_command_id_invalid'),
    position: nonNegativeInteger(source.position, 'chat_runtime_queue_position_invalid'),
    policy: enumValue(source.policy, QUEUE_POLICIES, 'chat_runtime_queue_policy_invalid'),
    payload: record(source.payload, 'chat_runtime_queue_payload_invalid'),
    status: enumValue(source.status, QUEUE_STATES, 'chat_runtime_queue_status_invalid'),
    createdAt: nonNegativeInteger(source.createdAt, 'chat_runtime_queue_created_at_invalid'),
    updatedAt: nonNegativeInteger(source.updatedAt, 'chat_runtime_queue_updated_at_invalid'),
    ...optionalTextField(source, 'leaseId', 'chat_runtime_queue_lease_id_invalid'),
    ...optionalTextField(source, 'boundaryItemId', 'chat_runtime_queue_boundary_id_invalid'),
    ...optionalUnknown(source, 'result'),
  };
}

function addOptionalSnapshotFields(
  snapshot: SessionSnapshot,
  source: Record<string, unknown>,
): SessionSnapshot {
  return {
    ...snapshot,
    ...(source.runtimeBinding === undefined ? {} : {
      runtimeBinding: parseRuntimeBinding(source.runtimeBinding),
    }),
    ...(source.capabilitySnapshot === undefined ? {} : {
      capabilitySnapshot: parseCapabilitySnapshot(source.capabilitySnapshot),
    }),
    ...(source.activeTurn === undefined ? {} : {
      activeTurn: parseActiveTurn(source.activeTurn),
    }),
  };
}

export function parseActiveTurn(value: unknown): ActiveTurn {
  const source = record(value, 'chat_runtime_active_turn_invalid');
  return {
    turnId: text(source.turnId, 'chat_runtime_active_turn_id_invalid'),
    state: sessionState(source.state),
    ...optionalTextField(source, 'runId', 'chat_runtime_active_run_id_invalid'),
    ...optionalTextField(
      source,
      'clientUserMessageId',
      'chat_runtime_active_client_message_id_invalid',
    ),
    ...optionalTextField(
      source,
      'nativeTurnId',
      'chat_runtime_active_native_turn_id_invalid',
    ),
  };
}

function nullableCursor(value: unknown): string | null {
  if (value === null) return null;
  return text(value, 'chat_runtime_snapshot_timeline_cursor_invalid');
}

function enumValue<T extends string>(value: unknown, values: ReadonlySet<T>, code: string): T {
  const result = text(value, code) as T;
  if (!values.has(result)) protocolFailure(code);
  return result;
}

function optionalTextField(source: Record<string, unknown>, field: string, code: string) {
  const value = optionalText(source[field], code);
  return value === undefined ? {} : { [field]: value };
}

function optionalUnknown(source: Record<string, unknown>, field: string) {
  return source[field] === undefined ? {} : { [field]: source[field] };
}

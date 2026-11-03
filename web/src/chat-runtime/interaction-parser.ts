import {
  assertSessionId,
  nonNegativeInteger,
  positiveInteger,
  protocolFailure,
  record,
  text,
} from './dto-guards';
import { parseApprovalInteractionPayload } from './approval-interaction-parser';
import { parseQuestionInteractionPayload } from './question-interaction-parser';
import { assertExactFields } from './interaction-parser-fields';
import type {
  PendingInteraction,
} from './types';

const INTERACTION_KINDS = new Set<PendingInteraction['kind']>([
  'question', 'approval', 'plan_confirmation',
]);
const INTERACTION_STATES = new Set<PendingInteraction['state']>([
  'pending', 'resolving', 'answered', 'expired',
]);
export function parsePendingInteraction(
  value: unknown,
  sessionId: string,
): PendingInteraction {
  const source = record(value, 'chat_runtime_interaction_invalid');
  assertExactFields(
    source,
    [
      'interactionId', 'sessionId', 'itemId', 'revision', 'state',
      'resolution', 'createdAt', 'updatedAt', 'kind', 'payload',
    ],
    'chat_runtime_interaction_invalid',
  );
  const kind = enumValue(
    source.kind, INTERACTION_KINDS, 'chat_runtime_interaction_kind_invalid',
  );
  const common = {
    interactionId: text(source.interactionId, 'chat_runtime_interaction_id_invalid'),
    sessionId: assertSessionId(source.sessionId, sessionId),
    itemId: text(source.itemId, 'chat_runtime_interaction_item_id_invalid'),
    revision: positiveInteger(source.revision, 'chat_runtime_interaction_revision_invalid'),
    state: enumValue(source.state, INTERACTION_STATES, 'chat_runtime_interaction_state_invalid'),
    createdAt: nonNegativeInteger(source.createdAt, 'chat_runtime_interaction_created_at_invalid'),
    updatedAt: nonNegativeInteger(source.updatedAt, 'chat_runtime_interaction_updated_at_invalid'),
    ...optionalUnknown(source, 'resolution'),
  };
  if (kind === 'approval') {
    return { ...common, kind, payload: parseApprovalInteractionPayload(source.payload) };
  }
  return { ...common, kind, payload: parseQuestionInteractionPayload(source.payload) };
}

function enumValue<T extends string>(
  value: unknown,
  values: ReadonlySet<T>,
  code: string,
): T {
  const result = text(value, code) as T;
  if (!values.has(result)) protocolFailure(code);
  return result;
}

function optionalUnknown(source: Record<string, unknown>, field: string) {
  return source[field] === undefined ? {} : { [field]: source[field] };
}

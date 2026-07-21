'use strict';

const { buildCodexTimelineItem } = require('./codex-app-server-timeline-item');
const {
  mapCodexPlanUpdate
} = require('./chat-runtime/codex-plan-update-adapter');
const {
  createNativeInteractionId
} = require('./chat-runtime/native-interaction-id');
const {
  adaptCodexInteractionRequest,
  attachCodexInteractionEnvelope
} = require('./chat-runtime/codex-interaction-request-adapter');
const {
  mapCodexMcpProgress,
  mapCodexTurnDiff
} = require('./chat-runtime/codex-timeline-notification-adapter');
const {
  mapCodexHookNotification,
  mapCodexWarningNotification
} = require('./chat-runtime/codex-runtime-notification-adapter');
const {
  sanitizeCanonicalDiagnostic,
  sanitizeDiagnosticCode,
  sanitizeDiagnosticText
} = require('./chat-runtime/canonical-diagnostic-sanitizer');

const METHOD_MAPPERS = new Map([
  ['turn/started', (_id, params) => mapTurnStarted(params)],
  ['turn/completed', (_id, params) => mapTurnCompleted(params)],
  ['turn/diff/updated', (_id, params) => mapCodexTurnDiff(params)],
  ['thread/compacted', (_id, params) => mapContextCompacted(params)],
  ['turn/plan/updated', (_id, params) => mapCodexPlanUpdate(params)],
  ['hook/started', (_id, params) => mapRuntimeNotification(
    params, mapCodexHookNotification(params, false)
  )],
  ['hook/completed', (_id, params) => mapRuntimeNotification(
    params, mapCodexHookNotification(params, true)
  )],
  ['item/agentMessage/delta', (_id, params) => mapDelta(params)],
  ['item/reasoning/summaryTextDelta', (_id, params) => mapDelta(params, ['summary', 'summaryIndex'])],
  ['item/reasoning/textDelta', (_id, params) => mapDelta(params, ['content', 'contentIndex'])],
  ['item/plan/delta', (_id, params) => mapDelta(params, ['plan', null])],
  ['item/commandExecution/outputDelta', (_id, params) => mapDelta(params, ['output', null])],
  ['item/fileChange/outputDelta', (_id, params) => mapDelta(params, ['diff', null])],
  ['item/mcpToolCall/progress', (_id, params) => mapCodexMcpProgress(params)],
  ['item/started', (_id, params) => mapItemLifecycle('item/started', params)],
  ['item/completed', (_id, params) => mapItemLifecycle('item/completed', params)],
  ['item/commandExecution/requestApproval', (id, params, context) => mapInteractionRequest(
    id, 'item/commandExecution/requestApproval', params, context
  )],
  ['item/fileChange/requestApproval', (id, params, context) => mapInteractionRequest(
    id, 'item/fileChange/requestApproval', params, context
  )],
  ['item/permissions/requestApproval', (id, params, context) => mapInteractionRequest(
    id, 'item/permissions/requestApproval', params, context
  )],
  ['item/tool/requestUserInput', (id, params, context) => mapInteractionRequest(
    id, 'item/tool/requestUserInput', params, context
  )],
  ['mcpServer/elicitation/request', (id, params, context) => mapInteractionRequest(
    id, 'mcpServer/elicitation/request', params, context
  )],
  ['serverRequest/resolved', (_id, params, context) => mapResolved(params, context)],
  ['warning', (_id, params) => mapRuntimeNotification(
    params, mapCodexWarningNotification(params)
  )],
  ['error', (_id, params) => streamError('codex_app_server_error', params)]
]);

const KNOWN_NOOP_METHODS = new Set([
  'mcpServer/startupStatus/updated',
  'thread/goal/cleared',
  'thread/settings/updated',
  'thread/status/changed',
  'thread/tokenUsage/updated',
  'item/reasoning/summaryPartAdded',
]);

function mapRuntimeNotification(params, mapped) {
  return mapped || streamError('invalid_codex_runtime_notification', params);
}

function mapCodexAppServerMessage(message = {}, context = {}) {
  const method = typeof message.method === 'string' ? message.method : '';
  const params = asRecord(message.params);
  const mapper = METHOD_MAPPERS.get(method);
  if (mapper) {
    try {
      return mapper(message.id, params, context);
    } catch (error) {
      if (error && error.code === 'native_interaction_identity_incomplete') {
        return streamError('invalid_codex_interaction_identity', params);
      }
      if (error && error instanceof Error && error.code) {
        return streamError(error.code, params);
      }
      throw error;
    }
  }
  if (KNOWN_NOOP_METHODS.has(method) && message.id === undefined) return knownNoop(method);
  return streamError('unsupported_codex_app_server_method', params);
}

function knownNoop(method) {
  return { classification: 'known_noop', method, payload: {} };
}

function mapTurnStarted(params) {
  const turn = asRecord(params.turn);
  return intent('turn.started', turn.id, null, {
    threadId: params.threadId, status: turn.status || 'inProgress', startedAt: turn.startedAt
  });
}

function mapTurnCompleted(params) {
  const turn = asRecord(params.turn);
  const types = { completed: 'turn.completed', failed: 'turn.failed', interrupted: 'turn.interrupted' };
  const type = types[turn.status] || 'turn.failed';
  return intent(type, turn.id, null, {
    threadId: params.threadId, status: turn.status,
    error: turn.error === undefined
      ? undefined
      : (turn.error === null
        ? null
        : sanitizeCanonicalDiagnostic(turn.error, { fallbackCode: 'codex_turn_failed' })),
    startedAt: turn.startedAt, completedAt: turn.completedAt, durationMs: turn.durationMs
  });
}

function mapDelta(params, descriptor) {
  const payload = { itemId: String(params.itemId || ''), chunk: String(params.delta || '') };
  if (descriptor) {
    const [channel, indexField] = descriptor;
    payload.detail = { channel };
    if (indexField && params[indexField] !== undefined) payload.detail.index = params[indexField];
  }
  return intent('timeline.item.delta', params.turnId, params.itemId, payload);
}

function mapItemLifecycle(method, params) {
  const rawItem = asRecord(params.item);
  const itemId = String(rawItem.id || '');
  if (!itemId) return streamError('invalid_codex_app_server_item', params);
  const completed = method === 'item/completed';
  const item = withTurnId(buildCodexTimelineItem(rawItem, params, completed), params.turnId);
  return intent(completed ? 'timeline.item.completed' : 'timeline.item.started', params.turnId, itemId, { item });
}

function mapInteractionRequest(requestId, method, params, context) {
  const adapted = adaptCodexInteractionRequest({
    method,
    params,
    requestId,
    sessionId: context && context.sessionId
  });
  const interaction = adapted.interaction;
  const mapped = intent(
    'interaction.requested',
    params.turnId,
    interaction.itemId,
    { interaction }
  );
  return attachCodexInteractionEnvelope(mapped, adapted.envelope);
}

function mapResolved(params, context) {
  return { type: 'interaction.resolved', payload: {
    interactionId: codexInteractionId(context, params, params.requestId)
  } };
}

function codexInteractionId(context, params, requestId) {
  return createNativeInteractionId({
    provider: 'codex',
    sessionId: context && context.sessionId,
    nativeThreadId: params && params.threadId,
    nativeRequestId: requestId
  });
}

function mapContextCompacted(params) {
  const turnId = String(params.turnId || '');
  const itemId = `codex-compaction:${turnId}`;
  return intent('timeline.item.completed', turnId, itemId, { item: {
    id: itemId,
    turnId,
    kind: 'notice',
    createdAt: 0,
    updatedAt: 0,
    status: 'completed',
    content: 'Context compacted',
    detail: { level: 'success', code: 'context_compacted' }
  } });
}

function withTurnId(item, turnId) {
  const id = String(turnId || '').trim();
  return id ? { ...item, turnId: id } : item;
}

function streamError(code, params) {
  const nativeError = asRecord(params.error);
  const upstreamMessage = code === 'codex_app_server_error'
    ? String(nativeError.message || params.message || '').trim()
    : '';
  const messages = {
    invalid_codex_plan_update: 'Invalid Codex plan update',
    unsupported_codex_app_server_method: 'Unsupported Codex app-server event'
  };
  const safeCode = sanitizeDiagnosticCode(code, 'codex_app_server_error');
  const message = sanitizeDiagnosticText(
    upstreamMessage || messages[safeCode] || 'Codex app-server request could not be adapted'
  );
  return {
    type: 'stream.error', payload: {
      error: safeCode,
      message,
      retryable: code === 'codex_app_server_error' && params.willRetry === true
    }
  };
}

function intent(type, turnId, itemId, payload) {
  const event = { type };
  if (turnId !== undefined && turnId !== null && turnId !== '') event.turnId = String(turnId);
  if (itemId !== undefined && itemId !== null && itemId !== '') event.itemId = String(itemId);
  event.payload = payload;
  return event;
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

module.exports = { mapCodexAppServerMessage };

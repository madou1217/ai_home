'use strict';

const { COMMAND_TYPES, ChatRuntimeError } = require('./contract-values');

const INTERVENE_MODES = new Set([
  'steer_current',
  'after_tool_boundary',
  'after_turn_same_run',
  'replace_current'
]);
const QUESTION_ACTIONS = new Set(['submit', 'decline', 'cancel']);
const APPROVAL_PAYLOAD_KEYS = new Set(['interactionId', 'revision', 'choiceId']);
const SERVER_OWNED_TURN_FIELDS = Object.freeze(['runId', 'turnId']);
const MAX_TURN_ATTACHMENTS = 8;
const PAYLOAD_NORMALIZERS = Object.freeze({
  'turn.submit': normalizeTurnSubmit,
  'turn.intervene': normalizeTurnIntervene,
  'interaction.answer': normalizeInteractionAnswer,
  'approval.decide': normalizeApprovalDecision,
  'queue.edit': requireQueueId,
  'queue.remove': requireQueueId,
  'queue.move': normalizeQueueMove,
  'queue.dispatch': normalizeQueueDispatch
});

function normalizeTurnSubmit(payload) {
  for (const key of SERVER_OWNED_TURN_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      throw new ChatRuntimeError('chat_turn_identity_client_controlled', 422, { key });
    }
  }
  payload.attachmentIds = normalizeAttachmentIds(payload.attachmentIds);
  payload.content = String(payload.content || '').trim();
  if (!payload.content && payload.attachmentIds.length === 0) {
    throw new ChatRuntimeError('chat_turn_content_required', 422);
  }
  if (payload.attachmentIds.length === 0) delete payload.attachmentIds;
  for (const key of ['model', 'reasoningEffort']) {
    if (payload[key] === undefined) continue;
    const value = String(payload[key] || '').trim();
    if (!value) throw new ChatRuntimeError('chat_turn_model_control_invalid', 422, { key });
    payload[key] = value;
  }
  return payload;
}

function normalizeAttachmentIds(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_TURN_ATTACHMENTS) {
    throw new ChatRuntimeError('chat_attachment_ids_invalid', 422, {
      limit: MAX_TURN_ATTACHMENTS
    });
  }
  const ids = value.map((item) => requiredText(item, 'chat_attachment_id_invalid'));
  if (new Set(ids).size !== ids.length) {
    throw new ChatRuntimeError('chat_attachment_ids_duplicate', 422);
  }
  return ids;
}

function normalizeCommand(input = {}) {
  const type = requiredText(input.type, 'chat_command_type_required');
  if (!COMMAND_TYPES.has(type)) {
    throw new ChatRuntimeError('unsupported_chat_command', 422, { type });
  }
  return {
    commandId: requiredText(input.commandId, 'chat_command_id_required'),
    sessionId: requiredText(input.sessionId, 'chat_session_id_required'),
    type,
    payload: normalizePayload(type, input.payload)
  };
}

function normalizePayload(type, input) {
  const payload = cloneRecord(input);
  const normalize = PAYLOAD_NORMALIZERS[type];
  return normalize ? normalize(payload) : payload;
}

function normalizeTurnIntervene(payload) {
  if (!INTERVENE_MODES.has(payload.mode)) {
    throw new ChatRuntimeError('invalid_turn_intervene_mode', 422, {
      mode: payload.mode
    });
  }
  return payload;
}

function normalizeApprovalDecision(payload) {
  if (payload.decision !== undefined || payload.grant !== undefined) {
    throw new ChatRuntimeError('approval_native_decision_not_allowed', 422);
  }
  const unknown = Object.keys(payload).filter((key) => !APPROVAL_PAYLOAD_KEYS.has(key));
  if (unknown.length > 0) {
    throw new ChatRuntimeError('invalid_approval_command_payload', 422, { unknown });
  }
  requireInteractionId(payload);
  payload.choiceId = requiredText(payload.choiceId, 'chat_approval_choice_id_required');
  return payload;
}

function normalizeInteractionAnswer(payload) {
  requireInteractionId(payload);
  if (!QUESTION_ACTIONS.has(payload.action)) {
    throw new ChatRuntimeError('invalid_question_action', 422, { action: payload.action });
  }
  const hasAnswer = Object.prototype.hasOwnProperty.call(payload, 'answer');
  if (payload.action === 'submit' && !hasAnswer) {
    throw new ChatRuntimeError('chat_question_answer_required', 422);
  }
  if (payload.action !== 'submit' && hasAnswer) {
    throw new ChatRuntimeError('chat_question_answer_not_allowed', 422);
  }
  return payload;
}

function requireInteractionId(payload) {
  payload.interactionId = requiredText(payload.interactionId, 'chat_interaction_id_required');
  return payload;
}

function requireQueueId(payload) {
  payload.queueId = requiredText(payload.queueId, 'chat_queue_id_required');
  return payload;
}

function normalizeQueueMove(payload) {
  requireQueueId(payload);
  if (payload.beforeQueueId !== undefined) {
    payload.beforeQueueId = requiredText(payload.beforeQueueId, 'chat_before_queue_id_invalid');
  }
  return payload;
}

function normalizeQueueDispatch(payload) {
  if (payload.queueId !== undefined) {
    payload.queueId = requiredText(payload.queueId, 'chat_queue_id_invalid');
  }
  return payload;
}

function requiredText(value, code) {
  const text = String(value || '').trim();
  if (!text) throw new ChatRuntimeError(code);
  return text;
}

function cloneRecord(value) {
  const record = value === undefined ? {} : value;
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new ChatRuntimeError('invalid_chat_payload');
  }
  try {
    return structuredClone(record);
  } catch (_error) {
    throw new ChatRuntimeError('invalid_chat_payload');
  }
}

module.exports = { normalizeCommand };

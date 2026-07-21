'use strict';

const { ChatRuntimeError } = require('./contracts');
const { createNativeInteractionId } = require('./native-interaction-id');

const QUESTION_ACTIONS = new Set(['submit', 'decline', 'cancel']);
const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval'
]);

function adaptCodexServerResponse(pending = {}, resolution = {}) {
  const envelope = requirePrivateEnvelope(pending);
  requireNativeInteractionIdentity(pending, envelope);
  const input = record(resolution, 'codex_interaction_resolution_invalid');
  if (APPROVAL_METHODS.has(envelope.method)) return approvalChoice(input, envelope);
  if (envelope.method === 'item/tool/requestUserInput') {
    return toolAnswers(input, envelope.nativeRequest);
  }
  if (envelope.method === 'mcpServer/elicitation/request') {
    return mcpElicitation(input, envelope.nativeRequest);
  }
  throw new ChatRuntimeError('codex_server_response_adapter_missing', 422);
}

function requirePrivateEnvelope(pending) {
  const envelope = pending && pending.envelope;
  if (!envelope || typeof envelope !== 'object') {
    throw new ChatRuntimeError('codex_interaction_private_envelope_missing', 500);
  }
  return envelope;
}

function requireNativeInteractionIdentity(pending, envelope) {
  const interactionId = createNativeInteractionId({
    provider: 'codex',
    sessionId: pending.sessionId || envelope.sessionId,
    nativeThreadId: envelope.nativeThreadId,
    nativeRequestId: envelope.requestId
  });
  if (interactionId !== pending.interactionId) {
    throw new ChatRuntimeError('codex_interaction_identity_mismatch', 409);
  }
}

function approvalChoice(resolution, envelope) {
  const choiceId = requiredText(
    resolution.choiceId,
    'codex_approval_choice_id_required'
  );
  const choices = envelope.choiceResponses;
  if (!(choices instanceof Map) || !choices.has(choiceId)) {
    throw new ChatRuntimeError('codex_approval_choice_not_available', 422, { choiceId });
  }
  return clone(choices.get(choiceId));
}

function toolAnswers(resolution, nativeRequest) {
  const action = questionAction(resolution.action);
  if (action !== 'submit') {
    throw new ChatRuntimeError('codex_question_action_unsupported', 422, { action });
  }
  const answer = record(resolution.answer, 'codex_question_answer_invalid');
  if (Object.keys(answer).length === 0) return { answers: {} };
  const questions = toolQuestionMap(nativeRequest && nativeRequest.questions);
  rejectUnknownAnswers(answer, questions);
  return { answers: Object.fromEntries(Object.entries(answer).map(([id, value]) => [
    id,
    { answers: nativeToolAnswerValues(value, questions.get(id)) }
  ])) };
}

function toolQuestionMap(input) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new ChatRuntimeError('codex_question_private_schema_invalid', 500);
  }
  return new Map(input.map((value) => {
    const question = record(value, 'codex_question_private_schema_invalid');
    return [requiredText(question.id, 'codex_question_private_schema_invalid'), question];
  }));
}

function rejectUnknownAnswers(answer, questions) {
  const unknown = Object.keys(answer).filter((id) => !questions.has(id));
  if (unknown.length > 0) {
    throw new ChatRuntimeError('codex_question_answer_unknown_field', 422, { fields: unknown });
  }
}

function nativeToolAnswerValues(value, question) {
  const values = answerValues(value);
  const options = Array.isArray(question.options)
    ? new Set(question.options.map((option) => String(option.label)))
    : null;
  return values.map((answer) => {
    if (options && options.has(answer)) return answer;
    if (options && question.isOther !== true) {
      throw new ChatRuntimeError('codex_question_answer_not_available', 422);
    }
    return `user_note: ${answer}`;
  });
}

function answerValues(value) {
  const values = Array.isArray(value) ? value : [value];
  if (values.some((item) => typeof item !== 'string')) {
    throw new ChatRuntimeError('codex_question_answer_invalid', 422);
  }
  return values.map((item) => item.trim()).filter(Boolean);
}

function mcpElicitation(resolution, nativeRequest = {}) {
  const action = questionAction(resolution.action);
  if (action !== 'submit') return { action, content: null, _meta: null };
  if (nativeRequest.mode === 'url') {
    const answer = record(resolution.answer, 'codex_question_answer_invalid');
    if (Object.keys(answer).length > 0) {
      throw new ChatRuntimeError('codex_question_answer_not_allowed', 422);
    }
    return { action: 'accept', content: null, _meta: null };
  }
  if (nativeRequest.mode !== 'form') {
    throw new ChatRuntimeError('codex_mcp_elicitation_mode_unsupported', 422);
  }
  const answer = record(resolution.answer, 'codex_question_answer_invalid');
  validateMcpAnswer(answer, nativeRequest.requestedSchema);
  return { action: 'accept', content: clone(answer), _meta: null };
}

function validateMcpAnswer(answer, schemaInput) {
  const schema = record(schemaInput, 'codex_question_private_schema_invalid');
  const properties = record(schema.properties, 'codex_question_private_schema_invalid');
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const unknown = Object.keys(answer).filter((id) => !Object.hasOwn(properties, id));
  if (unknown.length > 0) {
    throw new ChatRuntimeError('codex_question_answer_unknown_field', 422, { fields: unknown });
  }
  if ([...required].some((id) => !Object.hasOwn(answer, id))) {
    throw new ChatRuntimeError('codex_question_required_answer_missing', 422);
  }
  for (const [id, value] of Object.entries(answer)) validateMcpFieldValue(value, properties[id]);
}

function validateMcpFieldValue(value, schemaInput) {
  const schema = record(schemaInput, 'codex_question_private_schema_invalid');
  if (schema.type === 'string' && typeof value === 'string') {
    requireAdvertisedMcpOptions([value], mcpStringOptions(schema));
    return;
  }
  if (schema.type === 'number' && typeof value === 'number' && Number.isFinite(value)) return;
  if (schema.type === 'integer' && Number.isSafeInteger(value)) return;
  if (schema.type === 'boolean' && typeof value === 'boolean') return;
  if (
    schema.type === 'array'
    && Array.isArray(value)
    && value.every((item) => typeof item === 'string')
  ) {
    requireAdvertisedMcpOptions(value, mcpArrayOptions(schema));
    return;
  }
  throw new ChatRuntimeError('codex_question_answer_type_mismatch', 422);
}

function mcpStringOptions(schema) {
  if (schema.oneOf !== undefined) return mcpConstOptions(schema.oneOf);
  return schema.enum === undefined ? null : mcpEnumOptions(schema.enum);
}

function mcpArrayOptions(schema) {
  const items = record(schema.items, 'codex_question_private_schema_invalid');
  if (items.type === 'string' && items.enum !== undefined) {
    return mcpEnumOptions(items.enum);
  }
  return mcpConstOptions(items.anyOf === undefined ? items.oneOf : items.anyOf);
}

function mcpEnumOptions(input) {
  return normalizedMcpOptions(input, (value) => value);
}

function mcpConstOptions(input) {
  return normalizedMcpOptions(input, (value) => (
    record(value, 'codex_question_private_schema_invalid').const
  ));
}

function normalizedMcpOptions(input, readValue) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new ChatRuntimeError('codex_question_private_schema_invalid', 500);
  }
  const values = input.map(readValue).map((value) => {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized) {
      throw new ChatRuntimeError('codex_question_private_schema_invalid', 500);
    }
    return normalized;
  });
  if (new Set(values).size !== values.length) {
    throw new ChatRuntimeError('codex_question_private_schema_invalid', 500);
  }
  return new Set(values);
}

function requireAdvertisedMcpOptions(values, available) {
  if (available && values.some((value) => !available.has(value))) {
    throw new ChatRuntimeError('codex_question_answer_not_available', 422);
  }
}

function questionAction(value) {
  if (!QUESTION_ACTIONS.has(value)) {
    throw new ChatRuntimeError('invalid_question_action', 422, { action: value });
  }
  return value;
}

function requiredText(value, code) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new ChatRuntimeError(code, 422);
  return text;
}

function record(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ChatRuntimeError(code, 422);
  }
  return value;
}

function clone(value) {
  try {
    return structuredClone(value);
  } catch (_error) {
    throw new ChatRuntimeError('codex_interaction_resolution_invalid', 422);
  }
}

module.exports = { adaptCodexServerResponse };

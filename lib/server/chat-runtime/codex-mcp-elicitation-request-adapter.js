'use strict';

const {
  array,
  codexError,
  nonEmptyStringArray,
  optionalText,
  record,
  requiredText,
  requireUniqueIds,
  safeFieldId
} = require('./codex-interaction-adapter-support');

const AUTO_MIN_MS = 5_000;
const AUTO_MAX_MS = 300_000;

function adaptMcpElicitation(params) {
  if (params.mode === 'openai/form') {
    throw codexError('unsupported_codex_mcp_openai_form_schema');
  }
  if (params.mode === 'url') return adaptMcpUrl(params);
  if (params.mode === 'form') return adaptMcpForm(params);
  throw codexError('unsupported_codex_mcp_mode');
}

function adaptMcpForm(params) {
  const schema = record(params.requestedSchema, 'unsupported_codex_mcp_form_schema');
  if (schema.type !== 'object') throw codexError('unsupported_codex_mcp_form_schema');
  const properties = record(schema.properties, 'unsupported_codex_mcp_form_schema');
  const required = mcpRequiredFields(schema.required, properties);
  const fields = Object.entries(properties).map(([id, definition]) => (
    projectMcpField(id, definition, required.has(id))
  ));
  return {
    kind: 'question',
    payload: mcpQuestionPayload(params, fields, 'object')
  };
}

function projectMcpField(id, input, required) {
  const safeId = safeFieldId(id, 'unsupported_codex_mcp_form_schema');
  const schema = record(input, 'unsupported_codex_mcp_form_schema');
  const projection = mcpFieldProjection(schema);
  const description = optionalText(schema.description);
  return {
    id: safeId,
    label: optionalText(schema.title) || safeId,
    ...(description ? { description } : {}),
    type: projection.type,
    required,
    allowOther: false,
    secret: false,
    ...(projection.options ? { options: projection.options } : {})
  };
}

function mcpFieldProjection(schema) {
  if (schema.type === 'string' && (schema.enum || schema.oneOf)) {
    return { type: 'single_select', options: mcpEnumOptions(schema) };
  }
  if (schema.type === 'array') {
    return { type: 'multi_select', options: mcpMultiSelectOptions(schema.items) };
  }
  const primitive = {
    string: 'text',
    number: 'number',
    integer: 'integer',
    boolean: 'boolean'
  }[schema.type];
  if (!primitive) throw codexError('unsupported_codex_mcp_form_schema');
  return { type: primitive };
}

function mcpEnumOptions(schema) {
  if (schema.oneOf !== undefined) return titledOptions(schema.oneOf);
  const values = nonEmptyStringArray(schema.enum, 'unsupported_codex_mcp_form_schema');
  const names = schema.enumNames === undefined
    ? values
    : nonEmptyStringArray(schema.enumNames, 'unsupported_codex_mcp_form_schema');
  if (names.length !== values.length) throw codexError('unsupported_codex_mcp_form_schema');
  return uniqueOptions(values.map((value, index) => ({ value, label: names[index] })));
}

function mcpMultiSelectOptions(input) {
  const items = record(input, 'unsupported_codex_mcp_form_schema');
  if (items.type === 'string' && items.enum !== undefined) {
    const values = nonEmptyStringArray(items.enum, 'unsupported_codex_mcp_form_schema');
    return uniqueOptions(values.map((value) => ({ value, label: value })));
  }
  return titledOptions(items.anyOf === undefined ? items.oneOf : items.anyOf);
}

function titledOptions(input) {
  const options = array(input, 'unsupported_codex_mcp_form_schema').map((value) => {
    const option = record(value, 'unsupported_codex_mcp_form_schema');
    return {
      value: requiredText(option.const, 'unsupported_codex_mcp_form_schema'),
      label: requiredText(option.title, 'unsupported_codex_mcp_form_schema')
    };
  });
  if (options.length === 0) throw codexError('unsupported_codex_mcp_form_schema');
  return uniqueOptions(options);
}

function uniqueOptions(options) {
  requireUniqueIds(options, 'unsupported_codex_mcp_form_schema', 'value');
  return options;
}

function mcpRequiredFields(input, properties) {
  if (input === undefined) return new Set();
  const values = nonEmptyStringArray(input, 'unsupported_codex_mcp_form_schema');
  const required = new Set(values);
  if (required.size !== values.length) throw codexError('unsupported_codex_mcp_form_schema');
  if (values.some((id) => !Object.prototype.hasOwnProperty.call(properties, id))) {
    throw codexError('unsupported_codex_mcp_form_schema');
  }
  return required;
}

function adaptMcpUrl(params) {
  return {
    kind: 'question',
    payload: mcpQuestionPayload(params, [], 'none', {
      link: { label: 'Open link', url: requiredText(params.url, 'invalid_codex_mcp_url') }
    })
  };
}

function mcpQuestionPayload(params, fields, answerShape, presentationExtra = {}) {
  const message = optionalText(params.message);
  const payload = {
    presentation: {
      title: answerShape === 'none' ? 'Action required' : 'Input required',
      ...(message ? { message } : {}),
      ...presentationExtra
    },
    fields,
    actions: ['submit', 'decline', 'cancel'],
    answerShape,
    confirmUnanswered: false
  };
  const autoResolution = mcpAutoResolution(params._meta);
  if (autoResolution) payload.autoResolution = autoResolution;
  return payload;
}

function mcpAutoResolution(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input.autoResolutionMs;
  if (!Number.isSafeInteger(value) || value < AUTO_MIN_MS || value > AUTO_MAX_MS) {
    return null;
  }
  return {
    mode: 'countdown',
    countdownMs: value,
    onExpire: 'decline',
    snooze: 'disable'
  };
}

module.exports = { adaptMcpElicitation };

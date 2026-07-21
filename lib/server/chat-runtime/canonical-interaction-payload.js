'use strict';

const { ChatRuntimeError } = require('./contracts');

const APPROVAL_KEYS = new Set(['presentation', 'choices']);
const QUESTION_KEYS = new Set([
  'presentation', 'fields', 'actions', 'answerShape',
  'confirmUnanswered', 'autoResolution'
]);
const APPROVAL_PRESENTATION_KEYS = new Set(['title', 'description', 'detail', 'annotations']);
const QUESTION_PRESENTATION_KEYS = new Set(['title', 'message', 'link']);
const CHOICE_KEYS = new Set(['id', 'label', 'description', 'intent']);
const FIELD_KEYS = new Set([
  'id', 'label', 'header', 'description', 'type', 'required',
  'allowOther', 'secret', 'options'
]);
const OPTION_KEYS = new Set(['value', 'label', 'description']);
const LINK_KEYS = new Set(['label', 'url']);
const ANNOTATION_KEYS = new Set(['label', 'value']);
const AUTO_RESOLUTION_KEYS = new Set([
  'mode', 'inactivityMs', 'countdownMs', 'onExpire', 'snooze'
]);
const CHOICE_INTENTS = new Set(['accept', 'deny', 'cancel', 'neutral']);
const FIELD_TYPES = new Set([
  'text', 'number', 'integer', 'boolean', 'single_select', 'multi_select'
]);
const QUESTION_ACTIONS = new Set(['submit', 'decline', 'cancel']);
const ANSWER_SHAPES = new Set(['answers', 'object', 'none']);
const AUTO_MODES = new Set(['inactivity_countdown', 'countdown']);
const AUTO_EXPIRE_ACTIONS = new Set(['submit_empty', 'decline']);
const AUTO_SNOOZE_ACTIONS = new Set(['disable', 'restart']);

function normalizeCanonicalInteractionPayload(kind, input) {
  if (kind === 'approval') return normalizeApprovalPayload(input);
  if (kind === 'question' || kind === 'plan_confirmation') {
    return normalizeQuestionPayload(input);
  }
  throw invalid('kind', { kind });
}

function normalizeApprovalPayload(input) {
  const payload = strictRecord(input, APPROVAL_KEYS, 'approval');
  const choices = normalizeUniqueList(payload.choices, normalizeChoice, 'approval.choices');
  if (choices.length === 0) throw invalid('approval.choices');
  return {
    presentation: normalizePresentation(
      payload.presentation,
      APPROVAL_PRESENTATION_KEYS,
      'approval.presentation'
    ),
    choices
  };
}

function normalizeQuestionPayload(input) {
  const payload = strictRecord(input, QUESTION_KEYS, 'question');
  const fields = normalizeUniqueList(payload.fields, normalizeField, 'question.fields');
  const answerShape = enumValue(payload.answerShape, ANSWER_SHAPES, 'question.answerShape');
  if (answerShape === 'none' && fields.length > 0) throw invalid('question.fields');
  if (answerShape !== 'none' && fields.length === 0) throw invalid('question.fields');
  const normalized = {
    presentation: normalizePresentation(
      payload.presentation,
      QUESTION_PRESENTATION_KEYS,
      'question.presentation'
    ),
    fields,
    actions: normalizeEnumList(payload.actions, QUESTION_ACTIONS, 'question.actions'),
    answerShape,
    confirmUnanswered: booleanValue(payload.confirmUnanswered, 'question.confirmUnanswered')
  };
  if (payload.autoResolution !== undefined) {
    normalized.autoResolution = normalizeAutoResolution(payload.autoResolution);
  }
  return normalized;
}

function normalizePresentation(input, allowedKeys, path) {
  const source = strictRecord(input, allowedKeys, path);
  const result = { title: text(source.title, `${path}.title`) };
  copyOptionalText(result, source, 'description', path);
  copyOptionalText(result, source, 'detail', path);
  copyOptionalText(result, source, 'message', path);
  if (source.annotations !== undefined) {
    result.annotations = list(source.annotations, `${path}.annotations`).map((value, index) => {
      const annotationPath = `${path}.annotations[${index}]`;
      const annotation = strictRecord(value, ANNOTATION_KEYS, annotationPath);
      return {
        label: text(annotation.label, `${annotationPath}.label`),
        value: text(annotation.value, `${annotationPath}.value`)
      };
    });
  }
  if (source.link !== undefined) result.link = normalizeLink(source.link, `${path}.link`);
  return result;
}

function normalizeLink(input, path) {
  const link = strictRecord(input, LINK_KEYS, path);
  return {
    label: text(link.label, `${path}.label`),
    url: safeWebUrl(link.url, `${path}.url`)
  };
}

function safeWebUrl(value, path) {
  const source = text(value, path);
  let url;
  try {
    url = new URL(source);
  } catch (_error) {
    throw invalid(path);
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw invalid(path);
  return url.toString();
}

function normalizeChoice(input, index) {
  const path = `approval.choices[${index}]`;
  const choice = strictRecord(input, CHOICE_KEYS, path);
  const result = {
    id: text(choice.id, `${path}.id`),
    label: text(choice.label, `${path}.label`),
    intent: enumValue(choice.intent, CHOICE_INTENTS, `${path}.intent`)
  };
  copyOptionalText(result, choice, 'description', path);
  return result;
}

function normalizeField(input, index) {
  const path = `question.fields[${index}]`;
  const field = strictRecord(input, FIELD_KEYS, path);
  const type = enumValue(field.type, FIELD_TYPES, `${path}.type`);
  const result = {
    id: text(field.id, `${path}.id`),
    label: text(field.label, `${path}.label`),
    type,
    required: booleanValue(field.required, `${path}.required`),
    allowOther: booleanValue(field.allowOther, `${path}.allowOther`),
    secret: booleanValue(field.secret, `${path}.secret`)
  };
  copyOptionalText(result, field, 'header', path);
  copyOptionalText(result, field, 'description', path);
  const select = type === 'single_select' || type === 'multi_select';
  if (select) result.options = normalizeOptions(field.options, path);
  if (!select && field.options !== undefined) throw invalid(`${path}.options`);
  if (type !== 'single_select' && result.allowOther) throw invalid(`${path}.allowOther`);
  return orderedField(result);
}

function orderedField(field) {
  const result = { id: field.id, label: field.label };
  for (const key of ['header', 'description']) {
    if (field[key] !== undefined) result[key] = field[key];
  }
  result.type = field.type;
  result.required = field.required;
  result.allowOther = field.allowOther;
  result.secret = field.secret;
  if (field.options !== undefined) result.options = field.options;
  return result;
}

function normalizeOptions(input, fieldPath) {
  const options = normalizeUniqueList(input, (value, index) => {
    const path = `${fieldPath}.options[${index}]`;
    const option = strictRecord(value, OPTION_KEYS, path);
    const result = {
      value: text(option.value, `${path}.value`),
      label: text(option.label, `${path}.label`)
    };
    copyOptionalText(result, option, 'description', path);
    return result;
  }, `${fieldPath}.options`, 'value');
  if (options.length === 0) throw invalid(`${fieldPath}.options`);
  return options;
}

function normalizeAutoResolution(input) {
  const path = 'question.autoResolution';
  const source = strictRecord(input, AUTO_RESOLUTION_KEYS, path);
  const mode = enumValue(source.mode, AUTO_MODES, `${path}.mode`);
  const result = {
    mode,
    countdownMs: positiveInteger(source.countdownMs, `${path}.countdownMs`),
    onExpire: enumValue(source.onExpire, AUTO_EXPIRE_ACTIONS, `${path}.onExpire`),
    snooze: enumValue(source.snooze, AUTO_SNOOZE_ACTIONS, `${path}.snooze`)
  };
  if (mode === 'inactivity_countdown') {
    result.inactivityMs = nonNegativeInteger(source.inactivityMs, `${path}.inactivityMs`);
  } else if (source.inactivityMs !== undefined) {
    throw invalid(`${path}.inactivityMs`);
  }
  return orderedAutoResolution(result);
}

function orderedAutoResolution(value) {
  const result = { mode: value.mode };
  if (value.inactivityMs !== undefined) result.inactivityMs = value.inactivityMs;
  result.countdownMs = value.countdownMs;
  result.onExpire = value.onExpire;
  result.snooze = value.snooze;
  return result;
}

function normalizeUniqueList(input, normalize, path, identityKey = 'id') {
  const values = list(input, path).map(normalize);
  const identities = values.map((value) => value[identityKey]);
  if (new Set(identities).size !== identities.length) throw invalid(path);
  return values;
}

function normalizeEnumList(input, allowed, path) {
  const values = list(input, path).map((value, index) => (
    enumValue(value, allowed, `${path}[${index}]`)
  ));
  if (values.length === 0 || new Set(values).size !== values.length) throw invalid(path);
  return values;
}

function strictRecord(input, allowedKeys, path) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid(path);
  const unknown = Object.keys(input).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) throw invalid(path, { unknown });
  return input;
}

function list(input, path) {
  if (!Array.isArray(input)) throw invalid(path);
  return input;
}

function copyOptionalText(target, source, key, path) {
  if (source[key] !== undefined) target[key] = text(source[key], `${path}.${key}`);
}

function text(value, path) {
  if (typeof value !== 'string' || !value.trim()) throw invalid(path);
  return value.trim();
}

function booleanValue(value, path) {
  if (typeof value !== 'boolean') throw invalid(path);
  return value;
}

function positiveInteger(value, path) {
  if (!Number.isSafeInteger(value) || value < 1) throw invalid(path);
  return value;
}

function nonNegativeInteger(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) throw invalid(path);
  return value;
}

function enumValue(value, allowed, path) {
  if (!allowed.has(value)) throw invalid(path, { value });
  return value;
}

function invalid(path, details = {}) {
  return new ChatRuntimeError('invalid_canonical_interaction_payload', 422, {
    path,
    ...details
  });
}

module.exports = { normalizeCanonicalInteractionPayload };

'use strict';

const { ChatRuntimeError } = require('./contract-values');

const ROLES = new Set(['user', 'assistant', 'system']);
const PLAN_STATES = new Set(['draft', 'proposed', 'accepted', 'rejected']);
const PLAN_STEP_STATUSES = new Set(['pending', 'in_progress', 'completed']);
const TERMINAL_STREAMS = new Set(['stdin', 'stdout', 'stderr']);
const NOTICE_LEVELS = new Set(['info', 'warning', 'success']);
const LEGACY_NULL_OPTIONAL_FIELDS = new Map([
  ['tool', ['exitCode']],
  ['shell', ['output', 'exitCode', 'processId']]
]);

const VALIDATORS = new Map([
  ['message', validateMessage],
  ['reasoning', () => {}],
  ['plan', validatePlan],
  ['tool', validateTool],
  ['shell', validateShell],
  ['diff', (detail) => optionalTextArray(detail, 'paths')],
  ['file_change', (detail) => requiredArray(detail, 'changes')],
  ['terminal', (detail) => enumField(detail, 'stream', TERMINAL_STREAMS)],
  ['question', (detail) => requiredTextField(detail, 'interactionId')],
  ['approval', validateApproval],
  ['subagent', (detail) => requiredTextField(detail, 'agentId')],
  ['command', validateCommand],
  ['attachment', validateAttachment],
  ['artifact', validateArtifact],
  ['notice', (detail) => enumField(detail, 'level', NOTICE_LEVELS)],
  ['error', (detail) => requiredTextField(detail, 'code')]
]);

function validateMessage(detail) {
  enumField(detail, 'role', ROLES);
  normalizeOptionalTextField(detail, 'phase');
  normalizeOptionalTextField(detail, 'model');
}

function normalizeTimelineDetail(kind, input) {
  const detail = cloneRecord(input);
  omitLegacyNullOptionalFields(kind, detail);
  const validate = VALIDATORS.get(kind);
  if (!validate) throw new ChatRuntimeError('unknown_timeline_kind', 422, { kind });
  validate(detail);
  return detail;
}

function omitLegacyNullOptionalFields(kind, detail) {
  const fields = LEGACY_NULL_OPTIONAL_FIELDS.get(kind) || [];
  fields.forEach((field) => {
    if (detail[field] === null) delete detail[field];
  });
}

function validateTool(detail) {
  requiredTextField(detail, 'name');
  optionalIntegerField(detail, 'exitCode');
}

function validateShell(detail) {
  requiredTextField(detail, 'command');
  optionalStringField(detail, 'output');
  optionalIntegerField(detail, 'exitCode');
  optionalNonNegativeIntegerField(detail, 'processId');
}

function validateApproval(detail) {
  requiredTextField(detail, 'interactionId');
  requiredTextField(detail, 'action');
}

function validatePlan(detail) {
  optionalEnumField(detail, 'state', PLAN_STATES);
  if (detail.steps === undefined) return;
  if (!Array.isArray(detail.steps) || detail.steps.some((step) => !isPlanStep(step))) {
    invalidField('steps');
  }
}

function isPlanStep(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Boolean(String(value.step || '').trim()) && PLAN_STEP_STATUSES.has(value.status);
}

function validateCommand(detail) {
  requiredTextField(detail, 'commandId');
  requiredTextField(detail, 'command');
}

function validateAttachment(detail) {
  requiredTextField(detail, 'name');
  requiredTextField(detail, 'mimeType');
}

function validateArtifact(detail) {
  requiredTextField(detail, 'artifactId');
  validateAttachment(detail);
}

function enumField(detail, key, values) {
  const value = requiredTextField(detail, key);
  if (!values.has(value)) invalidField(key);
}

function optionalEnumField(detail, key, values) {
  if (detail[key] === undefined) return;
  enumField(detail, key, values);
}

function optionalTextArray(detail, key) {
  if (detail[key] === undefined) return;
  if (!Array.isArray(detail[key]) || detail[key].some((value) => typeof value !== 'string')) {
    invalidField(key);
  }
}

function optionalStringField(detail, key) {
  if (detail[key] !== undefined && typeof detail[key] !== 'string') invalidField(key);
}

function normalizeOptionalTextField(detail, key) {
  if (detail[key] === undefined) return;
  if (typeof detail[key] !== 'string') invalidField(key);
  const value = detail[key].trim();
  if (value) detail[key] = value;
  else delete detail[key];
}

function optionalIntegerField(detail, key) {
  if (detail[key] !== undefined && !Number.isSafeInteger(detail[key])) invalidField(key);
}

function optionalNonNegativeIntegerField(detail, key) {
  optionalIntegerField(detail, key);
  if (detail[key] !== undefined && detail[key] < 0) invalidField(key);
}

function requiredArray(detail, key) {
  if (!Array.isArray(detail[key])) invalidField(key);
}

function requiredTextField(detail, key) {
  const value = String(detail[key] || '').trim();
  if (!value) invalidField(key);
  return value;
}

function cloneRecord(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ChatRuntimeError('timeline_detail_invalid', 422);
  }
  try {
    return structuredClone(input);
  } catch (_error) {
    throw new ChatRuntimeError('timeline_detail_invalid', 422);
  }
}

function invalidField(field) {
  throw new ChatRuntimeError('timeline_detail_invalid', 422, { field });
}

module.exports = { normalizeTimelineDetail };

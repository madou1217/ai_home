'use strict';

const { ChatRuntimeError } = require('./contracts');

const UNSAFE_FIELD_IDS = new Set(['__proto__', 'constructor', 'prototype']);

function safeFieldId(value, code) {
  const id = requiredText(value, code);
  if (UNSAFE_FIELD_IDS.has(id)) throw codexError(code);
  return id;
}

function requireUniqueIds(values, code, key = 'id') {
  const identities = values.map((value) => value[key]);
  if (new Set(identities).size !== identities.length) throw codexError(code);
}

function nonEmptyStringArray(input, code) {
  const values = array(input, code).map((value) => requiredText(value, code));
  if (values.length === 0) throw codexError(code);
  return values;
}

function array(value, code) {
  if (!Array.isArray(value)) throw codexError(code);
  return value;
}

function record(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw codexError(code);
  }
  return value;
}

function requiredText(value, code) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw codexError(code);
  return normalized;
}

function optionalText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function clone(value) {
  try {
    return structuredClone(value);
  } catch (_error) {
    throw codexError('invalid_codex_interaction_request');
  }
}

function codexError(code, details) {
  return new ChatRuntimeError(code, 422, details);
}

module.exports = {
  array,
  clone,
  codexError,
  nonEmptyStringArray,
  optionalText,
  record,
  requiredText,
  requireUniqueIds,
  safeFieldId
};

'use strict';

const crypto = require('node:crypto');
const { readJsonValue, writeJsonValue } = require('./app-state-store');
const { validateUpstreamErrorRules } = require('../account/upstream-error-rules');

const UPSTREAM_ERROR_MAPPING_KEY = 'upstream-error-mapping-groups';
const UPSTREAM_ERROR_MAPPING_VERSION = 1;
const MAX_GROUPS = 100;

function normalizeId(value) {
  const id = String(value == null ? '' : value).trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : '';
}

function generateMappingId() {
  return `uem_${crypto.randomBytes(6).toString('hex')}`;
}

function normalizeText(value, maxLength) {
  const text = String(value == null ? '' : value).trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeProvider(value) {
  const provider = String(value == null ? '' : value).trim().toLowerCase();
  return provider || 'all';
}

function normalizeGroup(value, fallback = {}) {
  const source = { ...(fallback || {}), ...(value || {}) };
  const id = normalizeId(source.id) || normalizeId(fallback.id) || generateMappingId();
  const name = normalizeText(source.name, 80);
  if (!name) {
    const error = new Error('mapping_group_name_required');
    error.code = 'mapping_group_name_required';
    throw error;
  }
  const rules = validateUpstreamErrorRules(source.rules);
  if (!rules.length) {
    const error = new Error('mapping_group_rules_required');
    error.code = 'mapping_group_rules_required';
    throw error;
  }
  return {
    id,
    name,
    description: normalizeText(source.description, 240),
    provider: normalizeProvider(source.provider),
    enabled: source.enabled !== false,
    rules
  };
}

function normalizeMappingData(value) {
  const source = value && typeof value === 'object' ? value : {};
  const groups = Array.isArray(source.groups) ? source.groups : [];
  if (groups.length > MAX_GROUPS) {
    const error = new Error('mapping_group_limit_exceeded');
    error.code = 'mapping_group_limit_exceeded';
    throw error;
  }
  const seen = new Set();
  const normalized = groups.map((group) => normalizeGroup(group)).filter((group) => {
    if (seen.has(group.id)) return false;
    seen.add(group.id);
    return true;
  });
  return {
    version: UPSTREAM_ERROR_MAPPING_VERSION,
    groups: normalized
  };
}

function readUpstreamErrorMappingGroups(fs, aiHomeDir, options = {}) {
  try {
    return normalizeMappingData(readJsonValue(fs, aiHomeDir, UPSTREAM_ERROR_MAPPING_KEY, options));
  } catch (_error) {
    return { version: UPSTREAM_ERROR_MAPPING_VERSION, groups: [] };
  }
}

function saveUpstreamErrorMappingGroups(fs, aiHomeDir, value, options = {}) {
  const normalized = normalizeMappingData(value);
  if (!writeJsonValue(fs, aiHomeDir, UPSTREAM_ERROR_MAPPING_KEY, normalized, options)) {
    const error = new Error('mapping_group_write_failed');
    error.code = 'mapping_group_write_failed';
    throw error;
  }
  return normalized;
}

module.exports = {
  MAX_GROUPS,
  UPSTREAM_ERROR_MAPPING_KEY,
  UPSTREAM_ERROR_MAPPING_VERSION,
  generateMappingId,
  normalizeGroup,
  normalizeMappingData,
  readUpstreamErrorMappingGroups,
  saveUpstreamErrorMappingGroups
};

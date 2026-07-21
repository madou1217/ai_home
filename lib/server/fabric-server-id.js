'use strict';

const MAX_FABRIC_SERVER_ID_LENGTH = 64;
const FABRIC_SERVER_ID_PATTERN = /^[a-z0-9][a-z0-9_.-]{1,63}$/;

function normalizeFabricServerId(value) {
  const normalized = String(value || '').trim().toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '');
  return normalized.length <= MAX_FABRIC_SERVER_ID_LENGTH
    && FABRIC_SERVER_ID_PATTERN.test(normalized)
    ? normalized
    : '';
}

function validateCanonicalFabricServerId(value) {
  const raw = String(value || '').trim();
  return raw === raw.toLowerCase()
    && raw.length <= MAX_FABRIC_SERVER_ID_LENGTH
    && FABRIC_SERVER_ID_PATTERN.test(raw)
    ? raw
    : '';
}

module.exports = {
  MAX_FABRIC_SERVER_ID_LENGTH,
  normalizeFabricServerId,
  validateCanonicalFabricServerId
};

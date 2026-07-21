'use strict';

const crypto = require('node:crypto');
const os = require('node:os');
const {
  readJsonValue,
  writeJsonValue
} = require('./app-state-store');
const {
  validateCanonicalFabricServerId
} = require('./fabric-server-id');

const SERVER_IDENTITY_KEY = 'server:identity';

function normalizeText(value, maxLength) {
  const text = String(value == null ? '' : value).trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeServerName(value) {
  return normalizeText(value, 120).replace(/\.local$/i, '') || 'AI Home Server';
}

function normalizeServerId(value) {
  const id = validateCanonicalFabricServerId(String(value || '').trim().toLowerCase());
  return /^server-[a-z0-9][a-z0-9-]{7,56}$/.test(id) ? id : '';
}

function normalizeStoredIdentity(value) {
  const source = value && typeof value === 'object' ? value : {};
  const id = normalizeServerId(source.id);
  if (!id) return null;
  return {
    id,
    name: normalizeServerName(source.name)
  };
}

function loadOrCreateServerIdentity(input = {}, deps = {}) {
  const fs = input.fs;
  const aiHomeDir = normalizeText(input.aiHomeDir, 2048);
  const read = deps.readJsonValue || readJsonValue;
  const write = deps.writeJsonValue || writeJsonValue;
  const stored = read(fs, aiHomeDir, SERVER_IDENTITY_KEY);
  const existing = normalizeStoredIdentity(stored);
  if (existing) return existing;
  if (stored !== null && stored !== undefined) {
    const error = new Error('invalid_stored_server_identity');
    error.code = 'invalid_stored_server_identity';
    throw error;
  }

  const randomUUID = deps.randomUUID || crypto.randomUUID;
  const hostname = typeof deps.hostname === 'function' ? deps.hostname() : os.hostname();
  const identity = {
    id: normalizeServerId(`server-${randomUUID()}`),
    name: normalizeServerName(hostname)
  };
  if (!identity.id) throw new Error('invalid_generated_server_identity');
  write(fs, aiHomeDir, SERVER_IDENTITY_KEY, identity);
  return identity;
}

module.exports = {
  SERVER_IDENTITY_KEY,
  loadOrCreateServerIdentity,
  normalizeServerId,
  normalizeServerName
};

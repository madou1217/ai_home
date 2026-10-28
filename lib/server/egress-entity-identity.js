'use strict';

// Stable identity helpers for egress domain entities. Runtime lane names (for
// example node-1) are deliberately excluded from these identities.

const crypto = require('node:crypto');

function identityError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function normalizeProtocol(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeServer(value) {
  return String(value || '')
    .trim()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
}

function normalizePort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0;
}

function stableEndpoint(input = {}, errorCode = 'invalid_stable_node_fields') {
  const protocol = normalizeProtocol(input.protocol);
  const server = normalizeServer(input.server);
  const port = normalizePort(input.port);
  if (!protocol || !server || !port) throw identityError(errorCode);
  return { protocol, server, port };
}

function buildExitIdentity(input = {}) {
  const { protocol, server, port } = stableEndpoint(input, 'invalid_stable_exit_fields');
  return `${protocol}|${server}|${port}`;
}

function buildNodeEntityId(input = {}) {
  const endpoint = stableEndpoint(input);
  // The persisted NodeEntity does not retain credential references. Keep the
  // identity endpoint based so normalization is round-trip stable even when a
  // caller only has the public entity shape on the second pass.
  const fingerprint = JSON.stringify(endpoint);
  return `node_${crypto.createHash('sha256').update(fingerprint).digest('hex').slice(0, 24)}`;
}

module.exports = {
  buildExitIdentity,
  buildNodeEntityId,
  normalizePort,
  normalizeProtocol,
  normalizeServer
};

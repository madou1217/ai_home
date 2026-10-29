'use strict';

// Stable identity shared by the runtime node projection and the account-first
// egress domain. Runtime names such as node-1 are intentionally excluded.

const crypto = require('node:crypto');

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

function buildNodeEntityId(input = {}) {
  const endpoint = {
    protocol: normalizeProtocol(input.protocol),
    server: normalizeServer(input.server),
    port: normalizePort(input.port)
  };
  if (!endpoint.protocol || !endpoint.server || !endpoint.port) return '';
  return `node_${crypto.createHash('sha256').update(JSON.stringify(endpoint)).digest('hex').slice(0, 24)}`;
}

module.exports = { buildNodeEntityId };

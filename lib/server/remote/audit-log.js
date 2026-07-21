'use strict';

const path = require('node:path');
const { resolveAihLogPath } = require('../../runtime/aih-storage-layout');
const { appendBoundedJsonLine } = require('../bounded-log-writer');

const REMOTE_AUDIT_LOG_FILE = 'remote-audit.jsonl';
const MAX_TEXT_LENGTH = 512;

function getRemoteAuditLogPath(aiHomeDir) {
  return resolveAihLogPath(aiHomeDir, 'remote', REMOTE_AUDIT_LOG_FILE);
}

function normalizeText(value, maxLength = MAX_TEXT_LENGTH) {
  const text = String(value == null ? '' : value).trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalizeStringList(value, maxItems = 8, maxLength = 64) {
  return (Array.isArray(value) ? value : [])
    .map((item) => normalizeText(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function normalizeRejectedTransports(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => {
      const source = item && typeof item === 'object' ? item : {};
      return {
        id: normalizeText(source.id, 128),
        kind: normalizeText(source.kind, 64),
        reason: normalizeText(source.reason, 128)
      };
    })
    .filter((item) => item.id || item.kind || item.reason)
    .slice(0, 8);
}

function sanitizeAuditEvent(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    timestamp: normalizeText(source.timestamp || new Date().toISOString(), 64),
    requestId: normalizeText(source.requestId, 128),
    nodeId: normalizeText(source.nodeId, 128),
    rpc: normalizeText(source.rpc, 128),
    scope: normalizeText(source.scope, 128),
    method: normalizeText(source.method || 'GET', 16),
    pathname: normalizeText(source.pathname, 512),
    transportId: normalizeText(source.transportId, 128),
    transportKind: normalizeText(source.transportKind, 64),
    transportPurpose: normalizeText(source.transportPurpose, 64),
    fallbackUsed: Boolean(source.fallbackUsed),
    fallbackFrom: normalizeStringList(source.fallbackFrom),
    rejectedTransports: normalizeRejectedTransports(source.rejectedTransports),
    status: normalizeNumber(source.status),
    ok: Boolean(source.ok),
    durationMs: Math.max(0, normalizeNumber(source.durationMs)),
    error: normalizeText(source.error, 512)
  };
}

function appendRemoteAuditEvent(event, deps = {}) {
  const { fs, aiHomeDir } = deps;
  const filePath = getRemoteAuditLogPath(aiHomeDir);
  if (!fs || !filePath) return null;
  const entry = sanitizeAuditEvent(event);
  return appendBoundedJsonLine(fs, filePath, entry, { path }) ? entry : null;
}

module.exports = {
  REMOTE_AUDIT_LOG_FILE,
  getRemoteAuditLogPath,
  sanitizeAuditEvent,
  appendRemoteAuditEvent
};

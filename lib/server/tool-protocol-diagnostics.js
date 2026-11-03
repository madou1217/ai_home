'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const osPath = require('node:path');
const { resolveHostHomeDir } = require('../runtime/host-home');
const { resolveAihLogPath } = require('../runtime/aih-storage-layout');
const { appendBoundedJsonLine } = require('./bounded-log-writer');

const TOOL_PROTOCOL_DIAGNOSTIC_FILE = 'tool-protocol-diagnostics.jsonl';
const MAX_TEXT_LENGTH = 512;
const MAX_KEYS = 40;
const PREVIEW_HASH_LENGTH = 16;

function normalizeText(value, maxLength = MAX_TEXT_LENGTH) {
  const text = String(value == null ? '' : value).trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeTextList(value, maxItems = MAX_KEYS) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const items = [];
  value.forEach((item) => {
    const text = normalizeText(item, 128);
    if (!text || seen.has(text)) return;
    seen.add(text);
    items.push(text);
  });
  return items.slice(0, Math.max(0, Number(maxItems) || MAX_KEYS));
}

function hashText(value, length = PREVIEW_HASH_LENGTH) {
  const text = String(value == null ? '' : value);
  if (!text) return '';
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, length);
}

function stringifyRawArgs(rawArgs) {
  if (typeof rawArgs === 'string') return rawArgs;
  try {
    return JSON.stringify(rawArgs && typeof rawArgs === 'object' ? rawArgs : {});
  } catch (_error) {
    return '{}';
  }
}

function summarizePreviewValue(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    return {
      type: 'string',
      length: value.length,
      sha256: hashText(value)
    };
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return {
      type: 'array',
      length: value.length
    };
  }
  if (typeof value === 'object') {
    return {
      type: 'object',
      keys: Object.keys(value).slice(0, MAX_KEYS)
    };
  }
  return { type: typeof value };
}

function buildRawArgsPreview(rawArgs) {
  const source = typeof rawArgs === 'string' ? safeParseJsonObject(rawArgs) : rawArgs;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return normalizeText(JSON.stringify(summarizePreviewValue(stringifyRawArgs(rawArgs))), MAX_TEXT_LENGTH);
  }
  const preview = {};
  Object.entries(source).slice(0, MAX_KEYS).forEach(([key, value]) => {
    preview[key] = summarizePreviewValue(value);
  });
  return normalizeText(JSON.stringify(preview), MAX_TEXT_LENGTH);
}

function safeParseJsonObject(text) {
  try {
    const parsed = JSON.parse(String(text || ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function normalizeAdapterPath(value) {
  if (Array.isArray(value)) return normalizeTextList(value, 20);
  const text = normalizeText(value, 512);
  return text ? [text] : [];
}

function sanitizeToolProtocolDiagnostic(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const rawArgsText = stringifyRawArgs(source.rawArgs);
  return {
    timestamp: normalizeText(source.timestamp || new Date().toISOString(), 64),
    requestId: normalizeText(source.requestId, 128),
    provider: normalizeText(source.provider, 64),
    accountRef: normalizeText(source.accountRef, 128),
    model: normalizeText(source.model, 128),
    sourceProtocol: normalizeText(source.sourceProtocol, 128),
    targetProtocol: normalizeText(source.targetProtocol, 128),
    adapterPath: normalizeAdapterPath(source.adapterPath),
    toolName: normalizeText(source.toolName, 128),
    upstreamToolName: normalizeText(source.upstreamToolName, 128),
    action: normalizeText(source.action, 32),
    reason: normalizeText(source.reason, 128),
    argKeys: normalizeTextList(source.argKeys),
    requiredKeys: normalizeTextList(source.requiredKeys),
    normalizedKeys: normalizeTextList(source.normalizedKeys),
    missingKeys: normalizeTextList(source.missingKeys),
    unexpectedKeys: normalizeTextList(source.unexpectedKeys),
    removedKeys: normalizeTextList(source.removedKeys),
    rawArgsHash: hashText(rawArgsText, 64),
    rawArgsPreview: buildRawArgsPreview(source.rawArgs)
  };
}

function resolveDiagnosticLogPath(options = {}) {
  const filePath = normalizeText(options.toolProtocolDiagnosticFile, 2048);
  if (filePath) return filePath;
  const pathImpl = options.path || osPath;
  const aiHomeDir = normalizeText(options.aiHomeDir, 2048);
  if (aiHomeDir) return resolveAihLogPath(aiHomeDir, 'diagnostics', TOOL_PROTOCOL_DIAGNOSTIC_FILE);
  const hostHome = resolveHostHomeDir({ env: options.env || process.env, os: options.os });
  return hostHome
    ? resolveAihLogPath(pathImpl.join(hostHome, '.ai_home'), 'diagnostics', TOOL_PROTOCOL_DIAGNOSTIC_FILE)
    : '';
}

function appendToolProtocolDiagnostic(input, options = {}) {
  const entry = sanitizeToolProtocolDiagnostic(input);
  if (typeof options.appendToolProtocolDiagnostic === 'function') {
    try {
      options.appendToolProtocolDiagnostic(entry);
    } catch (_error) {}
  }
  if (options.writeToolProtocolDiagnosticFile === false) return entry;

  const fsImpl = options.fs || fs;
  const pathImpl = options.path || osPath;
  const filePath = resolveDiagnosticLogPath({ ...options, path: pathImpl });
  if (!filePath || !fsImpl) return entry;
  appendBoundedJsonLine(fsImpl, filePath, entry, {
    path: pathImpl,
    maxBytes: options.logMaxBytes
  });
  return entry;
}

module.exports = {
  TOOL_PROTOCOL_DIAGNOSTIC_FILE,
  appendToolProtocolDiagnostic,
  sanitizeToolProtocolDiagnostic
};

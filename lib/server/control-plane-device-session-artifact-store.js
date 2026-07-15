'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { resolveAihRunPath } = require('../runtime/aih-storage-layout');

const DEFAULT_ARTIFACT_TEXT_THRESHOLD = 4096;
const DEFAULT_MAX_ARTIFACTS = 500;
const artifacts = new Map();

function normalizeText(value, maxLength = 256) {
  const text = String(value == null ? '' : value).trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeContent(value) {
  return String(value == null ? '' : value);
}

function normalizeCursor(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.floor(number);
}

function byteLength(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function createArtifactError(code, statusCode = 400) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function createArtifactId(input) {
  const hash = crypto.createHash('sha1')
    .update(JSON.stringify({
      sessionId: input.sessionId,
      runId: input.runId,
      cursor: input.cursor,
      kind: input.kind,
      content: input.content
    }))
    .digest('hex')
    .slice(0, 24);
  return `art_${hash}`;
}

function artifactPreview(content, limit = 240) {
  return normalizeContent(content)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function pruneArtifacts(maxArtifacts = DEFAULT_MAX_ARTIFACTS) {
  while (artifacts.size > maxArtifacts) {
    const firstKey = artifacts.keys().next().value;
    if (!firstKey) break;
    artifacts.delete(firstKey);
  }
}

function resolveAiHomeDir(options = {}) {
  return normalizeText(options.aiHomeDir || options.ai_home_dir, 2048);
}

function getArtifactStoreDir(options = {}) {
  const aiHomeDir = resolveAiHomeDir(options);
  if (!aiHomeDir) return '';
  return resolveAihRunPath(aiHomeDir, 'control-plane', 'session-artifacts');
}

function safeArtifactId(value) {
  const artifactId = normalizeText(value, 128);
  return /^art_[a-f0-9]{12,64}$/.test(artifactId) ? artifactId : '';
}

function persistArtifact(record, options = {}) {
  const dir = getArtifactStoreDir(options);
  const artifactId = safeArtifactId(record && record.artifact && record.artifact.artifactId);
  if (!dir || !artifactId) return;
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${artifactId}.json`);
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function readPersistedArtifact(artifactId, options = {}) {
  const dir = getArtifactStoreDir(options);
  const safeId = safeArtifactId(artifactId);
  if (!dir || !safeId) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, `${safeId}.json`), 'utf8'));
  } catch (_error) {
    return null;
  }
}

function storeSessionArtifact(input = {}, deps = {}) {
  const content = normalizeContent(input.content);
  if (!content) throw createArtifactError('empty_artifact_content', 400);
  const nowMs = Math.max(0, Math.floor(Number(deps.nowMs) || Date.now()));
  const artifact = {
    artifactId: normalizeText(input.artifactId, 128),
    sessionId: normalizeText(input.sessionId || input.runId, 128),
    runId: normalizeText(input.runId, 128),
    cursor: normalizeCursor(input.cursor),
    kind: normalizeText(input.kind, 64) || 'text',
    title: normalizeText(input.title, 160) || 'Session artifact',
    mimeType: normalizeText(input.mimeType, 128) || 'text/plain',
    byteLength: byteLength(content),
    preview: artifactPreview(content),
    createdAt: nowMs
  };
  artifact.artifactId = artifact.artifactId || createArtifactId({ ...artifact, content });
  const record = {
    artifact,
    content
  };
  artifacts.set(artifact.artifactId, record);
  persistArtifact(record, deps);
  pruneArtifacts(Math.max(1, Number(deps.maxArtifacts) || DEFAULT_MAX_ARTIFACTS));
  return artifact;
}

function readSessionArtifact(payload = {}, deps = {}) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const artifactId = normalizeText(source.artifactId || source.artifact_id || source.id, 128);
  if (!artifactId) throw createArtifactError('missing_artifact_id', 400);
  const record = artifacts.get(artifactId) || readPersistedArtifact(artifactId, deps);
  if (!record) throw createArtifactError('artifact_not_found', 404);
  return {
    artifact: record.artifact,
    content: record.content
  };
}

function clearSessionArtifacts() {
  artifacts.clear();
}

function shouldExternalizeEvent(event = {}, options = {}) {
  const threshold = Math.max(256, Number(options.threshold) || DEFAULT_ARTIFACT_TEXT_THRESHOLD);
  const type = normalizeText(event && event.type, 64);
  if (type !== 'terminal-output') return false;
  return byteLength(event.text || event.content || '') > threshold;
}

function externalizeSessionEventArtifact(runId, cursor, event = {}, options = {}) {
  if (!shouldExternalizeEvent(event, options)) return event;
  const content = normalizeContent(event.text || event.content);
  const artifact = storeSessionArtifact({
    runId,
    sessionId: event.sessionId || runId,
    cursor,
    kind: 'terminal-output',
    title: 'Terminal output',
    mimeType: 'text/plain',
    content
  }, options);
  return {
    type: 'artifact_ref',
    artifact,
    artifactId: artifact.artifactId,
    artifactKind: artifact.kind,
    byteLength: artifact.byteLength,
    preview: artifact.preview
  };
}

module.exports = {
  DEFAULT_ARTIFACT_TEXT_THRESHOLD,
  clearSessionArtifacts,
  externalizeSessionEventArtifact,
  readSessionArtifact,
  shouldExternalizeEvent,
  storeSessionArtifact
};

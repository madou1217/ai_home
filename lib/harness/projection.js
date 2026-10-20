'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { writeFileAtomic } = require('../runtime/atomic-file-write');
const { ensureSharedStoreEntries } = require('../runtime/shared-store-linker');

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function normalizeId(value) {
  const text = String(value || '').trim().toLowerCase();
  return text.replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'pool';
}

function resolveHarnessProjectionRoot(input = {}) {
  const fsImpl = input.fs || nodeFs;
  const pathImpl = input.path || nodePath;
  const aiHomeDir = String(input.aiHomeDir || '').trim();
  if (!aiHomeDir) throw new Error('ai_home_dir_missing');
  const root = pathImpl.join(
    aiHomeDir,
    'run',
    'harness',
    normalizeId(input.harnessId),
    normalizeId(input.accountRef || 'pool')
  );
  fsImpl.mkdirSync(root, { recursive: true, mode: PRIVATE_DIR_MODE });
  return root;
}

function writePrivateJson(fsImpl, filePath, value) {
  writeFileAtomic(fsImpl, filePath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: PRIVATE_FILE_MODE
  });
}

function writePrivateText(fsImpl, filePath, text) {
  writeFileAtomic(fsImpl, filePath, String(text || ''), {
    mode: PRIVATE_FILE_MODE
  });
}

function linkHostSessions(input = {}) {
  const fsImpl = input.fs || nodeFs;
  const pathImpl = input.path || nodePath;
  const hostHomeDir = String(input.hostHomeDir || '').trim();
  if (!hostHomeDir) return { linked: 0, errors: ['host_home_missing'] };
  const hostRoot = pathImpl.join(hostHomeDir, ...(input.hostSegments || []));
  return ensureSharedStoreEntries({
    fs: fsImpl,
    path: pathImpl,
    projectionRoot: input.projectionRoot,
    sharedRoot: hostRoot,
    dirEntries: [['sessions']],
    fileEntries: [],
    sidecarEntries: []
  });
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : null;
}

function stringList(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean)
    : [];
}

function normalizeInputModalities(metadata, fallback) {
  const fromMetadata = stringList(metadata && metadata.modalities && metadata.modalities.input);
  const fromFallback = stringList(fallback && fallback.input);
  const source = fromMetadata.length ? fromMetadata : fromFallback;
  const input = source.filter((item) => item === 'text' || item === 'image');
  if (!input.includes('text')) input.unshift('text');
  return input;
}

function buildHarnessModelEntry(entry) {
  const id = String(entry && entry.id || '').trim();
  if (!id) return null;
  const metadata = entry.metadata && typeof entry.metadata === 'object' ? entry.metadata : {};
  const limits = metadata.limits && typeof metadata.limits === 'object' ? metadata.limits : {};
  const contextWindow = numberOrNull(limits.context);
  const maxTokens = numberOrNull(limits.output);
  const input = normalizeInputModalities(metadata, entry.modalities);
  const reasoning = metadata.capabilities && metadata.capabilities.reasoning === true;
  const cost = metadata.cost && typeof metadata.cost === 'object'
    && Number.isFinite(Number(metadata.cost.input))
    && Number.isFinite(Number(metadata.cost.output))
    ? {
        input: Number(metadata.cost.input),
        output: Number(metadata.cost.output),
        cacheRead: Number.isFinite(Number(metadata.cost.cacheRead)) ? Number(metadata.cost.cacheRead) : 0,
        cacheWrite: Number.isFinite(Number(metadata.cost.cacheWrite)) ? Number(metadata.cost.cacheWrite) : 0
      }
    : null;
  return {
    id,
    name: String(metadata.name || id).trim() || id,
    input,
    reasoning,
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxTokens ? { maxTokens } : {}),
    ...(cost ? { cost } : {})
  };
}

function buildHarnessModelEntries(catalog) {
  const models = Array.isArray(catalog && catalog.models) ? catalog.models : [];
  const byId = new Map();
  for (const entry of models) {
    const model = buildHarnessModelEntry(entry);
    if (model && !byId.has(model.id)) byId.set(model.id, model);
  }
  return Array.from(byId.values());
}

module.exports = {
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  buildHarnessModelEntries,
  buildHarnessModelEntry,
  linkHostSessions,
  normalizeInputModalities,
  resolveHarnessProjectionRoot,
  writePrivateJson,
  writePrivateText
};

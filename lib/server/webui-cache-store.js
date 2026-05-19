'use strict';

const path = require('node:path');
const { ensureDirSync } = require('./fs-compat');

function resolveCacheDeps(input = {}) {
  const nestedDeps = input && typeof input.deps === 'object' && input.deps
    ? input.deps
    : {};
  return {
    fs: input.fs || nestedDeps.fs || null,
    aiHomeDir: input.aiHomeDir || nestedDeps.aiHomeDir || ''
  };
}

function getCacheFilePath(aiHomeDir, fileName) {
  const root = String(aiHomeDir || '').trim();
  if (!root) return '';
  return path.join(root, 'cache', String(fileName || '').trim());
}

function ensureCacheStateBucket(state, key, factory) {
  if (!state[key]) {
    state[key] = typeof factory === 'function' ? factory() : {};
  }
  return state[key];
}

function readCacheJson(input, fileName) {
  const { fs, aiHomeDir } = resolveCacheDeps(input);
  const cachePath = getCacheFilePath(aiHomeDir, fileName);
  if (!cachePath || !fs || !fs.existsSync(cachePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  } catch (_error) {
    return null;
  }
}

function writeCacheJson(input, fileName, payload) {
  const { fs, aiHomeDir } = resolveCacheDeps(input);
  const cachePath = getCacheFilePath(aiHomeDir, fileName);
  if (!cachePath || !fs) return;
  ensureDirSync(fs, path.dirname(cachePath));
  fs.writeFileSync(cachePath, JSON.stringify(payload, null, 2));
}

module.exports = {
  resolveCacheDeps,
  getCacheFilePath,
  ensureCacheStateBucket,
  readCacheJson,
  writeCacheJson
};

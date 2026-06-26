'use strict';

const {
  readJsonValue,
  writeJsonValue
} = require('./app-state-store');

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
  return `app-state:${String(fileName || '').trim()}`;
}

function ensureCacheStateBucket(state, key, factory) {
  if (!state[key]) {
    state[key] = typeof factory === 'function' ? factory() : {};
  }
  return state[key];
}

function readCacheJson(input, fileName) {
  const { fs, aiHomeDir } = resolveCacheDeps(input);
  return readJsonValue(fs, aiHomeDir, `cache:${String(fileName || '').trim()}`, input);
}

function writeCacheJson(input, fileName, payload) {
  const { fs, aiHomeDir } = resolveCacheDeps(input);
  writeJsonValue(fs, aiHomeDir, `cache:${String(fileName || '').trim()}`, payload, {
    ...input,
    bestEffort: true
  });
}

module.exports = {
  resolveCacheDeps,
  getCacheFilePath,
  ensureCacheStateBucket,
  readCacheJson,
  writeCacheJson
};

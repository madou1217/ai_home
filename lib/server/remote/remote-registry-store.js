'use strict';

const { readJsonValue, writeJsonValue } = require('../app-state-store');

const REMOTE_REGISTRY_KEY = 'remote:registry';
const REGISTRY_VERSION = 1;

function nowMs() {
  return Date.now();
}

function normalizeRegistry(input) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    version: REGISTRY_VERSION,
    nodes: Array.isArray(source.nodes) ? source.nodes : [],
    transports: Array.isArray(source.transports) ? source.transports : []
  };
}

function readRemoteRegistry(deps = {}) {
  const { fs, aiHomeDir } = deps;
  return normalizeRegistry(readJsonValue(fs, aiHomeDir, REMOTE_REGISTRY_KEY));
}

function writeRemoteRegistry(registry, deps = {}) {
  const { fs, aiHomeDir } = deps;
  if (!fs || !aiHomeDir) return normalizeRegistry(registry);
  const normalized = normalizeRegistry(registry);
  writeJsonValue(fs, aiHomeDir, REMOTE_REGISTRY_KEY, normalized);
  return normalized;
}

function replaceRegistryCollections(current, patch = {}) {
  const base = normalizeRegistry(current);
  return normalizeRegistry({
    version: REGISTRY_VERSION,
    nodes: Array.isArray(patch.nodes) ? patch.nodes : base.nodes,
    transports: Array.isArray(patch.transports) ? patch.transports : base.transports
  });
}

module.exports = {
  REGISTRY_VERSION,
  REMOTE_REGISTRY_KEY,
  readRemoteRegistry,
  writeRemoteRegistry,
  replaceRegistryCollections,
  nowMs
};

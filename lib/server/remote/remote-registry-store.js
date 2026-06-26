'use strict';

const path = require('node:path');

const REMOTE_REGISTRY_FILE = 'remote-nodes.json';
const REGISTRY_VERSION = 1;

function nowMs() {
  return Date.now();
}

function readJsonFile(fs, filePath) {
  try {
    if (!filePath || !fs || !fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function ensureDir(fs, dirPath) {
  if (!fs || !dirPath || typeof fs.mkdirSync !== 'function') return;
  fs.mkdirSync(dirPath, { recursive: true });
}

function getRemoteRegistryPath(aiHomeDir) {
  const root = String(aiHomeDir || '').trim();
  return root ? path.join(root, REMOTE_REGISTRY_FILE) : '';
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
  return normalizeRegistry(readJsonFile(fs, getRemoteRegistryPath(aiHomeDir)));
}

function writeRemoteRegistry(registry, deps = {}) {
  const { fs, aiHomeDir } = deps;
  const filePath = getRemoteRegistryPath(aiHomeDir);
  if (!fs || !filePath) return normalizeRegistry(registry);
  const normalized = normalizeRegistry(registry);
  ensureDir(fs, path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  try {
    if (typeof fs.chmodSync === 'function') fs.chmodSync(filePath, 0o600);
  } catch (_error) {}
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
  REMOTE_REGISTRY_FILE,
  getRemoteRegistryPath,
  readRemoteRegistry,
  writeRemoteRegistry,
  replaceRegistryCollections,
  nowMs
};

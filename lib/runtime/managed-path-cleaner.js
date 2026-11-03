'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MANIFEST_FLAG = '--aih-managed-path-cleanup';

function uniquePaths(values) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean)));
}

function isUnsafeTarget(targetPath, pathImpl = path) {
  const resolved = pathImpl.resolve(String(targetPath || '').trim());
  const parsed = pathImpl.parse(resolved);
  return !resolved
    || resolved === parsed.root
    || resolved === pathImpl.resolve(parsed.root, '.')
    || resolved.length <= parsed.root.length + 1;
}

function normalizeManifest(manifest = {}, options = {}) {
  const pathImpl = options.path || path;
  const files = uniquePaths(manifest.files).map((target) => pathImpl.resolve(target));
  const trees = uniquePaths(manifest.trees).map((target) => pathImpl.resolve(target));
  const targets = [...files, ...trees];
  if (targets.some((target) => isUnsafeTarget(target, pathImpl))) {
    throw new Error('managed_cleanup_unsafe_target');
  }
  return { files, trees };
}

function encodeManifest(manifest, options = {}) {
  return Buffer.from(JSON.stringify(normalizeManifest(manifest, options)), 'utf8').toString('base64url');
}

function decodeManifest(value) {
  const text = Buffer.from(String(value || ''), 'base64url').toString('utf8');
  return normalizeManifest(JSON.parse(text));
}

function removeManagedPaths(manifest, options = {}) {
  const fsImpl = options.fs || fs;
  const normalized = normalizeManifest(manifest, options);
  const removed = [];
  const missing = [];
  const pathExists = (target) => {
    try {
      fsImpl.lstatSync(target);
      return true;
    } catch (_error) {
      return false;
    }
  };

  for (const target of normalized.files) {
    if (!pathExists(target)) {
      missing.push(target);
      continue;
    }
    const stat = fsImpl.lstatSync(target);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      throw new Error(`managed_cleanup_expected_file:${target}`);
    }
    fsImpl.rmSync(target, { force: true });
    removed.push(target);
  }

  for (const target of normalized.trees) {
    if (!pathExists(target)) {
      missing.push(target);
      continue;
    }
    fsImpl.rmSync(target, { recursive: true, force: true });
    removed.push(target);
  }

  return { ok: true, removed, missing };
}

function buildManagedPathCleanupPlan({ id, label, files = [], trees = [], options = {} }) {
  const manifest = normalizeManifest({ files, trees }, options);
  if (!manifest.files.length && !manifest.trees.length) return null;
  const processObj = options.processObj || process;
  return {
    id: String(id || 'managed_path_cleanup').trim(),
    label: String(label || '清理已安装程序文件').trim(),
    command: String(processObj.execPath || process.execPath),
    args: [__filename, MANIFEST_FLAG, encodeManifest(manifest, options)],
    timeoutMs: 5 * 60 * 1000
  };
}

function runCli(argv = process.argv) {
  const flagIndex = argv.indexOf(MANIFEST_FLAG);
  if (flagIndex < 0 || !argv[flagIndex + 1]) return false;
  try {
    const result = removeManagedPaths(decodeManifest(argv[flagIndex + 1]));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return true;
  } catch (error) {
    process.stderr.write(`${String(error && error.message || error)}\n`);
    process.exitCode = 1;
    return true;
  }
}

if (require.main === module) runCli();

module.exports = {
  MANIFEST_FLAG,
  buildManagedPathCleanupPlan,
  decodeManifest,
  encodeManifest,
  isUnsafeTarget,
  normalizeManifest,
  removeManagedPaths,
  runCli
};

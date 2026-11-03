'use strict';

const { isAccountRef } = require('../account/public-account-ref');

function pathExists(fs, targetPath) {
  try {
    return Boolean(targetPath && fs.existsSync(targetPath));
  } catch (_error) {
    return false;
  }
}

function resolvePhysicalPath(fs, path, targetPath) {
  const normalized = String(targetPath || '').trim();
  if (!normalized) return '';
  try {
    const realpath = fs.realpathSync && typeof fs.realpathSync.native === 'function'
      ? fs.realpathSync.native(normalized)
      : fs.realpathSync(normalized);
    return path.resolve(String(realpath || normalized));
  } catch (_error) {
    return path.resolve(normalized);
  }
}

function isWithinRoot(path, targetPath, rootPath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function inferIndexedAccountRef(path, aiHomeDir, sessionDir, targets = []) {
  const projectionsRoot = path.join(
    String(aiHomeDir || '').trim(),
    'run',
    'auth-projections',
    'kimi'
  );
  if (!aiHomeDir || !isWithinRoot(path, sessionDir, projectionsRoot)) return '';
  const relative = path.relative(path.resolve(projectionsRoot), path.resolve(sessionDir));
  const segments = relative.split(path.sep).filter(Boolean);
  if (
    segments.length < 4
    || !isAccountRef(segments[0])
    || segments[1] !== '.kimi-code'
    || segments[2] !== 'sessions'
  ) {
    return '';
  }
  const accountRef = segments[0];
  const trustedTargets = Array.isArray(targets) ? targets : [];
  if (trustedTargets.length > 0) {
    const target = trustedTargets.find((item) => (
      String(item && item.accountRef || '').trim() === accountRef
      && isWithinRoot(path, sessionDir, String(item && item.sessionsRoot || '').trim())
    ));
    if (!target) return '';
  }
  return accountRef;
}

function inferSessionDirFromWire(path, filePath) {
  const parts = path.resolve(String(filePath || '')).split(path.sep);
  const agentsIndex = parts.lastIndexOf('agents');
  if (agentsIndex <= 0 || parts[agentsIndex + 2] !== 'wire.jsonl') return '';
  return parts.slice(0, agentsIndex).join(path.sep) || path.sep;
}

function collectIndexPaths({ fs, path, hostHomeDir, targets = [] }) {
  const hostIndexPath = path.join(hostHomeDir, '.kimi-code', 'session_index.jsonl');
  const hostRuntimeRoot = path.dirname(hostIndexPath);
  const physicalHostRuntimeRoot = resolvePhysicalPath(fs, path, hostRuntimeRoot);
  const resolvedHostIndexPath = pathExists(fs, hostIndexPath)
    ? resolvePhysicalPath(fs, path, hostIndexPath)
    : '';
  const physicalHostIndexPath = resolvedHostIndexPath
    && isWithinRoot(path, resolvedHostIndexPath, physicalHostRuntimeRoot)
    ? resolvedHostIndexPath
    : '';
  const candidates = [{ filePath: hostIndexPath, runtimeRoot: path.dirname(hostIndexPath) }];
  targets.forEach((target) => {
    const sessionsRoot = String(target && target.sessionsRoot || '').trim();
    if (!sessionsRoot) return;
    const runtimeRoot = path.dirname(sessionsRoot);
    candidates.push({
      filePath: path.join(runtimeRoot, 'session_index.jsonl'),
      runtimeRoot
    });
  });
  const byPhysicalPath = new Map();
  candidates.forEach(({ filePath, runtimeRoot }) => {
    if (!pathExists(fs, filePath)) return;
    const physicalPath = resolvePhysicalPath(fs, path, filePath);
    const physicalRuntimeRoot = resolvePhysicalPath(fs, path, runtimeRoot);
    if (
      (!physicalHostIndexPath || physicalPath !== physicalHostIndexPath)
      && !isWithinRoot(path, physicalPath, physicalRuntimeRoot)
    ) {
      return;
    }
    if (!byPhysicalPath.has(physicalPath)) byPhysicalPath.set(physicalPath, filePath);
  });
  return Array.from(byPhysicalPath.values()).sort((left, right) => left.localeCompare(right));
}

function readKimiSessionOwnershipIndex(options = {}) {
  const fs = options.fs;
  const path = options.path;
  const hostHomeDir = String(options.hostHomeDir || '').trim();
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  const targets = Array.isArray(options.trustedTargets)
    ? options.trustedTargets
    : (Array.isArray(options.targets) ? options.targets : []);
  const hostSessionsRoot = path.join(hostHomeDir, '.kimi-code', 'sessions');
  const physicalHostSessionsRoot = resolvePhysicalPath(fs, path, hostSessionsRoot);
  const targetsByAccountRef = new Map(targets.map((target) => [
    String(target && target.accountRef || '').trim(),
    target
  ]));
  const ownersByPhysicalSession = new Map();
  let entries = 0;
  let invalidEntries = 0;
  const indexPaths = collectIndexPaths({ fs, path, hostHomeDir, targets });

  indexPaths.forEach((indexPath) => {
    let content = '';
    try {
      content = fs.readFileSync(indexPath, 'utf8');
    } catch (_error) {
      invalidEntries += 1;
      return;
    }
    content.split(/\r?\n/).forEach((line) => {
      const trimmed = String(line || '').trim();
      if (!trimmed) return;
      let parsed = null;
      try {
        parsed = JSON.parse(trimmed);
      } catch (_error) {
        invalidEntries += 1;
        return;
      }
      const sessionId = String(parsed && parsed.sessionId || '').trim();
      const sessionDir = String(parsed && parsed.sessionDir || '').trim();
      const accountRef = inferIndexedAccountRef(path, aiHomeDir, sessionDir, targets);
      const isHostSession = sessionDir && isWithinRoot(path, sessionDir, hostSessionsRoot);
      if (
        !sessionId
        || !sessionDir
        || !path.isAbsolute(sessionDir)
        || path.basename(path.resolve(sessionDir)) !== sessionId
        || (!accountRef && !isHostSession)
        || !pathExists(fs, sessionDir)
      ) {
        invalidEntries += 1;
        return;
      }
      const physicalSessionDir = resolvePhysicalPath(fs, path, sessionDir);
      const trustedTarget = accountRef ? targetsByAccountRef.get(accountRef) : null;
      const trustedPhysicalRoot = accountRef
        ? String(trustedTarget && trustedTarget.physicalRoot || '').trim()
        : physicalHostSessionsRoot;
      if (
        !trustedPhysicalRoot
        || !isWithinRoot(path, physicalSessionDir, trustedPhysicalRoot)
      ) {
        invalidEntries += 1;
        return;
      }
      entries += 1;
      if (!ownersByPhysicalSession.has(physicalSessionDir)) {
        ownersByPhysicalSession.set(physicalSessionDir, new Set());
      }
      if (accountRef) ownersByPhysicalSession.get(physicalSessionDir).add(accountRef);
    });
  });

  let ambiguousSessions = 0;
  ownersByPhysicalSession.forEach((owners) => {
    if (owners.size > 1) ambiguousSessions += 1;
  });

  return {
    entries,
    invalidEntries,
    ambiguousSessions,
    indexPaths: indexPaths.length,
    trustworthy: indexPaths.length > 0 && invalidEntries === 0,
    getAccountRef(filePath) {
      const sessionDir = inferSessionDirFromWire(path, filePath);
      if (!sessionDir) return '';
      const owners = ownersByPhysicalSession.get(resolvePhysicalPath(fs, path, sessionDir));
      return owners && owners.size === 1 ? Array.from(owners)[0] : '';
    },
    resolveAttribution(filePath) {
      const sessionDir = inferSessionDirFromWire(path, filePath);
      if (!sessionDir) return { accountRef: '', authoritative: false, reason: 'invalid_wire_path' };
      const owners = ownersByPhysicalSession.get(resolvePhysicalPath(fs, path, sessionDir));
      if (owners && owners.size > 1) {
        return { accountRef: '', authoritative: false, reason: 'ambiguous' };
      }
      if (indexPaths.length === 0) {
        return { accountRef: '', authoritative: false, reason: 'index_unavailable' };
      }
      if (invalidEntries > 0) {
        return { accountRef: '', authoritative: false, reason: 'index_invalid' };
      }
      return {
        accountRef: owners && owners.size === 1 ? Array.from(owners)[0] : '',
        authoritative: true,
        reason: owners && owners.size === 1 ? 'resolved' : 'unowned'
      };
    }
  };
}

module.exports = {
  readKimiSessionOwnershipIndex,
  resolvePhysicalPath,
  __private: {
    collectIndexPaths,
    inferIndexedAccountRef,
    inferSessionDirFromWire,
    isWithinRoot
  }
};

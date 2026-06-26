'use strict';

const path = require('node:path');
const { buildCodexAppServerWrapperScript, shellQuote } = require('./codex-app-server-hook-wrapper');

const WRAPPER_MARKER = 'aih-codex-cli-hook';
const NODE_ENTRY_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

function buildWrapperScript(options = {}) {
  return buildCodexAppServerWrapperScript(WRAPPER_MARKER, options);
}

function buildUpstreamDelegateScript(upstreamBinaryPath) {
  return [
    '#!/bin/sh',
    '# aih-codex-upstream-delegate',
    `exec ${shellQuote(upstreamBinaryPath)} "$@"`,
    ''
  ].join('\n');
}

function createCodexCliHookService(deps = {}) {
  const fs = deps.fs;
  const pathImpl = deps.path || path;
  const processObj = deps.processObj || process;
  const aiHomeDir = String(deps.aiHomeDir || '').trim();
  const nodeExecPath = String(deps.nodeExecPath || process.execPath).trim();
  const helperScriptPath = String(
    deps.helperScriptPath || require.resolve('./codex-app-server-stdio-proxy')
  ).trim();
  const resolveCliPath = deps.resolveCliPath;
  const collectCliPaths = deps.collectCliPaths;

  const stateFilePath = aiHomeDir ? pathImpl.join(aiHomeDir, 'codex-cli-hook-state.json') : '';

  function readTextFile(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return '';
    try {
      return String(fs.readFileSync(filePath, 'utf8'));
    } catch (_error) {
      return '';
    }
  }

  function isNodeEntryContent(filePath) {
    const content = readTextFile(filePath);
    if (!content) return false;
    const firstLine = String(content.split('\n')[0] || '').trim();
    return /node(?:\s|$)/i.test(firstLine);
  }

  function buildBackupPath(binaryPath) {
    const normalized = String(binaryPath || '').trim();
    if (!normalized) return '';
    const resolvedExt = pathImpl.extname(normalized).trim().toLowerCase();
    if (!NODE_ENTRY_EXTENSIONS.has(resolvedExt)) {
      return `${normalized}.aih-original`;
    }
    const parsed = pathImpl.parse(normalized);
    return pathImpl.join(parsed.dir, `${parsed.name}.aih-original${resolvedExt}`);
  }

  function resolveUpstreamBinaryPath(targetBinaryPath) {
    const normalizedTarget = String(targetBinaryPath || '').trim();
    if (!normalizedTarget) {
      return {
        resolvedTargetBinaryPath: '',
        upstreamBinaryPath: '',
        legacyUpstreamBinaryPaths: []
      };
    }

    let resolvedTargetBinaryPath = normalizedTarget;
    try {
      if (fs.existsSync(normalizedTarget) && typeof fs.realpathSync === 'function') {
        resolvedTargetBinaryPath = String(fs.realpathSync(normalizedTarget) || '').trim() || normalizedTarget;
      }
    } catch (_error) {}

    const upstreamBinaryPath = buildBackupPath(resolvedTargetBinaryPath);
    const legacyUpstreamBinaryPaths = [];
    const legacyTargetBackupPath = `${normalizedTarget}.aih-original`;
    if (legacyTargetBackupPath && legacyTargetBackupPath !== upstreamBinaryPath) {
      legacyUpstreamBinaryPaths.push(legacyTargetBackupPath);
    }
    const legacyTargetBackupPathWithExt = `${legacyTargetBackupPath}${pathImpl.extname(upstreamBinaryPath)}`;
    if (
      legacyTargetBackupPathWithExt
      && legacyTargetBackupPathWithExt !== upstreamBinaryPath
      && !legacyUpstreamBinaryPaths.includes(legacyTargetBackupPathWithExt)
    ) {
      legacyUpstreamBinaryPaths.push(legacyTargetBackupPathWithExt);
    }
    const resolvedLegacyBackupPath = `${resolvedTargetBinaryPath}.aih-original`;
    if (
      resolvedLegacyBackupPath
      && resolvedLegacyBackupPath !== upstreamBinaryPath
      && !legacyUpstreamBinaryPaths.includes(resolvedLegacyBackupPath)
    ) {
      legacyUpstreamBinaryPaths.push(resolvedLegacyBackupPath);
    }
    if (
      upstreamBinaryPath
      && !fs.existsSync(upstreamBinaryPath)
      && isNodeEntryContent(legacyTargetBackupPath)
      && !legacyUpstreamBinaryPaths.includes(legacyTargetBackupPath)
    ) {
      legacyUpstreamBinaryPaths.push(legacyTargetBackupPath);
    }
    return {
      resolvedTargetBinaryPath,
      upstreamBinaryPath,
      legacyUpstreamBinaryPaths
    };
  }

  function resolvePaths() {
    return resolveAllPaths()[0] || {
      targetBinaryPath: '',
      upstreamBinaryPath: '',
      reason: 'codex_cli_not_found'
    };
  }

  function uniqueStrings(values) {
    return Array.from(new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    ));
  }

  function isDesktopBundleBinary(targetBinaryPath) {
    return /\/Codex\.app\/Contents\/Resources\/codex$/.test(String(targetBinaryPath || '').trim());
  }

  function collectTargetBinaryPaths() {
    const collected = typeof collectCliPaths === 'function'
      ? uniqueStrings(collectCliPaths('codex', { processObj }) || [])
      : [];
    if (collected.length > 0) return collected;
    const targetBinaryPath = typeof resolveCliPath === 'function'
      ? String(resolveCliPath('codex') || '').trim()
      : '';
    return targetBinaryPath ? [targetBinaryPath] : [];
  }

  function resolveTargetPaths(targetBinaryPath) {
    if (!targetBinaryPath) {
      return {
        targetBinaryPath: '',
        upstreamBinaryPath: '',
        reason: 'codex_cli_not_found'
      };
    }
    if (isDesktopBundleBinary(targetBinaryPath)) {
      return {
        targetBinaryPath,
        upstreamBinaryPath: '',
        reason: 'desktop_bundle_binary'
      };
    }
    const upstream = resolveUpstreamBinaryPath(targetBinaryPath);
    return {
      targetBinaryPath,
      resolvedTargetBinaryPath: upstream.resolvedTargetBinaryPath,
      upstreamBinaryPath: upstream.upstreamBinaryPath,
      legacyUpstreamBinaryPaths: upstream.legacyUpstreamBinaryPaths,
      reason: ''
    };
  }

  function resolveAllPaths() {
    return collectTargetBinaryPaths().map(resolveTargetPaths);
  }

  function isWrapperInstalled(targetBinaryPath) {
    return readTextFile(targetBinaryPath)
      .split(/\r?\n/)
      .some((line) => line.trim() === `# ${WRAPPER_MARKER}`);
  }

  function resolveRealPath(filePath) {
    const normalized = String(filePath || '').trim();
    if (!normalized) return '';
    try {
      return fs.existsSync(normalized) && typeof fs.realpathSync === 'function'
        ? String(fs.realpathSync(normalized) || '').trim()
        : normalized;
    } catch (_error) {
      return normalized;
    }
  }

  function isSameFile(leftPath, rightPath) {
    const left = resolveRealPath(leftPath);
    const right = resolveRealPath(rightPath);
    return Boolean(left && right && left === right);
  }

  function resolvePnpmShimRuntimeTarget(filePath) {
    const content = readTextFile(filePath);
    const match = content.match(/\$basedir\/([^"]*node_modules\/@openai\/codex\/bin\/codex\.js)/);
    if (!match || !match[1]) return '';
    return pathImpl.resolve(pathImpl.dirname(String(filePath || '')), match[1]);
  }

  function isCleanExecutableSnapshot(filePath) {
    const normalized = String(filePath || '').trim();
    if (!normalized || !fs.existsSync(normalized) || isWrapperInstalled(normalized)) return false;
    const pnpmShimTarget = resolvePnpmShimRuntimeTarget(normalized);
    return !pnpmShimTarget || fs.existsSync(pnpmShimTarget);
  }

  function isTrustedUpstreamFile(upstreamBinaryPath, targetBinaryPath) {
    const upstream = String(upstreamBinaryPath || '').trim();
    if (!isCleanExecutableSnapshot(upstream)) return false;
    return !isSameFile(upstream, targetBinaryPath);
  }

  function collectTrustedRecoveryCandidates(targets) {
    const candidates = [];
    for (const paths of Array.isArray(targets) ? targets : []) {
      if (!paths || paths.reason === 'desktop_bundle_binary') continue;
      if (isTrustedUpstreamFile(paths.upstreamBinaryPath, paths.targetBinaryPath)) {
        candidates.push(paths.upstreamBinaryPath);
      }
      for (const legacyPath of Array.isArray(paths.legacyUpstreamBinaryPaths) ? paths.legacyUpstreamBinaryPaths : []) {
        if (isTrustedUpstreamFile(legacyPath, paths.targetBinaryPath)) candidates.push(legacyPath);
      }
      if (isCleanExecutableSnapshot(paths.targetBinaryPath)) candidates.push(paths.targetBinaryPath);
    }
    return uniqueStrings(candidates);
  }

  function serializeTargetState(target) {
    return {
      targetBinaryPath: String(target && target.targetBinaryPath || ''),
      resolvedTargetBinaryPath: String(target && target.resolvedTargetBinaryPath || ''),
      upstreamBinaryPath: String(target && target.upstreamBinaryPath || ''),
      enabled: target && target.enabled === true,
      healthy: target && target.healthy === true,
      installed: target && target.installed === true,
      updated: target && target.updated === true,
      repaired: target && target.repaired === true,
      reason: String(target && target.reason || '')
    };
  }

  function writeState(enabled, paths, extras = {}) {
    if (!stateFilePath) return false;
    const { targets, ...restExtras } = extras || {};
    fs.mkdirSync(pathImpl.dirname(stateFilePath), { recursive: true });
    fs.writeFileSync(stateFilePath, JSON.stringify({
      version: 1,
      enabled: enabled === true,
      updatedAt: new Date().toISOString(),
      targetBinaryPath: String(paths && paths.targetBinaryPath || ''),
      upstreamBinaryPath: String(paths && paths.upstreamBinaryPath || ''),
      targets: Array.isArray(targets)
        ? targets.map(serializeTargetState)
        : undefined,
      ...restExtras
    }, null, 2));
    return true;
  }

  function copyExecutableSnapshot(sourcePath, destinationPath) {
    const stat = fs.statSync(sourcePath);
    const content = fs.readFileSync(sourcePath);
    fs.writeFileSync(destinationPath, content);
    fs.chmodSync(destinationPath, stat.mode & 0o777);
    return stat;
  }

  function copyUpstreamSnapshot(targetBinaryPath, upstreamBinaryPath) {
    return copyExecutableSnapshot(targetBinaryPath, upstreamBinaryPath);
  }

  function writeUpstreamDelegate(destinationPath, upstreamBinaryPath) {
    fs.writeFileSync(destinationPath, buildUpstreamDelegateScript(upstreamBinaryPath), 'utf8');
    fs.chmodSync(destinationPath, 0o755);
  }

  function ensureUpstreamSnapshot(paths, recoveryCandidatePaths = []) {
    const { targetBinaryPath, upstreamBinaryPath, legacyUpstreamBinaryPaths } = paths;
    if (isTrustedUpstreamFile(upstreamBinaryPath, targetBinaryPath)) {
      return {
        ok: true,
        migrated: false,
        upstreamBinaryPath
      };
    }
    const legacyCandidates = Array.isArray(legacyUpstreamBinaryPaths)
      ? legacyUpstreamBinaryPaths
      : [];
    for (const legacyUpstreamBinaryPath of legacyCandidates) {
      if (!isTrustedUpstreamFile(legacyUpstreamBinaryPath, targetBinaryPath)) continue;
      copyExecutableSnapshot(legacyUpstreamBinaryPath, upstreamBinaryPath);
      try {
        fs.unlinkSync(legacyUpstreamBinaryPath);
      } catch (_error) {}
      return {
        ok: true,
        migrated: true,
        upstreamBinaryPath
      };
    }
    for (const recoveryCandidatePath of Array.isArray(recoveryCandidatePaths) ? recoveryCandidatePaths : []) {
      if (!isTrustedUpstreamFile(recoveryCandidatePath, targetBinaryPath)) continue;
      writeUpstreamDelegate(upstreamBinaryPath, recoveryCandidatePath);
      return {
        ok: true,
        migrated: false,
        recovered: true,
        upstreamBinaryPath
      };
    }
    if (!targetBinaryPath || !fs.existsSync(targetBinaryPath)) {
      return {
        ok: false,
        migrated: false,
        reason: 'target_binary_missing'
      };
    }
    if (isWrapperInstalled(targetBinaryPath)) {
      return {
        ok: false,
        migrated: false,
        reason: 'upstream_backup_invalid'
      };
    }
    copyUpstreamSnapshot(targetBinaryPath, upstreamBinaryPath);
    return {
      ok: true,
      migrated: false,
      upstreamBinaryPath
    };
  }

  function installWrapper(paths, recoveryCandidatePaths = []) {
    const { targetBinaryPath, upstreamBinaryPath } = paths;
    if (!targetBinaryPath || !fs.existsSync(targetBinaryPath)) {
      return {
        ok: false,
        installed: false,
        reason: 'target_binary_missing'
      };
    }

    const wrapper = buildWrapperScript({
      nodeExecPath,
      helperScriptPath,
      upstreamBinaryPath,
      stateFilePath
    });

    if (isWrapperInstalled(targetBinaryPath)) {
      const snapshotResult = ensureUpstreamSnapshot(paths, recoveryCandidatePaths);
      if (!snapshotResult.ok) {
        return {
          ok: false,
          installed: false,
          reason: String(snapshotResult.reason || 'missing_upstream_backup')
        };
      }
      fs.writeFileSync(targetBinaryPath, wrapper, 'utf8');
      fs.chmodSync(targetBinaryPath, 0o755);
      return {
        ok: true,
        installed: true,
        updated: true,
        targetBinaryPath,
        upstreamBinaryPath,
        migrated: snapshotResult.migrated,
        recovered: snapshotResult.recovered
      };
    }

    copyUpstreamSnapshot(targetBinaryPath, upstreamBinaryPath);
    fs.writeFileSync(targetBinaryPath, wrapper, 'utf8');
    fs.chmodSync(targetBinaryPath, 0o755);
    return {
      ok: true,
      installed: true,
      updated: false,
      targetBinaryPath,
      upstreamBinaryPath
    };
  }

  function isTargetHealthy(paths) {
    const wrapperInstalled = isWrapperInstalled(paths.targetBinaryPath);
    const expectedWrapper = buildWrapperScript({
      nodeExecPath,
      helperScriptPath,
      upstreamBinaryPath: paths.upstreamBinaryPath,
      stateFilePath
    });
    const wrapperCurrent = readTextFile(paths.targetBinaryPath) === expectedWrapper;
    const upstreamReady = isTrustedUpstreamFile(paths.upstreamBinaryPath, paths.targetBinaryPath);
    return wrapperInstalled && upstreamReady && wrapperCurrent;
  }

  function installTargets(targets) {
    const recoveryCandidatePaths = collectTrustedRecoveryCandidates(targets);
    const results = targets.map((paths) => {
      if (!paths.targetBinaryPath) {
        return {
          ok: true,
          supported: true,
          enabled: false,
          reason: paths.reason || 'codex_cli_not_found',
          repaired: false
        };
      }
      if (paths.reason === 'desktop_bundle_binary') {
        return {
          ok: true,
          supported: true,
          enabled: false,
          reason: paths.reason,
          targetBinaryPath: paths.targetBinaryPath,
          repaired: false
        };
      }
      if (isTargetHealthy(paths)) {
        return {
          ok: true,
          supported: true,
          enabled: true,
          healthy: true,
          targetBinaryPath: paths.targetBinaryPath,
          resolvedTargetBinaryPath: paths.resolvedTargetBinaryPath,
          upstreamBinaryPath: paths.upstreamBinaryPath,
          repaired: false
        };
      }
      const installResult = installWrapper(paths, recoveryCandidatePaths);
      return {
        ...installResult,
        supported: true,
        enabled: Boolean(installResult.ok),
        healthy: Boolean(installResult.ok),
        repaired: Boolean(installResult.ok),
        targetBinaryPath: paths.targetBinaryPath,
        resolvedTargetBinaryPath: paths.resolvedTargetBinaryPath,
        upstreamBinaryPath: paths.upstreamBinaryPath
      };
    });
    const failed = results.filter((result) => !result.ok);
    const enabledTargets = results.filter((result) => result.enabled);
    const primary = enabledTargets[0] || results[0] || {};
    if (targets.length === 0) {
      writeState(false, {}, { reason: 'codex_cli_not_found', targets: [] });
      return {
        ok: true,
        supported: true,
        enabled: false,
        reason: 'codex_cli_not_found',
        repaired: false,
        targets: []
      };
    }
    writeState(failed.length === 0 && enabledTargets.length > 0, primary, {
      reason: failed.length > 0 ? 'install_failed' : '',
      targets: results
    });
    return {
      ok: failed.length === 0,
      supported: true,
      enabled: failed.length === 0 && enabledTargets.length > 0,
      healthy: results.every((result) => result.healthy),
      targetBinaryPath: primary.targetBinaryPath,
      upstreamBinaryPath: primary.upstreamBinaryPath,
      installed: results.some((result) => result.installed),
      updated: results.some((result) => result.updated),
      repaired: results.some((result) => result.repaired),
      targets: results,
      reason: failed.length > 0 ? 'install_failed' : ''
    };
  }

  function ensureInstalled() {
    if (processObj.platform === 'win32') {
      return { ok: true, supported: false, enabled: false, reason: 'unsupported_platform', repaired: false };
    }
    return installTargets(resolveAllPaths());
  }

  function activate() {
    if (processObj.platform === 'win32') {
      return { ok: true, supported: false, enabled: false, reason: 'unsupported_platform' };
    }
    return {
      ...installTargets(resolveAllPaths()),
      stateFilePath
    };
  }

  function deactivate() {
    const paths = resolvePaths();
    if (!stateFilePath) {
      return { ok: true, supported: processObj.platform !== 'win32', enabled: false };
    }
    writeState(false, paths);
    return {
      ok: true,
      supported: processObj.platform !== 'win32',
      enabled: false,
      stateFilePath
    };
  }

  return {
    resolvePaths,
    resolveAllPaths,
    buildWrapperScript,
    ensureInstalled,
    activate,
    deactivate,
    isWrapperInstalled
  };
}

module.exports = {
  WRAPPER_MARKER,
  buildWrapperScript,
  createCodexCliHookService
};

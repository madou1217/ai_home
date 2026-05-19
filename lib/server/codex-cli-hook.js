'use strict';

const path = require('node:path');

const WRAPPER_MARKER = 'aih-codex-cli-hook';
const NODE_ENTRY_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

function shellQuote(value) {
  return `'${String(value || '').replace(/'/g, `'\\''`)}'`;
}

function buildWrapperScript(options = {}) {
  const {
    nodeExecPath,
    helperScriptPath,
    upstreamBinaryPath,
    stateFilePath
  } = options;
  return [
    '#!/bin/sh',
    `# ${WRAPPER_MARKER}`,
    `UPSTREAM=${shellQuote(upstreamBinaryPath)}`,
    `NODE_BIN=${shellQuote(nodeExecPath)}`,
    `HELPER=${shellQuote(helperScriptPath)}`,
    `STATE_FILE=${shellQuote(stateFilePath)}`,
    'if [ "$1" = "app-server" ]; then',
    '  exec "$NODE_BIN" "$HELPER" --upstream "$UPSTREAM" --state-file "$STATE_FILE" -- "$@"',
    'fi',
    'exec "$UPSTREAM" "$@"',
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
    const targetBinaryPath = typeof resolveCliPath === 'function'
      ? String(resolveCliPath('codex') || '').trim()
      : '';
    if (!targetBinaryPath) {
      return {
        targetBinaryPath: '',
        upstreamBinaryPath: '',
        reason: 'codex_cli_not_found'
      };
    }
    if (/\/Codex\.app\/Contents\/Resources\/codex$/.test(targetBinaryPath)) {
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

  function isWrapperInstalled(targetBinaryPath) {
    return readTextFile(targetBinaryPath).includes(WRAPPER_MARKER);
  }

  function writeState(enabled, paths, extras = {}) {
    if (!stateFilePath) return false;
    fs.mkdirSync(pathImpl.dirname(stateFilePath), { recursive: true });
    fs.writeFileSync(stateFilePath, JSON.stringify({
      version: 1,
      enabled: enabled === true,
      updatedAt: new Date().toISOString(),
      targetBinaryPath: String(paths && paths.targetBinaryPath || ''),
      upstreamBinaryPath: String(paths && paths.upstreamBinaryPath || ''),
      ...extras
    }, null, 2));
    return true;
  }

  function copyUpstreamSnapshot(targetBinaryPath, upstreamBinaryPath) {
    const stat = fs.statSync(targetBinaryPath);
    const content = fs.readFileSync(targetBinaryPath);
    fs.writeFileSync(upstreamBinaryPath, content);
    fs.chmodSync(upstreamBinaryPath, stat.mode & 0o777);
    return stat;
  }

  function ensureUpstreamSnapshot(paths) {
    const { targetBinaryPath, upstreamBinaryPath, legacyUpstreamBinaryPaths } = paths;
    if (upstreamBinaryPath && fs.existsSync(upstreamBinaryPath)) {
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
      if (!legacyUpstreamBinaryPath || !fs.existsSync(legacyUpstreamBinaryPath)) continue;
      const stat = fs.statSync(legacyUpstreamBinaryPath);
      fs.copyFileSync(legacyUpstreamBinaryPath, upstreamBinaryPath);
      fs.chmodSync(upstreamBinaryPath, stat.mode & 0o777);
      try {
        fs.unlinkSync(legacyUpstreamBinaryPath);
      } catch (_error) {}
      return {
        ok: true,
        migrated: true,
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
    copyUpstreamSnapshot(targetBinaryPath, upstreamBinaryPath);
    return {
      ok: true,
      migrated: false,
      upstreamBinaryPath
    };
  }

  function installWrapper(paths) {
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
      const snapshotResult = ensureUpstreamSnapshot(paths);
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
        migrated: snapshotResult.migrated
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

  function ensureInstalled() {
    if (processObj.platform === 'win32') {
      return { ok: true, supported: false, enabled: false, reason: 'unsupported_platform', repaired: false };
    }
    const paths = resolvePaths();
    if (!paths.targetBinaryPath) {
      writeState(false, paths, { reason: paths.reason || 'codex_cli_not_found' });
      return {
        ok: true,
        supported: true,
        enabled: false,
        reason: paths.reason || 'codex_cli_not_found',
        repaired: false
      };
    }
    if (paths.reason === 'desktop_bundle_binary') {
      writeState(false, paths, { reason: paths.reason });
      return {
        ok: true,
        supported: true,
        enabled: false,
        reason: paths.reason,
        targetBinaryPath: paths.targetBinaryPath,
        repaired: false
      };
    }

    const wrapperInstalled = isWrapperInstalled(paths.targetBinaryPath);
    const expectedWrapper = buildWrapperScript({
      nodeExecPath,
      helperScriptPath,
      upstreamBinaryPath: paths.upstreamBinaryPath,
      stateFilePath
    });
    const wrapperCurrent = readTextFile(paths.targetBinaryPath) === expectedWrapper;
    const upstreamReady = paths.upstreamBinaryPath && fs.existsSync(paths.upstreamBinaryPath);
    if (wrapperInstalled && upstreamReady && wrapperCurrent) {
      return {
        ok: true,
        supported: true,
        enabled: true,
        healthy: true,
        targetBinaryPath: paths.targetBinaryPath,
        upstreamBinaryPath: paths.upstreamBinaryPath,
        repaired: false
      };
    }

    const repaired = activate();
    return {
      ...repaired,
      repaired: Boolean(repaired && repaired.ok && repaired.enabled)
    };
  }

  function activate() {
    if (processObj.platform === 'win32') {
      return { ok: true, supported: false, enabled: false, reason: 'unsupported_platform' };
    }
    const paths = resolvePaths();
    if (!paths.targetBinaryPath) {
      return { ok: true, supported: true, enabled: false, reason: paths.reason || 'codex_cli_not_found' };
    }
    if (paths.reason === 'desktop_bundle_binary') {
      writeState(false, paths, { reason: paths.reason });
      return { ok: true, supported: true, enabled: false, reason: paths.reason, targetBinaryPath: paths.targetBinaryPath };
    }
    const installResult = installWrapper(paths);
    if (!installResult.ok) return { ...installResult, supported: true, enabled: false };
    writeState(true, paths);
    return {
      ok: true,
      supported: true,
      enabled: true,
      targetBinaryPath: paths.targetBinaryPath,
      upstreamBinaryPath: paths.upstreamBinaryPath,
      installed: installResult.installed,
      updated: installResult.updated,
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

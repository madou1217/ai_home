'use strict';

const path = require('node:path');

const WRAPPER_MARKER = 'aih-codex-desktop-hook';

function shellQuote(value) {
  return `'${String(value || '').replace(/'/g, `'\\''`)}'`;
}

function readDesktopClientPathCache(fs, aiHomeDir) {
  const baseDir = String(aiHomeDir || '').trim();
  if (!baseDir) return {};
  const filePath = path.join(baseDir, 'desktop-client-paths.json');
  if (!fs.existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function resolveCodexDesktopBundlePath(fs, aiHomeDir, hostHomeDir) {
  const cache = readDesktopClientPathCache(fs, aiHomeDir);
  const learnedBundle = cache && cache.codex && cache.codex.macos
    ? String(cache.codex.macos.bundlePath || '').trim()
    : '';
  const candidates = [
    learnedBundle,
    hostHomeDir ? path.join(hostHomeDir, 'Applications', 'Codex.app') : '',
    '/Applications/Codex.app'
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
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

function createCodexDesktopHookService(deps = {}) {
  const fs = deps.fs;
  const pathImpl = deps.path || path;
  const processObj = deps.processObj || process;
  const aiHomeDir = String(deps.aiHomeDir || '').trim();
  const hostHomeDir = String(deps.hostHomeDir || '').trim();
  const nodeExecPath = String(deps.nodeExecPath || process.execPath).trim();
  const helperScriptPath = String(
    deps.helperScriptPath || require.resolve('./codex-app-server-stdio-proxy')
  ).trim();

  const stateFilePath = aiHomeDir ? pathImpl.join(aiHomeDir, 'codex-desktop-hook-state.json') : '';

  function readState() {
    if (!stateFilePath || !fs.existsSync(stateFilePath)) return {};
    try {
      const parsed = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_error) {
      return {};
    }
  }

  function resolvePaths() {
    const bundlePath = resolveCodexDesktopBundlePath(fs, aiHomeDir, hostHomeDir);
    if (!bundlePath) {
      return {
        bundlePath: '',
        targetBinaryPath: '',
        upstreamBinaryPath: ''
      };
    }
    const targetBinaryPath = pathImpl.join(bundlePath, 'Contents', 'Resources', 'codex');
    return {
      bundlePath,
      targetBinaryPath,
      upstreamBinaryPath: `${targetBinaryPath}.aih-original`
    };
  }

  function isWrapperInstalled(targetBinaryPath) {
    if (!targetBinaryPath || !fs.existsSync(targetBinaryPath)) return false;
    try {
      return String(fs.readFileSync(targetBinaryPath, 'utf8')).includes(WRAPPER_MARKER);
    } catch (_error) {
      return false;
    }
  }

  function writeState(enabled, paths, extras = {}) {
    if (!stateFilePath) return false;
    const previous = readState();
    fs.mkdirSync(pathImpl.dirname(stateFilePath), { recursive: true });
    fs.writeFileSync(stateFilePath, JSON.stringify({
      version: 1,
      enabled: enabled === true,
      updatedAt: new Date().toISOString(),
      bundlePath: paths.bundlePath,
      targetBinaryPath: paths.targetBinaryPath,
      upstreamBinaryPath: paths.upstreamBinaryPath,
      traceFile: String(extras.traceFile !== undefined ? extras.traceFile : previous.traceFile || '').trim(),
      traceResponses: extras.traceResponses !== undefined
        ? extras.traceResponses === true
        : previous.traceResponses === true,
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
      if (!upstreamBinaryPath || !fs.existsSync(upstreamBinaryPath)) {
        return {
          ok: false,
          installed: false,
          reason: 'missing_upstream_backup'
        };
      }
      fs.writeFileSync(targetBinaryPath, wrapper, 'utf8');
      fs.chmodSync(targetBinaryPath, 0o755);
      return {
        ok: true,
        installed: true,
        updated: true,
        targetBinaryPath,
        upstreamBinaryPath
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

  function activate() {
    if (processObj.platform !== 'darwin') {
      return { ok: true, supported: false, enabled: false, reason: 'unsupported_platform' };
    }
    const paths = resolvePaths();
    if (!paths.bundlePath) {
      return { ok: true, supported: true, enabled: false, reason: 'codex_app_not_found' };
    }
    const installResult = installWrapper(paths);
    if (!installResult.ok) return { ...installResult, supported: true, enabled: false };
    writeState(true, paths);
    return {
      ok: true,
      supported: true,
      enabled: true,
      bundlePath: paths.bundlePath,
      targetBinaryPath: paths.targetBinaryPath,
      upstreamBinaryPath: paths.upstreamBinaryPath,
      installed: installResult.installed,
      updated: installResult.updated,
      stateFilePath
    };
  }

  function ensureInstalled() {
    if (processObj.platform !== 'darwin') {
      return { ok: true, supported: false, enabled: false, reason: 'unsupported_platform', repaired: false };
    }
    const paths = resolvePaths();
    if (!paths.bundlePath) {
      writeState(false, paths, { reason: 'codex_app_not_found' });
      return {
        ok: true,
        supported: true,
        enabled: false,
        reason: 'codex_app_not_found',
        repaired: false
      };
    }
    const wrapperInstalled = isWrapperInstalled(paths.targetBinaryPath);
    const upstreamReady = paths.upstreamBinaryPath && fs.existsSync(paths.upstreamBinaryPath);
    if (wrapperInstalled && upstreamReady) {
      return {
        ok: true,
        supported: true,
        enabled: true,
        healthy: true,
        bundlePath: paths.bundlePath,
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

  function updateTraceConfig(options = {}) {
    const paths = resolvePaths();
    const nextTraceFile = String(options.traceFile || '').trim();
    const nextTraceResponses = options.traceResponses === true;
    writeState(true, paths, {
      traceFile: nextTraceFile,
      traceResponses: nextTraceResponses
    });
    return {
      ok: true,
      stateFilePath,
      traceFile: nextTraceFile,
      traceResponses: nextTraceResponses
    };
  }

  function deactivate() {
    const paths = resolvePaths();
    if (!stateFilePath) {
      return { ok: true, supported: processObj.platform === 'darwin', enabled: false };
    }
    writeState(false, paths);
    return {
      ok: true,
      supported: processObj.platform === 'darwin',
      enabled: false,
      stateFilePath
    };
  }

  return {
    resolvePaths,
    buildWrapperScript,
    readState,
    ensureInstalled,
    updateTraceConfig,
    activate,
    deactivate,
    isWrapperInstalled
  };
}

module.exports = {
  WRAPPER_MARKER,
  buildWrapperScript,
  createCodexDesktopHookService
};

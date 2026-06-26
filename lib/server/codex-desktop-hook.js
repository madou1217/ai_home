'use strict';

const path = require('node:path');
const { buildCodexAppServerWrapperScript } = require('./codex-app-server-hook-wrapper');

const WRAPPER_MARKER = 'aih-codex-desktop-hook';

function normalizeDesktopAccountId(value) {
  const normalized = String(value || '').trim();
  return /^\d+$/.test(normalized) ? normalized : '';
}

function samePath(left, right) {
  return String(left || '').trim() === String(right || '').trim();
}

function getFileMtimeMs(fs, filePath) {
  const normalized = String(filePath || '').trim();
  if (!normalized) return 0;
  try {
    const stat = fs.statSync(normalized);
    return Number.isFinite(Number(stat && stat.mtimeMs)) ? Number(stat.mtimeMs) : 0;
  } catch (_error) {
    return 0;
  }
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
  return buildCodexAppServerWrapperScript(WRAPPER_MARKER, options);
}

function createCodexDesktopHookService(deps = {}) {
  const fs = deps.fs;
  const pathImpl = deps.path || path;
  const processObj = deps.processObj || process;
  const spawnSyncImpl = deps.spawnSync || null;
  const aiHomeDir = String(deps.aiHomeDir || '').trim();
  const hostHomeDir = String(deps.hostHomeDir || '').trim();
  const nodeExecPath = String(deps.nodeExecPath || process.execPath).trim();
  const providerHookReceiverUrl = String(deps.providerHookReceiverUrl || '').trim();
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
    const {
      desktopAccountId: _desktopAccountId,
      providerHookReceiverUrl: nextProviderHookReceiverUrl,
      ...stateExtras
    } = extras;
    const desktopAccountId = normalizeDesktopAccountId(
      extras.desktopAccountId !== undefined ? extras.desktopAccountId : previous.desktopAccountId
    );
    fs.mkdirSync(pathImpl.dirname(stateFilePath), { recursive: true });
    fs.writeFileSync(stateFilePath, JSON.stringify({
      version: 1,
      enabled: enabled === true,
      updatedAt: new Date().toISOString(),
      bundlePath: paths.bundlePath,
      targetBinaryPath: paths.targetBinaryPath,
      upstreamBinaryPath: paths.upstreamBinaryPath,
      helperScriptPath,
      helperScriptMtimeMs: getFileMtimeMs(fs, helperScriptPath),
      traceFile: String(extras.traceFile !== undefined ? extras.traceFile : previous.traceFile || '').trim(),
      traceResponses: extras.traceResponses !== undefined
        ? extras.traceResponses === true
        : previous.traceResponses === true,
      traceRemoteControl: extras.traceRemoteControl !== undefined
        ? extras.traceRemoteControl === true
        : previous.traceRemoteControl === true,
      remoteControlProxy: extras.remoteControlProxy !== undefined
        ? extras.remoteControlProxy === true
        : previous.remoteControlProxy === true,
      providerHookReceiverUrl: String(
        nextProviderHookReceiverUrl !== undefined
          ? nextProviderHookReceiverUrl
          : previous.providerHookReceiverUrl || providerHookReceiverUrl
      ).trim(),
      ...(desktopAccountId ? { desktopAccountId } : {}),
      ...stateExtras
    }, null, 2));
    return true;
  }

  function readStatePaths(state = readState()) {
    return {
      bundlePath: String(state.bundlePath || '').trim(),
      targetBinaryPath: String(state.targetBinaryPath || '').trim(),
      upstreamBinaryPath: String(state.upstreamBinaryPath || '').trim()
    };
  }

  function getDesktopAccountId() {
    return normalizeDesktopAccountId(readState().desktopAccountId);
  }

  function setDesktopAccountId(accountId) {
    const desktopAccountId = normalizeDesktopAccountId(accountId);
    if (!desktopAccountId) {
      return { ok: false, reason: 'invalid_account_id' };
    }
    if (!stateFilePath) {
      return { ok: false, reason: 'state_file_unavailable' };
    }
    const previous = readState();
    const written = writeState(previous.enabled === true, readStatePaths(previous), {
      desktopAccountId
    });
    return {
      ok: written,
      stateFilePath,
      desktopAccountId
    };
  }

  function clearDesktopAccountId(accountId = '') {
    if (!stateFilePath) {
      return { ok: false, reason: 'state_file_unavailable' };
    }
    if (!fs.existsSync(stateFilePath)) {
      return { ok: true, stateFilePath, desktopAccountId: '', changed: false };
    }
    const previous = readState();
    const currentId = normalizeDesktopAccountId(previous.desktopAccountId);
    const expectedId = normalizeDesktopAccountId(accountId);
    if (expectedId && currentId && currentId !== expectedId) {
      return { ok: true, stateFilePath, desktopAccountId: currentId, changed: false };
    }
    const written = writeState(previous.enabled === true, readStatePaths(previous), {
      desktopAccountId: ''
    });
    return {
      ok: written,
      stateFilePath,
      desktopAccountId: '',
      changed: Boolean(currentId)
    };
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
    const previous = readState();
    const nextHelperScriptMtimeMs = getFileMtimeMs(fs, helperScriptPath);
    const helperScriptChanged = !samePath(previous.helperScriptPath, helperScriptPath)
      || Number(previous.helperScriptMtimeMs || 0) !== nextHelperScriptMtimeMs;
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
      helperScriptChanged,
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
    const nextTraceRemoteControl = options.traceRemoteControl === true;
    const defaultTraceFile = nextTraceRemoteControl && aiHomeDir
      ? pathImpl.join(aiHomeDir, 'codex-mobile-trace.jsonl')
      : '';
    const nextTraceFile = String(options.traceFile || defaultTraceFile).trim();
    const nextTraceResponses = options.traceResponses === true;
    const nextRemoteControlProxy = options.remoteControlProxy === true;
    const previous = readState();
    const nextHelperScriptMtimeMs = getFileMtimeMs(fs, helperScriptPath);
    const changed = !samePath(previous.traceFile, nextTraceFile)
      || previous.traceResponses === true !== nextTraceResponses
      || previous.traceRemoteControl === true !== nextTraceRemoteControl
      || previous.remoteControlProxy === true !== nextRemoteControlProxy
      || !samePath(previous.helperScriptPath, helperScriptPath)
      || Number(previous.helperScriptMtimeMs || 0) !== nextHelperScriptMtimeMs;
    writeState(true, paths, {
      traceFile: nextTraceFile,
      traceResponses: nextTraceResponses,
      traceRemoteControl: nextTraceRemoteControl,
      remoteControlProxy: nextRemoteControlProxy,
      providerHookReceiverUrl
    });
    return {
      ok: true,
      stateFilePath,
      traceFile: nextTraceFile,
      traceResponses: nextTraceResponses,
      traceRemoteControl: nextTraceRemoteControl,
      remoteControlProxy: nextRemoteControlProxy,
      changed
    };
  }

  function listRunningAppServerProcesses() {
    if (!spawnSyncImpl || !stateFilePath) return [];
    const paths = readStatePaths();
    const helper = helperScriptPath;
    const upstream = paths.upstreamBinaryPath || resolvePaths().upstreamBinaryPath;
    let result = null;
    try {
      result = spawnSyncImpl('ps', ['-axo', 'pid=,command='], {
        encoding: 'utf8',
        windowsHide: true
      });
    } catch (_error) {
      return [];
    }
    if (!result || result.status !== 0) return [];
    return String(result.stdout || '').split(/\r?\n/)
      .map((line) => {
        const match = line.match(/^\s*(\d+)\s+(.+)$/);
        if (!match) return null;
        return {
          pid: Number(match[1]),
          command: String(match[2] || '').trim()
        };
      })
      .filter(Boolean)
      .filter((processInfo) => {
        if (!Number.isFinite(processInfo.pid) || processInfo.pid <= 0 || processInfo.pid === processObj.pid) {
          return false;
        }
        const command = processInfo.command;
        return (
          command.includes(helper)
          && command.includes(stateFilePath)
          && command.includes('app-server')
        ) || (
          upstream
          && command.includes(upstream)
          && command.includes('app-server')
        );
      });
  }

  function restartRunningAppServers() {
    const processes = listRunningAppServerProcesses();
    const signaled = [];
    for (const processInfo of processes) {
      try {
        processObj.kill(processInfo.pid, 'SIGTERM');
        signaled.push(processInfo.pid);
      } catch (_error) {}
    }
    return {
      ok: true,
      count: signaled.length,
      pids: signaled
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
    getDesktopAccountId,
    setDesktopAccountId,
    clearDesktopAccountId,
    ensureInstalled,
    updateTraceConfig,
    listRunningAppServerProcesses,
    restartRunningAppServers,
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

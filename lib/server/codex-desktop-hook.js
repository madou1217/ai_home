'use strict';

const path = require('node:path');
const { buildCodexAppServerWrapperScript } = require('./codex-app-server-hook-wrapper');
const { readJsonValue } = require('./app-state-store');
const { isAccountRef } = require('./account-ref-store');

const WRAPPER_MARKER = 'aih-codex-desktop-hook';
const MAX_WRAPPER_BYTES = 64 * 1024;
const NON_WRITABLE_ERROR_CODES = new Set(['EACCES', 'EPERM', 'EROFS']);
const CODEX_DESKTOP_BUNDLE_NAMES = Object.freeze(['ChatGPT.app', 'Codex.app']);

function normalizeDesktopAccountRef(value) {
  const normalized = String(value || '').trim();
  return isAccountRef(normalized) ? normalized : '';
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
  const value = readJsonValue(fs, aiHomeDir, 'desktop-client-paths');
  return value && typeof value === 'object' ? value : {};
}

function resolveCodexDesktopBundlePath(fs, aiHomeDir, hostHomeDir) {
  const cache = readDesktopClientPathCache(fs, aiHomeDir);
  const learnedBundle = cache && cache.codex && cache.codex.macos
    ? String(cache.codex.macos.bundlePath || '').trim()
    : '';
  const candidates = [
    learnedBundle,
    ...CODEX_DESKTOP_BUNDLE_NAMES.map((bundleName) => (
      hostHomeDir ? path.join(hostHomeDir, 'Applications', bundleName) : ''
    )),
    ...CODEX_DESKTOP_BUNDLE_NAMES.map((bundleName) => path.join('/Applications', bundleName))
  ];
  for (const candidate of candidates) {
    if (!candidate || !fs.existsSync(candidate)) continue;
    const codexRuntime = path.join(candidate, 'Contents', 'Resources', 'codex');
    if (fs.existsSync(codexRuntime)) return candidate;
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

  const stateFilePath = aiHomeDir
    ? pathImpl.join(aiHomeDir, 'run', 'codex', 'desktop-hook-state.json')
    : '';

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
    if (processObj.platform !== 'darwin') {
      return {
        bundlePath: '',
        targetBinaryPath: '',
        upstreamBinaryPath: ''
      };
    }
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
      const stat = fs.statSync(targetBinaryPath);
      if (!stat || Number(stat.size) > MAX_WRAPPER_BYTES) return false;
      return String(fs.readFileSync(targetBinaryPath, 'utf8')).includes(WRAPPER_MARKER);
    } catch (_error) {
      return false;
    }
  }

  function writeState(enabled, paths, extras = {}) {
    if (!stateFilePath) return false;
    const previous = readState();
    const {
      desktopAccountRef: _desktopAccountRef,
      providerHookReceiverUrl: nextProviderHookReceiverUrl,
      ...stateExtras
    } = extras;
    const desktopAccountRef = normalizeDesktopAccountRef(
      extras.desktopAccountRef !== undefined ? extras.desktopAccountRef : previous.desktopAccountRef
    );
    const hasHookTarget = Boolean(
      paths
      && String(paths.targetBinaryPath || '').trim()
      && String(paths.upstreamBinaryPath || '').trim()
    );
    fs.mkdirSync(pathImpl.dirname(stateFilePath), { recursive: true });
    fs.writeFileSync(stateFilePath, JSON.stringify({
      version: 1,
      enabled: enabled === true && hasHookTarget,
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
      ...(desktopAccountRef ? { desktopAccountRef } : {}),
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

  function getDesktopAccountRef() {
    return normalizeDesktopAccountRef(readState().desktopAccountRef);
  }

  function setDesktopAccountRef(accountRef) {
    const desktopAccountRef = normalizeDesktopAccountRef(accountRef);
    if (!desktopAccountRef) {
      return { ok: false, reason: 'invalid_account_ref' };
    }
    if (!stateFilePath) {
      return { ok: false, reason: 'state_file_unavailable' };
    }
    const previous = readState();
    const previousAccountRef = normalizeDesktopAccountRef(previous.desktopAccountRef);
    const written = writeState(previous.enabled === true, readStatePaths(previous), {
      desktopAccountRef
    });
    return {
      ok: written,
      stateFilePath,
      desktopAccountRef,
      changed: previousAccountRef !== desktopAccountRef
    };
  }

  function clearDesktopAccountRef(accountRef = '') {
    if (!stateFilePath) {
      return { ok: false, reason: 'state_file_unavailable' };
    }
    if (!fs.existsSync(stateFilePath)) {
      return { ok: true, stateFilePath, desktopAccountRef: '', changed: false };
    }
    const previous = readState();
    const currentRef = normalizeDesktopAccountRef(previous.desktopAccountRef);
    const expectedRef = normalizeDesktopAccountRef(accountRef);
    if (expectedRef && currentRef && currentRef !== expectedRef) {
      return { ok: true, stateFilePath, desktopAccountRef: currentRef, changed: false };
    }
    const written = writeState(previous.enabled === true, readStatePaths(previous), {
      desktopAccountRef: ''
    });
    return {
      ok: written,
      stateFilePath,
      desktopAccountRef: '',
      changed: Boolean(currentRef)
    };
  }

  function copyUpstreamSnapshot(targetBinaryPath, upstreamBinaryPath) {
    const stat = fs.statSync(targetBinaryPath);
    if (typeof fs.copyFileSync === 'function') {
      fs.copyFileSync(targetBinaryPath, upstreamBinaryPath);
    } else {
      const content = fs.readFileSync(targetBinaryPath);
      fs.writeFileSync(upstreamBinaryPath, content);
    }
    fs.chmodSync(upstreamBinaryPath, stat.mode & 0o777);
    return stat;
  }

  function toInstallFailure(error) {
    const code = String(error && error.code || '').trim();
    if (!NON_WRITABLE_ERROR_CODES.has(code)) throw error;
    return {
      ok: false,
      installed: false,
      enabled: false,
      retryable: false,
      reason: 'hook_target_not_writable',
      errorCode: code
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

    try {
      if (isWrapperInstalled(targetBinaryPath)) {
        if (!upstreamBinaryPath || !fs.existsSync(upstreamBinaryPath)) {
          return {
            ok: false,
            installed: false,
            reason: 'missing_upstream_backup'
          };
        }
        if (String(fs.readFileSync(targetBinaryPath, 'utf8')) === wrapper) {
          return {
            ok: true,
            installed: true,
            updated: false,
            unchanged: true,
            targetBinaryPath,
            upstreamBinaryPath
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
    } catch (error) {
      return toInstallFailure(error);
    }
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
    if (!installResult.ok) {
      writeState(false, paths, {
        reason: installResult.reason,
        errorCode: installResult.errorCode,
        retryable: installResult.retryable
      });
      return { ...installResult, supported: true, enabled: false };
    }
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
      ? pathImpl.join(aiHomeDir, 'logs', 'codex', 'mobile-trace.jsonl')
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
    writeState(previous.enabled === true, paths, {
      traceFile: nextTraceFile,
      traceResponses: nextTraceResponses,
      traceRemoteControl: nextTraceRemoteControl,
      remoteControlProxy: nextRemoteControlProxy,
      providerHookReceiverUrl,
      ...(previous.reason ? { reason: previous.reason } : {}),
      ...(previous.errorCode ? { errorCode: previous.errorCode } : {}),
      ...(previous.retryable === false ? { retryable: false } : {})
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
    const bundle = paths.bundlePath || resolvePaths().bundlePath;
    const target = paths.targetBinaryPath || resolvePaths().targetBinaryPath;
    const upstream = paths.upstreamBinaryPath || resolvePaths().upstreamBinaryPath;
    if (!bundle) return [];
    let result = null;
    try {
      result = spawnSyncImpl('ps', ['-axo', 'pid=,ppid=,command='], {
        encoding: 'utf8',
        windowsHide: true
      });
    } catch (_error) {
      return [];
    }
    if (!result || result.status !== 0) return [];
    const processes = String(result.stdout || '').split(/\r?\n/)
      .map((line) => {
        const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
        if (!match) return null;
        return {
          pid: Number(match[1]),
          parentPid: Number(match[2]),
          command: String(match[3] || '').trim()
        };
      })
      .filter(Boolean);
    const processByPid = new Map(processes.map((processInfo) => [processInfo.pid, processInfo]));
    const desktopMainDir = pathImpl.join(bundle, 'Contents', 'MacOS');
    return processes.filter((processInfo) => {
        if (!Number.isFinite(processInfo.pid) || processInfo.pid <= 0 || processInfo.pid === processObj.pid) {
          return false;
        }
        const parent = processByPid.get(processInfo.parentPid);
        if (!parent || !parent.command.startsWith(`${desktopMainDir}${pathImpl.sep}`)) {
          return false;
        }
        const command = processInfo.command;
        return (
          command.includes(helper)
          && command.includes(stateFilePath)
          && command.includes('app-server')
        ) || (
          target
          && command.includes(target)
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
    getDesktopAccountRef,
    setDesktopAccountRef,
    clearDesktopAccountRef,
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
  CODEX_DESKTOP_BUNDLE_NAMES,
  WRAPPER_MARKER,
  buildWrapperScript,
  createCodexDesktopHookService
};

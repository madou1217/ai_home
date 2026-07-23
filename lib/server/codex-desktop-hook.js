'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync: systemSpawnSync } = require('node:child_process');
const { buildCodexAppServerWrapperScript } = require('./codex-app-server-hook-wrapper');
const { readJsonValue } = require('./app-state-store');
const { isAccountRef } = require('./account-ref-store');

const WRAPPER_MARKER = 'aih-codex-desktop-hook';
const HOOK_STATE_VERSION = 2;
const PROCESS_ANCESTOR_LIMIT = 8;
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

function commandUsesExecutable(command, executablePath) {
  const commandText = String(command || '');
  const executable = String(executablePath || '').trim();
  return Boolean(executable)
    && (commandText === executable || commandText.includes(`${executable} `));
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

function hashText(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function getFileRevision(fs, filePath) {
  const normalized = String(filePath || '').trim();
  if (!normalized) return '';
  try {
    return hashText(fs.readFileSync(normalized));
  } catch (_error) {
    return '';
  }
}

function getFileFingerprint(fs, filePath) {
  const normalized = String(filePath || '').trim();
  if (!normalized) return null;
  try {
    const stat = fs.statSync(normalized);
    return {
      size: Number(stat && stat.size) || 0,
      mtimeMs: Number(stat && stat.mtimeMs) || 0
    };
  } catch (_error) {
    return null;
  }
}

function sameFingerprint(left, right) {
  return Boolean(left && right)
    && Number(left.size) === Number(right.size)
    && Number(left.mtimeMs) === Number(right.mtimeMs);
}

function readXmlPlistValue(content, key) {
  const escaped = String(key || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(content || '').match(new RegExp(`<key>${escaped}</key>\\s*<string>([^<]*)</string>`));
  return match ? String(match[1] || '').trim() : '';
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
  const inspectSpawnSync = deps.inspectSpawnSync || systemSpawnSync;
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

  function readBundleMetadata(bundlePath) {
    if (typeof deps.readBundleMetadata === 'function') {
      return deps.readBundleMetadata(bundlePath) || {};
    }
    const infoPlistPath = pathImpl.join(bundlePath, 'Contents', 'Info.plist');
    if (!fs.existsSync(infoPlistPath)) return {};
    try {
      const content = fs.readFileSync(infoPlistPath, 'utf8');
      const appVersion = readXmlPlistValue(content, 'CFBundleShortVersionString');
      const appBuildVersion = readXmlPlistValue(content, 'CFBundleVersion');
      if (appVersion || appBuildVersion) return { appVersion, appBuildVersion };
    } catch (_error) {}
    try {
      const readValue = (key) => {
        const result = inspectSpawnSync('/usr/bin/plutil', [
          '-extract', key, 'raw', '-o', '-', infoPlistPath
        ], { encoding: 'utf8', windowsHide: true });
        return result && result.status === 0 ? String(result.stdout || '').trim() : '';
      };
      return {
        appVersion: readValue('CFBundleShortVersionString'),
        appBuildVersion: readValue('CFBundleVersion')
      };
    } catch (_error) {
      return {};
    }
  }

  function readCodexVersion(upstreamBinaryPath, previousState, upstreamFingerprint) {
    if (typeof deps.readCodexVersion === 'function') {
      return String(deps.readCodexVersion(upstreamBinaryPath) || '').trim();
    }
    if (
      sameFingerprint(previousState && previousState.upstreamFingerprint, upstreamFingerprint)
      && String(previousState && previousState.codexVersion || '').trim()
    ) {
      return String(previousState.codexVersion).trim();
    }
    try {
      const result = inspectSpawnSync(upstreamBinaryPath, ['--version'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 3000
      });
      return result && result.status === 0
        ? String(result.stdout || result.stderr || '').trim().split(/\r?\n/)[0]
        : '';
    } catch (_error) {
      return '';
    }
  }

  function buildExpectedHookState(paths, previousState = readState()) {
    const wrapper = buildWrapperScript({
      nodeExecPath,
      helperScriptPath,
      upstreamBinaryPath: paths.upstreamBinaryPath,
      stateFilePath
    });
    const bundleMetadata = readBundleMetadata(paths.bundlePath);
    const upstreamFingerprint = getFileFingerprint(fs, paths.upstreamBinaryPath);
    return {
      appVersion: String(bundleMetadata.appVersion || '').trim(),
      appBuildVersion: String(bundleMetadata.appBuildVersion || '').trim(),
      codexVersion: readCodexVersion(paths.upstreamBinaryPath, previousState, upstreamFingerprint),
      wrapperRevision: hashText(wrapper),
      helperRevision: getFileRevision(fs, helperScriptPath),
      upstreamFingerprint
    };
  }

  function collectDriftReasons(paths, previousState = readState()) {
    const reasons = [];
    const wrapper = buildWrapperScript({
      nodeExecPath,
      helperScriptPath,
      upstreamBinaryPath: paths.upstreamBinaryPath,
      stateFilePath
    });
    const expected = buildExpectedHookState(paths, previousState);
    if (Number(previousState.version) !== HOOK_STATE_VERSION) reasons.push('state_schema');
    if (!isWrapperInstalled(paths.targetBinaryPath)) {
      reasons.push('wrapper_missing');
    } else {
      try {
        if (String(fs.readFileSync(paths.targetBinaryPath, 'utf8')) !== wrapper) reasons.push('wrapper_content');
      } catch (_error) {
        reasons.push('wrapper_unreadable');
      }
    }
    if (!paths.upstreamBinaryPath || !fs.existsSync(paths.upstreamBinaryPath)) reasons.push('upstream_missing');
    if (!samePath(previousState.bundlePath, paths.bundlePath)) reasons.push('bundle_path');
    if (!samePath(previousState.targetBinaryPath, paths.targetBinaryPath)) reasons.push('target_path');
    if (!samePath(previousState.upstreamBinaryPath, paths.upstreamBinaryPath)) reasons.push('upstream_path');
    if (String(previousState.appVersion || '') !== expected.appVersion) reasons.push('app_version');
    if (String(previousState.appBuildVersion || '') !== expected.appBuildVersion) reasons.push('app_build_version');
    if (String(previousState.codexVersion || '') !== expected.codexVersion) reasons.push('codex_version');
    if (String(previousState.wrapperRevision || '') !== expected.wrapperRevision) reasons.push('wrapper_revision');
    if (String(previousState.helperRevision || '') !== expected.helperRevision) reasons.push('helper_revision');
    if (!sameFingerprint(previousState.upstreamFingerprint, expected.upstreamFingerprint)) reasons.push('upstream_fingerprint');
    return { reasons: Array.from(new Set(reasons)), expected };
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
      version: HOOK_STATE_VERSION,
      enabled: enabled === true && hasHookTarget,
      updatedAt: new Date().toISOString(),
      bundlePath: paths.bundlePath,
      targetBinaryPath: paths.targetBinaryPath,
      upstreamBinaryPath: paths.upstreamBinaryPath,
      helperScriptPath,
      helperScriptMtimeMs: getFileMtimeMs(fs, helperScriptPath),
      helperRevision: String(extras.helperRevision !== undefined ? extras.helperRevision : previous.helperRevision || '').trim(),
      appVersion: String(extras.appVersion !== undefined ? extras.appVersion : previous.appVersion || '').trim(),
      appBuildVersion: String(
        extras.appBuildVersion !== undefined ? extras.appBuildVersion : previous.appBuildVersion || ''
      ).trim(),
      codexVersion: String(extras.codexVersion !== undefined ? extras.codexVersion : previous.codexVersion || '').trim(),
      wrapperRevision: String(
        extras.wrapperRevision !== undefined ? extras.wrapperRevision : previous.wrapperRevision || ''
      ).trim(),
      upstreamFingerprint: extras.upstreamFingerprint !== undefined
        ? extras.upstreamFingerprint
        : previous.upstreamFingerprint || null,
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
    const previous = readState();
    const drift = collectDriftReasons(paths, previous);
    const installResult = installWrapper(paths);
    if (!installResult.ok) {
      writeState(false, paths, {
        reason: installResult.reason,
        errorCode: installResult.errorCode,
        retryable: installResult.retryable
      });
      return { ...installResult, supported: true, enabled: false };
    }
    const nextHelperScriptMtimeMs = getFileMtimeMs(fs, helperScriptPath);
    const helperScriptChanged = !samePath(previous.helperScriptPath, helperScriptPath)
      || Number(previous.helperScriptMtimeMs || 0) !== nextHelperScriptMtimeMs
      || String(previous.helperRevision || '') !== drift.expected.helperRevision;
    const expected = buildExpectedHookState(paths, previous);
    writeState(true, paths, expected);
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
      driftReasons: drift.reasons,
      restartRequired: drift.reasons.length > 0,
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
    const previous = readState();
    const drift = collectDriftReasons(paths, previous);
    if (drift.reasons.length === 0) {
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
      driftReasons: drift.reasons,
      restartRequired: Boolean(repaired && repaired.ok && repaired.enabled),
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
    const nextHelperRevision = getFileRevision(fs, helperScriptPath);
    const changed = !samePath(previous.traceFile, nextTraceFile)
      || previous.traceResponses === true !== nextTraceResponses
      || previous.traceRemoteControl === true !== nextTraceRemoteControl
      || previous.remoteControlProxy === true !== nextRemoteControlProxy
      || !samePath(previous.helperScriptPath, helperScriptPath)
      || Number(previous.helperScriptMtimeMs || 0) !== nextHelperScriptMtimeMs
      || String(previous.helperRevision || '') !== nextHelperRevision;
    writeState(previous.enabled === true, paths, {
      traceFile: nextTraceFile,
      traceResponses: nextTraceResponses,
      traceRemoteControl: nextTraceRemoteControl,
      remoteControlProxy: nextRemoteControlProxy,
      providerHookReceiverUrl,
      helperRevision: nextHelperRevision,
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
    const hasDesktopAncestor = (processInfo) => {
      let current = processInfo;
      for (let depth = 0; depth < PROCESS_ANCESTOR_LIMIT; depth += 1) {
        current = processByPid.get(current.parentPid);
        if (!current) return false;
        if (current.command.startsWith(`${desktopMainDir}${pathImpl.sep}`)) return true;
      }
      return false;
    };
    const isDirectDesktopChild = (processInfo) => {
      const parent = processByPid.get(processInfo.parentPid);
      return Boolean(parent && parent.command.startsWith(`${desktopMainDir}${pathImpl.sep}`));
    };
    const candidates = processes.filter((processInfo) => {
      if (!Number.isFinite(processInfo.pid) || processInfo.pid <= 0 || processInfo.pid === processObj.pid) {
        return false;
      }
      if (!hasDesktopAncestor(processInfo)) return false;
      const command = processInfo.command;
      return (
        command.includes(helper)
        && command.includes(stateFilePath)
        && command.includes('app-server')
      ) || (
        target
        && commandUsesExecutable(command, target)
        && command.includes('app-server')
      ) || (
        upstream
        && isDirectDesktopChild(processInfo)
        && command.includes(upstream)
        && command.includes('app-server')
      );
    });
    const candidatePids = new Set(candidates.map((processInfo) => processInfo.pid));
    return candidates.filter((processInfo) => {
      let current = processInfo;
      for (let depth = 0; depth < PROCESS_ANCESTOR_LIMIT; depth += 1) {
        current = processByPid.get(current.parentPid);
        if (!current) return true;
        if (candidatePids.has(current.pid)) return false;
      }
      return true;
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
  HOOK_STATE_VERSION,
  WRAPPER_MARKER,
  buildWrapperScript,
  createCodexDesktopHookService
};

'use strict';

const path = require('node:path');
const { buildCodexAppServerWrapperScript } = require('./codex-app-server-hook-wrapper');

const WRAPPER_MARKER = 'aih-codex-vscode-hook';
const EXTENSION_ID_PREFIX = 'openai.chatgpt';

function buildWrapperScript(options = {}) {
  return buildCodexAppServerWrapperScript(WRAPPER_MARKER, options);
}

function uniqueStrings(values) {
  return Array.from(new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  ));
}

function resolveExtensionRoots(hostHomeDir, env = {}, pathImpl = path) {
  const roots = [
    env.VSCODE_EXTENSIONS,
    hostHomeDir ? pathImpl.join(hostHomeDir, '.vscode', 'extensions') : '',
    hostHomeDir ? pathImpl.join(hostHomeDir, '.vscode-insiders', 'extensions') : ''
  ];
  return uniqueStrings(roots);
}

function isOpenAiChatGptExtensionDir(entryName) {
  const name = String(entryName || '').trim();
  return name === EXTENSION_ID_PREFIX || name.startsWith(`${EXTENSION_ID_PREFIX}-`);
}

function isExecutableFile(fs, filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch (_error) {
    return false;
  }
}

function collectCodexBinariesFromExtension(fs, extensionDir, pathImpl = path) {
  const binDir = pathImpl.join(extensionDir, 'bin');
  let platformDirs = [];
  try {
    platformDirs = fs.readdirSync(binDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((entryName) => entryName.startsWith('macos-'));
  } catch (_error) {
    return [];
  }
  return platformDirs
    .map((platformDir) => pathImpl.join(binDir, platformDir, 'codex'))
    .filter((candidate) => isExecutableFile(fs, candidate));
}

function resolveCodexVscodeExtensionBinaryPaths(fs, options = {}) {
  const pathImpl = options.path || path;
  const processObj = options.processObj || process;
  if (processObj.platform !== 'darwin') return [];
  const hostHomeDir = String(options.hostHomeDir || '').trim();
  const env = processObj.env || {};
  const targets = [];

  for (const extensionRoot of resolveExtensionRoots(hostHomeDir, env, pathImpl)) {
    let entries = [];
    try {
      entries = fs.readdirSync(extensionRoot, { withFileTypes: true });
    } catch (_error) {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !isOpenAiChatGptExtensionDir(entry.name)) continue;
      targets.push(...collectCodexBinariesFromExtension(
        fs,
        pathImpl.join(extensionRoot, entry.name),
        pathImpl
      ));
    }
  }

  return uniqueStrings(targets).sort();
}

function readFilePrefix(fs, filePath, maxBytes = 4096) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(maxBytes);
    const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch (_error) {
    return '';
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_closeError) {}
    }
  }
}

function readTextFileSafe(fs, filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return '';
    return String(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return '';
  }
}

function copyUpstreamSnapshot(fs, targetBinaryPath, upstreamBinaryPath) {
  const stat = fs.statSync(targetBinaryPath);
  fs.copyFileSync(targetBinaryPath, upstreamBinaryPath);
  fs.chmodSync(upstreamBinaryPath, stat.mode & 0o777);
}

function createCodexVscodeHookService(deps = {}) {
  const fs = deps.fs;
  const pathImpl = deps.path || path;
  const processObj = deps.processObj || process;
  const spawnSyncImpl = deps.spawnSync || null;
  const aiHomeDir = String(deps.aiHomeDir || '').trim();
  const hostHomeDir = String(deps.hostHomeDir || '').trim();
  const nodeExecPath = String(deps.nodeExecPath || process.execPath).trim();
  const helperScriptPath = String(
    deps.helperScriptPath || require.resolve('./codex-app-server-stdio-proxy')
  ).trim();
  const stateFilePath = aiHomeDir ? pathImpl.join(aiHomeDir, 'codex-desktop-hook-state.json') : '';

  function resolvePaths() {
    return resolveCodexVscodeExtensionBinaryPaths(fs, {
      path: pathImpl,
      processObj,
      hostHomeDir
    }).map((targetBinaryPath) => ({
      targetBinaryPath,
      upstreamBinaryPath: `${targetBinaryPath}.aih-original`
    }));
  }

  function isWrapperInstalled(targetBinaryPath) {
    if (!targetBinaryPath || !fs.existsSync(targetBinaryPath)) return false;
    return readFilePrefix(fs, targetBinaryPath).includes(WRAPPER_MARKER);
  }

  function installWrapper(target) {
    const targetBinaryPath = String(target && target.targetBinaryPath || '').trim();
    const upstreamBinaryPath = String(target && target.upstreamBinaryPath || '').trim();
    if (!targetBinaryPath || !upstreamBinaryPath || !fs.existsSync(targetBinaryPath)) {
      return { ok: false, installed: false, reason: 'target_binary_missing', targetBinaryPath };
    }
    if (!stateFilePath) {
      return { ok: false, installed: false, reason: 'state_file_unavailable', targetBinaryPath };
    }

    const wrapper = buildWrapperScript({
      nodeExecPath,
      helperScriptPath,
      upstreamBinaryPath,
      stateFilePath
    });
    if (isWrapperInstalled(targetBinaryPath)) {
      if (!fs.existsSync(upstreamBinaryPath)) {
        return { ok: false, installed: false, reason: 'missing_upstream_backup', targetBinaryPath };
      }
      if (readTextFileSafe(fs, targetBinaryPath) !== wrapper) {
        fs.writeFileSync(targetBinaryPath, wrapper, 'utf8');
        fs.chmodSync(targetBinaryPath, 0o755);
        return { ok: true, installed: false, updated: true, changed: true, targetBinaryPath, upstreamBinaryPath };
      }
      return { ok: true, installed: false, updated: false, changed: false, targetBinaryPath, upstreamBinaryPath };
    }

    copyUpstreamSnapshot(fs, targetBinaryPath, upstreamBinaryPath);
    fs.writeFileSync(targetBinaryPath, wrapper, 'utf8');
    fs.chmodSync(targetBinaryPath, 0o755);
    return { ok: true, installed: true, updated: false, changed: true, targetBinaryPath, upstreamBinaryPath };
  }

  function installAll() {
    if (processObj.platform !== 'darwin') {
      return { ok: true, supported: false, enabled: false, reason: 'unsupported_platform', targets: [] };
    }
    const targets = resolvePaths();
    if (targets.length === 0) {
      return {
        ok: true,
        supported: true,
        enabled: false,
        reason: 'vscode_codex_extension_not_found',
        targets: []
      };
    }
    const results = targets.map((target) => installWrapper(target));
    const failed = results.filter((result) => !result.ok);
    return {
      ok: failed.length === 0,
      supported: true,
      enabled: failed.length === 0,
      installed: results.filter((result) => result.installed).length,
      changed: results.some((result) => result.changed),
      targets: results,
      reason: failed.length > 0 ? 'install_failed' : ''
    };
  }

  function activate() {
    return installAll();
  }

  function ensureInstalled() {
    const result = installAll();
    return {
      ...result,
      repaired: Boolean(result && result.ok && result.changed)
    };
  }

  function listRunningAppServerProcesses() {
    if (!spawnSyncImpl) return [];
    const targets = resolvePaths();
    const pathNeedles = new Set();
    for (const target of targets) {
      pathNeedles.add(target.targetBinaryPath);
      pathNeedles.add(target.upstreamBinaryPath);
    }
    if (pathNeedles.size === 0) return [];
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
        return { pid: Number(match[1]), command: String(match[2] || '').trim() };
      })
      .filter(Boolean)
      .filter((processInfo) => {
        if (!Number.isFinite(processInfo.pid) || processInfo.pid <= 0 || processInfo.pid === processObj.pid) {
          return false;
        }
        if (!processInfo.command.includes('app-server')) return false;
        for (const needle of pathNeedles) {
          if (needle && processInfo.command.includes(needle)) return true;
        }
        return false;
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
    return { ok: true, count: signaled.length, pids: signaled };
  }

  return {
    resolvePaths,
    buildWrapperScript,
    isWrapperInstalled,
    activate,
    ensureInstalled,
    listRunningAppServerProcesses,
    restartRunningAppServers
  };
}

module.exports = {
  WRAPPER_MARKER,
  buildWrapperScript,
  createCodexVscodeHookService,
  resolveCodexVscodeExtensionBinaryPaths,
  __private: {
    collectCodexBinariesFromExtension,
    resolveExtensionRoots
  }
};

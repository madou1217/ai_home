'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { AI_CLI_CONFIGS } = require('./provider-registry');
const {
  readJsonValue,
  writeJsonValue
} = require('../../../server/app-state-store');

const DESKTOP_CLIENT_PATHS_KEY = 'desktop-client-paths';

function normalizePlatform(platform) {
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  if (platform === 'linux') return 'linux';
  return String(platform || '').trim().toLowerCase();
}

function toLowerValues(values) {
  return (Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean);
}

function extractExecutableFromCommandLine(commandLine) {
  const input = String(commandLine || '').trim();
  if (!input) return '';
  const quote = input[0];
  if (quote === '"' || quote === '\'') {
    const end = input.indexOf(quote, 1);
    if (end > 1) return input.slice(1, end).trim();
  }
  const firstWhitespace = input.search(/\s/);
  return firstWhitespace === -1 ? input : input.slice(0, firstWhitespace).trim();
}

function extractMacAppBundlePath(executablePath) {
  const input = String(executablePath || '').trim();
  if (!input) return '';
  const marker = '/Contents/MacOS/';
  const idx = input.indexOf(marker);
  if (idx === -1) return '';
  return input.slice(0, idx);
}

function isValidMacDesktopExecutable(executablePath) {
  return Boolean(extractMacAppBundlePath(executablePath));
}

function sleepMs(durationMs) {
  const timeout = Math.max(0, Number(durationMs) || 0);
  if (timeout <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, timeout);
}

const DESKTOP_SANDBOX_ENV_KEYS = Object.freeze([
  'CODEX_HOME',
  'CODEX_SQLITE_HOME',
  'CLAUDE_CONFIG_DIR',
  'AIH_HOME',
  'AIH_HOST_HOME',
  'AI_HOME_DIR',
  'AIH_PROFILE_DIR',
  'AIH_PROFILE_ID',
  'AIH_PERSIST_ACTIVE',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME'
]);

function createDesktopClientRestartService(deps = {}) {
  const fsImpl = deps.fs || fs;
  const pathImpl = deps.path || path;
  const spawnImpl = deps.spawn || spawn;
  const spawnSyncImpl = deps.spawnSync || spawnSync;
  const processObj = deps.processObj || process;
  const cliConfigs = deps.cliConfigs || AI_CLI_CONFIGS;
  const aiHomeDir = String(deps.aiHomeDir || '').trim();
  const hostHomeDir = String(deps.hostHomeDir || '').trim();
  const stopWaitTimeoutMs = Math.max(1000, Number(deps.stopWaitTimeoutMs) || 30000);
  const stopWaitIntervalMs = Math.max(50, Number(deps.stopWaitIntervalMs) || 250);

  function getBaseEnv() {
    const env = processObj && processObj.env && typeof processObj.env === 'object'
      ? processObj.env
      : process.env;
    const out = {};
    Object.keys(env || {}).forEach((key) => {
      const value = env[key];
      if (value !== undefined && value !== null) out[key] = String(value);
    });
    return out;
  }

  function resolvePathApi(platformKey) {
    if (platformKey === 'windows') return path.win32;
    return pathImpl;
  }

  function resolveLaunchCwd(platformKey, executablePath) {
    const pathApi = resolvePathApi(platformKey);
    const parentDir = String(executablePath || '').trim()
      ? pathApi.dirname(String(executablePath || '').trim())
      : '';
    if (parentDir && parentDir !== '.' && parentDir !== executablePath) return parentDir;
    return hostHomeDir || '';
  }

  function applyWindowsHomeEnv(env) {
    if (!hostHomeDir) return;
    env.HOME = hostHomeDir;
    env.USERPROFILE = hostHomeDir;
    const match = hostHomeDir.match(/^([A-Za-z]:)([\\/].*)?$/);
    if (!match) return;
    env.HOMEDRIVE = match[1];
    env.HOMEPATH = (match[2] || '\\').replace(/\//g, '\\');
  }

  function buildDesktopLaunchOptions(platformKey, executablePath) {
    const env = getBaseEnv();
    DESKTOP_SANDBOX_ENV_KEYS.forEach((key) => {
      delete env[key];
    });
    if (platformKey === 'windows') {
      applyWindowsHomeEnv(env);
    } else if (hostHomeDir) {
      env.HOME = hostHomeDir;
      env.USERPROFILE = hostHomeDir;
    }
    const options = {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env
    };
    const cwd = resolveLaunchCwd(platformKey, executablePath);
    if (cwd) options.cwd = cwd;
    return options;
  }

  function loadLearnedPaths() {
    const value = readJsonValue(fsImpl, aiHomeDir, DESKTOP_CLIENT_PATHS_KEY);
    return value && typeof value === 'object' ? value : {};
  }

  function saveLearnedPaths(payload) {
    return writeJsonValue(fsImpl, aiHomeDir, DESKTOP_CLIENT_PATHS_KEY, payload, { bestEffort: true });
  }

  function rememberExecutablePath(cliName, platformKey, clientName, executablePath) {
    const target = String(executablePath || '').trim();
    if (!target) return false;
    const cache = loadLearnedPaths();
    if (!cache[cliName] || typeof cache[cliName] !== 'object') cache[cliName] = {};
    const record = {
      clientName: String(clientName || cliName).trim() || cliName,
      executablePath: target
    };
    if (platformKey === 'macos') {
      const bundlePath = extractMacAppBundlePath(target);
      if (bundlePath) record.bundlePath = bundlePath;
    }
    cache[cliName][platformKey] = record;
    return saveLearnedPaths(cache);
  }

  function forgetExecutablePath(cliName, platformKey) {
    const cache = loadLearnedPaths();
    if (!cache[cliName] || typeof cache[cliName] !== 'object' || !cache[cliName][platformKey]) return false;
    delete cache[cliName][platformKey];
    if (Object.keys(cache[cliName]).length === 0) delete cache[cliName];
    return saveLearnedPaths(cache);
  }

  function getSavedExecutableRecord(cliName, platformKey) {
    const cache = loadLearnedPaths();
    const record = cache && cache[cliName] && cache[cliName][platformKey];
    if (!record || typeof record !== 'object') return null;
    const executablePath = String(record.executablePath || '').trim();
    const bundlePath = String(record.bundlePath || '').trim();
    if (platformKey === 'macos') {
      const normalizedBundlePath = bundlePath || extractMacAppBundlePath(executablePath);
      if (!normalizedBundlePath) return null;
      return {
        clientName: String(record.clientName || cliName).trim() || cliName,
        executablePath,
        bundlePath: normalizedBundlePath
      };
    }
    if (!executablePath && !bundlePath) return null;
    return {
      clientName: String(record.clientName || cliName).trim() || cliName,
      executablePath,
      bundlePath
    };
  }

  function listUnixProcesses() {
    try {
      const run = spawnSyncImpl('ps', ['-ax', '-o', 'pid=,command='], {
        encoding: 'utf8'
      });
      if (run.status !== 0) {
        return {
          ok: false,
          reason: 'process_list_failed',
          detail: String(run.stderr || run.stdout || '').trim()
        };
      }
      const processes = String(run.stdout || '')
        .split(/\r?\n/)
        .map((line) => String(line || '').trim())
        .filter(Boolean)
        .map((line) => {
          const match = line.match(/^(\d+)\s+(.+)$/);
          if (!match) return null;
          const pid = Number(match[1]);
          const commandLine = match[2].trim();
          const executablePath = extractExecutableFromCommandLine(commandLine);
          const baseName = executablePath ? pathImpl.basename(executablePath) : '';
          return {
            pid,
            name: baseName,
            executablePath,
            commandLine
          };
        })
        .filter(Boolean);
      return { ok: true, processes };
    } catch (error) {
      return {
        ok: false,
        reason: 'process_list_failed',
        detail: error && error.message ? error.message : String(error)
      };
    }
  }

  function listWindowsProcesses() {
    try {
      const run = spawnSyncImpl('powershell.exe', [
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress'
      ], {
        encoding: 'utf8'
      });
      if (run.status !== 0) {
        return {
          ok: false,
          reason: 'process_list_failed',
          detail: String(run.stderr || run.stdout || '').trim()
        };
      }
      const raw = String(run.stdout || '').trim();
      if (!raw) return { ok: true, processes: [] };
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      const processes = items
        .filter(Boolean)
        .map((item) => {
          const executablePath = String(item.ExecutablePath || '').trim() || extractExecutableFromCommandLine(item.CommandLine);
          const name = String(item.Name || '').trim() || (executablePath ? pathImpl.basename(executablePath) : '');
          return {
            pid: Number(item.ProcessId),
            name,
            executablePath,
            commandLine: String(item.CommandLine || '').trim()
          };
        })
        .filter((item) => Number.isFinite(item.pid) && item.pid > 0);
      return { ok: true, processes };
    } catch (error) {
      return {
        ok: false,
        reason: 'process_list_failed',
        detail: error && error.message ? error.message : String(error)
      };
    }
  }

  function matchesDesktopClient(processInfo, platformConfig, platformKey) {
    if (!processInfo || !platformConfig) return false;
    if (Number(processInfo.pid) === Number(processObj.pid)) return false;

    const caseSensitive = platformKey === 'linux';
    const exactNames = new Set((Array.isArray(platformConfig.processNames) ? platformConfig.processNames : [])
      .concat(Array.isArray(platformConfig.execNames) ? platformConfig.execNames : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .map((value) => (caseSensitive ? value : value.toLowerCase())));
    const pathIncludes = toLowerValues(platformConfig.pathIncludes);

    const rawProcessName = String(processInfo.name || '').trim();
    const rawExecutablePath = String(processInfo.executablePath || '').trim();
    const rawCommandLine = String(processInfo.commandLine || '').trim();
    if (platformKey === 'macos' && !isValidMacDesktopExecutable(rawExecutablePath)) {
      return false;
    }
    const processName = caseSensitive ? rawProcessName : rawProcessName.toLowerCase();
    const executablePath = caseSensitive ? rawExecutablePath : rawExecutablePath.toLowerCase();
    const commandLine = caseSensitive ? rawCommandLine : rawCommandLine.toLowerCase();

    if (exactNames.has(processName)) return true;
    if (rawExecutablePath) {
      const execBaseName = pathImpl.basename(rawExecutablePath);
      const normalizedBaseName = caseSensitive ? execBaseName : execBaseName.toLowerCase();
      if (exactNames.has(normalizedBaseName)) return true;
    }
    if (!caseSensitive) {
      return pathIncludes.some((needle) => executablePath.includes(needle) || commandLine.includes(needle));
    }
    return pathIncludes.some((needle) => rawExecutablePath.toLowerCase().includes(needle) || rawCommandLine.toLowerCase().includes(needle));
  }

  function getPlatformConfig(cliName, platformKey) {
    const cliConfig = cliConfigs[String(cliName || '').trim()];
    return cliConfig && cliConfig.desktopClient && cliConfig.desktopClient[platformKey]
      ? cliConfig.desktopClient[platformKey]
      : null;
  }

  function resolveInstallPathToken(input) {
    return String(input || '').replace('{hostHomeDir}', hostHomeDir);
  }

  function findInstalledDesktopClientRecord(platformKey, platformConfig) {
    const installPaths = Array.isArray(platformConfig && platformConfig.installPaths)
      ? platformConfig.installPaths
      : [];
    for (const rawCandidate of installPaths) {
      const candidate = resolveInstallPathToken(rawCandidate).trim();
      if (!candidate) continue;
      if (typeof fsImpl.existsSync === 'function' && !fsImpl.existsSync(candidate)) continue;
      if (platformKey === 'macos') {
        const execNames = (Array.isArray(platformConfig.execNames) ? platformConfig.execNames : [])
          .map((name) => String(name || '').trim())
          .filter(Boolean);
        const bundleName = pathImpl.basename(candidate, '.app');
        const matchingExecName = execNames.find((name) => name.toLowerCase() === bundleName.toLowerCase());
        const execName = execNames.find((name) => (
          typeof fsImpl.existsSync !== 'function'
          || fsImpl.existsSync(pathImpl.join(candidate, 'Contents', 'MacOS', name))
        )) || matchingExecName || execNames[0] || '';
        return {
          clientName: platformConfig.clientName || execName || 'Desktop Client',
          bundlePath: candidate,
          executablePath: execName ? pathImpl.join(candidate, 'Contents', 'MacOS', execName) : ''
        };
      }
      return {
        clientName: platformConfig.clientName || 'Desktop Client',
        executablePath: candidate,
        bundlePath: ''
      };
    }
    return null;
  }

  function findRunningDesktopClient(cliName, platformKey) {
    const platformConfig = getPlatformConfig(cliName, platformKey);
    if (!platformConfig) {
      return {
        supported: false,
        detected: false,
        restarted: false,
        launched: false,
        reason: 'unsupported_platform'
      };
    }

    const listed = platformKey === 'windows' ? listWindowsProcesses() : listUnixProcesses();
    if (!listed.ok) {
      return {
        supported: true,
        detected: false,
        restarted: false,
        launched: false,
        clientName: platformConfig.clientName || cliName,
        reason: listed.reason,
        detail: listed.detail
      };
    }

    const match = listed.processes.find((processInfo) => matchesDesktopClient(processInfo, platformConfig, platformKey));
    if (!match) {
      return {
        supported: true,
        detected: false,
        restarted: false,
        launched: false,
        clientName: platformConfig.clientName || cliName,
        reason: 'not_running'
      };
    }

    return {
      supported: true,
      detected: true,
      restarted: false,
      launched: false,
      platform: platformKey,
      clientName: platformConfig.clientName || match.name || cliName,
      processInfo: match
    };
  }

  function stopDesktopClient(pid, platformKey, platformConfig) {
    if (platformKey === 'macos' && platformConfig && platformConfig.bundleId) {
      try {
        const run = spawnSyncImpl('osascript', [
          '-e',
          `tell application id "${platformConfig.bundleId}" to quit`
        ], {
          encoding: 'utf8'
        });
        if (run.status === 0) return { ok: true, mode: 'applescript' };
      } catch (_error) {
        // fallback to signal-based stop below
      }
    }
    if (platformKey === 'windows') {
      try {
        const run = spawnSyncImpl('taskkill', ['/PID', String(pid), '/T', '/F'], {
          encoding: 'utf8'
        });
        if (run.status === 0) return { ok: true };
        return {
          ok: false,
          reason: 'stop_failed',
          detail: String(run.stderr || run.stdout || '').trim()
        };
      } catch (error) {
        return {
          ok: false,
          reason: 'stop_failed',
          detail: error && error.message ? error.message : String(error)
        };
      }
    }

    try {
      processObj.kill(Number(pid), 'SIGTERM');
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        reason: 'stop_failed',
        detail: error && error.message ? error.message : String(error)
      };
    }
  }

  function forceStopDesktopClient(pid, platformKey) {
    const numericPid = Number(pid);
    if (!Number.isFinite(numericPid) || numericPid <= 0) {
      return { ok: false, reason: 'invalid_pid' };
    }
    if (platformKey === 'windows') {
      return stopDesktopClient(numericPid, platformKey, null);
    }
    try {
      processObj.kill(numericPid, 'SIGKILL');
      return { ok: true, mode: 'force_kill' };
    } catch (error) {
      return {
        ok: false,
        reason: 'force_stop_failed',
        detail: error && error.message ? error.message : String(error)
      };
    }
  }

  function isProcessAlive(pid, platformKey) {
    const numericPid = Number(pid);
    if (!Number.isFinite(numericPid) || numericPid <= 0) return false;
    if (processObj && typeof processObj.kill === 'function') {
      try {
        processObj.kill(numericPid, 0);
        return true;
      } catch (_error) {
        return false;
      }
    }
    const listed = platformKey === 'windows' ? listWindowsProcesses() : listUnixProcesses();
    if (!listed.ok) return false;
    return listed.processes.some((processInfo) => Number(processInfo.pid) === numericPid);
  }

  function waitForProcessExit(pid, platformKey) {
    const deadline = Date.now() + stopWaitTimeoutMs;
    while (Date.now() < deadline) {
      if (!isProcessAlive(pid, platformKey)) return true;
      sleepMs(stopWaitIntervalMs);
    }
    return !isProcessAlive(pid, platformKey);
  }

  function launchDesktopClient(platformKey, launchRecord) {
    const executablePath = String(launchRecord && launchRecord.executablePath || '').trim();
    const bundlePath = String(launchRecord && launchRecord.bundlePath || '').trim();
    try {
      let child = null;
      if (platformKey === 'macos') {
        const appTarget = bundlePath || extractMacAppBundlePath(executablePath);
        if (!appTarget) return { ok: false, reason: 'missing_bundle_path' };
        child = spawnImpl('open', ['-a', appTarget], buildDesktopLaunchOptions(platformKey, executablePath || appTarget));
      } else {
        if (!executablePath) return { ok: false, reason: 'missing_executable_path' };
        child = spawnImpl(executablePath, [], buildDesktopLaunchOptions(platformKey, executablePath));
      }
      if (child && typeof child.unref === 'function') child.unref();
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        reason: 'spawn_failed',
        detail: error && error.message ? error.message : String(error)
      };
    }
  }

  function restartDetectedDesktopClient(cliName, options = {}) {
    const normalizedCli = String(cliName || '').trim();
    const platformKey = normalizePlatform(processObj.platform);
    const platformConfig = getPlatformConfig(normalizedCli, platformKey);
    const forceQuitRequested = Boolean(options && options.forceQuit);
    if (!platformConfig) {
      return {
        supported: false,
        detected: false,
        restarted: false,
        launched: false,
        reason: 'unsupported_platform'
      };
    }

    const running = findRunningDesktopClient(normalizedCli, platformKey);
    if (running.detected) {
      const processInfo = running.processInfo || {};
      const learnedPath = String(processInfo.executablePath || '').trim();
      const savedRecord = getSavedExecutableRecord(normalizedCli, platformKey);
      const launchRecord = {
        executablePath: learnedPath || (savedRecord ? savedRecord.executablePath : ''),
        bundlePath: platformKey === 'macos'
          ? (extractMacAppBundlePath(learnedPath) || (savedRecord ? savedRecord.bundlePath : ''))
          : ''
      };
      if (!launchRecord.executablePath && !launchRecord.bundlePath) {
        return {
          supported: true,
          detected: true,
          restarted: false,
          launched: false,
          clientName: running.clientName,
          reason: 'missing_executable_path'
        };
      }
      const cachedPathUpdated = learnedPath
        ? rememberExecutablePath(normalizedCli, platformKey, running.clientName, learnedPath)
        : false;
      let stopResult = null;
      if (forceQuitRequested) {
        stopResult = forceStopDesktopClient(processInfo.pid, platformKey);
        if (!stopResult.ok) {
          return {
            supported: true,
            detected: true,
            restarted: false,
            launched: false,
            clientName: running.clientName,
            reason: stopResult.reason,
            detail: stopResult.detail,
            cachedPathUpdated
          };
        }
        if (!waitForProcessExit(processInfo.pid, platformKey)) {
          return {
            supported: true,
            detected: true,
            restarted: false,
            launched: false,
            clientName: running.clientName,
            reason: 'stop_timeout',
            cachedPathUpdated
          };
        }
      } else {
        stopResult = stopDesktopClient(processInfo.pid, platformKey, platformConfig);
        if (!stopResult.ok) {
          return {
            supported: true,
            detected: true,
            restarted: false,
            launched: false,
            clientName: running.clientName,
            reason: stopResult.reason,
            detail: stopResult.detail,
            cachedPathUpdated
          };
        }
        if (!waitForProcessExit(processInfo.pid, platformKey)) {
          const forceStopResult = forceStopDesktopClient(processInfo.pid, platformKey);
          if (!forceStopResult.ok || !waitForProcessExit(processInfo.pid, platformKey)) {
            return {
              supported: true,
              detected: true,
              restarted: false,
              launched: false,
              clientName: running.clientName,
              reason: 'stop_timeout',
              cachedPathUpdated
            };
          }
          stopResult.mode = forceStopResult.mode || stopResult.mode || '';
        }
      }
      const launchResult = launchDesktopClient(platformKey, launchRecord);
      if (!launchResult.ok) {
        return {
          supported: true,
          detected: true,
          restarted: false,
          launched: false,
          clientName: running.clientName,
          reason: launchResult.reason,
          detail: launchResult.detail,
          cachedPathUpdated
        };
      }
      return {
        supported: true,
        detected: true,
        restarted: true,
        launched: false,
        clientName: running.clientName,
        stopMode: stopResult.mode || '',
        forceQuit: stopResult.mode === 'force_kill',
        cachedPathUpdated
      };
    }

    if (running.reason !== 'not_running') return running;

    const savedRecord = getSavedExecutableRecord(normalizedCli, platformKey);
    if (!savedRecord) {
      const installedRecord = findInstalledDesktopClientRecord(platformKey, platformConfig);
      if (installedRecord) {
        rememberExecutablePath(normalizedCli, platformKey, installedRecord.clientName, installedRecord.executablePath);
        const launchResult = launchDesktopClient(platformKey, installedRecord);
        if (launchResult.ok) {
          return {
            supported: true,
            detected: false,
            restarted: false,
            launched: true,
            clientName: installedRecord.clientName,
            usedInstalledPath: true
          };
        }
        return {
          supported: true,
          detected: false,
          restarted: false,
          launched: false,
          clientName: installedRecord.clientName,
          reason: launchResult.reason,
          detail: launchResult.detail,
          usedInstalledPath: true
        };
      }
      return {
        supported: true,
        detected: false,
        restarted: false,
        launched: false,
        clientName: platformConfig.clientName || normalizedCli,
        reason: 'no_saved_path'
      };
    }
    const savedPathForCheck = platformKey === 'macos'
      ? (savedRecord.bundlePath || savedRecord.executablePath)
      : savedRecord.executablePath;
    if (typeof fsImpl.existsSync === 'function' && savedPathForCheck && !fsImpl.existsSync(savedPathForCheck)) {
      forgetExecutablePath(normalizedCli, platformKey);
      return {
        supported: true,
        detected: false,
        restarted: false,
        launched: false,
        clientName: savedRecord.clientName,
        reason: 'saved_path_missing'
      };
    }
    const launchResult = launchDesktopClient(platformKey, savedRecord);
    if (!launchResult.ok) {
      return {
        supported: true,
        detected: false,
        restarted: false,
        launched: false,
        clientName: savedRecord.clientName,
        reason: launchResult.reason,
        detail: launchResult.detail,
        usedSavedPath: true
      };
    }
    return {
      supported: true,
      detected: false,
      restarted: false,
      launched: true,
      clientName: savedRecord.clientName,
      usedSavedPath: true
    };
  }

  return {
    restartDetectedDesktopClient
  };
}

module.exports = {
  createDesktopClientRestartService,
  extractExecutableFromCommandLine,
  extractMacAppBundlePath,
  normalizePlatform
};

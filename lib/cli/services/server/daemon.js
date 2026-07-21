'use strict';
const { createServerAutostartService } = require('./autostart');
const {
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
  buildServerBaseUrl,
  normalizeServerPort
} = require('../../../server/server-defaults');
const {
  clearRecordedSourceFingerprint: clearRecordedSourceFingerprintFile,
  findSourceEntryFromCwd,
  getSourceFingerprintFilePath,
  getSourceFreshness: computeSourceFreshness,
  isBackgroundSupervisorCommand,
  isExistingAiHomeEntry,
  parseServerEntryFilePathFromCommand,
  samePath: sameSourcePath,
  writeRecordedSourceFingerprint: writeRecordedSourceFingerprintFile
} = require('../../../server/source-fingerprint');

function createServerDaemonService(deps = {}) {
  const fs = deps.fs;
  const path = deps.path;
  const spawn = deps.spawn;
  const spawnSync = deps.spawnSync;
  const fetchImpl = deps.fetchImpl || fetch;
  const processObj = deps.processObj || process;
  const ensureDir = deps.ensureDir;
  const parseServeArgs = deps.parseServeArgs;
  const readServerConfig = deps.readServerConfig;
  const buildServerArgsFromConfig = deps.buildServerArgsFromConfig;
  const aiHomeDir = deps.aiHomeDir;
  const hostHomeDir = deps.hostHomeDir;
  const pidFile = deps.pidFile;
  const logFile = deps.logFile;
  const launchdLabel = deps.launchdLabel;
  const launchdPlist = deps.launchdPlist;
  const entryFilePath = deps.entryFilePath;
  const prepareBackgroundStart = deps.prepareBackgroundStart;
  const defaultPort = normalizeServerPort(deps.defaultPort, DEFAULT_SERVER_PORT);
  const sourceFingerprintFile = getSourceFingerprintFilePath(path, aiHomeDir);
  const autostartService = createServerAutostartService({
    fs,
    path,
    spawnSync,
    processObj,
    ensureDir,
    aiHomeDir,
    hostHomeDir,
    launchdLabel,
    launchdPlist,
    logFile,
    resolveStartEntryFilePath,
    resolveStartServeArgs
  });

  function samePath(left, right) {
    return sameSourcePath(path, processObj, left, right);
  }

  function resolveStartEntryFilePath(startOptions = {}) {
    const sourceEntry = startOptions.preferCwdEntryFilePath === false
      ? ''
      : findSourceEntryFromCwd(fs, path, processObj);
    if (sourceEntry) return { entryFilePath: sourceEntry, source: 'cwd' };

    const requestedEntry = String(startOptions.entryFilePath || '').trim();
    if (requestedEntry) {
      return { entryFilePath: requestedEntry, source: 'previous' };
    }

    return { entryFilePath, source: 'current' };
  }

  function writeRecordedSourceFingerprint(pid, candidateEntryFilePath) {
    writeRecordedSourceFingerprintFile(fs, path, sourceFingerprintFile, pid, candidateEntryFilePath);
  }

  function clearRecordedSourceFingerprint() {
    clearRecordedSourceFingerprintFile(fs, sourceFingerprintFile);
  }

  function clearPidState() {
    try { fs.unlinkSync(pidFile); } catch (_e) {}
    clearRecordedSourceFingerprint();
  }

  function runBackgroundStartPreparation() {
    if (typeof prepareBackgroundStart !== 'function') return null;
    try {
      return prepareBackgroundStart() || null;
    } catch (error) {
      return {
        ok: false,
        reason: 'background_start_preparation_failed',
        error
      };
    }
  }

  function resolveCurrentSourceEntryFilePath() {
    return findSourceEntryFromCwd(fs, path, processObj) || entryFilePath;
  }

  function getSourceFreshness(pid, runningEntryFilePath) {
    return computeSourceFreshness({
      fs,
      path,
      processObj,
      sourceFingerprintFile,
      pid,
      runningEntryFilePath,
      currentEntryFilePath: resolveCurrentSourceEntryFilePath()
    });
  }

  function readPid() {
    if (!fs.existsSync(pidFile)) return 0;
    try {
      const val = String(fs.readFileSync(pidFile, 'utf8')).trim();
      return /^\d+$/.test(val) ? Number(val) : 0;
    } catch (_e) {
      return 0;
    }
  }

  function isAlive(pid) {
    if (!Number.isFinite(pid) || pid <= 0) return false;
    try {
      processObj.kill(pid, 0);
      return true;
    } catch (_e) {
      return false;
    }
  }

  function waitForReady(port, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
      const tick = async () => {
        if (Date.now() > deadline) {
          resolve(false);
          return;
        }
        try {
          const res = await fetchImpl(`http://127.0.0.1:${port}/healthz`);
          if (res.ok) {
            resolve(true);
            return;
          }
        } catch (_e) {}
        setTimeout(tick, 150);
      };
      tick();
    });
  }

  function scheduleBackgroundReadyProbe(pid, port, timeoutMs) {
    const startedAt = Date.now();
    const tick = () => {
      if (!isAlive(pid)) {
        if (readPid() === pid) {
          try { fs.unlinkSync(pidFile); } catch (_e) {}
        }
        return;
      }
      waitForReady(port, 150).then((ready) => {
        if (ready) return;
        if (Date.now() - startedAt >= timeoutMs) return;
        const timer = setTimeout(tick, 150);
        if (typeof timer.unref === 'function') timer.unref();
      }).catch(() => {
        if (Date.now() - startedAt >= timeoutMs) return;
        const timer = setTimeout(tick, 150);
        if (typeof timer.unref === 'function') timer.unref();
      });
    };
    const timer = setTimeout(tick, 0);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function readProcessCommand(pid) {
    if (!Number.isFinite(pid) || pid <= 0) return '';
    try {
      if (processObj.platform === 'win32') {
        const out = spawnSync('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty CommandLine`
        ], { encoding: 'utf8' });
        if (out.status === 0 && out.stdout) {
          return String(out.stdout || '').trim();
        }
        return '';
      } else {
        const out = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
        if (out.status !== 0) return '';
        return String(out.stdout || '').trim();
      }
    } catch (_e) {
      return '';
    }
  }

  function parseServerEntryFilePath(command) {
    return parseServerEntryFilePathFromCommand(command, { fs, path });
  }

  function isAihServerCommand(command) {
    const detectedEntry = parseServerEntryFilePath(command);
    if (!detectedEntry) return false;
    return samePath(detectedEntry, entryFilePath) || isExistingAiHomeEntry(fs, path, detectedEntry);
  }

  function isAihServerProcess(pid) {
    if (!isAlive(pid)) return false;
    return isAihServerCommand(readProcessCommand(pid));
  }

  function parseServePortFromCommand(command) {
    const text = String(command || '').trim();
    if (!text) return 0;
    const inline = text.match(/(?:^|\s)--port=(\d{1,5})(?=\s|$)/);
    const spaced = inline ? null : text.match(/(?:^|\s)--port\s+(\d{1,5})(?=\s|$)/);
    const port = Number((inline && inline[1]) || (spaced && spaced[1]) || 0);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0;
  }

  function parseServeHostFromCommand(command) {
    const text = String(command || '').trim();
    if (!text) return '';
    const inline = text.match(/(?:^|\s)--host=([^\s]+)(?=\s|$)/);
    const spaced = inline ? null : text.match(/(?:^|\s)--host\s+([^\s]+)(?=\s|$)/);
    return String((inline && inline[1]) || (spaced && spaced[1]) || '').trim();
  }

  function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function stripOptionQuotes(value) {
    const text = String(value || '').trim();
    if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1);
    if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1);
    return text;
  }

  function readServeOptionFromArgs(args, names) {
    const tokens = Array.isArray(args) ? args : [];
    const optionNames = Array.isArray(names) ? names : [names];
    let found = false;
    let value = '';
    for (let index = 0; index < tokens.length; index += 1) {
      const token = String(tokens[index] || '').trim();
      if (!token) continue;
      for (const name of optionNames) {
        if (token === name) {
          found = true;
          value = stripOptionQuotes(tokens[index + 1]);
          break;
        }
        if (token.startsWith(`${name}=`)) {
          found = true;
          value = stripOptionQuotes(token.slice(name.length + 1));
          break;
        }
      }
    }
    return { found, value };
  }

  function readServeOptionFromCommand(command, names) {
    const text = String(command || '').trim();
    if (!text) return { found: false, value: '' };
    const optionNames = Array.isArray(names) ? names : [names];
    let result = { found: false, value: '' };
    for (const name of optionNames) {
      const escaped = escapeRegExp(name);
      const valuePattern = '("([^"]*)"|\'([^\']*)\'|[^\\s]+)';
      const inline = text.match(new RegExp(`(?:^|\\s)${escaped}=${valuePattern}(?=\\s|$)`));
      const spaced = inline ? null : text.match(new RegExp(`(?:^|\\s)${escaped}\\s+${valuePattern}(?=\\s|$)`));
      const match = inline || spaced;
      if (match) {
        result = { found: true, value: stripOptionQuotes(match[1]) };
      }
    }
    return result;
  }

  function normalizeServeOptionValue(optionId, value) {
    const text = String(value || '').trim();
    if (optionId === 'models-probe-accounts' && /^\d+$/.test(text)) return String(Number(text));
    return text;
  }

  function hasAuthoritativeServeArgs(args) {
    return [
      ['--host'],
      ['--port'],
      ['--api-key', '--client-key'],
      ['--management-key'],
      ['--proxy-url'],
      ['--no-proxy'],
      ['--models-probe-accounts']
    ].some((names) => readServeOptionFromArgs(args, names).found);
  }

  function buildServerProcessSnapshot(pid, fallbackPort = 0) {
    if (!isAlive(pid)) return null;
    const command = readProcessCommand(pid);
    if (!isAihServerCommand(command)) return null;
    const fallback = Number(fallbackPort);
    return {
      pid,
      command,
      port: parseServePortFromCommand(command) || (Number.isInteger(fallback) && fallback > 0 ? fallback : 0),
      host: parseServeHostFromCommand(command)
    };
  }

  function getServeConfigDrift(proc, serveArgs, parsed, targetPort) {
    if (!proc) return { replace: true, reason: 'server_process_missing' };
    const command = String(proc.command || '');
    if (isBackgroundSupervisorCommand(command)) return { replace: false };
    const currentPort = Number(proc.port) || parseServePortFromCommand(command);
    if (currentPort > 0 && currentPort !== targetPort) {
      return { replace: true, reason: 'server_port_mismatch' };
    }

    const desiredHostFlag = readServeOptionFromArgs(serveArgs, '--host');
    const runningHostFlag = readServeOptionFromCommand(command, '--host');
    const desiredHost = desiredHostFlag.found
      ? desiredHostFlag.value
      : String(parsed && parsed.host || '').trim();
    const runningHost = runningHostFlag.found ? runningHostFlag.value : DEFAULT_SERVER_HOST;
    const shouldCompareHost = desiredHostFlag.found || runningHostFlag.found;
    if (shouldCompareHost && desiredHost && String(runningHost).trim() !== String(desiredHost).trim()) {
      return { replace: true, reason: 'server_host_mismatch' };
    }

    const authoritative = hasAuthoritativeServeArgs(serveArgs);
    const options = [
      { id: 'client-key', names: ['--api-key', '--client-key'], reason: 'server_client_key_mismatch' },
      { id: 'management-key', names: ['--management-key'], reason: 'server_management_key_mismatch' },
      { id: 'proxy-url', names: ['--proxy-url'], reason: 'server_proxy_url_mismatch' },
      { id: 'no-proxy', names: ['--no-proxy'], reason: 'server_no_proxy_mismatch' },
      { id: 'models-probe-accounts', names: ['--models-probe-accounts'], reason: 'server_models_probe_accounts_mismatch' }
    ];
    for (const option of options) {
      const desired = readServeOptionFromArgs(serveArgs, option.names);
      const running = readServeOptionFromCommand(command, option.names);
      if (desired.found) {
        if (!running.found) return { replace: true, reason: option.reason };
        const desiredValue = normalizeServeOptionValue(option.id, desired.value);
        const runningValue = normalizeServeOptionValue(option.id, running.value);
        if (desiredValue !== runningValue) return { replace: true, reason: option.reason };
        continue;
      }
      if (authoritative && running.found) {
        return { replace: true, reason: option.reason };
      }
    }
    return { replace: false };
  }

  function stopDriftedServerProcess(proc, reason) {
    if (!proc) return { stopped: true, pid: 0, port: 0, reason: reason || 'server_process_missing' };
    const result = terminateProcess(proc.pid, { gracefulStopWaitMs: 500 });
    if (result.stopped !== false && readPid() === proc.pid) {
      clearPidState();
    }
    return {
      stopped: result.stopped !== false,
      pid: proc.pid,
      port: proc.port || 0,
      reason: result.reason || reason || '',
      forced: Boolean(result.forced)
    };
  }

  function sleepSync(ms) {
    const safeMs = Math.max(0, Number(ms) || 0);
    if (!safeMs) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, safeMs);
  }

  function terminateProcess(pid, options = {}) {
    if (!isAlive(pid)) return { stopped: true, pid, alreadyStopped: true };
    const gracefulStopWaitMs = Math.max(0, Number(options.gracefulStopWaitMs) || 500);
    const signal = options.signal || 'SIGTERM';
    try {
      processObj.kill(pid, signal);
    } catch (_e) {
      return { stopped: false, reason: 'kill_failed', pid };
    }

    const deadline = Date.now() + gracefulStopWaitMs;
    while (Date.now() < deadline) {
      if (!isAlive(pid)) return { stopped: true, pid };
      sleepSync(80);
    }

    if (options.force === false) {
      return { stopped: false, reason: 'still_running', pid };
    }

    try { processObj.kill(pid, 'SIGKILL'); } catch (_e) {}
    return { stopped: true, pid, forced: true };
  }

  function shouldReplaceTrackedPid(pid, targetPort) {
    if (!isAlive(pid)) return { replace: true, reason: 'stale_pid' };
    const command = readProcessCommand(pid);
    if (!isAihServerCommand(command)) {
      return { replace: true, reason: 'pid_not_aih_server' };
    }
    const servePort = parseServePortFromCommand(command);
    if (servePort > 0 && servePort !== targetPort) {
      return {
        replace: true,
        reason: 'server_port_mismatch',
        servePort,
        targetPort,
        command
      };
    }
    return { replace: false, servePort, command };
  }

  function findListeningPidsByPort(port) {
    const p = Number(port);
    if (!Number.isInteger(p) || p <= 0 || p > 65535) return [];
    try {
      let pids = [];
      if (processObj.platform === 'win32') {
        const out = spawnSync('cmd.exe', ['/c', `netstat -ano | findstr LISTEN | findstr :${p}`], { encoding: 'utf8' });
        if (out.status === 0 && out.stdout) {
          const lines = out.stdout.split(/\r?\n/);
          for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 5 && parts[1].endsWith(`:${p}`)) {
              const pid = Number(parts[parts.length - 1]);
              if (Number.isInteger(pid) && pid > 0) pids.push(pid);
            }
          }
        }
      } else {
        const out = spawnSync(
          'lsof',
          ['-n', '-P', '-t', `-iTCP:${p}`, '-sTCP:LISTEN'],
          { encoding: 'utf8' }
        );
        if (out.status === 0 && out.stdout) {
          pids = String(out.stdout)
            .split(/\r?\n/)
            .map((line) => Number(String(line || '').trim()))
            .filter((n) => Number.isInteger(n) && n > 0);
        }
      }
      return Array.from(new Set(pids));
    } catch (_e) {
      return [];
    }
  }

  function listAihServerProcesses() {
    try {
      const out = processObj.platform === 'win32'
        ? spawnSync('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }'
        ], { encoding: 'utf8' })
        : spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
      if (out.status !== 0 || !out.stdout) return [];
      const rows = [];
      String(out.stdout || '').split(/\r?\n/).forEach((line) => {
        const text = String(line || '').trim();
        if (!text) return;
        const match = text.match(/^(\d+)\s+(.+)$/);
        if (!match) return;
        const pid = Number(match[1]);
        const command = String(match[2] || '').trim();
        if (!Number.isInteger(pid) || pid <= 0 || !isAihServerCommand(command)) return;
        rows.push({
          pid,
          command,
          port: parseServePortFromCommand(command),
          host: parseServeHostFromCommand(command)
        });
      });
      return rows
        .filter((row) => isAlive(row.pid))
        .map((row) => ({
          ...row,
          port: row.port || resolveServerProcessPort(row)
        }));
    } catch (_e) {
      return [];
    }
  }

  function readAihServerProcess(pid) {
    if (!isAlive(pid)) return null;
    const command = readProcessCommand(pid);
    if (!isAihServerCommand(command)) return null;
    return {
      pid,
      command,
      port: parseServePortFromCommand(command),
      host: parseServeHostFromCommand(command)
    };
  }

  function listKnownAihServerProcesses(preferredPid = 0) {
    const byPid = new Map();
    listAihServerProcesses().forEach((proc) => {
      byPid.set(proc.pid, proc);
    });
    const tracked = readAihServerProcess(Number(preferredPid) || 0);
    if (tracked) byPid.set(tracked.pid, tracked);
    return Array.from(byPid.values()).sort((left, right) => left.pid - right.pid);
  }

  function selectPrimaryServerProcess(processes, preferredPid = 0, preferredPort = 0) {
    const list = Array.isArray(processes) ? processes : [];
    if (!list.length) return null;
    const tracked = list.find((proc) => proc.pid === preferredPid);
    if (tracked) return tracked;
    const onPreferredPort = list.find((proc) => proc.port === preferredPort);
    if (onPreferredPort) return onPreferredPort;
    const onDefaultPort = list.find((proc) => proc.port === defaultPort);
    if (onDefaultPort) return onDefaultPort;
    const listening = list.find((proc) => Number.isInteger(proc.port) && proc.port > 0);
    return listening || list[0];
  }

  function classifyListeningPort(port) {
    const pids = findListeningPidsByPort(port);
    const serverPids = [];
    const externalPids = [];
    pids.forEach((pid) => {
      if (isAihServerProcess(pid)) serverPids.push(pid);
      else externalPids.push(pid);
    });
    return {
      port: normalizeServerPort(port, defaultPort),
      pids,
      serverPids,
      externalPids,
      serverPid: serverPids[0] || 0
    };
  }

  function findServerPidByPort(port) {
    return classifyListeningPort(port).serverPid || 0;
  }

  function buildPortInUseError(port, externalPids) {
    const pidList = (Array.isArray(externalPids) ? externalPids : [])
      .filter((pid) => Number.isInteger(pid) && pid > 0)
      .join(',');
    const err = new Error(pidList
      ? `server_port_in_use:${port}:pid=${pidList}`
      : `server_port_in_use:${port}`);
    err.code = 'server_port_in_use';
    err.port = port;
    err.pids = Array.isArray(externalPids) ? externalPids.slice() : [];
    return err;
  }

  function resolveStartTarget(preferredPort) {
    const startPort = normalizeServerPort(preferredPort, defaultPort);
    const classified = classifyListeningPort(startPort);
    if (classified.externalPids.length > 0) {
      throw buildPortInUseError(startPort, classified.externalPids);
    }
    if (classified.serverPid > 0) {
      return { port: startPort, existingPid: classified.serverPid };
    }
    return { port: startPort, existingPid: 0 };
  }

  function buildServeArgsWithPort(rawServeArgs, port) {
    const args = Array.isArray(rawServeArgs) ? rawServeArgs.slice() : [];
    const normalizedPort = String(normalizeServerPort(port, defaultPort));
    for (let i = 0; i < args.length; i += 1) {
      const text = String(args[i] || '').trim();
      if (text === '--port') {
        args[i + 1] = normalizedPort;
        return args;
      }
      if (text.startsWith('--port=')) {
        args[i] = `--port=${normalizedPort}`;
        return args;
      }
    }
    args.push('--port', normalizedPort);
    return args;
  }

  function resolveReadyPid(port) {
    const readyPid = findServerPidByPort(port);
    return readyPid > 0 ? readyPid : 0;
  }

  function isRestartableAutostart(status) {
    if (!status || !status.supported || !status.loaded) return false;
    if (status.type === 'launchd') return true;
    return status.installed && status.type === 'systemd-user';
  }

  function shouldUseMacBackgroundSupervisor(status) {
    return Boolean(
      status
      && status.supported
      && status.type === 'launchd'
      && (status.installed || status.loaded)
    );
  }

  function stopLoadedMacBackgroundSupervisor() {
    if (processObj.platform !== 'darwin') return null;
    const status = autostartService.getStatus();
    if (!shouldUseMacBackgroundSupervisor(status) || !status.loaded) return null;
    return autostartService.stopLoaded();
  }

  function stopExtraServers(targetPort, options = {}) {
    const normalizedTargetPort = normalizeServerPort(targetPort, defaultPort);
    const keepPid = Number(options.keepPid || 0);
    const gracefulStopWaitMs = Math.max(0, Number(options.gracefulStopWaitMs) || 500);
    const stopped = [];
    listAihServerProcesses().forEach((proc) => {
      if (proc.pid === keepPid) return;
      if (proc.port === normalizedTargetPort) return;
      const result = terminateProcess(proc.pid, { gracefulStopWaitMs });
      stopped.push({
        pid: proc.pid,
        port: proc.port,
        stopped: result.stopped !== false,
        forced: Boolean(result.forced),
        reason: result.reason || ''
      });
    });
    return stopped;
  }

  function stopServerProcess(pid, gracefulStopWaitMs) {
    const command = readProcessCommand(pid);
    const entryFilePath = parseServerEntryFilePath(command);
    const port = parseServePortFromCommand(command);
    const result = terminateProcess(pid, { gracefulStopWaitMs });
    if (result.stopped !== false && readPid() === pid) {
      clearPidState();
    }
    return {
      stopped: result.stopped !== false,
      pid,
      forced: Boolean(result.forced),
      reason: result.reason || '',
      port,
      entryFilePath
    };
  }

  function resolveStartServeArgs(rawServeArgs) {
    const args = Array.isArray(rawServeArgs) ? rawServeArgs.slice() : [];
    if (args.length > 0) return args;
    if (typeof readServerConfig !== 'function' || typeof buildServerArgsFromConfig !== 'function') return args;
    try {
      return buildServerArgsFromConfig(readServerConfig() || {});
    } catch (_error) {
      return args;
    }
  }

  function getConfiguredServerPort() {
    if (typeof readServerConfig !== 'function') return defaultPort;
    try {
      return normalizeServerPort((readServerConfig() || {}).port, defaultPort);
    } catch (_error) {
      return defaultPort;
    }
  }

  function resolveServerProcessPort(proc) {
    const currentPort = Number(proc && proc.port);
    if (Number.isInteger(currentPort) && currentPort > 0 && currentPort <= 65535) return currentPort;
    const pid = Number(proc && proc.pid) || 0;
    const candidates = Array.from(new Set([
      getConfiguredServerPort(),
      defaultPort
    ])).filter((port) => Number.isInteger(port) && port > 0 && port <= 65535);
    for (const candidate of candidates) {
      if (findServerPidByPort(candidate) === pid) return candidate;
    }
    return 0;
  }

  function buildRunningState(pid, port) {
    const readyPid = resolveReadyPid(port);
    const ready = readyPid > 0;
    const effectivePid = ready ? readyPid : pid;
    const runningEntryFilePath = parseServerEntryFilePath(readProcessCommand(effectivePid));
    return {
      running: effectivePid > 0,
      pid: effectivePid,
      ready,
      state: ready ? 'running' : 'starting',
      port,
      baseUrl: buildServerBaseUrl({ port }),
      ...getSourceFreshness(effectivePid, runningEntryFilePath)
    };
  }

  async function restartLoadedAutostart(targetPort, restartOptions, autostartStatus) {
    const gracefulStopWaitMs = Math.max(0, Number(restartOptions.gracefulStopWaitMs) || 500);
    const stoppedAutostart = typeof autostartService.stopLoaded === 'function'
      ? autostartService.stopLoaded()
      : autostartStatus;
    const stopped = stopServerProcesses({ gracefulStopWaitMs }, stoppedAutostart);
    if (stopped.stopped === false && stopped.reason !== 'not_running') {
      return {
        alreadyRunning: true,
        started: false,
        ready: false,
        state: 'starting',
        pid: stopped.pid || 0,
        port: stopped.port || targetPort,
        baseUrl: buildServerBaseUrl({ port: stopped.port || targetPort }),
        reason: stopped.reason || 'existing_server_not_stopped',
        stoppedForRestart: stopped,
        stoppedAutostart
      };
    }

    return startInstalledAutostart(targetPort, restartOptions, {
      stoppedForRestart: stopped,
      stoppedAutostart
    });
  }

  async function startInstalledAutostart(targetPort, startOptions = {}, extra = {}) {
    const readyTimeoutMs = Math.max(500, Number(startOptions.readyTimeoutMs) || 7000);
    const waitForReadyEnabled = startOptions.waitForReady !== false;
    const installedAutostart = autostartService.install();
    const ready = waitForReadyEnabled ? await waitForReady(targetPort, readyTimeoutMs) : false;
    const pid = resolveReadyPid(targetPort);
    if (pid > 0) {
      try { fs.writeFileSync(pidFile, String(pid)); } catch (_e) {}
      if (!waitForReadyEnabled) scheduleBackgroundReadyProbe(pid, targetPort, readyTimeoutMs);
    }

    return {
      alreadyRunning: false,
      started: true,
      ready,
      readyCheck: waitForReadyEnabled ? 'foreground' : 'background',
      state: ready ? 'running' : 'starting',
      pid,
      port: targetPort,
      baseUrl: buildServerBaseUrl({ port: targetPort }),
      ...extra,
      installedAutostart
    };
  }

  async function start(rawServeArgs, startOptions = {}) {
    ensureDir(aiHomeDir);
    runBackgroundStartPreparation();
    const serveInputArgs = resolveStartServeArgs(rawServeArgs || []);
    const parsed = parseServeArgs(serveInputArgs);
    const targetPort = normalizeServerPort(parsed.port, defaultPort);
    const startTarget = resolveStartTarget(targetPort);
    const effectivePort = startTarget.port;
    const autostartStatus = processObj.platform === 'darwin'
      ? autostartService.getStatus()
      : null;
    const useMacBackgroundSupervisor = shouldUseMacBackgroundSupervisor(autostartStatus);
    if (useMacBackgroundSupervisor && autostartStatus.loaded && !autostartStatus.installed) {
      return restartLoadedAutostart(effectivePort, startOptions, autostartStatus);
    }
    const readyTimeoutMs = Math.max(500, Number(startOptions.readyTimeoutMs) || 7000);
    const waitForReadyEnabled = startOptions.waitForReady !== false;
    const existingPid = readPid();
    const existingServers = listKnownAihServerProcesses(existingPid);
    const existingServer = selectPrimaryServerProcess(existingServers, existingPid, effectivePort);
    if (existingServer && existingServer.port === effectivePort) {
      const drift = useMacBackgroundSupervisor
        && !isBackgroundSupervisorCommand(existingServer.command)
        ? { replace: true, reason: 'background_supervisor_required' }
        : getServeConfigDrift(existingServer, serveInputArgs, parsed, effectivePort);
      if (!drift.replace) {
        try { fs.writeFileSync(pidFile, String(existingServer.pid)); } catch (_e) {}
        const stoppedExtraServers = stopExtraServers(effectivePort, { keepPid: existingServer.pid });
        return {
          alreadyRunning: true,
          started: true,
          stoppedExtraServers,
          ...buildRunningState(existingServer.pid, effectivePort)
        };
      }
      const stopped = stopDriftedServerProcess(existingServer, drift.reason);
      if (stopped.stopped === false) {
        return {
          alreadyRunning: true,
          started: false,
          ready: false,
          state: 'starting',
          pid: existingServer.pid,
          port: existingServer.port || effectivePort,
          baseUrl: buildServerBaseUrl({ port: existingServer.port || effectivePort }),
          reason: stopped.reason || drift.reason || 'existing_server_not_stopped'
        };
      }
    } else if (existingServer) {
      const stopped = stop({ gracefulStopWaitMs: 500 });
      if (stopped.stopped === false) {
        return {
          alreadyRunning: true,
          started: false,
          ready: false,
          state: 'starting',
          pid: existingServer.pid,
          port: existingServer.port || effectivePort,
          baseUrl: buildServerBaseUrl({ port: existingServer.port || effectivePort }),
          reason: stopped.reason || 'existing_server_not_stopped'
        };
      }
    }
    if (isAlive(existingPid)) {
      const trackedPidState = shouldReplaceTrackedPid(existingPid, effectivePort);
      if (trackedPidState.replace) {
        if (trackedPidState.reason === 'server_port_mismatch') {
          terminateProcess(existingPid, { gracefulStopWaitMs: 500 });
        }
        clearPidState();
      } else {
        const readyPid = resolveReadyPid(effectivePort);
        if (readyPid > 0 && readyPid !== existingPid) {
          try { fs.writeFileSync(pidFile, String(readyPid)); } catch (_e) {}
          const readyEntryFilePath = parseServerEntryFilePath(readProcessCommand(readyPid));
          return {
            alreadyRunning: true,
            started: true,
            pid: readyPid,
            ready: true,
            state: 'running',
            port: effectivePort,
            baseUrl: buildServerBaseUrl({ port: effectivePort }),
            stoppedExtraServers: stopExtraServers(effectivePort, { keepPid: readyPid }),
            ...getSourceFreshness(readyPid, readyEntryFilePath)
          };
        }
        const extraStopped = stopExtraServers(effectivePort, { keepPid: existingPid });
        return {
          alreadyRunning: true,
          started: true,
          stoppedExtraServers: extraStopped,
          ...buildRunningState(existingPid, effectivePort)
        };
      }
    }
    const existingByPort = findServerPidByPort(effectivePort);
    if (existingByPort > 0) {
      const processSnapshot = buildServerProcessSnapshot(existingByPort, effectivePort);
      const drift = useMacBackgroundSupervisor
        && processSnapshot
        && !isBackgroundSupervisorCommand(processSnapshot.command)
        ? { replace: true, reason: 'background_supervisor_required' }
        : getServeConfigDrift(processSnapshot, serveInputArgs, parsed, effectivePort);
      if (!drift.replace) {
        try { fs.writeFileSync(pidFile, String(existingByPort)); } catch (_e) {}
        const runningEntryFilePath = parseServerEntryFilePath(readProcessCommand(existingByPort));
        const extraStopped = stopExtraServers(effectivePort, { keepPid: existingByPort });
        return {
          alreadyRunning: true,
          started: true,
          pid: existingByPort,
          ready: true,
          state: 'running',
          port: effectivePort,
          baseUrl: buildServerBaseUrl({ port: effectivePort }),
          stoppedExtraServers: extraStopped,
          ...getSourceFreshness(existingByPort, runningEntryFilePath)
        };
      }
      const stopped = stopDriftedServerProcess(processSnapshot, drift.reason);
      if (stopped.stopped === false) {
        return {
          alreadyRunning: true,
          started: false,
          ready: false,
          state: 'starting',
          pid: existingByPort,
          port: effectivePort,
          baseUrl: buildServerBaseUrl({ port: effectivePort }),
          reason: stopped.reason || drift.reason || 'existing_server_not_stopped'
        };
      }
    }
    if (existingPid) {
      clearPidState();
    }

    if (useMacBackgroundSupervisor) {
      return startInstalledAutostart(effectivePort, startOptions, {
        previousAutostartStatus: autostartStatus
      });
    }

    const startEntry = resolveStartEntryFilePath(startOptions);
    const serveArgs = buildServeArgsWithPort(serveInputArgs, effectivePort);
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    const outFd = fs.openSync(logFile, 'a');
    const child = spawn(processObj.execPath, [startEntry.entryFilePath, 'server', 'serve', ...serveArgs], {
      detached: true,
      stdio: ['ignore', outFd, outFd],
      env: processObj.env
    });
    child.unref();
    fs.writeFileSync(pidFile, String(child.pid));
    writeRecordedSourceFingerprint(child.pid, startEntry.entryFilePath);
    if (!waitForReadyEnabled) {
      scheduleBackgroundReadyProbe(child.pid, effectivePort, readyTimeoutMs);
      return {
        alreadyRunning: false,
        pid: child.pid,
        started: true,
        ready: false,
        readyCheck: 'background',
        state: 'starting',
        port: effectivePort,
        baseUrl: buildServerBaseUrl({ port: effectivePort }),
        entryFilePath: startEntry.entryFilePath,
        entrySource: startEntry.source
      };
    }
    const started = await waitForReady(effectivePort, readyTimeoutMs);
    if (!isAlive(child.pid)) {
      const recoveredPid = findServerPidByPort(effectivePort);
      if (recoveredPid > 0) {
        try { fs.writeFileSync(pidFile, String(recoveredPid)); } catch (_e) {}
        const recoveredEntry = parseServerEntryFilePath(readProcessCommand(recoveredPid));
        return {
          alreadyRunning: true,
          pid: recoveredPid,
          started: true,
          ready: true,
          port: effectivePort,
          baseUrl: buildServerBaseUrl({ port: effectivePort }),
          entryFilePath: recoveredEntry || startEntry.entryFilePath,
          ...getSourceFreshness(recoveredPid, recoveredEntry || startEntry.entryFilePath)
        };
      }
      clearPidState();
      return {
        alreadyRunning: false,
        pid: child.pid,
        started: false,
        ready: false,
        state: 'stopped',
        failed: true,
        reason: 'process_exited_before_ready'
      };
    }
    return {
      alreadyRunning: false,
      pid: child.pid,
      started,
      ready: started,
      state: started ? 'running' : 'starting',
      port: effectivePort,
      baseUrl: buildServerBaseUrl({ port: effectivePort }),
      entryFilePath: startEntry.entryFilePath,
      entrySource: startEntry.source,
      ...getSourceFreshness(child.pid, startEntry.entryFilePath)
    };
  }

  async function restart(rawServeArgs, restartOptions = {}) {
    ensureDir(aiHomeDir);
    const serveInputArgs = resolveStartServeArgs(rawServeArgs || []);
    const parsed = parseServeArgs(serveInputArgs);
    const targetPort = normalizeServerPort(parsed.port, defaultPort);
    resolveStartTarget(targetPort);
    const autostartStatus = autostartService.getStatus();
    if (isRestartableAutostart(autostartStatus)) {
      runBackgroundStartPreparation();
      return restartLoadedAutostart(targetPort, restartOptions, autostartStatus);
    }

    const gracefulStopWaitMs = Math.max(0, Number(restartOptions.gracefulStopWaitMs) || 500);
    const stopped = stop({ gracefulStopWaitMs });
    if (stopped.stopped === false && stopped.reason !== 'not_running') {
      return {
        alreadyRunning: true,
        started: false,
        ready: false,
        state: 'starting',
        pid: stopped.pid || 0,
        port: stopped.port || targetPort,
        baseUrl: buildServerBaseUrl({ port: stopped.port || targetPort }),
        reason: stopped.reason || 'existing_server_not_stopped',
        stoppedForRestart: stopped
      };
    }

    const startOptions = {
      ...restartOptions,
      waitForReady: restartOptions.waitForReady !== false,
      readyTimeoutMs: restartOptions.readyTimeoutMs
    };
    delete startOptions.gracefulStopWaitMs;
    if (!startOptions.entryFilePath && stopped.entryFilePath) {
      startOptions.entryFilePath = stopped.entryFilePath;
    }
    const result = await start(serveInputArgs, startOptions);
    return {
      ...result,
      stoppedForRestart: stopped
    };
  }

  function stopServerProcesses(stopOptions = {}, stoppedAutostart = null) {
    const gracefulStopWaitMs = Math.max(0, Number(stopOptions.gracefulStopWaitMs) || 3000);
    let pid = readPid();
    let isStaleFilePid = false;

    if (pid && !isAlive(pid)) {
      clearPidState();
      pid = 0;
      isStaleFilePid = true;
    }

    const servers = listKnownAihServerProcesses(pid);
    if (!servers.length) {
      if (isStaleFilePid) {
        return {
          stopped: true,
          reason: 'stale_pid_cleaned',
          pid: 0,
          ...(stoppedAutostart ? { stoppedAutostart } : {})
        };
      }
      if (stoppedAutostart) {
        return { stopped: true, reason: '', pid: 0, stoppedAutostart };
      }
      return { stopped: false, reason: 'not_running' };
    }

    const primary = selectPrimaryServerProcess(servers, pid, getConfiguredServerPort());
    const stoppedServers = servers.map((server) => stopServerProcess(server.pid, gracefulStopWaitMs));
    if (stoppedServers.some((item) => item.stopped)) {
      clearPidState();
    }
    const primaryResult = stoppedServers.find((item) => item.pid === primary.pid) || stoppedServers[0];
    return {
      stopped: stoppedServers.some((item) => item.stopped),
      pid: primaryResult ? primaryResult.pid : 0,
      pids: stoppedServers.map((item) => item.pid),
      stoppedServers,
      forced: stoppedServers.some((item) => item.forced),
      reason: primaryResult ? primaryResult.reason : '',
      port: primaryResult ? primaryResult.port : 0,
      entryFilePath: primaryResult ? primaryResult.entryFilePath : '',
      ...(stoppedAutostart ? { stoppedAutostart } : {})
    };
  }

  function stop(stopOptions = {}) {
    const stoppedAutostart = stopLoadedMacBackgroundSupervisor();
    return stopServerProcesses(stopOptions, stoppedAutostart);
  }

  function getStatus() {
    const pid = readPid();
    const configuredPort = getConfiguredServerPort();
    const servers = listKnownAihServerProcesses(pid);
    let primary = selectPrimaryServerProcess(servers, pid, configuredPort);
    if (!primary) {
      const recoveredPid = findServerPidByPort(configuredPort);
      primary = readAihServerProcess(recoveredPid);
    }
    if (!primary) {
      if (pid && !isAlive(pid)) clearPidState();
      return {
        running: false,
        pid: 0,
        ready: false,
        state: 'stopped',
        port: configuredPort,
        baseUrl: buildServerBaseUrl({ port: configuredPort }),
        pidFile,
        logFile,
        entryFilePath: '',
        ...getSourceFreshness(0, entryFilePath)
      };
    }

    if (primary.pid !== pid) {
      try { fs.writeFileSync(pidFile, String(primary.pid)); } catch (_e) {}
    }
    const resolvedPort = resolveServerProcessPort(primary);
    const port = normalizeServerPort(resolvedPort || primary.port, defaultPort);
    const ready = resolvedPort > 0 && findServerPidByPort(resolvedPort) === primary.pid;
    const runningEntryFilePath = parseServerEntryFilePath(primary.command);
    return {
      running: true,
      pid: primary.pid,
      ready,
      state: ready ? 'running' : 'starting',
      port,
      baseUrl: buildServerBaseUrl({ port }),
      pidFile,
      logFile,
      entryFilePath: runningEntryFilePath || entryFilePath,
      extraServers: Math.max(0, servers.length - 1),
      ...getSourceFreshness(primary.pid, runningEntryFilePath || entryFilePath)
    };
  }

  function getAutostartStatus() {
    return autostartService.getStatus();
  }

  function installAutostart() {
    runBackgroundStartPreparation();
    return autostartService.install();
  }

  function uninstallAutostart() {
    return autostartService.uninstall();
  }

  return {
    readPid,
    isAlive,
    waitForReady,
    start,
    restart,
    stop,
    getStatus,
    getAutostartStatus,
    installAutostart,
    uninstallAutostart
  };
}

module.exports = {
  createServerDaemonService
};

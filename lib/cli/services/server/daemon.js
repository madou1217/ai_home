'use strict';
const {
  DEFAULT_SERVER_PORT,
  LEGACY_SERVER_PORTS,
  buildServerBaseUrl,
  normalizeServerPort
} = require('../../../server/server-defaults');
const {
  clearRecordedSourceFingerprint: clearRecordedSourceFingerprintFile,
  findSourceEntryFromCwd,
  getSourceFingerprintFilePath,
  getSourceFreshness: computeSourceFreshness,
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
  const writeServerConfig = deps.writeServerConfig;
  const aiHomeDir = deps.aiHomeDir;
  const pidFile = deps.pidFile;
  const logFile = deps.logFile;
  const launchdLabel = deps.launchdLabel;
  const launchdPlist = deps.launchdPlist;
  const entryFilePath = deps.entryFilePath;
  const defaultPort = normalizeServerPort(deps.defaultPort, DEFAULT_SERVER_PORT);
  const sourceFingerprintFile = getSourceFingerprintFilePath(path, aiHomeDir);

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

  function isAihServerCommand(command) {
    const detectedEntry = parseServerEntryFilePathFromCommand(command);
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

  function stopKnownLegacyServers(targetPort) {
    const normalizedTargetPort = normalizeServerPort(targetPort, defaultPort);
    for (const legacyPort of LEGACY_SERVER_PORTS) {
      const port = Number(legacyPort);
      if (!Number.isInteger(port) || port <= 0 || port > 65535 || port === normalizedTargetPort) continue;
      const legacyPid = findServerPidByPort(port);
      if (legacyPid > 0) {
        terminateProcess(legacyPid, { gracefulStopWaitMs: 500 });
      }
    }
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

  function findServerPidByPort(port) {
    const pids = findListeningPidsByPort(port);
    try {
      for (const pid of pids) {
        if (isAihServerProcess(pid)) return pid;
      }
      return 0;
    } catch (_e) {
      return 0;
    }
  }

  function isPortListening(port) {
    return findListeningPidsByPort(port).length > 0;
  }

  function resolveStartPort(preferredPort) {
    const startPort = normalizeServerPort(preferredPort, defaultPort);
    const existingPid = findServerPidByPort(startPort);
    if (existingPid > 0) {
      return { port: startPort, existingPid, changed: false };
    }
    if (!isPortListening(startPort)) {
      return { port: startPort, existingPid: 0, changed: false };
    }

    const maxAttempts = 100;
    for (let offset = 1; offset <= maxAttempts; offset += 1) {
      const candidate = startPort + offset;
      if (candidate > 65535) break;
      const candidateExistingPid = findServerPidByPort(candidate);
      if (candidateExistingPid > 0) {
        return {
          port: candidate,
          existingPid: candidateExistingPid,
          changed: true,
          reason: 'preferred_port_in_use'
        };
      }
      if (!isPortListening(candidate)) {
        return {
          port: candidate,
          existingPid: 0,
          changed: true,
          reason: 'preferred_port_in_use'
        };
      }
    }
    throw new Error(`no_available_port_after_${startPort}`);
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

  function persistSelectedPort(parsed, port) {
    if (typeof writeServerConfig !== 'function') return;
    try {
      writeServerConfig({
        host: parsed.host,
        port,
        apiKey: parsed.clientKey || parsed.apiKey || '',
        managementKey: parsed.managementKey || '',
        openNetwork: parsed.host === '0.0.0.0'
      });
    } catch (_error) {}
  }

  function resolveReadyPid(port) {
    const readyPid = findServerPidByPort(port);
    return readyPid > 0 ? readyPid : 0;
  }

  function buildRunningState(pid, port) {
    const readyPid = resolveReadyPid(port);
    const ready = readyPid > 0;
    const effectivePid = ready ? readyPid : pid;
    const runningEntryFilePath = parseServerEntryFilePathFromCommand(readProcessCommand(effectivePid));
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

  async function start(rawServeArgs, startOptions = {}) {
    ensureDir(aiHomeDir);
    const parsed = parseServeArgs(rawServeArgs || []);
    const targetPort = normalizeServerPort(parsed.port, defaultPort);
    const startTarget = resolveStartPort(targetPort);
    const effectivePort = startTarget.port;
    if (startTarget.changed) {
      persistSelectedPort(parsed, effectivePort);
    }
    const readyTimeoutMs = Math.max(500, Number(startOptions.readyTimeoutMs) || 7000);
    const waitForReadyEnabled = startOptions.waitForReady !== false;
    const existingPid = readPid();
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
          const readyEntryFilePath = parseServerEntryFilePathFromCommand(readProcessCommand(readyPid));
          return {
            alreadyRunning: true,
            started: true,
            pid: readyPid,
            ready: true,
            state: 'running',
            port: effectivePort,
            baseUrl: buildServerBaseUrl({ port: effectivePort }),
            portChanged: startTarget.changed,
            portChangeReason: startTarget.reason || '',
            ...getSourceFreshness(readyPid, readyEntryFilePath)
          };
        }
        return {
          alreadyRunning: true,
          started: true,
          ...buildRunningState(existingPid, effectivePort)
        };
      }
    }
    stopKnownLegacyServers(effectivePort);
    const existingByPort = startTarget.existingPid || findServerPidByPort(effectivePort);
    if (existingByPort > 0) {
      try { fs.writeFileSync(pidFile, String(existingByPort)); } catch (_e) {}
      const runningEntryFilePath = parseServerEntryFilePathFromCommand(readProcessCommand(existingByPort));
      return {
        alreadyRunning: true,
        started: true,
        pid: existingByPort,
        ready: true,
        state: 'running',
        port: effectivePort,
        baseUrl: buildServerBaseUrl({ port: effectivePort }),
        portChanged: startTarget.changed,
        portChangeReason: startTarget.reason || '',
        ...getSourceFreshness(existingByPort, runningEntryFilePath)
      };
    }
    if (existingPid) {
      clearPidState();
    }

    const startEntry = resolveStartEntryFilePath(startOptions);
    const serveArgs = buildServeArgsWithPort(rawServeArgs, effectivePort);
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
        portChanged: startTarget.changed,
        portChangeReason: startTarget.reason || '',
        entryFilePath: startEntry.entryFilePath,
        entrySource: startEntry.source
      };
    }
    const started = await waitForReady(effectivePort, readyTimeoutMs);
    if (!isAlive(child.pid)) {
      const recoveredPid = findServerPidByPort(effectivePort);
      if (recoveredPid > 0) {
        try { fs.writeFileSync(pidFile, String(recoveredPid)); } catch (_e) {}
        const recoveredEntry = parseServerEntryFilePathFromCommand(readProcessCommand(recoveredPid));
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
      portChanged: startTarget.changed,
      portChangeReason: startTarget.reason || '',
      entryFilePath: startEntry.entryFilePath,
      entrySource: startEntry.source,
      ...getSourceFreshness(child.pid, startEntry.entryFilePath)
    };
  }

  function stop(stopOptions = {}) {
    const gracefulStopWaitMs = Math.max(0, Number(stopOptions.gracefulStopWaitMs) || 3000);
    let pid = readPid();
    let isStaleFilePid = false;

    if (pid && !isAlive(pid)) {
      clearPidState();
      pid = 0;
      isStaleFilePid = true;
    }

    if (!pid) {
      pid = findServerPidByPort(defaultPort);
      if (!pid) {
        if (isStaleFilePid) return { stopped: true, reason: 'stale_pid_cleaned', pid: 0 };
        return { stopped: false, reason: 'not_running' };
      }
    }
    const command = readProcessCommand(pid);
    const stoppedEntryFilePath = parseServerEntryFilePathFromCommand(command);
    try {
      processObj.kill(pid, 'SIGTERM');
    } catch (_e) {
      return { stopped: false, reason: 'kill_failed', pid, entryFilePath: stoppedEntryFilePath };
    }
    const deadline = Date.now() + gracefulStopWaitMs;
    while (Date.now() < deadline) {
      if (!isAlive(pid)) {
        clearPidState();
        return { stopped: true, pid, entryFilePath: stoppedEntryFilePath };
      }
      sleepSync(80);
    }
    try {
      processObj.kill(pid, 'SIGKILL');
    } catch (_e) {}
    clearPidState();
    return { stopped: true, pid, forced: true, entryFilePath: stoppedEntryFilePath };
  }

  function getStatus(statusOptions = {}) {
    const requestedPort = Number(statusOptions.port);
    const targetPort = Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort <= 65535
      ? requestedPort
      : defaultPort;
    const pid = readPid();
    let running = isAlive(pid);
    let effectivePid = running ? pid : 0;
    let ready = false;
    let runningEntryFilePath = running
      ? parseServerEntryFilePathFromCommand(readProcessCommand(pid))
      : '';
    if (running) {
      const trackedPidState = shouldReplaceTrackedPid(pid, targetPort);
      if (trackedPidState.replace) {
        running = false;
        effectivePid = 0;
        runningEntryFilePath = '';
        clearPidState();
      }
    }
    if (!running) {
      const recoveredPid = findServerPidByPort(targetPort);
      if (recoveredPid > 0) {
        running = true;
        effectivePid = recoveredPid;
        ready = true;
        runningEntryFilePath = parseServerEntryFilePathFromCommand(readProcessCommand(recoveredPid));
        try { fs.writeFileSync(pidFile, String(recoveredPid)); } catch (_e) {}
      }
    } else {
      const readyPid = resolveReadyPid(targetPort);
      if (readyPid > 0) {
        ready = true;
        effectivePid = readyPid;
        if (readyPid !== pid) {
          try { fs.writeFileSync(pidFile, String(readyPid)); } catch (_e) {}
        }
        runningEntryFilePath = parseServerEntryFilePathFromCommand(readProcessCommand(readyPid));
      }
    }
    if (!running && pid) {
      clearPidState();
    }
    return {
      running,
      pid: running ? effectivePid : 0,
      ready: running ? ready : false,
      state: running ? (ready ? 'running' : 'starting') : 'stopped',
      port: targetPort,
      baseUrl: buildServerBaseUrl({ port: targetPort }),
      pidFile,
      logFile,
      entryFilePath: running ? (runningEntryFilePath || entryFilePath) : '',
      ...getSourceFreshness(effectivePid, runningEntryFilePath || entryFilePath)
    };
  }

  function getAutostartStatus() {
    if (processObj.platform !== 'darwin') {
      return { supported: false, installed: false, loaded: false };
    }
    const installed = fs.existsSync(launchdPlist);
    let loaded = false;
    try {
      const out = spawnSync('launchctl', ['list', launchdLabel], { encoding: 'utf8' });
      loaded = out.status === 0;
    } catch (_e) {
      loaded = false;
    }
    return { supported: true, installed, loaded, plist: launchdPlist, label: launchdLabel };
  }

  function installAutostart() {
    if (processObj.platform !== 'darwin') {
      throw new Error('autostart is currently implemented for macOS launchd only');
    }
    ensureDir(path.dirname(launchdPlist));
    const startEntry = resolveStartEntryFilePath();
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${launchdLabel}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${processObj.execPath}</string>
      <string>${startEntry.entryFilePath}</string>
      <string>server</string>
      <string>serve</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${logFile}</string>
    <key>StandardErrorPath</key>
    <string>${logFile}</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>${processObj.env.PATH || ''}</string>
    </dict>
  </dict>
</plist>
`;
    fs.writeFileSync(launchdPlist, plist);
    spawnSync('launchctl', ['unload', launchdPlist], { stdio: 'ignore' });
    const load = spawnSync('launchctl', ['load', launchdPlist], { encoding: 'utf8' });
    if (load.status !== 0) {
      throw new Error(String(load.stderr || load.stdout || 'launchctl load failed').trim());
    }
  }

  function uninstallAutostart() {
    if (processObj.platform !== 'darwin') {
      throw new Error('autostart is currently implemented for macOS launchd only');
    }
    if (fs.existsSync(launchdPlist)) {
      spawnSync('launchctl', ['unload', launchdPlist], { stdio: 'ignore' });
      fs.unlinkSync(launchdPlist);
    }
  }

  return {
    readPid,
    isAlive,
    waitForReady,
    start,
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

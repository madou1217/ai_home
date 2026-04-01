'use strict';

function createServerDaemonService(deps = {}) {
  const fs = deps.fs;
  const path = deps.path;
  const spawn = deps.spawn;
  const spawnSync = deps.spawnSync;
  const fetchImpl = deps.fetchImpl || fetch;
  const processObj = deps.processObj || process;
  const ensureDir = deps.ensureDir;
  const parseServeArgs = deps.parseServeArgs;
  const aiHomeDir = deps.aiHomeDir;
  const pidFile = deps.pidFile;
  const logFile = deps.logFile;
  const launchdLabel = deps.launchdLabel;
  const launchdPlist = deps.launchdPlist;
  const entryFilePath = deps.entryFilePath;
  const defaultPort = Number(deps.defaultPort) > 0 ? Number(deps.defaultPort) : 8317;

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

  function readProcessCommand(pid) {
    if (!Number.isFinite(pid) || pid <= 0) return '';
    try {
      const out = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
      if (out.status !== 0) return '';
      return String(out.stdout || '').trim();
    } catch (_e) {
      return '';
    }
  }

  function isAihServerProcess(pid) {
    if (!isAlive(pid)) return false;
    const cmd = readProcessCommand(pid);
    if (!cmd) return false;
    if (!cmd.includes(entryFilePath)) return false;
    return /\bserver\b/.test(cmd) && /\bserve\b/.test(cmd);
  }

  function findServerPidByPort(port) {
    const p = Number(port);
    if (!Number.isInteger(p) || p <= 0 || p > 65535) return 0;
    try {
      const out = spawnSync(
        'lsof',
        ['-n', '-P', '-t', `-iTCP:${p}`, '-sTCP:LISTEN'],
        { encoding: 'utf8' }
      );
      if (out.status !== 0) return 0;
      const pids = String(out.stdout || '')
        .split(/\r?\n/)
        .map((line) => Number(String(line || '').trim()))
        .filter((n) => Number.isInteger(n) && n > 0);
      for (const pid of pids) {
        if (isAihServerProcess(pid)) return pid;
      }
      return 0;
    } catch (_e) {
      return 0;
    }
  }

  async function start(rawServeArgs) {
    ensureDir(aiHomeDir);
    const parsed = parseServeArgs(rawServeArgs || []);
    const targetPort = Number(parsed.port) || defaultPort;
    const existingPid = readPid();
    if (isAlive(existingPid)) {
      return { alreadyRunning: true, pid: existingPid };
    }
    const existingByPort = findServerPidByPort(targetPort);
    if (existingByPort > 0) {
      try { fs.writeFileSync(pidFile, String(existingByPort)); } catch (_e) {}
      return { alreadyRunning: true, pid: existingByPort };
    }
    if (existingPid) {
      try { fs.unlinkSync(pidFile); } catch (_e) {}
    }

    const outFd = fs.openSync(logFile, 'a');
    const child = spawn(processObj.execPath, [entryFilePath, 'server', 'serve', ...(rawServeArgs || [])], {
      detached: true,
      stdio: ['ignore', outFd, outFd],
      env: processObj.env
    });
    child.unref();
    fs.writeFileSync(pidFile, String(child.pid));
    const started = await waitForReady(parsed.port, 7000);
    if (!isAlive(child.pid)) {
      const recoveredPid = findServerPidByPort(targetPort);
      if (recoveredPid > 0) {
        try { fs.writeFileSync(pidFile, String(recoveredPid)); } catch (_e) {}
        return { alreadyRunning: true, pid: recoveredPid, started: true };
      }
      try { fs.unlinkSync(pidFile); } catch (_e) {}
      return {
        alreadyRunning: false,
        pid: child.pid,
        started: false,
        failed: true,
        reason: 'process_exited_before_ready'
      };
    }
    return { alreadyRunning: false, pid: child.pid, started };
  }

  function stop() {
    let pid = readPid();
    if (!pid) {
      pid = findServerPidByPort(defaultPort);
      if (!pid) return { stopped: false, reason: 'not_running' };
    }
    if (!isAlive(pid)) {
      try { fs.unlinkSync(pidFile); } catch (_e) {}
      return { stopped: false, reason: 'stale_pid', pid };
    }
    try {
      processObj.kill(pid, 'SIGTERM');
    } catch (_e) {
      return { stopped: false, reason: 'kill_failed', pid };
    }
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (!isAlive(pid)) {
        try { fs.unlinkSync(pidFile); } catch (_e) {}
        return { stopped: true, pid };
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);
    }
    try {
      processObj.kill(pid, 'SIGKILL');
    } catch (_e) {}
    try { fs.unlinkSync(pidFile); } catch (_e) {}
    return { stopped: true, pid, forced: true };
  }

  function getStatus() {
    const pid = readPid();
    let running = isAlive(pid);
    let effectivePid = running ? pid : 0;
    if (!running) {
      const recoveredPid = findServerPidByPort(defaultPort);
      if (recoveredPid > 0) {
        running = true;
        effectivePid = recoveredPid;
        try { fs.writeFileSync(pidFile, String(recoveredPid)); } catch (_e) {}
      }
    }
    if (!running && pid) {
      try { fs.unlinkSync(pidFile); } catch (_e) {}
    }
    return {
      running,
      pid: running ? effectivePid : 0,
      pidFile,
      logFile
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
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${launchdLabel}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${processObj.execPath}</string>
      <string>${entryFilePath}</string>
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

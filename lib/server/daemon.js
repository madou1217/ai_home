'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

function createServerDaemonController(opts) {
  const options = opts || {};
  const ensureDir = options.ensureDir;
  const parseServerServeArgs = options.parseServerServeArgs;
  const aiHomeDir = options.aiHomeDir;
  const pidFile = options.pidFile;
  const logFile = options.logFile;
  const launchdLabel = options.launchdLabel;
  const launchdPlist = options.launchdPlist;
  const entryScriptPath = options.entryScriptPath;
  const nodeExecPath = options.nodeExecPath || process.execPath;
  const defaultPort = Number(options.defaultPort) > 0 ? Number(options.defaultPort) : 8317;

  if (typeof ensureDir !== 'function') throw new Error('server_daemon_missing_ensureDir');
  if (typeof parseServerServeArgs !== 'function') throw new Error('server_daemon_missing_parseProxyServeArgs');
  if (!aiHomeDir || !pidFile || !logFile || !launchdLabel || !launchdPlist || !entryScriptPath) {
    throw new Error('server_daemon_missing_paths');
  }

  function readServerPid() {
    if (!fs.existsSync(pidFile)) return 0;
    try {
      const val = String(fs.readFileSync(pidFile, 'utf8')).trim();
      return /^\d+$/.test(val) ? Number(val) : 0;
    } catch (e) {
      return 0;
    }
  }

  function clearPidFile() {
    try {
      fs.unlinkSync(pidFile);
    } catch (e) {}
  }

  function buildAppliedConfig(parsed) {
    const cfg = parsed || {};
    return {
      host: cfg.host,
      port: cfg.port,
      codexBaseUrl: cfg.codexBaseUrl,
      geminiBaseUrl: cfg.geminiBaseUrl,
      claudeBaseUrl: cfg.claudeBaseUrl,
      codexModels: cfg.codexModels,
      proxyUrl: cfg.proxyUrl,
      noProxy: cfg.noProxy,
      strategy: cfg.strategy,
      backend: cfg.backend,
      provider: cfg.provider,
      cooldownMs: cfg.cooldownMs,
      upstreamTimeoutMs: cfg.upstreamTimeoutMs,
      maxAttempts: cfg.maxAttempts,
      modelsCacheTtlMs: cfg.modelsCacheTtlMs,
      modelsProbeAccounts: cfg.modelsProbeAccounts,
      failureThreshold: cfg.failureThreshold,
      logRequests: cfg.logRequests,
      codexMaxConcurrency: cfg.codexMaxConcurrency,
      geminiMaxConcurrency: cfg.geminiMaxConcurrency,
      claudeMaxConcurrency: cfg.claudeMaxConcurrency,
      queueLimit: cfg.queueLimit,
      clientKeyConfigured: Boolean(cfg.clientKey),
      managementKeyConfigured: Boolean(cfg.managementKey)
    };
  }

  function isProcessAlive(pid) {
    if (!Number.isFinite(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return false;
    }
  }

  function readProcessCommand(pid) {
    if (!Number.isFinite(pid) || pid <= 0) return '';
    try {
      const out = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
      if (out.status !== 0) return '';
      return String(out.stdout || '').trim();
    } catch (e) {
      return '';
    }
  }

  function isServerProcess(pid) {
    if (!isProcessAlive(pid)) return false;
    const cmd = readProcessCommand(pid);
    if (!cmd) return false;
    if (!cmd.includes(entryScriptPath)) return false;
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
        if (isServerProcess(pid)) return pid;
      }
      return 0;
    } catch (e) {
      return 0;
    }
  }

  function waitForServerReady(port, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
      const tick = async () => {
        if (Date.now() > deadline) {
          resolve(false);
          return;
        }
        try {
          const res = await fetch(`http://127.0.0.1:${port}/healthz`);
          if (res.ok) {
            resolve(true);
            return;
          }
        } catch (e) {}
        setTimeout(tick, 150);
      };
      tick();
    });
  }

  async function start(rawServeArgs) {
    ensureDir(aiHomeDir);
    const parsed = parseServerServeArgs(rawServeArgs || []);
    const appliedConfig = buildAppliedConfig(parsed);
    const targetPort = Number(parsed.port) || defaultPort;
    const existingPid = readServerPid();
    if (isProcessAlive(existingPid)) {
      return { alreadyRunning: true, pid: existingPid, started: true, appliedConfig };
    }
    const existingByPort = findServerPidByPort(targetPort);
    if (existingByPort > 0) {
      try { fs.writeFileSync(pidFile, String(existingByPort)); } catch (e) {}
      return { alreadyRunning: true, pid: existingByPort, started: true, appliedConfig };
    }
    if (existingPid) clearPidFile();

    const outFd = fs.openSync(logFile, 'a');
    const child = spawn(nodeExecPath, [entryScriptPath, 'server', 'serve', ...(rawServeArgs || [])], {
      detached: true,
      stdio: ['ignore', outFd, outFd],
      env: process.env
    });
    child.unref();
    fs.writeFileSync(pidFile, String(child.pid));
    const started = await waitForServerReady(parsed.port, 7000);
    if (!isProcessAlive(child.pid)) {
      const recoveredPid = findServerPidByPort(targetPort);
      if (recoveredPid > 0) {
        try { fs.writeFileSync(pidFile, String(recoveredPid)); } catch (e) {}
        return {
          alreadyRunning: true,
          pid: recoveredPid,
          started: true,
          appliedConfig
        };
      }
      clearPidFile();
      return {
        alreadyRunning: false,
        pid: child.pid,
        started: false,
        failed: true,
        reason: 'process_exited_before_ready',
        appliedConfig
      };
    }
    return { alreadyRunning: false, pid: child.pid, started, failed: !started, appliedConfig };
  }

  function stop() {
    let pid = readServerPid();
    if (!pid) {
      pid = findServerPidByPort(defaultPort);
      if (!pid) return { stopped: false, reason: 'not_running' };
    }
    if (!isProcessAlive(pid)) {
      try { fs.unlinkSync(pidFile); } catch (e) {}
      return { stopped: false, reason: 'stale_pid', pid };
    }
    try {
      process.kill(pid, 'SIGTERM');
    } catch (e) {
      return { stopped: false, reason: 'kill_failed', pid };
    }
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (!isProcessAlive(pid)) {
        try { fs.unlinkSync(pidFile); } catch (e) {}
        return { stopped: true, pid };
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch (e) {}
    try { fs.unlinkSync(pidFile); } catch (e) {}
    return { stopped: true, pid, forced: true };
  }

  function status() {
    const pid = readServerPid();
    let running = isProcessAlive(pid);
    let effectivePid = running ? pid : 0;
    if (!running) {
      const recoveredPid = findServerPidByPort(defaultPort);
      if (recoveredPid > 0) {
        running = true;
        effectivePid = recoveredPid;
        try { fs.writeFileSync(pidFile, String(recoveredPid)); } catch (e) {}
      }
    }
    if (!running && pid) clearPidFile();
    return {
      running,
      pid: running ? effectivePid : 0,
      pidFile,
      logFile
    };
  }

  function autostartStatus() {
    if (process.platform !== 'darwin') {
      return { supported: false, installed: false, loaded: false };
    }
    const installed = fs.existsSync(launchdPlist);
    let loaded = false;
    try {
      const out = spawnSync('launchctl', ['list', launchdLabel], { encoding: 'utf8' });
      loaded = out.status === 0;
    } catch (e) {
      loaded = false;
    }
    return { supported: true, installed, loaded, plist: launchdPlist, label: launchdLabel };
  }

  function installAutostart() {
    if (process.platform !== 'darwin') {
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
      <string>${nodeExecPath}</string>
      <string>${entryScriptPath}</string>
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
      <string>${process.env.PATH || ''}</string>
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
    if (process.platform !== 'darwin') {
      throw new Error('autostart is currently implemented for macOS launchd only');
    }
    if (fs.existsSync(launchdPlist)) {
      spawnSync('launchctl', ['unload', launchdPlist], { stdio: 'ignore' });
      fs.unlinkSync(launchdPlist);
    }
  }

  async function restart(rawServeArgs) {
    const stopped = stop();
    const started = await start(rawServeArgs || []);
    return {
      stopped,
      started,
      running: Boolean(started && started.started),
      pid: started && started.pid ? started.pid : 0,
      appliedConfig: started && started.appliedConfig ? started.appliedConfig : {}
    };
  }

  return {
    start,
    restart,
    stop,
    status,
    autostartStatus,
    installAutostart,
    uninstallAutostart
  };
}

module.exports = {
  createServerDaemonController
};

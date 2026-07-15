'use strict';

// Standalone single-instance guard for `aih server serve`.
//
// The daemon `start` path has its own pidfile bookkeeping, but the raw
// foreground `serve` had no cross-instance guard at all. Its only check was a
// host-scoped port probe (`canListenOnPort(host, port)`), so a second `serve`
// launched on a *different* --host (e.g. 127.0.0.1 while another held 0.0.0.0)
// slipped past it — the two coexisted on the same port because Node sets
// SO_REUSEADDR and the kernel allows a wildcard and a specific-address socket
// to share a port. This module makes `serve` refuse to become a second
// instance, and cleans up its pidfile on exit.

const net = require('net');
const path = require('path');

function isProcessAlive(processObj, pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    processObj.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH => no such process (dead). EPERM => alive but owned by someone else.
    return Boolean(error && error.code === 'EPERM');
  }
}

function readPidFile(fs, pidFile) {
  try {
    if (!fs.existsSync(pidFile)) return 0;
    const pid = parseInt(String(fs.readFileSync(pidFile, 'utf8')).trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  } catch (_error) {
    return 0;
  }
}

function probeHostFree(host, port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    let settled = false;
    const done = (free) => { if (settled) return; settled = true; resolve(Boolean(free)); };
    probe.once('error', () => done(false));
    probe.listen(port, host, () => probe.close(() => done(true)));
  });
}

// Returns the host on which the port is already held, or null if free.
//
// The requested host is probed alongside the wildcard (0.0.0.0) and loopback
// (127.0.0.1). An identical addr:port bind always fails with EADDRINUSE
// (SO_REUSEADDR never permits two identical listeners), so probing the
// requested host catches a same-scope holder; adding wildcard + loopback catches
// a holder that bound a different scope than us — the exact gap that let two
// instances coexist. A short retry window absorbs a predecessor still releasing
// the port during a restart.
async function findPortHolderHost(host, port, opts = {}) {
  const retries = Number.isInteger(opts.retries) ? opts.retries : 0;
  const waitMs = Number.isInteger(opts.waitMs) ? opts.waitMs : 200;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const hosts = Array.from(new Set([host || '0.0.0.0', '0.0.0.0', '127.0.0.1']));
  let busyHost = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    busyHost = null;
    for (const candidate of hosts) {
      if (!(await probeHostFree(candidate, port))) { busyHost = candidate; break; }
    }
    if (!busyHost) return null;
    if (attempt < retries) await sleep(waitMs);
  }
  return busyHost;
}

// Acquire the single-instance lock. Resolves to either { ok: true, release } or
// { ok: false, reason } describing why a second instance must not start.
async function acquireServerInstanceLock(opts = {}) {
  const fs = opts.fs;
  const processObj = opts.processObj || process;
  const aiHomeDir = opts.aiHomeDir;
  const pidFile = opts.pidFile || (aiHomeDir ? path.join(aiHomeDir, 'run', 'server.pid') : null);
  if (!fs || !pidFile) return { ok: true, release: () => {}, skipped: true };

  const host = opts.host;
  const port = Number(opts.port);
  const selfPid = processObj.pid;

  // 1) A live aih instance already owns the pidfile.
  const existingPid = readPidFile(fs, pidFile);
  if (existingPid && existingPid !== selfPid && isProcessAlive(processObj, existingPid)) {
    return { ok: false, reason: 'already_running', pid: existingPid, pidFile };
  }

  // 2) Something is already listening on the port (e.g. a pidfile-less stray).
  const busyHost = await findPortHolderHost(host, port, {
    retries: Number.isInteger(opts.portRetries) ? opts.portRetries : 0,
    waitMs: Number.isInteger(opts.portWaitMs) ? opts.portWaitMs : 200,
    sleep: opts.sleep
  });
  if (busyHost) return { ok: false, reason: 'port_in_use', host: busyHost, port, pidFile };

  // 3) Claim it. Cleanup only unlinks the pidfile if it still holds our pid, so a
  // successor that overwrote it is never clobbered.
  try {
    if (typeof fs.mkdirSync === 'function') {
      fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    }
    fs.writeFileSync(pidFile, String(selfPid));
  } catch (_error) {}
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try { if (readPidFile(fs, pidFile) === selfPid) fs.unlinkSync(pidFile); } catch (_error) {}
  };
  if (opts.registerCleanup !== false && typeof processObj.once === 'function') {
    processObj.once('exit', release);
  }
  return { ok: true, pidFile, release };
}

module.exports = {
  acquireServerInstanceLock,
  findPortHolderHost,
  __private: { isProcessAlive, readPidFile, probeHostFree }
};

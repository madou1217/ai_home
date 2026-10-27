'use strict';

const { spawn } = require('node:child_process');

const DEFAULT_MAX_OUTPUT = 1024 * 1024;
const DEFAULT_KILL_GRACE_MS = 250;

function terminateChild(child, signal = 'SIGTERM') {
  if (!child) return;
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (_error) {
    try { child.kill(signal); } catch (_ignored) {}
  }
}

function runProcess(command, args = [], options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Math.trunc(Number(options.timeoutMs)) : 30000;
  const maxOutput = Number(options.maxOutput) > 0 ? Math.trunc(Number(options.maxOutput)) : DEFAULT_MAX_OUTPUT;
  const killGraceMs = Number(options.killGraceMs) >= 0
    ? Math.trunc(Number(options.killGraceMs))
    : DEFAULT_KILL_GRACE_MS;
  const spawnOptions = {
    cwd: options.cwd,
    env: options.env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: options.windowsHide !== false
  };

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, spawnOptions);
    } catch (error) {
      resolve({ status: null, signal: null, stdout: '', stderr: '', error: error.code || error.message || String(error) });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let stoppedEarly = false;
    let settled = false;
    let killTimer = null;
    const append = (current, chunk) => `${current}${String(chunk || '')}`.slice(-maxOutput);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        status: stoppedEarly ? 0 : result.status,
        signal: result.signal || null,
        stdout,
        stderr,
        timedOut,
        stoppedEarly,
        error: result.error || ''
      });
    };

    const stop = (reason) => {
      if (settled || stoppedEarly) return;
      stoppedEarly = reason === 'completed';
      timedOut = reason === 'timeout';
      terminateChild(child, timedOut ? 'SIGTERM' : 'SIGTERM');
      // Descendants can retain the pipe after the direct child exits. Close
      // our ends immediately and escalate the detached process group shortly.
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (killGraceMs === 0) {
        terminateChild(child, 'SIGKILL');
        // Native CLIs can leave descendants holding the stdio pipe after the
        // direct child has been signalled.  The runner's contract is bounded
        // supervision, so do not wait for a late `close` event in that case.
        if (timedOut) finish({ status: null, signal: 'SIGKILL' });
      } else {
        killTimer = setTimeout(() => {
          terminateChild(child, 'SIGKILL');
          if (timedOut) finish({ status: null, signal: 'SIGKILL' });
        }, killGraceMs);
      }
    };

    const timeoutTimer = setTimeout(() => stop('timeout'), timeoutMs);
    if (typeof timeoutTimer.unref === 'function') timeoutTimer.unref();
    child.stdout.on('data', (chunk) => {
      stdout = append(stdout, chunk);
      if (!stoppedEarly && !timedOut && typeof options.stopWhen === 'function') {
        let complete = false;
        try { complete = options.stopWhen(stdout) === true; } catch (_error) {}
        if (complete) {
          stop('completed');
          finish({ status: 0, signal: null });
        }
      }
    });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.on('error', (error) => {
      if (stoppedEarly || timedOut) finish({ status: stoppedEarly ? 0 : null, signal: null, error: error.code || error.message || String(error) });
      else finish({ status: null, signal: null, error: error.code || error.message || String(error) });
    });
    child.on('close', (status, signal) => finish({ status, signal }));
  });
}

module.exports = { runProcess, terminateChild };

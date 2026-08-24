'use strict';

const { spawn: nodeSpawn } = require('node:child_process');
const { resolveWindowsUpstreamSpawn } = require('../../../runtime/pty-launch');
const {
  normalizeClientPlatform,
  toNodePlatform
} = require('../../../runtime/client-platform');

function resolvePlatform(options = {}) {
  const processObj = options.processObj || process;
  return toNodePlatform(normalizeClientPlatform(options.platform || processObj.platform || process.platform));
}

function resolveExecutionTarget(plan, options = {}) {
  const command = String(plan && plan.command || '').trim();
  const args = Array.isArray(plan && plan.args) ? plan.args.map((arg) => String(arg)) : [];
  if (resolvePlatform(options) !== 'win32') {
    return { command, args, envPatch: {}, windowsVerbatimArguments: false };
  }
  return resolveWindowsUpstreamSpawn(command, args, { ...options, platform: 'win32' });
}

function createOutputCollector(maxOutputBytes, onOutput) {
  let capturedBytes = 0;
  let stdout = '';
  let stderr = '';
  let outputTruncated = false;

  function append(stream, chunk) {
    const text = Buffer.from(chunk);
    const remaining = maxOutputBytes - capturedBytes;
    if (remaining <= 0) {
      outputTruncated = true;
      return;
    }
    const captured = text.subarray(0, remaining);
    capturedBytes += captured.length;
    if (text.length > remaining) outputTruncated = true;
    const value = captured.toString('utf8');
    if (stream === 'stdout') stdout += value;
    else stderr += value;
    onOutput?.(value, stream);
  }

  return {
    append,
    snapshot: () => ({ stdout: stdout.trim(), stderr: stderr.trim(), outputTruncated })
  };
}

function executeLifecyclePlan(plan, options = {}) {
  const spawnImpl = options.spawn || nodeSpawn;
  const processObj = options.processObj || process;
  const errorPrefix = String(options.errorPrefix || 'lifecycle_action');
  const timeoutMs = Math.min(
    Math.max(Number(plan && plan.timeoutMs) || Number(options.actionTimeoutMs) || 120000, 1000),
    60 * 60 * 1000
  );
  const maxOutputBytes = Math.min(Math.max(Number(options.maxOutputBytes) || 64 * 1024, 1024), 1024 * 1024);
  const target = resolveExecutionTarget(plan, options);
  const output = createOutputCollector(maxOutputBytes, options.onOutput);

  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(target.command, target.args, {
        cwd: plan.cwd || undefined,
        env: {
          ...(options.env || processObj.env || {}),
          ...(plan.env || {}),
          ...(target.envPatch || {})
        },
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: Boolean(target.windowsVerbatimArguments),
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      resolve({
        ok: false,
        error: `${errorPrefix}_spawn_failed`,
        message: String(error && error.message || error),
        ...output.snapshot()
      });
      return;
    }

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, ...output.snapshot() });
    };
    const timer = setTimeout(() => {
      child?.kill?.('SIGTERM');
      finish({ ok: false, error: `${errorPrefix}_timeout`, timedOut: true });
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => output.append('stdout', chunk));
    child.stderr?.on('data', (chunk) => output.append('stderr', chunk));
    child.on('error', (error) => {
      finish({ ok: false, error: `${errorPrefix}_spawn_failed`, message: String(error && error.message || error) });
    });
    child.on('close', (code, signal) => {
      finish({
        ok: code === 0,
        error: code === 0 ? null : `${errorPrefix}_failed`,
        exitCode: Number.isInteger(code) ? code : null,
        signal: signal || null
      });
    });
  });
}

module.exports = {
  createOutputCollector,
  executeLifecyclePlan,
  resolveExecutionTarget
};

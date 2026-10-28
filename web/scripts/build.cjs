'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const LOW_MEMORY_BUILD_LIMIT = 2048 * 1024 * 1024;

function readCgroupMemoryLimit() {
  for (const file of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const value = fs.readFileSync(file, 'utf8').trim();
      if (!value || value === 'max') continue;
      const bytes = Number(value);
      if (Number.isFinite(bytes) && bytes > 0) return bytes;
    } catch {
      // cgroup v1/v2 is optional; fall back to os.totalmem().
    }
  }
  return Infinity;
}

function availableMemory() {
  return Math.min(os.totalmem(), readCgroupMemoryLimit());
}

function ensureBuildHeap(env, memoryBytes) {
  if (/--max-old-space-size=\d+/.test(String(env.NODE_OPTIONS || ''))) return;
  // Webpack can finish compiling inside Node's default heap and then fail while
  // serializing the asset graph. Give it a bounded heap derived from the
  // container limit, leaving room for webpack's native buffers and the OS.
  const memoryMiB = Math.max(1024, Math.floor(memoryBytes / 1024 / 1024));
  const heapMiB = Math.max(1152, Math.min(1408, Math.floor(memoryMiB * 0.72)));
  env.NODE_OPTIONS = `${env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ` : ''}--max-old-space-size=${heapMiB}`;
  process.stderr.write(`web build: reserving up to ${heapMiB} MiB Node old-space\n`);
}

function acquireBuildLock() {
  const lockDir = path.resolve('node_modules/.cache/aih-web-build.lock');
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  try {
    fs.mkdirSync(lockDir);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let ownerPid = 0;
    try { ownerPid = Number(fs.readFileSync(path.join(lockDir, 'pid'), 'utf8')); } catch (_readError) {}
    if (ownerPid > 0) {
      try {
        process.kill(ownerPid, 0);
        throw new Error(`web build already running (pid=${ownerPid})`);
      } catch (probeError) {
        if (probeError.message.includes('already running')) throw probeError;
      }
    }
    fs.rmSync(lockDir, { recursive: true, force: true });
    fs.mkdirSync(lockDir);
  }
  fs.writeFileSync(path.join(lockDir, 'pid'), String(process.pid), 'utf8');
  return () => fs.rmSync(lockDir, { recursive: true, force: true });
}

function releaseBuildLockSafely(releaseLock) {
  try { releaseLock(); } catch (_error) {}
}

function run() {
  const env = { ...process.env };
  const memory = availableMemory();
  ensureBuildHeap(env, memory);
  if (!env.COMPRESS && memory <= LOW_MEMORY_BUILD_LIMIT) {
    env.COMPRESS = 'none';
    process.stderr.write(
      `web build: ${Math.round(memory / 1024 / 1024)} MiB available; ` +
      'disabling production minification to stay within the low-memory build budget\n'
    );
  }

  const releaseLock = acquireBuildLock();
  const command = process.platform === 'win32' ? 'max.cmd' : 'max';
  const buildStartedAt = Date.now();
  const child = spawn(command, ['build'], {
    env,
    stdio: ['inherit', 'pipe', 'pipe'],
    windowsHide: true
  });
  let terminating = false;
  let buildComplete = false;
  let completionTimer = null;
  const forwardOutput = (stream, chunk) => {
    const text = String(chunk || '');
    stream.write(chunk);
    if (buildComplete || !/Build\s+index\.html/.test(text)) return;
    const outputPath = path.resolve('dist', 'index.html');
    let hasFreshIndex = false;
    try {
      hasFreshIndex = fs.statSync(outputPath).mtimeMs >= buildStartedAt;
    } catch (_error) {}
    if (!hasFreshIndex) return;
    buildComplete = true;
    // Umi's webpack build resolves here, but its esbuild service can leave an
    // open handle behind. Give the cache writer enough time to flush without
    // keeping the CLI around for the full webpack idle timeout.
    completionTimer = setTimeout(() => {
      terminating = true;
      try { child.kill('SIGTERM'); } catch (_error) {}
    }, 8_000);
    if (completionTimer && typeof completionTimer.unref === 'function') completionTimer.unref();
  };
  child.stdout.on('data', (chunk) => forwardOutput(process.stdout, chunk));
  child.stderr.on('data', (chunk) => forwardOutput(process.stderr, chunk));
  const forwardSignal = (signal) => {
    terminating = true;
    try { child.kill(signal); } catch (_error) {}
  };
  const onSigint = () => forwardSignal('SIGINT');
  const onSigterm = () => forwardSignal('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  child.once('error', (error) => {
    releaseBuildLockSafely(releaseLock);
    process.stderr.write(`web build failed to start: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.once('close', (code, signal) => {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    if (completionTimer) clearTimeout(completionTimer);
    releaseBuildLockSafely(releaseLock);
    if (buildComplete) process.exitCode = 0;
    else if (signal || terminating) process.exitCode = 1;
    else process.exitCode = Number.isInteger(code) ? code : 1;
  });
}

run();

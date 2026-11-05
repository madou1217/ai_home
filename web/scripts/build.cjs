'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

// A full Umi/Webpack production build has a measured peak just over 1 GiB
// even with minification disabled. Leave headroom for the kernel, Node's
// native buffers and the package manager on the build host. Hosts below this
// floor should use the documented Mac mini build path instead of being allowed
// to reach an unrecoverable cgroup OOM kill.
const MIN_RELIABLE_BUILD_MEMORY_MIB = 1536;
const MIN_BUILD_HEAP_MIB = 768;
// 1024 曾是上限，但压缩构建的实测峰值已经越过 1 GiB：2026-11-02 的发布就死在
// Ineffective mark-compacts near heap limit（约 1000 MiB old space）。这是天花板
// 不是预占，V8 按需增长，所以放宽到 2048 不会让空闲构建多吃内存。
const MAX_BUILD_HEAP_MIB = 2048;
// 开压缩（Umi 默认）时的最低堆。给不到这个数就别压了 —— 关压缩比 OOM 强。
const MINIFIED_BUILD_HEAP_MIB = 1536;

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

function memoryMiB(memoryBytes) {
  if (!Number.isFinite(memoryBytes) || memoryBytes <= 0) return Infinity;
  return Math.floor(memoryBytes / 1024 / 1024);
}

function hasReliableBuildMemory(memoryBytes) {
  return memoryMiB(memoryBytes) >= MIN_RELIABLE_BUILD_MEMORY_MIB;
}

function writeInsufficientMemoryMessage(memoryBytes) {
  const availableMiB = memoryMiB(memoryBytes);
  process.stderr.write(
    `web build: ${Number.isFinite(availableMiB) ? `${availableMiB} MiB` : 'unknown memory'} available; ` +
    `a production Umi build requires at least ${MIN_RELIABLE_BUILD_MEMORY_MIB} MiB. ` +
    'Build the WebUI on the Mac mini and deploy the generated dist/ directory.\n'
  );
}

// Webpack can finish compiling inside Node's default heap and then fail while
// serializing the asset graph. Give it a bounded heap derived from the
// container limit, leaving room for webpack's native buffers and the OS.
function resolveBuildHeapMiB(memoryBytes) {
  const hostMemoryMiB = Math.max(512, memoryMiB(memoryBytes));
  return Math.max(MIN_BUILD_HEAP_MIB, Math.min(
    MAX_BUILD_HEAP_MIB,
    Math.floor(hostMemoryMiB * 0.58)
  ));
}

function ensureBuildHeap(env, memoryBytes) {
  if (/--max-old-space-size=\d+/.test(String(env.NODE_OPTIONS || ''))) return;
  const heapMiB = resolveBuildHeapMiB(memoryBytes);
  env.NODE_OPTIONS = `${env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ` : ''}--max-old-space-size=${heapMiB}`;
  process.stderr.write(`web build: reserving up to ${heapMiB} MiB Node old-space\n`);
}

/** 堆预算给不到压缩构建的下限时退回不压缩；显式 COMPRESS 永远优先。 */
function shouldDisableCompression(env, heapMiB) {
  return !env.COMPRESS && heapMiB < MINIFIED_BUILD_HEAP_MIB;
}

/** 从已经拼好的 NODE_OPTIONS 里取实际生效的堆，认不出去就按宿主内存重算。 */
function effectiveHeapMiB(env, memoryBytes) {
  const match = /--max-old-space-size=(\d+)/.exec(String(env.NODE_OPTIONS || ''));
  return match ? Number(match[1]) : resolveBuildHeapMiB(memoryBytes);
}

function acquireBuildLock() {
  const lockDir = path.resolve('node_modules/.cache/aih-web-build.lock');
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  try {
    fs.mkdirSync(lockDir);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let ownerPid = 0;
    try {
      ownerPid = Number(fs.readFileSync(path.join(lockDir, 'pid'), 'utf8'));
    } catch {
      // A stale lock may not have a readable owner marker.
    }
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
  try {
    releaseLock();
  } catch {
    // Cleanup must not mask the child process result.
  }
}

/**
 * 产物落地（看到 Build index.html 且 index.html 是本次新写的）只说明 webpack 交付完了，
 * 不代表进程正常退出。以前见到 buildComplete 就写 0，把收尾阶段的 OOM 当成了成功
 * （2026-11-02 的发布就是这么把失败吞掉、继续往后走的）。现在只有「子进程 exit 0」和
 * 「我们自己按计划收掉的空闲子进程」算成功，其余一律失败。
 */
function resolveBuildExitCode({ buildComplete, code, terminating }) {
  if (code === 0) return 0;
  if (buildComplete && terminating) return 0;
  return 1;
}

function run() {
  const env = { ...process.env };
  const memory = availableMemory();
  if (!hasReliableBuildMemory(memory)) {
    writeInsufficientMemoryMessage(memory);
    process.exitCode = 78;
    return;
  }
  ensureBuildHeap(env, memory);
  const heapMiB = effectiveHeapMiB(env, memory);
  if (shouldDisableCompression(env, heapMiB)) {
    env.COMPRESS = 'none';
    process.stderr.write(
      `web build: ${Math.round(memory / 1024 / 1024)} MiB available (heap ${heapMiB} MiB); ` +
      `disabling production minification to stay below the ${MINIFIED_BUILD_HEAP_MIB} MiB floor\n`
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
    const outputPath = path.resolve(process.env.AIH_WEB_OUT_DIR || 'dist', 'index.html');
    let hasFreshIndex = false;
    try {
      hasFreshIndex = fs.statSync(outputPath).mtimeMs >= buildStartedAt;
    } catch {
      // The output file may not exist until webpack has flushed it.
    }
    if (!hasFreshIndex) return;
    buildComplete = true;
    // Umi's webpack build resolves here, but its esbuild service can leave an
    // open handle behind. Give the cache writer enough time to flush without
    // keeping the CLI around for the full webpack idle timeout.
    completionTimer = setTimeout(() => {
      terminating = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // The child may have exited between the timer and the signal.
      }
    }, 8_000);
    if (completionTimer && typeof completionTimer.unref === 'function') completionTimer.unref();
  };
  child.stdout.on('data', (chunk) => forwardOutput(process.stdout, chunk));
  child.stderr.on('data', (chunk) => forwardOutput(process.stderr, chunk));
  const forwardSignal = (signal) => {
    terminating = true;
    try {
      child.kill(signal);
    } catch {
      // The child may already have exited.
    }
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
    process.exitCode = resolveBuildExitCode({ buildComplete, code, signal, terminating });
  });
}

if (require.main === module) run();

module.exports = {
  MIN_RELIABLE_BUILD_MEMORY_MIB,
  MIN_BUILD_HEAP_MIB,
  MAX_BUILD_HEAP_MIB,
  MINIFIED_BUILD_HEAP_MIB,
  availableMemory,
  hasReliableBuildMemory,
  memoryMiB,
  resolveBuildHeapMiB,
  ensureBuildHeap,
  effectiveHeapMiB,
  shouldDisableCompression,
  resolveBuildExitCode,
  writeInsufficientMemoryMessage
};

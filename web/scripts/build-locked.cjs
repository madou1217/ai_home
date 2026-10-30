'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const lockPath = path.join(root, '.aih-web-build.lock');
const pollMs = 250;
const maxWaitMs = 30 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readLockPid() {
  try {
    const value = await fs.readFile(lockPath, 'utf8');
    const pid = Number.parseInt(value.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (_error) {
    return null;
  }
}

function isProcessAlive(pid) {
  if (!pid || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

async function acquireLock() {
  const startedAt = Date.now();
  while (true) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      await handle.writeFile(`${process.pid}\n`, 'utf8');
      await handle.close();
      return;
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      const pid = await readLockPid();
      if (!isProcessAlive(pid)) {
        await fs.rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() - startedAt >= maxWaitMs) {
        throw new Error(`web build is still running under pid ${pid}`);
      }
      await sleep(pollMs);
    }
  }
}

async function releaseLock() {
  const pid = await readLockPid();
  if (pid === process.pid) await fs.rm(lockPath, { force: true });
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32'
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`${command} terminated by ${signal}`));
      else if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

async function main() {
  await acquireLock();
  try {
    // 内层交给 build.cjs：低内存主机上的堆自适应（--max-old-space-size / 低内存时
    // COMPRESS=none）与「Umi 构建结束后回收空闲子进程」都在那里实现；外层保留本文件的
    // **等待式**串行锁（并发构建排队而不是直接失败）与 SW 缓存戳。
    // 两侧改动都保留：见本次合并提交说明（本地 5b5977b4 的串行锁+戳 / 远端 2a388382 的
    // 低内存适配 + 6b2aae63 的构建结束回收）。
    await run(process.execPath, [path.join(root, 'scripts', 'build.cjs')]);
    await run(process.execPath, [path.join(root, 'scripts', 'stamp-sw-cache.cjs')]);
  } finally {
    await releaseLock();
  }
}

main().catch((error) => {
  process.stderr.write(`web build: ${error.message}\n`);
  process.exitCode = 1;
});

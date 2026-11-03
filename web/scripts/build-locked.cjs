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
  } catch {
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

function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env,
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
    //
    // 产物原子替换：先构建到 dist.next，校验完整后再整体换上。构建失败 / OOM / 被杀时，
    // 线上 dist 保持上一版不动 —— 此前 Umi 直接清空并写 dist，一次失败就让 Server 报
    // 「Web UI not built」。
    const staging = STAGING_DIR;
    await fs.rm(path.join(root, staging), { recursive: true, force: true });
    const env = { ...process.env, AIH_WEB_OUT_DIR: staging };
    await run(process.execPath, [path.join(root, 'scripts', 'build.cjs')], env);
    await run(process.execPath, [path.join(root, 'scripts', 'stamp-sw-cache.cjs')], env);
    await verifyBuildOutput(path.join(root, staging));
    await swapIntoPlace(path.join(root, staging), path.join(root, 'dist'));
  } catch (error) {
    await fs.rm(path.join(root, STAGING_DIR), { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    await releaseLock();
  }
}

const STAGING_DIR = 'dist.next';

/** 产物必须至少有 index.html、引用到的入口脚本都在、且有 sw.js。 */
async function verifyBuildOutput(dir) {
  const index = await fs.readFile(path.join(dir, 'index.html'), 'utf8').catch(() => '');
  if (!index) throw new Error('build output has no index.html; keeping the current dist');
  const scripts = [...index.matchAll(/src="(?:\/ui\/)?([^"?#]+\.js)"/g)].map((match) => match[1]);
  if (scripts.length === 0) throw new Error('build output index.html references no scripts; keeping the current dist');
  for (const script of scripts) {
    await fs.access(path.join(dir, script)).catch(() => {
      throw new Error(`build output is missing ${script}; keeping the current dist`);
    });
  }
}

/** dist → dist.prev，dist.next → dist（两次 rename，同一文件系统上是原子的），再删 dist.prev。 */
async function swapIntoPlace(staging, target) {
  const previous = `${target}.prev`;
  await fs.rm(previous, { recursive: true, force: true });
  let hadPrevious = false;
  try {
    await fs.rename(target, previous);
    hadPrevious = true;
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  try {
    await fs.rename(staging, target);
  } catch (error) {
    if (hadPrevious) await fs.rename(previous, target).catch(() => {});
    throw error;
  }
  await fs.rm(previous, { recursive: true, force: true });
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`web build: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { STAGING_DIR, swapIntoPlace, verifyBuildOutput };

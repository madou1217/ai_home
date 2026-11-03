'use strict';

const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_STALE_MS = 2 * 60_000;
const DEFAULT_RETRY_MS = 50;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(1, Number(ms) || DEFAULT_RETRY_MS)));
}

function readJsonFileSafe(fs, filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return null;
  }
}

function isPidAlive(pid) {
  const safePid = Number(pid);
  if (!Number.isInteger(safePid) || safePid <= 0) return false;
  try {
    process.kill(safePid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

function isLockStale(lockInfo, nowMs, staleMs) {
  const createdAt = Number(lockInfo && lockInfo.createdAt);
  if (!Number.isFinite(createdAt) || createdAt <= 0) return true;
  if (nowMs - createdAt > staleMs) return true;
  const pid = Number(lockInfo && lockInfo.pid);
  return Number.isInteger(pid) && pid > 0 && !isPidAlive(pid);
}

function writeLockFile(fs, lockPath) {
  const fd = fs.openSync(lockPath, 'wx');
  try {
    fs.writeFileSync(fd, `${JSON.stringify({
      pid: process.pid,
      createdAt: Date.now()
    })}\n`, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

async function acquireAuthRefreshLock(fs, path, authPath, options = {}) {
  const safeAuthPath = String(authPath || '').trim();
  if (!safeAuthPath) return null;
  const lockPath = `${safeAuthPath}.refresh.lock`;
  const timeoutMs = Math.max(1_000, Number(options.timeoutMs) || DEFAULT_LOCK_TIMEOUT_MS);
  const staleMs = Math.max(10_000, Number(options.staleMs) || DEFAULT_LOCK_STALE_MS);
  const retryMs = Math.max(10, Number(options.retryMs) || DEFAULT_RETRY_MS);
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      writeLockFile(fs, lockPath);
      return {
        lockPath,
        release() {
          try {
            fs.unlinkSync(lockPath);
          } catch (_error) {}
        }
      };
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      const lockInfo = readJsonFileSafe(fs, lockPath);
      if (isLockStale(lockInfo, Date.now(), staleMs)) {
        try {
          fs.unlinkSync(lockPath);
          continue;
        } catch (_unlinkError) {}
      }
      if (Date.now() >= deadline) return null;
      await sleep(retryMs);
    }
  }
}

async function withAuthRefreshLock(fs, path, authPath, work, options = {}) {
  const lock = await acquireAuthRefreshLock(fs, path, authPath, options);
  if (!lock) return { acquired: false, value: null };
  try {
    return {
      acquired: true,
      value: await work()
    };
  } finally {
    lock.release();
  }
}

module.exports = {
  acquireAuthRefreshLock,
  withAuthRefreshLock,
  __private: {
    isLockStale,
    readJsonFileSafe
  }
};

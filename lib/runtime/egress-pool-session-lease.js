'use strict';

// 会话独占出口：同一账号开多个本地 CLI 会话（例如三个窗口都在跑 `aih opencode 3`）时，
// 每个会话认领一条不同的会话车道（server 已为该账号预留多条车道、彼此错开节点，见
// egress-pool-planner 的 session 策略），于是每个会话从不同的出口 IP 出网。
//
// 认领是本机文件租约：`<aiHome>/run/egress-pool/session-leases/<accountRef>/lane-<slot>.json`
// （目录 0700、文件 0600，内容只有 { pid, at }）。租约随持有进程存活：
//   - 认领时按槽位顺序找第一条「没有租约 / 租约进程已退出」的车道，用 O_EXCL 写入；
//     并发启动的两个会话不会认领到同一条；
//   - 不需要释放：进程退出后租约自然失效，下一个会话直接接管；
//   - 槽位全被占用（会话数 > 车道数）时按 pid 取模复用一条（仍能出网，只是与另一个会话同出口）。
// 只用于本地会话（CLI 进程自己是持有者）。网关请求、用量探测等不认领租约，走槽位 0。

const nodeFs = require('node:fs');
const nodePath = require('node:path');

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function safeSegment(value) {
  return normalizeString(value).replace(/[^A-Za-z0-9_.-]/g, '_');
}

function leaseDir(aiHomeDir, accountRef, pathImpl = nodePath) {
  return pathImpl.join(String(aiHomeDir || ''), 'run', 'egress-pool', 'session-leases', safeSegment(accountRef));
}

function defaultIsPidAlive(pid) {
  const target = Number(pid);
  if (!Number.isInteger(target) || target <= 0) return false;
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

function readLease(fs, filePath) {
  try {
    const doc = JSON.parse(String(fs.readFileSync(filePath, 'utf8')));
    return doc && typeof doc === 'object' ? doc : null;
  } catch (_error) {
    return null;
  }
}

function tryCreate(fs, filePath, pid, now) {
  try {
    fs.writeFileSync(filePath, JSON.stringify({ pid, at: now }), { flag: 'wx', mode: 0o600 });
    return true;
  } catch (_error) {
    return false;
  }
}

/**
 * 为当前会话认领一条会话车道。
 * @param {object} input { fs, aiHomeDir, accountRef, urls: string[], pid?, isPidAlive?, now? }
 * @returns {{ url: string, slot: number, shared: boolean } | null}  urls 为空时返回 null
 */
function acquireSessionLane(input = {}) {
  const urls = Array.isArray(input.urls) ? input.urls.filter(Boolean) : [];
  if (urls.length === 0) return null;
  const fs = input.fs || nodeFs;
  const pid = Number(input.pid) || process.pid;
  const isPidAlive = typeof input.isPidAlive === 'function' ? input.isPidAlive : defaultIsPidAlive;
  const now = Number(input.now) || Date.now();
  const dir = leaseDir(input.aiHomeDir, input.accountRef, input.path);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (_error) {
    return { url: urls[pid % urls.length], slot: pid % urls.length, shared: true };
  }
  for (let slot = 0; slot < urls.length; slot += 1) {
    const filePath = nodePath.join(dir, `lane-${slot}.json`);
    if (tryCreate(fs, filePath, pid, now)) return { url: urls[slot], slot, shared: false };
    const lease = readLease(fs, filePath);
    if (lease && Number(lease.pid) === pid) return { url: urls[slot], slot, shared: false };
    if (lease && isPidAlive(lease.pid)) continue;
    // 持有者已退出（或租约文件损坏）：删掉后再用 O_EXCL 抢一次，与并发认领者只会有一个成功。
    try { fs.unlinkSync(filePath); } catch (_error) { /* 别人刚删掉 */ }
    if (tryCreate(fs, filePath, pid, now)) return { url: urls[slot], slot, shared: false };
  }
  const slot = pid % urls.length;
  return { url: urls[slot], slot, shared: true };
}

/** 当前各槽位的持有情况（排障 / WebUI 用）：[{ slot, pid, alive }]。 */
function describeSessionLeases(input = {}) {
  const fs = input.fs || nodeFs;
  const isPidAlive = typeof input.isPidAlive === 'function' ? input.isPidAlive : defaultIsPidAlive;
  const count = Number(input.count) || 0;
  const dir = leaseDir(input.aiHomeDir, input.accountRef, input.path);
  return Array.from({ length: count }, (_, slot) => {
    const lease = readLease(fs, nodePath.join(dir, `lane-${slot}.json`));
    return { slot, pid: lease ? Number(lease.pid) || 0 : 0, alive: Boolean(lease && isPidAlive(lease.pid)) };
  });
}

module.exports = {
  acquireSessionLane,
  describeSessionLeases,
  leaseDir
};

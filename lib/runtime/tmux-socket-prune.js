'use strict';

// tmux 的 unix socket 只会在 server **正常退出**时被清掉；被 kill -9、机器崩溃、
// 或者历史版本遗留的 server 会留下永久失效的 socket 文件。实测一台机器能堆到 1000+
// 个（/tmp/tmux-<uid>/ 里全是死文件），既难看又会让「按 socket 枚举会话」变慢。
//
// 判定方式：能连上 = server 还活着；连不上 = 死文件，删掉。
// 只删 socket 类型、且年龄超过 minAgeMs 的条目 —— 避免和"刚起来还没开始监听"的
// server 抢（那个窗口期连不上但文件已经存在）。

const DEFAULT_MIN_AGE_MS = 60 * 1000;
const DEFAULT_TIMEOUT_MS = 50;

/** 当前用户的 tmux socket 目录；Windows 没有这个概念。 */
function defaultTmuxSocketDir(processObj = process) {
  if (!processObj || processObj.platform === 'win32') return '';
  const uid = typeof processObj.getuid === 'function' ? processObj.getuid() : null;
  if (uid === null || uid === undefined) return '';
  return `/tmp/tmux-${uid}`;
}

function isAlive(net, path, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ path });
    const finish = (alive) => {
      try { socket.destroy(); } catch (_error) {}
      resolve(alive);
    };
    socket.setTimeout(timeoutMs, () => finish(true));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/**
 * 清理失效的 tmux socket 文件（只删死文件，活的/太新的一律不动）。
 *
 * @returns {Promise<{scanned:number, removed:number, kept:number, skipped:number}>}
 */
async function pruneStaleTmuxSockets(options = {}) {
  const fs = options.fs || require('node:fs');
  const net = options.net || require('node:net');
  const dir = String(options.dir !== undefined ? options.dir : defaultTmuxSocketDir(options.processObj)).trim();
  const minAgeMs = Number(options.minAgeMs) >= 0 ? Number(options.minAgeMs) : DEFAULT_MIN_AGE_MS;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const summary = { scanned: 0, removed: 0, kept: 0, skipped: 0 };
  if (!dir) return { ...summary, skipped: 1 };

  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (_error) {
    return { ...summary, skipped: 1 };
  }

  for (const name of names) {
    const path = `${dir}/${name}`;
    let stat;
    try {
      stat = fs.lstatSync(path);
    } catch (_error) {
      continue;
    }
    if (!stat || typeof stat.isSocket !== 'function' || !stat.isSocket()) continue;
    summary.scanned += 1;
    if (nowMs - Number(stat.mtimeMs || 0) < minAgeMs) {
      summary.kept += 1;
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const alive = await isAlive(net, path, timeoutMs);
    if (alive) {
      summary.kept += 1;
      continue;
    }
    try {
      fs.unlinkSync(path);
      summary.removed += 1;
    } catch (_error) {
      summary.skipped += 1;
    }
  }
  return summary;
}

module.exports = {
  DEFAULT_MIN_AGE_MS,
  DEFAULT_TIMEOUT_MS,
  defaultTmuxSocketDir,
  pruneStaleTmuxSockets
};

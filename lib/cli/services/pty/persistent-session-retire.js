'use strict';

// 换号时退休旧账号的持久会话。
//
// 背景（2026-11-05 用户报的「空闲垃圾进程」）：`aih codebuddy` 的 PTY 子进程不是
// provider CLI，而是 **tmux 客户端**（attach / new-session）。换号只 kill 这个客户端，
// tmux 会话、以及会话里的 provider 进程会继续留在后台；每次自动换号就多一个永不退出
// 的 codebuddy —— 用户看到 4 个 codebuddy，其中 3 个空闲。
//
// 退休口径（宁可不杀，也不误杀）：
//   - 只退休**本次启动自己创建**的会话（`owned`）。reattach / takeover / mirror 进入的
//     是用户已有的会话，换号不该把它关掉。
//   - 附着客户端多于一个时（镜像 / 另一个终端正在看）不动：杀了会把人踢下线。
//   - 会话已经不存在 / tmux 不可用：当作已退休，静默跳过。
//
// 只做「判定 + 一条 kill-session」，时序由调用方保证（新进程起来之后再调）。

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

/**
 * pty 进程 → 可退休的会话信息。不是持久会话、不是本次创建的，返回 null。
 * 纯函数：不执行任何命令。
 */
function planPersistentSessionRetire(proc) {
  const info = proc && proc.aihPersistentSessionInfo;
  if (!info || typeof info !== 'object') return null;
  if (info.owned !== true) return null;
  const command = normalizeText(info.command);
  const socket = normalizeText(info.socket);
  const session = normalizeText(info.session);
  if (!command || !socket || !session) return null;
  return { command, socket, session };
}

/**
 * 当前附着在这个会话上的客户端数。
 * 返回 null 表示查不到（tmux 报错 / 会话已消失）——调用方按「只有我们」处理。
 */
function readAttachedClientCount(plan, options = {}) {
  const spawnSync = options.spawnSync || require('node:child_process').spawnSync;
  if (!plan) return null;
  try {
    const result = spawnSync(
      plan.command,
      ['-L', plan.socket, 'display-message', '-p', '-t', plan.session, '#{session_attached}'],
      { encoding: 'utf8' }
    );
    if (!result || result.error || result.status !== 0) return null;
    const count = Number(String(result.stdout || '').trim());
    return Number.isFinite(count) && count >= 0 ? count : null;
  } catch (_error) {
    return null;
  }
}

/**
 * 换号前取一份「退休计划」：只读一次附着数，决定这次要不要杀。
 * 必须在 kill 旧客户端**之前**调用——kill 之后附着数就不可信了。
 */
function capturePersistentSessionRetire(proc, options = {}) {
  const plan = planPersistentSessionRetire(proc);
  if (!plan) return null;
  const attached = readAttachedClientCount(plan, options);
  // 别的客户端还挂着：这个会话不是我们独占的，留给用户 / 空闲回收。
  if (attached !== null && attached > 1) return null;
  return plan;
}

/**
 * 执行退休。best-effort：任何失败都只返回 `{ ok: false }`，不能把换号带崩。
 */
function retirePersistentSession(plan, options = {}) {
  const spawnSync = options.spawnSync || require('node:child_process').spawnSync;
  if (!plan) return { ok: false, reason: 'no_plan' };
  try {
    const result = spawnSync(
      plan.command,
      ['-L', plan.socket, 'kill-session', '-t', plan.session],
      { stdio: 'ignore' }
    );
    if (!result || result.error) {
      return { ok: false, reason: String((result && result.error && result.error.message) || 'spawn_failed') };
    }
    if (result.status !== 0) return { ok: false, reason: `exit_${result.status}` };
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: String((error && error.message) || error || 'unknown_error') };
  }
}

module.exports = {
  capturePersistentSessionRetire,
  planPersistentSessionRetire,
  readAttachedClientCount,
  retirePersistentSession
};

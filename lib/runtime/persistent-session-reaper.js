'use strict';

// 空闲持久会话回收：TTL 过期 + 上限淘汰（对应 Redis 的 lazy/active expire 与 LRU）。
//
// 判定口径：
//   - attached（row.live）永远不动：用户正看着它，哪怕很久没有输出。
//   - 空闲时长 = now - lastActiveAt。lastActiveAt 取
//     max(window_activity, session_activity, created)：window_activity 是「有输出」，
//     session_activity 是「附着 / 交互」。所以「差一分钟满 1 天又被激活」会从激活
//     时刻重新计时，而不是沿用旧窗口。
//   - 超过 TTL（默认 1 天）→ 过期回收。
//   - 剩余空闲数超过上限（默认 10）→ 按最久未活动优先淘汰（allkeys-lru 口径）。
//   - 时间戳完全未知（0）的会话不按 TTL 过期（无法证明它闲了多久），但计入上限，
//     且排序时当作最旧，先被淘汰。

const DEFAULT_IDLE_TTL_MINUTES = 24 * 60;
const DEFAULT_MAX_IDLE = 10;

function readNonNegativeInteger(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

function resolveReapPolicy(env = {}, options = {}) {
  const source = env && typeof env === 'object' ? env : {};
  const enabled = String(source.AIH_SESSION_REAP || '').trim() !== '0';
  const ttlMinutes = readNonNegativeInteger(
    source.AIH_SESSION_IDLE_TTL_MINUTES,
    readNonNegativeInteger(options.idleTtlMinutes, DEFAULT_IDLE_TTL_MINUTES)
  );
  const maxIdle = readNonNegativeInteger(
    source.AIH_SESSION_MAX_IDLE,
    readNonNegativeInteger(options.maxIdle, DEFAULT_MAX_IDLE)
  );
  return {
    enabled,
    idleTtlMs: ttlMinutes * 60 * 1000,
    maxIdle
  };
}

// tmux 的 session_created 是**秒**，而 window_activity / session_activity 在解析时
// 已经乘过 1000。created 作为兜底时必须先归一化，否则会被当成 1970 年，一上来就过期。
function normalizeEpochMs(value, options = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  if (options.seconds && parsed < 1e12) return parsed * 1000;
  return parsed;
}

function sessionLastActiveAt(row) {
  const candidates = [
    normalizeEpochMs(row && row.lastActiveAt),
    normalizeEpochMs(row && row.lastActivityAt),
    normalizeEpochMs(row && row.created, { seconds: true })
  ].filter((value) => value > 0);
  return candidates.length ? Math.max(...candidates) : 0;
}

function sortByLeastRecentlyActive(left, right) {
  if (left.lastActiveAt !== right.lastActiveAt) return left.lastActiveAt - right.lastActiveAt;
  return String(left.row && left.row.name || '').localeCompare(String(right.row && right.row.name || ''));
}

/**
 * 纯函数：给定会话行，算出这一轮要回收谁。
 * rows 里的 live=true 表示当前有客户端附着，永不动。
 */
function planIdleSessionReap(rows, options = {}) {
  const policy = options.policy || resolveReapPolicy(options.env, options);
  const now = Number(options.now) || Date.now();
  const list = Array.isArray(rows) ? rows : [];
  const plan = { expired: [], evicted: [], kept: list.slice(), idleCount: 0, policy };
  if (!policy.enabled) return plan;

  const idle = list.filter((row) => row && !row.live);
  plan.idleCount = idle.length;
  if (!idle.length) return plan;

  const entries = idle.map((row) => ({ row, lastActiveAt: sessionLastActiveAt(row) }));
  const expired = [];
  const remaining = [];
  for (const entry of entries) {
    const idleMs = entry.lastActiveAt > 0 ? now - entry.lastActiveAt : 0;
    if (policy.idleTtlMs > 0 && entry.lastActiveAt > 0 && idleMs >= policy.idleTtlMs) {
      expired.push({ ...entry, idleMs });
    } else {
      remaining.push(entry);
    }
  }

  let evicted = [];
  if (policy.maxIdle > 0 && remaining.length > policy.maxIdle) {
    evicted = remaining
      .slice()
      .sort(sortByLeastRecentlyActive)
      .slice(0, remaining.length - policy.maxIdle);
  }
  const evictedRows = new Set(evicted.map((entry) => entry.row));

  const reapedRows = new Set([...expired.map((entry) => entry.row), ...evictedRows]);
  plan.expired = expired;
  plan.evicted = evicted;
  // kept 是「这一轮没被回收的全部会话」，包含 attached（它们根本不在 idle 集合里）。
  plan.kept = list.filter((row) => !reapedRows.has(row));
  return plan;
}

/**
 * 执行回收。closeSession(row) 返回 {ok:false} 或抛错都记为失败，不影响其它会话。
 */
function reapIdleSessions(rows, options = {}) {
  const plan = planIdleSessionReap(rows, options);
  const targets = [...plan.expired, ...plan.evicted];
  const closeSession = options.closeSession;
  const closedRows = [];
  let failed = 0;
  if (typeof closeSession !== 'function') {
    return { ...plan, closed: 0, failed: 0, closedRows };
  }
  for (const entry of targets) {
    try {
      const result = closeSession(entry.row);
      if (result && result.ok === false) failed += 1;
      else closedRows.push(entry.row);
    } catch (_error) {
      failed += 1;
    }
  }
  return { ...plan, closed: closedRows.length, failed, closedRows };
}

function formatIdleTtl(idleTtlMs) {
  const hours = Math.round(Number(idleTtlMs) / 3600000);
  if (hours >= 24 && hours % 24 === 0) return `${hours / 24} 天`;
  return `${hours} 小时`;
}

function describeReapResult(result) {
  if (!result || (!result.closed && !result.failed)) return '';
  const reasons = [];
  if (result.expired.length) reasons.push(`空闲超 ${formatIdleTtl(result.policy.idleTtlMs)} ${result.expired.length} 个`);
  if (result.evicted.length) reasons.push(`超出 ${result.policy.maxIdle} 个空闲上限 ${result.evicted.length} 个`);
  const detail = reasons.length ? `（${reasons.join('，')}）` : '';
  const failed = result.failed ? `，${result.failed} 个失败` : '';
  return `已回收 ${result.closed} 个空闲会话${detail}${failed}`;
}

module.exports = {
  DEFAULT_IDLE_TTL_MINUTES,
  DEFAULT_MAX_IDLE,
  describeReapResult,
  planIdleSessionReap,
  reapIdleSessions,
  resolveReapPolicy,
  sessionLastActiveAt
};

'use strict';

// `aih <provider> ls` 的限流徽章（账号级 + 模型级）。
//
// 事实来源与 WebUI 状态一致：account_state.runtime_state 的 typed 冷却（账号级
// rateLimitUntil，见 deriveRuntimeStatus）与 modelCooldowns / modelFailureStreaks
// （按「账号 × 模型」记，见 lib/server/account-runtime-state.js）。
//
// 一行放不下多个条目，所以这里只产出**候选徽章**（每个都是完整文本）：
//   `[限流: 账号 至 12:30]`            —— 账号级限流（与 WebUI 的 rate_limited 对齐）
//   `[限流: deepseek-v4.1-flash 至 14:29]` —— 确定是某个模型被限流时才带模型名
//   `[受限: xxx 至 14:29]`             —— 非限流类阻塞（如档位不提供该模型）
// 展示层按时间轮换（一次只显示一条），不再把所有模型堆在一行里。

// 这几种 kind 都是「上游限流」语义，徽章叫「限流」；其余（例如档位不提供该模型）
// 叫「受限」，不冒称限流。
const RATE_LIMIT_KINDS = new Set([
  'rate_limited',
  'model_quota_exhausted',
  'model_overloaded',
  'model_capacity_unavailable'
]);

// 轮换候选上限：再多也没意义，用户只会在几条之间来回看。
const MAX_BADGE_VARIANTS = 6;

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** 恢复时刻：同一天只给 HH:MM，跨天补上 MM-DD，避免误读成「已经过去了」。 */
function formatRecoveryClock(untilMs, nowMs = Date.now()) {
  const until = new Date(Number(untilMs));
  const now = new Date(Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now());
  if (Number.isNaN(until.getTime())) return '';
  const clock = `${pad2(until.getHours())}:${pad2(until.getMinutes())}`;
  const sameDay = until.getFullYear() === now.getFullYear()
    && until.getMonth() === now.getMonth()
    && until.getDate() === now.getDate();
  return sameDay ? clock : `${pad2(until.getMonth() + 1)}-${pad2(until.getDate())} ${clock}`;
}

/** 仍生效的 (账号, 模型) 冷却，按恢复时刻升序（最先恢复的排前面）。 */
function listActiveModelThrottles(runtimeState, nowMs = Date.now()) {
  if (!runtimeState || typeof runtimeState !== 'object') return [];
  const cooldowns = runtimeState.modelCooldowns;
  if (!cooldowns || typeof cooldowns !== 'object') return [];
  const streaks = runtimeState.modelFailureStreaks && typeof runtimeState.modelFailureStreaks === 'object'
    ? runtimeState.modelFailureStreaks
    : {};
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const entries = [];
  for (const [model, untilValue] of Object.entries(cooldowns)) {
    const name = String(model == null ? '' : model).trim();
    const until = Number(untilValue);
    if (!name || !Number.isFinite(until) || until <= now) continue;
    const streak = streaks[model];
    entries.push({
      model: name,
      until,
      kind: String(streak && streak.kind || '').trim()
    });
  }
  entries.sort((left, right) => left.until - right.until || left.model.localeCompare(right.model));
  return entries;
}

function formatBadge(text) {
  const value = String(text || '').trim();
  return value ? `\x1b[33m[${value}]\x1b[0m` : '';
}

/**
 * 轮换候选：账号级限流排最前，其后是各模型（按恢复时刻）。
 *
 * @param {object|null} runtimeState account_state.runtime_state
 * @param {{status?: string, until?: number}|null} accountRuntime deriveRuntimeStatus 的结论
 * @returns {string[]} 每个元素都是可直接渲染的完整徽章
 */
function buildThrottleBadgeVariants(runtimeState, accountRuntime = null, nowMs = Date.now()) {
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const variants = [];
  const push = (badge) => {
    if (badge && !variants.includes(badge)) variants.push(badge);
  };

  // 账号级限流：与 WebUI 的 rate_limited 同一事实（typed until），不涉及具体模型。
  const accountStatus = String(accountRuntime && accountRuntime.status || '').trim().toLowerCase();
  const accountUntil = Number(accountRuntime && accountRuntime.until) || 0;
  if (accountStatus === 'rate_limited' && accountUntil > now) {
    push(formatBadge(`限流: 账号 至 ${formatRecoveryClock(accountUntil, now)}`));
  }

  listActiveModelThrottles(runtimeState, now).forEach((entry) => {
    const title = RATE_LIMIT_KINDS.has(entry.kind) ? '限流' : '受限';
    push(formatBadge(`${title}: ${entry.model} 至 ${formatRecoveryClock(entry.until, now)}`));
  });

  return variants.slice(0, MAX_BADGE_VARIANTS);
}

/** 兼容旧调用：把所有候选拼成一枚徽章（ls 已改用轮换，见 buildThrottleBadgeVariants）。 */
function formatModelThrottleBadge(runtimeState, nowMs = Date.now()) {
  const variants = buildThrottleBadgeVariants(runtimeState, null, nowMs);
  return variants.join(' ');
}

module.exports = {
  RATE_LIMIT_KINDS,
  MAX_BADGE_VARIANTS,
  formatRecoveryClock,
  listActiveModelThrottles,
  buildThrottleBadgeVariants,
  formatModelThrottleBadge
};

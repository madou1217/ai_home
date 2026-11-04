'use strict';

// `aih <provider> ls` 的**模型级**受限徽章。
//
// 事实来源与 WebUI「部分模型受限」一致：account_state.runtime_state 里的
// modelCooldowns / modelFailureStreaks（按「账号 × 模型」记，见
// lib/server/account-runtime-state.js 的 touchAccountModelFailureState）。
// 一个模型 429 不代表整号不可用（账号级运行态仍是 healthy），所以不能把整行标红；
// 但只看账号级状态又会让它显得完全正常——ls 只有一行，于是压成一枚黄色徽章，
// 列出仍然生效的模型与恢复时刻；模型数量多时只列最早恢复的几个，其余给个数。

// 这几种 kind 都是「上游限流」语义，徽章统一叫「模型限流」；其余（例如档位
// 不提供该模型）叫「模型受限」，不冒称限流。
const RATE_LIMIT_KINDS = new Set([
  'rate_limited',
  'model_quota_exhausted',
  'model_overloaded',
  'model_capacity_unavailable'
]);

const MAX_LISTED_MODELS = 3;

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

/** 徽章文本；没有生效中的模型冷却时返回空串（调用方按空串不渲染）。 */
function formatModelThrottleBadge(runtimeState, nowMs = Date.now()) {
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const entries = listActiveModelThrottles(runtimeState, now);
  if (entries.length === 0) return '';
  const title = entries.every((entry) => RATE_LIMIT_KINDS.has(entry.kind))
    ? '模型限流'
    : '模型受限';
  const shown = entries
    .slice(0, MAX_LISTED_MODELS)
    .map((entry) => `${entry.model} 至 ${formatRecoveryClock(entry.until, now)}`);
  const suffix = entries.length > MAX_LISTED_MODELS ? ` 等 ${entries.length} 个模型` : '';
  return `\x1b[33m[${title}: ${shown.join('、')}${suffix}]\x1b[0m`;
}

module.exports = {
  formatRecoveryClock,
  listActiveModelThrottles,
  formatModelThrottleBadge
};

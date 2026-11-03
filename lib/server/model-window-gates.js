'use strict';

// 「(账号, 模型) 现在还能不能发」的门禁（Model Window Gate）。
//
// 动机：relay 选号此前只看模型目录（账号目录里有没有这个模型），不看**额度窗口**。
// 于是窗口已经耗尽的账号仍会被选中 → 上游回 429（agy 会包装成「AI credits balance is too low」），
// 用户直接看到失败。这里按 provider 声明「该账号该模型的窗口是否已耗尽」，
// 选号阶段就把注定 429 的账号摘掉（同池其它账号顶上；全都耗尽则由调用方渲染 no_available_account，
// 别名回落可以换模型）——**预防优于冷却**。
//
// 新增 provider = 加一行判定；未声明的 provider 不做窗口过滤（行为不变）。

const { resolveAgyCliModelName } = require('../runtime/agy-model-names');

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeProvider(provider) {
  return normalizeText(provider).toLowerCase();
}

// 快照里的模型条目按「id 或 CLI 显示名」匹配（两套命名都存在，见 agy-model-names）。
function findSnapshotModelEntry(snapshot, model) {
  const entries = snapshot && Array.isArray(snapshot.models) ? snapshot.models : [];
  if (entries.length === 0) return null;
  const wanted = normalizeText(model);
  const cliName = resolveAgyCliModelName(wanted);
  return entries.find((entry) => {
    const id = normalizeText(entry && entry.model);
    if (!id) return false;
    if (id === wanted) return true;
    if (cliName && resolveAgyCliModelName(id) === cliName) return true;
    return false;
  }) || null;
}

// 快照新鲜度上限：过期快照不能当否定证据（否则会凭空摘账号）。
const MODEL_WINDOW_MAX_SNAPSHOT_AGE_MS = 10 * 60 * 1000;

// agy：额度快照的 per-model 窗口。remainingPct<=0 且窗口尚未重置 → 已耗尽。
function agyModelWindowExhausted(account, model, now, options = {}) {
  const snapshot = account && account.usageSnapshot;
  const maxAgeMs = Number(options.maxSnapshotAgeMs);
  if (Number.isFinite(maxAgeMs) && maxAgeMs > 0) {
    const capturedAt = Number(snapshot && snapshot.capturedAt);
    if (!Number.isFinite(capturedAt) || capturedAt <= 0 || (now - capturedAt) > maxAgeMs) return false;
  }
  const entry = findSnapshotModelEntry(snapshot, model);
  if (!entry) return false;
  const remaining = Number(entry.remainingPct);
  if (!Number.isFinite(remaining) || remaining > 0) return false;
  const resetAtMs = Number(entry.resetAtMs);
  return !(Number.isFinite(resetAtMs) && resetAtMs > 0 && resetAtMs <= now);
}

const MODEL_WINDOW_GATES = Object.freeze({
  agy: agyModelWindowExhausted
});

function isModelWindowExhausted(input = {}) {
  const gate = MODEL_WINDOW_GATES[normalizeProvider(input.provider)];
  if (typeof gate !== 'function') return false;
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  try {
    return gate(input.account, input.model, now, { maxSnapshotAgeMs: input.maxSnapshotAgeMs }) === true;
  } catch (_error) {
    return false; // 门禁自身异常按「不拦」处理：宁可发出去，也不要凭空摘账号
  }
}

/**
 * 该 (账号, 模型) 的窗口**何时恢复**（epoch ms；未知/未耗尽/已过期 → 0）。
 * 用途：上游已经回了 429/配额耗尽时，把冷却设到这一刻，而不是固定 5 分钟——
 * 后者会在整个窗口期内反复撞墙重试（每次都可能再被记一次失败）。
 */
function modelWindowResetAtMs(input = {}) {
  const gate = MODEL_WINDOW_GATES[normalizeProvider(input.provider)];
  if (typeof gate !== 'function') return 0;
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const maxAgeMs = Number(input.maxSnapshotAgeMs);
  const snapshot = input.account && input.account.usageSnapshot;
  if (Number.isFinite(maxAgeMs) && maxAgeMs > 0) {
    const capturedAt = Number(snapshot && snapshot.capturedAt);
    if (!Number.isFinite(capturedAt) || capturedAt <= 0 || (now - capturedAt) > maxAgeMs) return 0;
  }
  try {
    if (gate(input.account, input.model, now, { maxSnapshotAgeMs: maxAgeMs }) !== true) return 0;
  } catch (_error) {
    return 0;
  }
  const entry = findSnapshotModelEntry(snapshot, input.model);
  const resetAtMs = Number(entry && entry.resetAtMs);
  return Number.isFinite(resetAtMs) && resetAtMs > now ? resetAtMs : 0;
}

module.exports = {
  MODEL_WINDOW_GATES,
  MODEL_WINDOW_MAX_SNAPSHOT_AGE_MS,
  agyModelWindowExhausted,
  findSnapshotModelEntry,
  isModelWindowExhausted,
  modelWindowResetAtMs
};

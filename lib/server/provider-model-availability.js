'use strict';

// Provider 级「该模型在此 provider 上不可用」的**负面事实**登记簿。
//
// 背景（2026-10-22 真机）：`gemini-3.5-flash` 被前缀推断成 agy 家族，agy 池有账号，
// 于是路由每次都把请求送到 agy —— 但上游早已把裸名下架、agy 目录只剩 `-low`/`-lite`/
// `-extra-low` 变体。网关因此反复产出误导性的
// `no available agy account can serve model gemini-3.5-flash`（听起来像账号问题，
// 实际是模型与 provider 不匹配）。
//
// 分类层已能识别这类拒绝（见 upstream-failure-policy 的 account_tier_model_denied /
// model_not_available_on_endpoint），但**分类只是当次请求的处理**：下一次请求仍会按同一份
// 目录把请求送回同一个 provider，错误周而复始。本模块补上闭环 —— 把「上游明确说这个
// provider 服务不了这个模型」记成事实，让后续路由**先看事实再选 provider**。
//
// 与既有机制的分工：
// - `account.modelCooldowns`：账号 × 模型，记「这次遭遇」，会过期（软冷却）；
// - 本模块：provider × 模型，记「上游的目录事实」，TTL 更长且独立于具体账号 ——
//   因为「agy 没有 gemini-3.5-flash」对 agy 的**所有**账号都成立。
//
// 存储：挂在 state 上（进程内），随目录刷新自然失效 —— 不落盘。理由：它是**观测缓存**
// 而非配置，进程重启后重新观测即可；落盘会引入「上次的结论锁死这次的路由」的风险，
// 而那正是 2026-10-21 那次事故的形态。

const DEFAULT_TTL_MS = 30 * 60 * 1000;

/** @type {Map<string, Map<string, number>>} provider → (modelKey → expiresAt) */
const registry = new Map();

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function modelKey(model) {
  return normalizeText(model).toLowerCase();
}

/**
 * 记下「provider 服务不了这个模型」。
 *
 * @param {string} provider
 * @param {string} model
 * @param {{ ttlMs?: number, now?: number }} [options]
 */
function markModelUnavailableForProvider(provider, model, options = {}) {
  const p = normalizeText(provider).toLowerCase();
  const m = modelKey(model);
  if (!p || !m) return;
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : DEFAULT_TTL_MS;
  const byModel = registry.get(p) || new Map();
  byModel.set(m, now + ttlMs);
  registry.set(p, byModel);
}

/**
 * 该 (provider, 模型) 是否已被判定为不可用。过期的记录顺手清掉。
 *
 * @returns {boolean}
 */
function isModelUnavailableForProvider(provider, model, now = Date.now()) {
  const p = normalizeText(provider).toLowerCase();
  const m = modelKey(model);
  if (!p || !m) return false;
  const byModel = registry.get(p);
  if (!byModel) return false;
  const expiresAt = byModel.get(m);
  if (!expiresAt) return false;
  if (expiresAt <= now) {
    byModel.delete(m);
    if (byModel.size < 1) registry.delete(p);
    return false;
  }
  return true;
}

/** 清掉某 provider 的全部记录（目录刷新后调用：上游可能已经上架回来了）。 */
function clearProviderModelUnavailable(provider) {
  const p = normalizeText(provider).toLowerCase();
  if (!p) return;
  registry.delete(p);
}

/** 清空全部（测试与目录整体刷新用）。 */
function resetModelAvailabilityRegistry() {
  registry.clear();
}

/** 可观测快照（排障用）。 */
function snapshotModelAvailability(now = Date.now()) {
  const out = {};
  registry.forEach((byModel, provider) => {
    const alive = {};
    byModel.forEach((expiresAt, model) => {
      if (expiresAt > now) alive[model] = expiresAt;
    });
    if (Object.keys(alive).length > 0) out[provider] = alive;
  });
  return out;
}

module.exports = {
  DEFAULT_TTL_MS,
  clearProviderModelUnavailable,
  isModelUnavailableForProvider,
  markModelUnavailableForProvider,
  resetModelAvailabilityRegistry,
  snapshotModelAvailability
};

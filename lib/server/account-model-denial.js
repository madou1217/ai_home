'use strict';

// 账号级「实测用不了这个模型」的**负面事实**登记簿。
//
// 与 provider-model-availability 的分工：
// - 那个记「上��说这个**端点/provider**没有这个模型」（目录事实，provider 级）；
// - 本模块记「这个**账号**调它被上游拒了」（实测事实，账号级）。
//
// 为什么必须分两级（2026-10-22/23 真机）：CodeBuddy/WorkBuddy 家族对免费档返回
//   {"code":11158,"msg":"model [gemini-3.5-flash] is not allowed for user type [personal_free_user]"}
// 这是**账号档位**属性 —— 同 provider 的 pro 账号可能就能用。所以：
// - 标成 provider 级会把 pro 账号一起封掉（错）；
// - 完全不记则模型永远留在对外目录里，用户选了必然失败（也是错，用户的原话：
//   「为什么上游模型消失了没有同步处理」）。
// 正确粒度就是账号级：谁被拒就只记谁。
//
// 与目录探测的关系：探测回答「上游**列了**什么」，本模块回答「实际**能不能用**」。
// 上游会列出它支持但你的档位不允许的模型，所以两者都要，且实测优先 ——
// 探测结果在写入目录前会先减掉这里登记的模型（见 provider-model-discovery）。
//
// 存储：挂在 state 上（进程内），不落���。它是**观测缓存**：账号续费/升级后应自动恢复，
// 落盘会让上次的结论锁死这次的路由（2026-10-21 那次事故的形态）。

const DEFAULT_TTL_MS = 30 * 60 * 1000;

/** @type {Map<string, Map<string, number>>} accountRef → (modelKey → expiresAt) */
const registry = new Map();

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function modelKey(model) {
  return normalizeText(model).toLowerCase();
}

/**
 * 记下「这个账号实测用不了这个模型」。
 *
 * @param {string} accountRef
 * @param {string} model
 * @param {{ ttlMs?: number, now?: number }} [options]
 */
function markModelDeniedForAccount(accountRef, model, options = {}) {
  const ref = normalizeText(accountRef);
  const m = modelKey(model);
  if (!ref || !m) return;
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : DEFAULT_TTL_MS;
  const byModel = registry.get(ref) || new Map();
  byModel.set(m, now + ttlMs);
  registry.set(ref, byModel);
}

/** 该 (账号, 模型) 是否已被实测判定为不可用。过期的记录顺手清掉。 */
function isModelDeniedForAccount(accountRef, model, now = Date.now()) {
  const ref = normalizeText(accountRef);
  const m = modelKey(model);
  if (!ref || !m) return false;
  const byModel = registry.get(ref);
  if (!byModel) return false;
  const expiresAt = byModel.get(m);
  if (!expiresAt) return false;
  if (expiresAt <= now) {
    byModel.delete(m);
    if (byModel.size < 1) registry.delete(ref);
    return false;
  }
  return true;
}

/** 从一份模型清单里减掉该账号已被实测拒绝的模型（探测结果的净化）。 */
function subtractDeniedModels(accountRef, models, now = Date.now()) {
  const list = Array.isArray(models) ? models : [];
  if (list.length < 1) return list;
  const byModel = registry.get(normalizeText(accountRef));
  if (!byModel || byModel.size < 1) return list;
  return list.filter((model) => !isModelDeniedForAccount(accountRef, model, now));
}

/** 清掉某账号的全部记录（账号续费/升级后由调用方触发）。 */
function clearAccountModelDenials(accountRef) {
  const ref = normalizeText(accountRef);
  if (!ref) return;
  registry.delete(ref);
}

/** 清空全部（测试与账号重载用）。 */
function resetAccountModelDenialRegistry() {
  registry.clear();
}

/** 可观测快照（排障用）。 */
function snapshotAccountModelDenials(now = Date.now()) {
  const out = {};
  registry.forEach((byModel, accountRef) => {
    const alive = {};
    byModel.forEach((expiresAt, model) => {
      if (expiresAt > now) alive[model] = expiresAt;
    });
    if (Object.keys(alive).length > 0) out[accountRef] = alive;
  });
  return out;
}

module.exports = {
  DEFAULT_TTL_MS,
  clearAccountModelDenials,
  isModelDeniedForAccount,
  markModelDeniedForAccount,
  resetAccountModelDenialRegistry,
  snapshotAccountModelDenials,
  subtractDeniedModels
};

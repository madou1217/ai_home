'use strict';

// 模型上下文窗口的**手动覆盖**（按账号 × 模型）。
//
// 为什么需要（2026-10-23 用户要求）：上游声明不一定拿得到，也不一定可信 ——
// opencode 的 `/models` 只返回 id、不声明窗口；models.dev 的公开值对中转账号未必成立。
// 用户明确要求：**值必须有可靠数据支撑，不能凭感觉写死**，拿不到就让人设。
//
// 维度刻意是「账号 × 模型」而不是「provider × 模型」：同一个 provider 下有不同类型账号
// （中转 / OAuth / API Key），它们的真实窗口不同 —— 同套餐 OAuth 通常一致，中转则取决于上游。
//
// 解析优先级（唯一入口 resolveContextWindow）：
//   手动覆盖 > 上游探测 > models.dev 目录 > 未知
// 三者的存储各归其位：手动值在这里，探测值在 probed-model-limits，目录值在 models-dev-metadata。
// 本模块只负责手动层与合并，不复制另外两层的数据。

const { readJsonValue, writeJsonValue } = require('./app-state-store');
const { resolveProbedContextLength } = require('./probed-model-limits');
const { createModelsDevReader } = require('./models-dev-metadata');

// 单一 KV 键：整份覆盖表一次读写。条数天然受「账号数 × 有窗口问题的模型数」限制，
// 不需要分片；分片反而让「列全部覆盖」变成前缀扫描。
const OVERRIDE_KEY = 'config:model-context-overrides';

// 窗口合法范围：0 与负数无意义；上界挡住把 1e9 之类的误输入当窗口用。
// 当前公开模型最大约 1M（用户 2026-10-23 判断），留一倍余量给未来。
const MIN_CONTEXT_TOKENS = 1024;
const MAX_CONTEXT_TOKENS = 2_000_000;

function normalizeText(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function normalizeTokens(value) {
  const tokens = Number(value);
  if (!Number.isSafeInteger(tokens)) return 0;
  if (tokens < MIN_CONTEXT_TOKENS || tokens > MAX_CONTEXT_TOKENS) return 0;
  return tokens;
}

/** 读取整份覆盖表：`{ [accountRef]: { [modelId]: tokens } }`。 */
function readOverrides(deps = {}) {
  const { fs, aiHomeDir } = deps;
  if (!fs || !normalizeText(aiHomeDir)) return {};
  const stored = readJsonValue(fs, aiHomeDir, OVERRIDE_KEY, deps);
  return sanitizeOverrides(stored);
}

function sanitizeOverrides(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const out = {};
  for (const [accountRef, byModel] of Object.entries(source)) {
    const ref = normalizeText(accountRef);
    if (!ref || !byModel || typeof byModel !== 'object' || Array.isArray(byModel)) continue;
    const models = {};
    for (const [modelId, tokens] of Object.entries(byModel)) {
      const id = normalizeText(modelId);
      const normalized = normalizeTokens(tokens);
      if (id && normalized) models[id] = normalized;
    }
    if (Object.keys(models).length > 0) out[ref] = models;
  }
  return out;
}

/**
 * 设置（或清除）一个「账号 × 模型」的窗口覆盖。
 *
 * `tokens` 传 0 / null / undefined 表示**清除**该条覆盖，回落到探测或目录值 ——
 * 这是「手设错了要能撤掉」的唯一入口，不做「设 0 表示不限」的歧义语义。
 *
 * @returns {{ ok: boolean, error?: string, overrides?: object }}
 */
function setContextOverride(deps, input = {}) {
  const accountRef = normalizeText(input.accountRef);
  const modelId = normalizeText(input.model);
  if (!accountRef || !modelId) return { ok: false, error: 'account_and_model_required' };
  const clearing = input.tokens === 0 || input.tokens === null || input.tokens === undefined
    || String(input.tokens).trim() === '';
  const tokens = clearing ? 0 : normalizeTokens(input.tokens);
  if (!clearing && !tokens) {
    return { ok: false, error: 'context_tokens_out_of_range' };
  }
  const current = readOverrides(deps);
  const forAccount = { ...(current[accountRef] || {}) };
  if (clearing) delete forAccount[modelId];
  else forAccount[modelId] = tokens;
  const next = { ...current };
  if (Object.keys(forAccount).length > 0) next[accountRef] = forAccount;
  else delete next[accountRef];
  return writeOverrides(deps, next);
}

/**
 * 一次写入多个账号的同一模型覆盖（WebUI「同类型账号一并设置」走这里）。
 *
 * 部分失败不做「尽力而为」：整份表要么写成功要么保持原样，避免用户看到
 * 「有几个账号设上了、有几个没有」的中间态。
 */
function setContextOverridesForAccounts(deps, input = {}) {
  const modelId = normalizeText(input.model);
  const accountRefs = Array.isArray(input.accountRefs)
    ? [...new Set(input.accountRefs.map(normalizeText).filter(Boolean))]
    : [];
  if (!modelId || accountRefs.length === 0) return { ok: false, error: 'account_and_model_required' };
  const clearing = input.tokens === 0 || input.tokens === null || input.tokens === undefined
    || String(input.tokens).trim() === '';
  const tokens = clearing ? 0 : normalizeTokens(input.tokens);
  if (!clearing && !tokens) return { ok: false, error: 'context_tokens_out_of_range' };

  const next = readOverrides(deps);
  for (const accountRef of accountRefs) {
    const forAccount = { ...(next[accountRef] || {}) };
    if (clearing) delete forAccount[modelId];
    else forAccount[modelId] = tokens;
    if (Object.keys(forAccount).length > 0) next[accountRef] = forAccount;
    else delete next[accountRef];
  }
  return writeOverrides(deps, next);
}

function writeOverrides(deps, overrides) {
  const { fs, aiHomeDir } = deps;
  if (!fs || !normalizeText(aiHomeDir)) return { ok: false, error: 'storage_unavailable' };
  const sanitized = sanitizeOverrides(overrides);
  const written = writeJsonValue(fs, aiHomeDir, OVERRIDE_KEY, sanitized, deps);
  if (written === false) return { ok: false, error: 'storage_write_failed' };
  return { ok: true, overrides: sanitized };
}

/** 返回某账号的手动覆盖表（无覆盖时为空对象）。 */
function listAccountOverrides(deps, accountRef) {
  const ref = normalizeText(accountRef);
  if (!ref) return {};
  return { ...(readOverrides(deps)[ref] || {}) };
}

let reader = null;
function modelsDevReader() {
  if (!reader) reader = createModelsDevReader();
  return reader;
}

function catalogContextWindow(provider, model) {
  const id = normalizeText(model);
  if (!id) return 0;
  try {
    const entry = modelsDevReader().resolveEntry({ id, provider: normalizeText(provider) });
    const limits = entry && entry.limits;
    const value = Number(limits && (limits.input || limits.context));
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  } catch (_error) {
    return 0;
  }
}

/**
 * 解析该「账号 × 模型」应使用的上下文窗口。
 *
 * @returns {{ tokens: number, source: 'override'|'probed'|'catalog'|'unknown' }}
 *   source 让调用方（WebUI、日志、超限报错）能说清「这个数字是哪来的」——
 *   用户要求值必须有数据支撑，来源可见是这条要求的组成部分。
 */
function resolveContextWindow(deps, input = {}) {
  const accountRef = normalizeText(input.accountRef);
  const model = normalizeText(input.model);
  const override = accountRef ? Number((readOverrides(deps)[accountRef] || {})[model]) : 0;
  if (Number.isSafeInteger(override) && override > 0) return { tokens: override, source: 'override' };
  const probed = accountRef ? Number(resolveProbedContextLength(accountRef, model)) : 0;
  if (Number.isSafeInteger(probed) && probed > 0) return { tokens: probed, source: 'probed' };
  const catalog = catalogContextWindow(input.provider, model);
  if (catalog > 0) return { tokens: catalog, source: 'catalog' };
  return { tokens: 0, source: 'unknown' };
}

module.exports = {
  MAX_CONTEXT_TOKENS,
  MIN_CONTEXT_TOKENS,
  OVERRIDE_KEY,
  listAccountOverrides,
  readOverrides,
  resolveContextWindow,
  sanitizeOverrides,
  setContextOverride,
  setContextOverridesForAccounts
};

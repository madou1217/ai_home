'use strict';

// 显式模型命名空间头：客户端只能发裸模型名、而 aih 目录里该 provider 的模型带
// 命名空间时，由客户端声明命名空间，网关在入口补全。
//
// 起因（2026-10-18）：opencode CLI 的内置 `opencode`（Zen）provider 经 aih 改道到网关后，
// 请求体里是裸名 `deepseek-v4.1-flash-free`，而 aih 的 opencode 账号目录登记的是
// `opencode/deepseek-v4.1-flash-free`。两者在选号器里不等价，账号被当成「目录已知且不含
// 该模型」排除 → no_available_account。
//
// 为什么用显式头而不是放宽通用匹配规则：`cline-pass/x` 与裸名 `x` 在别的 provider 下是
// 不同产品，全局「去命名空间」会让账号漂移（见 model-pool-narrowing 的强证据排除）。
// 只有 aih 自己注入了这个头的请求才补全，零误伤。

const MODEL_NAMESPACE_HEADER = 'x-aih-model-namespace';
const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

function readNamespace(headers) {
  const raw = headers && (headers[MODEL_NAMESPACE_HEADER] || headers['X-Aih-Model-Namespace']);
  const value = String(Array.isArray(raw) ? raw[0] : raw || '').trim().toLowerCase();
  return NAMESPACE_PATTERN.test(value) ? value : '';
}

/**
 * 按命名空间头补全裸模型名。返回补全后的新请求体；无需补全时返回 null（调用方原样转发）。
 * 已带命名空间的模型名（含 `/`）不动 —— 客户端明确指定的永远优先。
 */
function applyModelNamespaceHeader(headers, requestJson) {
  const namespace = readNamespace(headers);
  if (!namespace || !requestJson || typeof requestJson !== 'object') return null;
  const model = typeof requestJson.model === 'string' ? requestJson.model.trim() : '';
  if (!model || model.includes('/')) return null;
  return { ...requestJson, model: `${namespace}/${model}` };
}

/** 请求头声明的合法命名空间；未声明或非法时返回 ''。 */
function readModelNamespace(headers) {
  return readNamespace(headers);
}

/**
 * 这个请求会不会被入口改写模型名（与 applyModelNamespaceHeader 同一判定，只看模型字符串）。
 * Go 路由交还判定用它：补全只存在于 Node 的 v1-router，Go 收到裸名会选不到账号。
 */
function wouldApplyModelNamespace(namespace, model) {
  const ns = String(namespace || '').trim().toLowerCase();
  const name = typeof model === 'string' ? model.trim() : '';
  return NAMESPACE_PATTERN.test(ns) && Boolean(name) && !name.includes('/');
}

module.exports = {
  MODEL_NAMESPACE_HEADER,
  applyModelNamespaceHeader,
  readModelNamespace,
  wouldApplyModelNamespace
};

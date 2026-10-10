'use strict';

// 上游 /models 探测拿到的上下文长度登记表(进程内,按 accountRef)。
// models.dev 快照只覆盖公开模型;自建/中转服务(MTPLX、vLLM、LM Studio、OpenRouter 等)
// 的真实窗口只在它们自己的 /models 里声明。缺了它,Chat harness 给 Codex 的模型目录没有
// context_window:skills 预算被压到最小、自动压缩阈值也算不出来。
// 这里只登记、不参与路由:账号可服务的模型清单仍以探测得到的 id 列表为准。
const CONTEXT_LENGTH_FIELDS = ['context_length', 'max_context_length', 'max_model_len', 'context_window', 'max_input_tokens'];

const limitsByAccount = new Map();

function normalizeRef(value) {
  return String(value || '').trim();
}

function readContextLength(item) {
  for (const field of CONTEXT_LENGTH_FIELDS) {
    const value = Number(item && item[field]);
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  return 0;
}

// 每次成功探测都整体替换该账号的登记(即使上游一个字段都没给),
// 让「本进程探测过但没有数据」与「还没探测过」可以区分。只登记最终保留下来的模型 id。
function registerProbedModelLimits(accountRef, items, keptIds) {
  const ref = normalizeRef(accountRef);
  if (!ref) return;
  const kept = new Set(Array.isArray(keptIds) ? keptIds : []);
  const limits = new Map();
  (Array.isArray(items) ? items : []).forEach((item) => {
    const id = normalizeRef(item && item.id);
    const contextLength = readContextLength(item);
    if (id && contextLength && kept.has(id)) limits.set(id, contextLength);
  });
  limitsByAccount.set(ref, limits);
}

function hasProbedModelLimits(accountRef) {
  return limitsByAccount.has(normalizeRef(accountRef));
}

function resolveProbedContextLength(accountRef, modelId) {
  const limits = limitsByAccount.get(normalizeRef(accountRef));
  return (limits && limits.get(normalizeRef(modelId))) || 0;
}

// 供 WebUI 模型缓存快照持久化：重启后从快照恢复，首次读取不必为了窗口再探测上游。
function snapshotProbedModelLimits(accountRef) {
  const limits = limitsByAccount.get(normalizeRef(accountRef));
  return limits ? Object.fromEntries(limits) : null;
}

// 只在本进程还没有该账号的登记时恢复，避免旧快照覆盖刚探测到的新值。
function restoreProbedModelLimits(accountRef, limits) {
  const ref = normalizeRef(accountRef);
  if (!ref || limitsByAccount.has(ref) || !limits || typeof limits !== 'object') return;
  const restored = new Map();
  Object.entries(limits).forEach(([modelId, value]) => {
    const id = normalizeRef(modelId);
    const contextLength = Number(value);
    if (id && Number.isSafeInteger(contextLength) && contextLength > 0) restored.set(id, contextLength);
  });
  limitsByAccount.set(ref, restored);
}

function resetProbedModelLimits() {
  limitsByAccount.clear();
}

module.exports = {
  hasProbedModelLimits,
  registerProbedModelLimits,
  resetProbedModelLimits,
  resolveProbedContextLength,
  restoreProbedModelLimits,
  snapshotProbedModelLimits
};

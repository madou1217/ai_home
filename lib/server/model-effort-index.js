'use strict';

// 模型推理强度档位的查询入口（带缓存），与 model-modality-index 同构。
//
// 数据来源：models.dev 快照的 `capabilities.reasoningOptions`。
// 消费方有两类：
//   1. 网关 /v1/models —— 发布 `aih_reasoning_efforts`，外部 harness 据此渲染强度选择器；
//   2. harness 注入层（opencode / pi 的模型目录）—— 转成各自的字段形状。
//
// **刻意不做家族兜底**（与模态相反）：猜错模态只是多剥或少剥一张图，猜错强度却会把用户
// 明确要求的 high 静默降档。查不到就返回空数组，调用方据此省略该字段（省略 = 未知）。

const { createModelsDevReader } = require('./models-dev-metadata');

// Canonical 强度全序，必须与 core/inference 的 ReasoningEffort 一致：
// harness 会按这个顺序呈现档位，顺序错会让「更强」看起来更弱。
const CANONICAL_EFFORT_ORDER = Object.freeze([
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'
]);

let reader = null;
const effortCache = new Map();

function modelsDevReader() {
  if (!reader) reader = createModelsDevReader();
  return reader;
}

function normalizeEffort(value) {
  return String(value === undefined || value === null ? '' : value).trim().toLowerCase();
}

/**
 * 返回该模型声明的推理强度档位（Canonical 全序升序）；查不到返回空数组。
 *
 * @param {{ provider?: string, model: string, reader?: object }} deps
 * @returns {string[]}
 */
function resolveModelEfforts(deps = {}) {
  const model = String(deps.model || '').trim();
  if (!model) return [];
  const provider = String(deps.provider || '').trim().toLowerCase();
  const cacheKey = `${provider}\u0000${model}`;
  const cached = effortCache.get(cacheKey);
  if (cached) return cached.slice();

  let entry = null;
  try {
    const source = deps.reader || modelsDevReader();
    entry = source.resolveEntry({ id: model, provider: deps.provider });
  } catch (_error) {
    return [];
  }
  const options = entry && entry.capabilities && entry.capabilities.reasoningOptions;
  const declared = new Set();
  for (const option of Array.isArray(options) ? options : []) {
    if (!option || option.type !== 'effort') continue;
    for (const value of Array.isArray(option.values) ? option.values : []) {
      const effort = normalizeEffort(value);
      if (effort) declared.add(effort);
    }
  }
  // 目录里的未知档位（未来词汇）排在末尾：不静默丢弃，也不让它打乱已知顺序。
  const known = CANONICAL_EFFORT_ORDER.filter((effort) => declared.has(effort));
  const unknown = [...declared].filter((effort) => !CANONICAL_EFFORT_ORDER.includes(effort)).sort();
  const resolved = [...known, ...unknown];
  effortCache.set(cacheKey, resolved);
  return resolved.slice();
}

module.exports = {
  CANONICAL_EFFORT_ORDER,
  resolveModelEfforts
};

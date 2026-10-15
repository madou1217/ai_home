'use strict';

// agy（Antigravity CLI）的模型名映射表 —— **id ↔ CLI 显示名**。
//
// 事实（2026-10-15 本机 agy 实测）：`agy --model <x>` 只认**显示名**，写 id 直接报错：
//   $ agy --print 'x' --model gemini-2.5-flash
//   error: invalid model selection (--model "gemini-2.5-flash"): model gemini-2.5-flash is not
//   recognized as a known model …  Available models:
//     Gemini 3.8 Flash (High) / (Medium) / (Low)
//     Claude Sonnet 4.6 (Thinking) / Claude Opus 4.6 (Thinking) / GPT-OSS 120B (Medium)
//
// 而 aih 内部与**额度快照**用的是 id（usageSnapshot.models[].model，例如 claude-opus-4-6-thinking）。
// 两套命名必须在**一处**声明并转换：模型 id 传错 → CLI 拒绝；不传 → agy 用自己的默认模型，
// 而该默认模型未必在账号目录里 → `RESOURCE_EXHAUSTED (429)`（2026-10-15 实测：某账号目录只有
// gemini 家族，默认模型请求直接 429「AI credits balance is too low」）。
//
// 新增/变更模型 = 改这张表（+ 需要时补别名），调用方不动。

// 快照/内部 id → CLI 显示名。别名（同一显示名对应多个 id）也在这里声明。
const CLI_NAME_BY_ID = Object.freeze({
  'gemini-3.8-flash-high': 'Gemini 3.8 Flash (High)',
  'gemini-3.8-flash-medium': 'Gemini 3.8 Flash (Medium)',
  'gemini-3.8-flash-tiered': 'Gemini 3.8 Flash (Medium)',
  'gemini-3.8-flash-low': 'Gemini 3.8 Flash (Low)',
  'claude-sonnet-4-6': 'Claude Sonnet 4.6 (Thinking)',
  'claude-opus-4-6-thinking': 'Claude Opus 4.6 (Thinking)',
  'gpt-oss-120b-medium': 'GPT-OSS 120B (Medium)'
});

const CLI_NAMES = Object.freeze([...new Set(Object.values(CLI_NAME_BY_ID))]);

// 默认模型偏好顺序（越靠前越优先）：agy 的默认应落在**便宜/快**档 —— 高价档（Opus）虽在额度窗口内，
// 但每次请求消耗大、更容易把账号窗口打满（2026-10-15：默认模型不可用/额度耗尽是 429 的主因）。
// 用户显式选模型时不受此表影响。
const DEFAULT_PREFERENCE = Object.freeze([
  'Gemini 3.8 Flash (Low)',
  'Gemini 3.8 Flash (Medium)',
  'Gemini 3.8 Flash (High)',
  'Claude Sonnet 4.6 (Thinking)',
  'Claude Opus 4.6 (Thinking)',
  'GPT-OSS 120B (Medium)'
]);

/** 按偏好顺序重排候选 id（稳定：同档保持原相对顺序）。 */
function orderAgyModelIds(ids) {
  const list = Array.isArray(ids) ? ids : [];
  const rank = (id) => {
    const name = resolveAgyCliModelName(id);
    const index = DEFAULT_PREFERENCE.indexOf(name);
    return index < 0 ? DEFAULT_PREFERENCE.length : index;
  };
  return list
    .map((id, index) => ({ id, index, rank: rank(id) }))
    .sort((left, right) => (left.rank - right.rank) || (left.index - right.index))
    .map((entry) => entry.id);
}

function normalizeModel(value) {
  return String(value || '').trim();
}

/** 内部 id → CLI 显示名；已经是显示名则原样返回；都不是返回 ''。 */
function resolveAgyCliModelName(value) {
  const text = normalizeModel(value);
  if (!text) return '';
  if (CLI_NAME_BY_ID[text]) return CLI_NAME_BY_ID[text];
  return CLI_NAMES.includes(text) ? text : '';
}

/** 该 id 是否能交给 agy CLI（默认模型/模型目录过滤用）。 */
function isAgyCliModelId(value) {
  return Boolean(resolveAgyCliModelName(value));
}

function listAgyCliModelNames() {
  return CLI_NAMES;
}

module.exports = {
  CLI_NAME_BY_ID,
  DEFAULT_PREFERENCE,
  isAgyCliModelId,
  listAgyCliModelNames,
  orderAgyModelIds,
  resolveAgyCliModelName
};

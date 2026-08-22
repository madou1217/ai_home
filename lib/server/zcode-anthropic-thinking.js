'use strict';

// GLM「始终思考」模型（实证 2026-08-22：glm-5.3，glm-5/5.1/5.2/4.x 均免参）在
// bigmodel / z.ai 的 Anthropic 端点上必须显式携带 thinking，否则上游 400
// （code 1210「该模型始终思考，不支持关闭思考」）。zcode 出站 body 在此补齐：
// 客户端已显式携带 thinking 时不干预；模型不在清单内时缓冲区原样返回，
// 与 ensureClaudeCodeSystemBuffer 的「条件改写、失败放行」同一形态。
// 清单可用 AIH_ZCODE_ALWAYS_THINKING_MODELS=glm-5.3,glm-x.y 扩展，避免为新模型改代码。

const DEFAULT_ALWAYS_THINKING_MODELS = Object.freeze(['glm-5.3']);
const DEFAULT_THINKING_BUDGET_TOKENS = 1024;
const MIN_THINKING_BUDGET_TOKENS = 64;

function resolveAlwaysThinkingModels(env = process.env) {
  const raw = String((env && env.AIH_ZCODE_ALWAYS_THINKING_MODELS) || '').trim();
  if (!raw) return DEFAULT_ALWAYS_THINKING_MODELS;
  const listed = raw.split(',').map((item) => item.trim()).filter(Boolean);
  return listed.length > 0 ? listed : DEFAULT_ALWAYS_THINKING_MODELS;
}

// 模型可带路由前缀（如 opencode-go/glm-5.3），判定只看末段裸 ID。
function bareModelId(model) {
  const value = String(model || '').trim();
  const slash = value.lastIndexOf('/');
  return slash >= 0 ? value.slice(slash + 1) : value;
}

function isAlwaysThinkingModel(model, models = DEFAULT_ALWAYS_THINKING_MODELS) {
  const bare = bareModelId(model).toLowerCase();
  if (!bare) return false;
  return models.some((candidate) => bare === String(candidate || '').trim().toLowerCase());
}

// bigmodel 实测 budget 边界宽松（64~4096 均可，budget == max_tokens 也可）；
// 取固定默认值并夹在 max_tokens 内，保证小 max_tokens 请求不被上游拒绝。
function resolveThinkingBudgetTokens(maxTokens, fallback = DEFAULT_THINKING_BUDGET_TOKENS) {
  const cap = Number(maxTokens);
  if (!Number.isFinite(cap) || cap <= 0) return fallback;
  return Math.max(MIN_THINKING_BUDGET_TOKENS, Math.min(fallback, Math.round(cap)));
}

function injectZcodeThinking(body, options = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  if (body.thinking && typeof body.thinking === 'object') return body;
  const model = typeof body.model === 'string' ? body.model : '';
  if (!isAlwaysThinkingModel(model, options.models)) return body;
  const budgetTokens = resolveThinkingBudgetTokens(
    body.max_tokens,
    options.budgetTokens || DEFAULT_THINKING_BUDGET_TOKENS
  );
  return {
    ...body,
    thinking: { type: 'enabled', budget_tokens: budgetTokens }
  };
}

/**
 * 对 zcode 出站请求体缓冲区注入 thinking。仅在模型命中清单且 body 未携带
 * thinking 时解析并重新序列化；其余情况（含非 JSON body）原样返回同一 Buffer。
 */
function ensureZcodeThinkingBuffer(bodyBuffer, options = {}) {
  if (!Buffer.isBuffer(bodyBuffer) || bodyBuffer.length === 0) return bodyBuffer;
  let parsed;
  try {
    parsed = JSON.parse(bodyBuffer.toString('utf8'));
  } catch (_error) {
    return bodyBuffer;
  }
  const injected = injectZcodeThinking(parsed, options);
  if (injected === parsed) return bodyBuffer;
  return Buffer.from(JSON.stringify(injected), 'utf8');
}

module.exports = {
  DEFAULT_ALWAYS_THINKING_MODELS,
  DEFAULT_THINKING_BUDGET_TOKENS,
  ensureZcodeThinkingBuffer,
  injectZcodeThinking,
  isAlwaysThinkingModel,
  resolveAlwaysThinkingModels,
  resolveThinkingBudgetTokens
};

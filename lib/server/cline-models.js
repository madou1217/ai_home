'use strict';

/**
 * Cline Pass 的模型目录。
 *
 * 上游 GET https://api.cline.bot/api/v1/models 返回的是 462 条 OpenRouter 风格的
 * 伙伴命名空间 ID（`anthropic/claude-sonnet-4.5`、`meta/muse-wonder`…），**完全不含
 * `cline-pass/*`**（2026-10-14 实测 HTTP 200 + 全量列举）。若把这份上游目录原样透出，
 * `inferProviderFromModel` 会把这些 ID 判给 claude 等 provider，造成跨 provider 误路由。
 *
 * 因此 cline 的对外目录 = 官方 SDK 随包发布的推荐模型清单（`@cline/llms` 的
 * GENERATED_CLINE_RECOMMENDED_MODELS），已逐条对 `/chat/completions` 实测可用。
 * 与 zcode-models.js 同构：静态规范清单 + 可路由判定。
 *
 * 刻意排除 `cline-free/*`（SDK 里另有 4 条：mimo-v2.6-flash、muse-spark-1.3-contributor、
 * solar-mini4、step-5-preview）：它们在本网关所用的 API 面上一律 HTTP 403
 * 「is only available via Cline product surfaces」，路由过去只会稳定失败。
 */
const KNOWN_CLINE_MODELS = Object.freeze([
  'cline-pass/deepseek-v4-pro',
  'cline-pass/deepseek-v4.1-flash',
  'cline-pass/glm-5.3',
  'cline-pass/glm-5.3-flash',
  'cline-pass/kimi-k3',
  'cline-pass/mimo-v2.5',
  'cline-pass/mimo-v2.5-pro',
  'cline-pass/mimo-v2.6-flash',
  'cline-pass/mimo-v2.6-pro',
  'cline-pass/minimax-m3',
  'cline-pass/muse-spark-1.3-contributor',
  'cline-pass/qwen3.7-max',
  'cline-pass/qwen3.7-plus',
  'cline-pass/qwen3.8-max'
]);

// 只有 cline-pass 命名空间能回到 cline 上游。裸模型名（`glm-5.3`）不认：它会与
// zcode 的 glm-* 抢路由。
const CLINE_MODEL_NAMESPACE = 'cline-pass/';

function isClineRoutableModelId(modelId) {
  if (!modelId) return false;
  return String(modelId).trim().toLowerCase().startsWith(CLINE_MODEL_NAMESPACE);
}

function isKnownClineModel(modelId) {
  if (!modelId) return false;
  const normalized = String(modelId).trim().toLowerCase();
  return KNOWN_CLINE_MODELS.some((model) => model.toLowerCase() === normalized);
}

module.exports = {
  CLINE_MODEL_NAMESPACE,
  KNOWN_CLINE_MODELS,
  isClineRoutableModelId,
  isKnownClineModel
};

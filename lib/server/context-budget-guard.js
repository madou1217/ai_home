'use strict';

// 发送前的上下文窗口预检：请求明显超过目标模型窗口时**立即**给出明确错误，
// 而不是把超限请求发出去、等上游挂到超时（用户侧表现为「卡死」）。
//
// 为什么需要（2026-10-23 实测）：`opencode/deepseek-v4.1-flash-free` 在真实使用中
// 累计 444 次失败，其中 372 次上游返回 `context_length_exceeded`（400），
// 70 次直接挂满 120 秒超时。前者至少给了明确原因，后者让用户干等两分钟才知道失败 ——
// 而这两种情况的成因是同一个：**请求超限**。超限时上游不一定立刻拒绝。
//
// 估算方式：**按字符数除以密度**，不做精确分词。理由：
//   - 仓库没有 tiktoken 类依赖，也不该为此引入（体积/离线约束）；
//   - 预检只需要判断「明显超限」，保守高估比精确更重要：宁可对临界请求放行（交给上游裁决），
//     也不要因为估算偏低而误杀一个合法请求。
// 实测校准（2026-10-23，opencode/deepseek-v4.1-flash-free，中英混合代码文本）：
//   1,113,365 字符 → 225,353 prompt tokens ≈ 4.94 字符/token。
// 取 4 作为保守密度（比实测更低 = 估出更多 token = 更早拦截），并留出安全余量。

// 每 token 的字符数下界（越小估得越保守）。
//
// 实测校准（2026-10-23，opencode/deepseek-v4.1-flash-free，中英混合代码文本）：
//   1,113,365 字符 → 225,353 prompt tokens ≈ 4.94 字符/token。
// 取 4.5（高估约 10%）而不是实测值本身：预检只需要判断「明显超限」，
// 高估留出安全余量，又不会把实测能通过的请求误杀 —— 用 4 会高估 24%，
// 实测能把 225k tokens 的请求误判成超限（已验证过这个误杀）。
const MIN_CHARS_PER_TOKEN = 4.5;
// 消息骨架开销（role/分隔符等）按条计，避免大量短消息被严重低估。
const PER_MESSAGE_OVERHEAD_TOKENS = 8;

function normalizeText(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

/** 递归统计请求 JSON 里的文本字符数（content/parts 等任意嵌套形状）。 */
function countTextChars(value) {
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countTextChars(item), 0);
  if (value && typeof value === 'object') {
    let total = 0;
    for (const item of Object.values(value)) total += countTextChars(item);
    return total;
  }
  return 0;
}

/**
 * 估算请求的输入 token 数（保守高估）。
 *
 * 只统计 messages / input / contents 三个已知载荷字段，不整份 JSON 扫 ——
 * 工具定义、schema 等也会占用上游 token，但它们同时也会被上游计入；
 * 全量扫描会把纯 schema 开销算成内容，导致合法请求被误判超限。
 * 这里取「内容字符 + 消息骨架」，是「明显超限」判定所需的量级。
 */
function estimateInputTokens(requestJson) {
  if (!requestJson || typeof requestJson !== 'object') return 0;
  const messages = Array.isArray(requestJson.messages) ? requestJson.messages : null;
  if (messages) {
    let chars = 0;
    for (const message of messages) chars += countTextChars(message && message.content);
    return Math.ceil(chars / MIN_CHARS_PER_TOKEN) + messages.length * PER_MESSAGE_OVERHEAD_TOKENS;
  }
  // Responses / Gemini 形状：input 或 contents
  const payload = requestJson.input !== undefined ? requestJson.input : requestJson.contents;
  if (payload === undefined) return 0;
  return Math.ceil(countTextChars(payload) / MIN_CHARS_PER_TOKEN);
}

/**
 * 预检结果。
 *
 * `exceeded=false` 表示「没有明显超限」——包括「窗口未知」的情况：
 * 窗口未知时不拦截（宁可让上游裁决，也不要凭一个猜的窗口误杀请求）。
 */
function checkContextBudget(input = {}) {
  const windowTokens = Number(input.windowTokens);
  const estimated = estimateInputTokens(input.requestJson);
  // 预算 = 窗口 × 1.3，两个因子各有实测依据（2026-10-23，deepseek-v4.1-flash-free）：
  //   1. 估算器保守高估约 10%（4.5 字符/token vs 实测 4.94）；
  //   2. 目录声明的窗口往往比上游实际接受的更保守 —— 声明 200k，实测 225k tokens 仍通过。
  // 系数 1.3 是让「实测能通过的放行、实测被拒的拦截」的最小值（二分验证：1.2 会误杀 225k）。
  //
  // 这是**兜底**而不是真相：某账号的真实边界应以 WebUI 里按账号设置的窗口为准
  // （model-context-overrides，优先级高于目录值）。预检的职责只是拦住「明显超限」。
  const budget = Number.isSafeInteger(windowTokens) && windowTokens > 0
    ? Math.floor(windowTokens * 1.3)
    : 0;
  if (!budget || estimated <= budget) {
    return { exceeded: false, estimatedTokens: estimated, budgetTokens: budget, windowTokens: windowTokens || 0 };
  }
  return {
    exceeded: true,
    estimatedTokens: estimated,
    budgetTokens: budget,
    windowTokens,
    source: normalizeText(input.source) || 'unknown'
  };
}

/**
 * 生成给客户端的错误体（OpenAI 兼容形状，与上游 `context_length_exceeded` 对齐）。
 *
 * 措辞明确说明「是网关预检拦下的」，并带上窗口值与其来源 —— 用户要求这个数字
 * 必须有数据支撑，报错里能看出它从哪来，才能判断该不该去 WebUI 改。
 */
function buildContextExceededError(check) {
  const sourceLabel = {
    override: 'manual override',
    probed: 'upstream probe',
    catalog: 'models.dev catalog'
  }[check.source] || 'unknown source';
  return {
    error: {
      message: `Request exceeds the context window of this model: estimated ${check.estimatedTokens} input tokens `
        + `over a limit of ${check.budgetTokens} (window ${check.windowTokens}, from ${sourceLabel}). `
        + 'Reduce the conversation length, run compaction, or raise the window for this account/model in the WebUI.',
      type: 'invalid_request_error',
      code: 'context_length_exceeded'
    }
  };
}

module.exports = {
  MIN_CHARS_PER_TOKEN,
  buildContextExceededError,
  checkContextBudget,
  countTextChars,
  estimateInputTokens
};

'use strict';

// Qoder / Qoder CN 的用量估算（**透明估算，不是精确计数**）。
//
// 事实（qodercli 1.1.73 真机取证，见 docs/providers/qoder-client-protocol.md）：
//   * stream-json 的 assistant / result.usage 里 input_tokens / output_tokens /
//     cache_* 全是 0；CLI 不返回真实 token 数。
//   * 同一份 usage 带 `credits`、`billable`、`request_id` 与 `context_usage_ratio`。
//   * 会话 JSONL 的 runtime-config.contextWindow 为 null，
//     modelUsage.<model>.contextWindow 为 0，模型目录（--list-models）只有名字。
// 因此精确 token 无法从客户端取得；本模块用两条**可复核**的证据换算：
//   1) 输入：context_usage_ratio × 200000（见下方窗口推导）；
//   2) 输出：本轮正文/思考文本的字符估算（CJK 按 1 token，其他字符按 4 字符/token）。
//
// 200000 的推导（不是拍脑袋）：qodercli 二进制里的上下文窗口候选是 128k / 200k /
// maxInputTokens；实测 `context_usage_ratio=0.2014`，而本轮仅 AGENTS.md（85,548 字符，
// 16,081 个 CJK）按本模块公式就约 33.4k tokens。若窗口是 128k，整轮上下文只有 25.9k，
// 小于 AGENTS.md 单独的体积——矛盾；200k 时整轮约 40.3k，余下 ~7k 给系统提示/技能清单，
// 与 init 事件里加载的技能数量吻合。因此对 Qoder 模型使用 200k 作为换算窗口。
// 所有写入 model_usage_records 的估算记录都以 `_estimated` 后缀的 sourceKind 标记，
// 界面/统计可以把它们当估算值看待，绝不伪装成上游精确 usage。

const QODER_CONTEXT_WINDOW_TOKENS = 200000;
const QODER_ESTIMATED_SOURCE_SUFFIX = '_estimated';

function normalizeText(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function readFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function isCjkCodePoint(codePoint) {
  return (
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) // CJK Extension A
    || (codePoint >= 0x4e00 && codePoint <= 0x9fff) // CJK Unified
    || (codePoint >= 0xf900 && codePoint <= 0xfaff) // CJK Compatibility
    || (codePoint >= 0x3000 && codePoint <= 0x303f) // CJK 标点（。、「」等按 1 token）
    || (codePoint >= 0x3040 && codePoint <= 0x30ff) // Hiragana / Katakana
    || (codePoint >= 0xac00 && codePoint <= 0xd7af) // Hangul
    || (codePoint >= 0xff00 && codePoint <= 0xffef) // 全角字符
    || (codePoint >= 0x20000 && codePoint <= 0x2fa1f) // CJK Extension B-F
  );
}

/**
 * 文本 token 估算：CJK 每字 1 token，其余（拉丁字母、数字、空白、标点）按 4 字符
 * 1 token。只用于 Qoder 这类不返回 token 的通道，结果会带 estimated 标记。
 */
function estimateTextTokens(text) {
  const value = String(text === undefined || text === null ? '' : text);
  if (!value) return 0;
  let cjk = 0;
  let other = 0;
  for (const char of value) {
    const codePoint = char.codePointAt(0) || 0;
    if (isCjkCodePoint(codePoint)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

function readQoderUsageDetails(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const contextUsageRatio = readFiniteNumber(usage.context_usage_ratio ?? usage.contextUsageRatio);
  const credits = readFiniteNumber(usage.credits);
  const originalCredits = readFiniteNumber(usage.original_credits ?? usage.originalCredits);
  const requestId = normalizeText(usage.request_id ?? usage.requestId);
  const hasBillable = Object.prototype.hasOwnProperty.call(usage, 'billable');
  const billable = hasBillable ? usage.billable === true : null;
  const details = {
    contextUsageRatio: contextUsageRatio !== null && contextUsageRatio >= 0 ? contextUsageRatio : 0,
    credits: credits !== null ? credits : 0,
    originalCredits: originalCredits !== null ? originalCredits : 0,
    requestId,
    billable
  };
  if (!details.contextUsageRatio && !details.credits && !details.originalCredits && !details.requestId && details.billable === null) {
    return null;
  }
  return details;
}

function mergeQoderUsageDetails(...values) {
  const merged = {
    contextUsageRatio: 0,
    credits: 0,
    originalCredits: 0,
    requestId: '',
    billable: null
  };
  let seen = false;
  for (const value of values) {
    if (!value || typeof value !== 'object') continue;
    seen = true;
    if (Number(value.contextUsageRatio) > merged.contextUsageRatio) {
      merged.contextUsageRatio = Number(value.contextUsageRatio);
    }
    if (Number(value.credits) > merged.credits) merged.credits = Number(value.credits);
    if (Number(value.originalCredits) > merged.originalCredits) {
      merged.originalCredits = Number(value.originalCredits);
    }
    if (!merged.requestId && value.requestId) merged.requestId = normalizeText(value.requestId);
    if (merged.billable === null && value.billable !== null && value.billable !== undefined) {
      merged.billable = value.billable === true;
    }
  }
  return seen ? merged : null;
}

/**
 * 读取 CLI 真给的 token 计数（未来版本若修好这个字段就优先使用，绝不拿估算覆盖真值）。
 * 全零/缺失返回 null（1.1.73 的常态）。
 */
function readQoderTokenCounters(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const inputTokens = Math.max(0, Math.floor(readFiniteNumber(
    usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens
  ) || 0));
  const outputTokens = Math.max(0, Math.floor(readFiniteNumber(
    usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens
  ) || 0));
  // HTTP 直连通道给的是 OpenAI 形状：cached/reasoning 在 *_details 里；
  // 旧 CLI 形状是顶层 cache_read_input_tokens / reasoning_output_tokens。
  const promptDetails = (usage.prompt_tokens_details && typeof usage.prompt_tokens_details === 'object')
    ? usage.prompt_tokens_details
    : ((usage.input_tokens_details && typeof usage.input_tokens_details === 'object') ? usage.input_tokens_details : {});
  const completionDetails = (usage.completion_tokens_details && typeof usage.completion_tokens_details === 'object')
    ? usage.completion_tokens_details
    : ((usage.output_tokens_details && typeof usage.output_tokens_details === 'object') ? usage.output_tokens_details : {});
  const cacheReadInputTokens = Math.max(0, Math.floor(readFiniteNumber(
    usage.cache_read_input_tokens
    ?? usage.cacheReadInputTokens
    ?? usage.cacheReadTokens
    ?? promptDetails.cached_tokens
    ?? promptDetails.cached_input_tokens
  ) || 0));
  const cacheCreationInputTokens = Math.max(0, Math.floor(readFiniteNumber(
    usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens ?? usage.cacheWriteTokens
  ) || 0));
  const reasoningOutputTokens = Math.max(0, Math.floor(readFiniteNumber(
    usage.reasoning_output_tokens
    ?? usage.reasoningOutputTokens
    ?? completionDetails.reasoning_tokens
  ) || 0));
  if (!inputTokens && !outputTokens && !cacheReadInputTokens && !cacheCreationInputTokens && !reasoningOutputTokens) {
    return null;
  }
  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    reasoningOutputTokens
  };
}

function extractAssistantText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'thinking' && typeof block.thinking === 'string') parts.push(block.thinking);
  }
  return parts.join('');
}

/**
 * 用 Qoder 的 context_usage_ratio + 输出文本估算一轮用量。
 * @param {object} input
 * @param {object} [input.usage] 原始 stream usage（assistant / message_delta / result）
 * @param {object} [input.details] readQoderUsageDetails 的结果（可覆盖 usage）
 * @param {string} [input.promptText] 请求正文（没有 ratio 时的输入兜底）
 * @param {string} [input.outputText] 本轮输出（正文 + 思考）
 * @param {number} [input.contextWindowTokens] 覆盖默认 200k 窗口（测试用）
 * @returns {{inputTokens:number,outputTokens:number,totalTokens:number,contextUsageRatio:number,credits:number,originalCredits:number,billable:boolean|null,requestId:string,estimated:true}|null}
 */
function estimateQoderUsage(input = {}) {
  const details = mergeQoderUsageDetails(
    input.details,
    readQoderUsageDetails(input.usage)
  );
  const contextWindowTokens = readFiniteNumber(input.contextWindowTokens) > 0
    ? readFiniteNumber(input.contextWindowTokens)
    : QODER_CONTEXT_WINDOW_TOKENS;
  const outputTokens = estimateTextTokens(input.outputText);
  const ratio = details ? Number(details.contextUsageRatio) || 0 : 0;
  const inputTokens = ratio > 0
    ? Math.max(1, Math.round(ratio * contextWindowTokens))
    : estimateTextTokens(input.promptText);
  if (!inputTokens && !outputTokens && !(details && (details.credits || details.requestId || details.billable !== null))) {
    return null;
  }
  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: inputTokens + outputTokens,
    contextUsageRatio: ratio,
    credits: details ? details.credits : 0,
    originalCredits: details ? details.originalCredits : 0,
    billable: details ? details.billable : null,
    requestId: details ? details.requestId : '',
    estimated: true
  };
}

/**
 * 统一入口：有真实 token 计数就用真值；否则才用 ratio + 文本估算。
 * 返回值始终带 `estimated`，调用方据此决定 sourceKind。
 */
function resolveQoderUsage(input = {}) {
  const details = mergeQoderUsageDetails(
    input.details,
    readQoderUsageDetails(input.usage)
  );
  const counters = readQoderTokenCounters(input.usage);
  if (counters) {
    return {
      ...counters,
      totalTokens: counters.inputTokens + counters.outputTokens,
      contextUsageRatio: details ? details.contextUsageRatio : 0,
      credits: details ? details.credits : 0,
      originalCredits: details ? details.originalCredits : 0,
      billable: details ? details.billable : null,
      requestId: details ? details.requestId : '',
      estimated: false
    };
  }
  return estimateQoderUsage({ ...input, details });
}

/** OpenAI chat usage 形状（prompt_tokens/completion_tokens/total_tokens）。 */
function toOpenAiUsage(estimated) {
  if (!estimated || (!estimated.inputTokens && !estimated.outputTokens)) return undefined;
  return {
    prompt_tokens: estimated.inputTokens,
    completion_tokens: estimated.outputTokens,
    total_tokens: estimated.totalTokens
  };
}

/** 把估算结果并入模型用量记录时使用的 sourceKind（明确标出是估算）。 */
function qoderEstimatedSourceKind(baseSourceKind) {
  const base = normalizeText(baseSourceKind) || 'server_qoder_cli_proxy';
  return base.endsWith(QODER_ESTIMATED_SOURCE_SUFFIX) ? base : `${base}${QODER_ESTIMATED_SOURCE_SUFFIX}`;
}

module.exports = {
  QODER_CONTEXT_WINDOW_TOKENS,
  QODER_ESTIMATED_SOURCE_SUFFIX,
  estimateTextTokens,
  estimateQoderUsage,
  extractAssistantText,
  mergeQoderUsageDetails,
  normalizeText,
  qoderEstimatedSourceKind,
  readQoderTokenCounters,
  readQoderUsageDetails,
  resolveQoderUsage,
  toOpenAiUsage
};

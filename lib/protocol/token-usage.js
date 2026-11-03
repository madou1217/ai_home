'use strict';

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

// Anthropic 的 input_tokens 不含命中/写入 prompt 缓存的部分;转成 OpenAI/canonical 的
// 「输入总量」语义时三者相加,否则长会话的上下文占用被严重低估(下游据此判断何时压缩)。
const ANTHROPIC_INPUT_FIELDS = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];

function hasValue(value) {
  return value !== undefined && value !== null;
}

function anthropicTotalInputTokens(usage) {
  if (!usage || !ANTHROPIC_INPUT_FIELDS.some((field) => hasValue(usage[field]))) return null;
  return ANTHROPIC_INPUT_FIELDS.reduce((sum, field) => sum + finiteNumber(usage[field]), 0);
}

// 流式 usage 合并。有的上游(如 MTPLX)在 message_start 报 0、到 message_delta 才给真实输入量;
// 官方 API 的 message_delta 则常常只带 output_tokens。任一事件给出正数就以它为准,否则沿用之前的值。
function mergeAnthropicStreamUsage(previous, usage) {
  const prior = previous || { input_tokens: 0, output_tokens: 0 };
  const input = anthropicTotalInputTokens(usage);
  const output = usage && hasValue(usage.output_tokens) ? finiteNumber(usage.output_tokens) : null;
  return {
    input_tokens: input > 0 ? input : finiteNumber(prior.input_tokens),
    output_tokens: output > 0 ? output : finiteNumber(prior.output_tokens)
  };
}

function mapOpenAIChatUsageToAnthropic(usage) {
  return {
    input_tokens: finiteNumber(usage && usage.prompt_tokens),
    output_tokens: finiteNumber(usage && usage.completion_tokens)
  };
}

function mapAnthropicUsageToOpenAIChat(usage) {
  const inputTokens = finiteNumber(anthropicTotalInputTokens(usage));
  const outputTokens = finiteNumber(usage && usage.output_tokens);
  return {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens
  };
}

function mapOpenAIResponseUsageToAnthropic(usage) {
  return {
    input_tokens: finiteNumber(usage && (usage.input_tokens || usage.prompt_tokens)),
    output_tokens: finiteNumber(usage && (usage.output_tokens || usage.completion_tokens))
  };
}

function mapOpenAIResponseUsageToGemini(usage) {
  const inputTokens = finiteNumber(usage && (usage.input_tokens || usage.prompt_tokens));
  const outputTokens = finiteNumber(usage && (usage.output_tokens || usage.completion_tokens));
  const totalTokens = finiteNumber(usage && usage.total_tokens) || inputTokens + outputTokens;
  return {
    promptTokenCount: inputTokens,
    candidatesTokenCount: outputTokens,
    totalTokenCount: totalTokens
  };
}

function mapGeminiResponseUsageToOpenAIChat(usage) {
  const inputTokens = finiteNumber(usage && (usage.promptTokenCount || usage.prompt_token_count));
  const outputTokens = finiteNumber(usage && (usage.candidatesTokenCount || usage.candidates_token_count));
  const totalTokens = finiteNumber(usage && (usage.totalTokenCount || usage.total_token_count)) || inputTokens + outputTokens;
  return {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: totalTokens
  };
}

function mapGeminiResponseUsageToOpenAIResponse(usage) {
  const openAIUsage = mapGeminiResponseUsageToOpenAIChat(usage);
  return {
    input_tokens: openAIUsage.prompt_tokens,
    output_tokens: openAIUsage.completion_tokens,
    total_tokens: openAIUsage.total_tokens
  };
}

function mapGeminiResponseUsageToAnthropic(usage) {
  const openAIUsage = mapGeminiResponseUsageToOpenAIChat(usage);
  return {
    input_tokens: openAIUsage.prompt_tokens,
    output_tokens: openAIUsage.completion_tokens
  };
}

function normalizeCanonicalUsage(usage) {
  if (!usage || typeof usage !== 'object') {
    return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  }
  const inputTokens = Number(usage.input_tokens || usage.prompt_tokens || 0);
  const outputTokens = Number(usage.output_tokens || usage.completion_tokens || 0);
  const totalTokens = Number(usage.total_tokens || inputTokens + outputTokens);
  return {
    input_tokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    output_tokens: Number.isFinite(outputTokens) ? outputTokens : 0,
    total_tokens: Number.isFinite(totalTokens) ? totalTokens : 0
  };
}

module.exports = {
  anthropicTotalInputTokens,
  mergeAnthropicStreamUsage,
  normalizeCanonicalUsage,
  mapAnthropicUsageToOpenAIChat,
  mapGeminiResponseUsageToAnthropic,
  mapGeminiResponseUsageToOpenAIChat,
  mapGeminiResponseUsageToOpenAIResponse,
  mapOpenAIChatUsageToAnthropic,
  mapOpenAIResponseUsageToAnthropic,
  mapOpenAIResponseUsageToGemini
};

'use strict';

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function mapOpenAIChatUsageToAnthropic(usage) {
  return {
    input_tokens: finiteNumber(usage && usage.prompt_tokens),
    output_tokens: finiteNumber(usage && usage.completion_tokens)
  };
}

function mapAnthropicUsageToOpenAIChat(usage) {
  const inputTokens = finiteNumber(usage && usage.input_tokens);
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
  normalizeCanonicalUsage,
  mapAnthropicUsageToOpenAIChat,
  mapGeminiResponseUsageToAnthropic,
  mapGeminiResponseUsageToOpenAIChat,
  mapGeminiResponseUsageToOpenAIResponse,
  mapOpenAIChatUsageToAnthropic,
  mapOpenAIResponseUsageToAnthropic,
  mapOpenAIResponseUsageToGemini
};

'use strict';

const crypto = require('node:crypto');
const { isAccountRef } = require('../account/public-account-ref');

const NON_CANONICAL_ACCOUNT_FIELDS = Object.freeze(['accountId', 'account_id', 'account_ref']);

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}

function firstObject(...values) {
  return values.find((value) => value && typeof value === 'object') || null;
}

function stableHash(value) {
  return crypto.createHash('sha1').update(JSON.stringify(value || {})).digest('hex').slice(0, 16);
}

function normalizeOpenAiUsage(usage = {}) {
  const details = firstObject(usage.prompt_tokens_details, usage.input_tokens_details) || {};
  const cached = toNumber(details.cached_tokens || details.cached_input_tokens);
  const input = toNumber(usage.prompt_tokens ?? usage.input_tokens);
  const output = toNumber(usage.completion_tokens ?? usage.output_tokens);
  const total = toNumber(usage.total_tokens) || input + output;
  return {
    inputTokens: Math.max(0, input - cached),
    outputTokens: output,
    cacheReadInputTokens: cached,
    totalTokens: total
  };
}

function normalizeAnthropicUsage(usage = {}) {
  const input = toNumber(usage.input_tokens);
  const output = toNumber(usage.output_tokens);
  const cacheCreate = toNumber(usage.cache_creation_input_tokens);
  const cacheRead = toNumber(usage.cache_read_input_tokens);
  return {
    inputTokens: input,
    outputTokens: output,
    cacheCreationInputTokens: cacheCreate,
    cacheReadInputTokens: cacheRead,
    totalTokens: input + output + cacheCreate + cacheRead
  };
}

function normalizeGeminiUsage(usage = {}) {
  const cached = toNumber(usage.cachedContentTokenCount || usage.cached_content_token_count);
  const prompt = toNumber(usage.promptTokenCount || usage.prompt_token_count);
  const output = toNumber(usage.candidatesTokenCount || usage.candidates_token_count);
  const thoughts = toNumber(usage.thoughtsTokenCount || usage.thoughts_token_count);
  const total = toNumber(usage.totalTokenCount || usage.total_token_count) || prompt + output + thoughts;
  return {
    inputTokens: Math.max(0, prompt - cached),
    outputTokens: output,
    cacheReadInputTokens: cached,
    reasoningOutputTokens: thoughts,
    totalTokens: total
  };
}

function hasAnyKey(object, keys) {
  if (!object || typeof object !== 'object') return false;
  return keys.some((key) => Object.prototype.hasOwnProperty.call(object, key));
}

function normalizeUsageFormat(value) {
  const format = String(value || '').trim().toLowerCase();
  if (format === 'openai' || format === 'openai_chat' || format === 'openai_responses') return 'openai';
  if (format === 'anthropic' || format === 'claude') return 'anthropic';
  if (format === 'gemini' || format === 'google') return 'gemini';
  return '';
}

function inferUsageFormat(provider, usage = {}) {
  if (hasAnyKey(usage, [
    'promptTokenCount',
    'prompt_token_count',
    'candidatesTokenCount',
    'candidates_token_count',
    'cachedContentTokenCount',
    'cached_content_token_count',
    'thoughtsTokenCount',
    'thoughts_token_count'
  ])) {
    return 'gemini';
  }
  if (hasAnyKey(usage, ['prompt_tokens', 'completion_tokens', 'prompt_tokens_details'])) {
    return 'openai';
  }
  if (hasAnyKey(usage, [
    'cache_creation_input_tokens',
    'cache_read_input_tokens'
  ])) {
    return 'anthropic';
  }
  if (hasAnyKey(usage, ['input_tokens', 'output_tokens', 'input_tokens_details'])) {
    return String(provider || '').trim().toLowerCase() === 'claude' ? 'anthropic' : 'openai';
  }
  return '';
}

function normalizeApiUsageByProvider(provider, usage = {}) {
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  if (!usage || typeof usage !== 'object') return null;
  const inferredFormat = inferUsageFormat(normalizedProvider, usage);
  if (inferredFormat === 'anthropic') return normalizeAnthropicUsage(usage);
  if (inferredFormat === 'gemini') return normalizeGeminiUsage(usage);
  if (inferredFormat === 'openai') return normalizeOpenAiUsage(usage);
  if (normalizedProvider === 'claude') return normalizeAnthropicUsage(usage);
  if (normalizedProvider === 'gemini' || normalizedProvider === 'agy') return normalizeGeminiUsage(usage);
  return normalizeOpenAiUsage(usage);
}

function normalizeApiUsageByFormat(format, provider, usage = {}) {
  const normalizedFormat = normalizeUsageFormat(format);
  if (normalizedFormat === 'anthropic') return normalizeAnthropicUsage(usage);
  if (normalizedFormat === 'gemini') return normalizeGeminiUsage(usage);
  if (normalizedFormat === 'openai') return normalizeOpenAiUsage(usage);
  return normalizeApiUsageByProvider(provider, usage);
}

function buildApiUsageRecord(input = {}) {
  const provider = String(input.provider || '').trim().toLowerCase();
  const model = String(input.model || '').trim();
  const usage = input.usage && typeof input.usage === 'object' ? input.usage : null;
  const normalized = normalizeApiUsageByFormat(input.usageFormat, provider, usage);
  if (!provider || !normalized) return null;
  if (
    !normalized.inputTokens
    && !normalized.outputTokens
    && !normalized.cacheReadInputTokens
    && !normalized.cacheCreationInputTokens
    && !normalized.reasoningOutputTokens
    && !normalized.totalTokens
  ) {
    return null;
  }
  const timestampMs = Number(input.timestampMs) || Date.now();
  const requestId = String(input.requestId || '').trim();
  if (NON_CANONICAL_ACCOUNT_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(input, field))) {
    throw new Error('model_usage_account_key_invalid');
  }
  const accountRef = String(input.accountRef || '').trim();
  if (accountRef && !isAccountRef(accountRef)) {
    throw new Error('model_usage_account_ref_invalid');
  }
  const eventKey = String(input.eventKey || '').trim()
    || `api:${provider}:${requestId || 'no-request'}:${accountRef || 'no-account'}:${timestampMs}:${stableHash({ model, usage })}`;
  return {
    ...normalized,
    eventKey,
    provider,
    accountRef,
    requestId,
    sessionId: String(input.sessionId || '').trim(),
    model,
    sourceKind: String(input.sourceKind || 'server_api').trim(),
    timestampMs,
    project: String(input.project || '').trim(),
    cwd: String(input.cwd || '').trim()
  };
}

module.exports = {
  buildApiUsageRecord,
  normalizeApiUsageByFormat,
  normalizeApiUsageByProvider,
  __private: {
    inferUsageFormat,
    normalizeAnthropicUsage,
    normalizeGeminiUsage,
    normalizeOpenAiUsage,
    normalizeUsageFormat
  }
};

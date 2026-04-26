'use strict';

function normalizeHeaderBag(headers) {
  if (!headers) return {};
  if (headers instanceof Map) {
    return Object.fromEntries(Array.from(headers.entries()).map(([key, value]) => [String(key).toLowerCase(), String(value)]));
  }
  if (typeof headers.get === 'function') {
    const entries = {};
    ['retry-after', 'anthropic-ratelimit-unified-reset', 'x-ratelimit-reset-requests', 'x-codex-ratelimit-reset'].forEach((key) => {
      const value = headers.get(key);
      if (value != null && value !== '') entries[key] = String(value);
    });
    return entries;
  }
  return Object.entries(headers).reduce((acc, [key, value]) => {
    const normalizedKey = String(key || '').toLowerCase();
    if (!normalizedKey) return acc;
    if (Array.isArray(value)) {
      acc[normalizedKey] = value.map((item) => String(item || '').trim()).filter(Boolean).join(', ');
      return acc;
    }
    acc[normalizedKey] = String(value == null ? '' : value);
    return acc;
  }, {});
}

function parseRetryAfterHeaderMs(value, nowMs) {
  const text = String(value || '').trim();
  if (!text) return 0;
  const seconds = Number.parseInt(text, 10);
  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds * 1000;
  }
  const dateMs = Date.parse(text);
  if (Number.isFinite(dateMs) && dateMs > nowMs) {
    return dateMs - nowMs;
  }
  return 0;
}

function parseJsonSafe(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_error) {
    return null;
  }
}

function readNestedValue(input, pathParts) {
  let cursor = input;
  for (let i = 0; i < pathParts.length; i += 1) {
    if (!cursor || typeof cursor !== 'object') return '';
    cursor = cursor[pathParts[i]];
  }
  return String(cursor || '').trim();
}

function parseGeminiRetryDelayMs(body) {
  const payload = typeof body === 'object' && body ? body : parseJsonSafe(body);
  if (!payload || typeof payload !== 'object') return 0;

  const details = Array.isArray(payload.error && payload.error.details) ? payload.error.details : [];
  for (const detail of details) {
    if (!detail || typeof detail !== 'object') continue;
    if (String(detail['@type'] || '').trim() === 'type.googleapis.com/google.rpc.RetryInfo') {
      const retryDelay = String(detail.retryDelay || '').trim();
      const parsed = Number.isFinite(Date.parse(retryDelay)) ? 0 : retryDelay;
      if (parsed) {
        const match = retryDelay.match(/^(\d+(?:\.\d+)?)s$/i);
        if (match) return Math.ceil(Number(match[1]) * 1000);
      }
    }
    if (String(detail['@type'] || '').trim() === 'type.googleapis.com/google.rpc.ErrorInfo') {
      const quotaResetDelay = readNestedValue(detail, ['metadata', 'quotaResetDelay']);
      if (quotaResetDelay) {
        const match = quotaResetDelay.match(/^(\d+(?:\.\d+)?)(ms|s)$/i);
        if (match) {
          const amount = Number(match[1]);
          if (!Number.isFinite(amount) || amount <= 0) continue;
          return match[2].toLowerCase() === 'ms' ? Math.ceil(amount) : Math.ceil(amount * 1000);
        }
      }
    }
  }

  const message = readNestedValue(payload, ['error', 'message']);
  const match = message.match(/after\s+(\d+)s\b/i);
  if (match) return Number(match[1]) * 1000;
  return 0;
}

function parseProviderRetryHintMs(options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const provider = String(options.provider || '').trim().toLowerCase();
  const headers = normalizeHeaderBag(options.headers);
  const body = options.body;

  const retryAfterMs = parseRetryAfterHeaderMs(headers['retry-after'], nowMs);
  if (retryAfterMs > 0) return retryAfterMs;

  const anthropicResetMs = parseRetryAfterHeaderMs(headers['anthropic-ratelimit-unified-reset'], nowMs);
  if (anthropicResetMs > 0) return anthropicResetMs;

  const openAiResetMs = parseRetryAfterHeaderMs(
    headers['x-ratelimit-reset-requests'] || headers['x-codex-ratelimit-reset'],
    nowMs
  );
  if (openAiResetMs > 0) return openAiResetMs;

  if (provider === 'gemini') {
    return parseGeminiRetryDelayMs(body);
  }

  return 0;
}

module.exports = {
  parseProviderRetryHintMs
};

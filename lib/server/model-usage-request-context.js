'use strict';

const REQUEST_CONTEXT_KIND = 'model_usage_request_context';

function normalizeText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function objectValue(value) {
  return value && typeof value === 'object' ? value : {};
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function normalizeThinkingBudget(value) {
  return Number.isSafeInteger(value) ? `budget:${value}` : '';
}

function resolveReasoningEffort(requestJson = {}) {
  const reasoning = objectValue(requestJson.reasoning);
  const thinking = objectValue(requestJson.thinking);
  const explicitEffort = normalizeText(
    requestJson.reasoning_effort
    || requestJson.reasoningEffort
    || reasoning.effort
    || thinking.effort,
    32
  );
  if (explicitEffort) return explicitEffort.toLowerCase();

  if (hasOwn(thinking, 'budget_tokens')) {
    const budget = normalizeThinkingBudget(thinking.budget_tokens);
    if (budget) return budget;
  }
  const thinkingType = normalizeText(thinking.type, 32).toLowerCase();
  if (thinkingType) return thinkingType;

  const generationConfig = objectValue(requestJson.generationConfig || requestJson.generation_config);
  const thinkingConfig = objectValue(
    generationConfig.thinkingConfig || generationConfig.thinking_config
  );
  const thinkingLevel = normalizeText(
    thinkingConfig.thinkingLevel || thinkingConfig.thinking_level,
    32
  ).toLowerCase();
  if (thinkingLevel) return thinkingLevel;
  for (const key of ['thinkingBudget', 'thinking_budget']) {
    if (!hasOwn(thinkingConfig, key)) continue;
    const budget = normalizeThinkingBudget(thinkingConfig[key]);
    if (budget) return budget;
  }
  if (thinkingConfig.includeThoughts === false || thinkingConfig.include_thoughts === false) {
    return 'disabled';
  }
  return '';
}

function isReasoningApplicable(method, pathname) {
  const normalizedMethod = normalizeText(method, 16).toUpperCase();
  const endpoint = normalizeText(pathname, 512);
  return normalizedMethod !== 'GET'
    && normalizedMethod !== 'HEAD'
    && !endpoint.endsWith('/count_tokens');
}

function resolveReasoningSemantics(requestJson, input = {}) {
  const explicit = resolveReasoningEffort(requestJson);
  if (explicit) return explicit;
  return isReasoningApplicable(input.method, input.pathname)
    ? 'provider_default'
    : 'not_applicable';
}

function resolveRequestType(requestJson = {}, clientProtocol = '') {
  if (requestJson.stream === true || normalizeText(clientProtocol, 64).includes('stream')) {
    return 'stream';
  }
  return 'sync';
}

function recordModelUsageRequestContext(appendLog, input = {}) {
  if (typeof appendLog !== 'function') return false;
  const requestMeta = input.requestMeta && typeof input.requestMeta === 'object'
    ? input.requestMeta
    : {};
  const requestJson = input.requestJson && typeof input.requestJson === 'object'
    ? input.requestJson
    : {};
  const requestId = normalizeText(requestMeta.requestId, 160);
  if (!requestId) return false;
  appendLog({
    at: new Date().toISOString(),
    kind: REQUEST_CONTEXT_KIND,
    requestId,
    provider: normalizeText(input.provider, 32).toLowerCase(),
    model: normalizeText(
      requestJson.model
      || input.model
      || (normalizeText(input.pathname, 512) === '/v1/models' ? 'model-catalog' : ''),
      256
    ),
    reasoningEffort: resolveReasoningSemantics(requestJson, input),
    endpoint: normalizeText(input.pathname, 512),
    clientIp: normalizeText(requestMeta.clientIp, 128),
    requestType: resolveRequestType(requestJson, input.clientProtocol)
  });
  return true;
}

function recordAccountPinDiagnostic(appendLog, input = {}) {
  if (typeof appendLog !== 'function') return false;
  const requestMeta = objectValue(input.requestMeta);
  const requestId = normalizeText(requestMeta.requestId, 160);
  if (!requestId) return false;
  const endpoint = normalizeText(input.pathname, 512);
  const healed = input.healed === true;
  const method = normalizeText(input.method, 16).toUpperCase();
  const entry = {
    at: new Date().toISOString(),
    kind: healed ? 'stale_account_pin_healed' : 'account_pin_rejected',
    requestId,
    provider: endpoint === '/v1/models' ? 'gateway' : '',
    model: endpoint === '/v1/models' ? 'model-catalog' : '',
    reasoningEffort: endpoint === '/v1/models' ? 'not_applicable' : '',
    endpoint,
    clientIp: normalizeText(requestMeta.clientIp, 128),
    requestType: method === 'GET' || method === 'HEAD' ? 'sync' : ''
  };
  if (!healed) {
    entry.status = Math.max(400, Math.round(Number(input.status) || 400));
    entry.error = normalizeText(input.error, 96) || 'account_pin_rejected';
  }
  appendLog(entry);
  return true;
}

module.exports = {
  REQUEST_CONTEXT_KIND,
  recordAccountPinDiagnostic,
  recordModelUsageRequestContext,
  __private: {
    isReasoningApplicable,
    resolveReasoningEffort,
    resolveReasoningSemantics,
    resolveRequestType
  }
};

'use strict';

const REQUEST_CONTEXT_KIND = 'model_usage_request_context';

function normalizeText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function resolveReasoningEffort(requestJson = {}) {
  const reasoning = requestJson.reasoning && typeof requestJson.reasoning === 'object'
    ? requestJson.reasoning
    : {};
  const thinking = requestJson.thinking && typeof requestJson.thinking === 'object'
    ? requestJson.thinking
    : {};
  return normalizeText(
    requestJson.reasoning_effort
    || requestJson.reasoningEffort
    || reasoning.effort
    || thinking.effort,
    32
  );
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
    model: normalizeText(requestJson.model || input.model, 256),
    reasoningEffort: resolveReasoningEffort(requestJson),
    endpoint: normalizeText(input.pathname, 512),
    clientIp: normalizeText(requestMeta.clientIp, 128),
    requestType: resolveRequestType(requestJson, input.clientProtocol)
  });
  return true;
}

module.exports = {
  REQUEST_CONTEXT_KIND,
  recordModelUsageRequestContext,
  __private: {
    resolveReasoningEffort,
    resolveRequestType
  }
};

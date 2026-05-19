'use strict';

const SENSITIVE_HEADER_RE = /authorization|cookie|set-cookie|api-key|token|secret|credential|key/i;

function toPlainText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
}

function stringifyDiagnosticValue(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch (_error) {
    return String(value);
  }
}

function sanitizeHeaderValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => toPlainText(item)).join(', ');
  }
  return toPlainText(value);
}

function safeHeaderEntries(headers) {
  if (!headers || typeof headers !== 'object') return {};
  const out = {};
  const add = (key, value) => {
    const name = toPlainText(key).trim().toLowerCase();
    if (!name || SENSITIVE_HEADER_RE.test(name)) return;
    out[name] = sanitizeHeaderValue(value);
  };
  if (typeof headers.forEach === 'function') {
    headers.forEach((value, key) => add(key, value));
    return out;
  }
  Object.entries(headers).forEach(([key, value]) => add(key, value));
  return out;
}

function extractUpstreamRequestId(detail, headers) {
  const text = stringifyDiagnosticValue(detail);
  const textMatch = text.match(/\brequest\s+ID\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i);
  if (textMatch) return textMatch[1];
  const safeHeaders = safeHeaderEntries(headers);
  const headerNames = [
    'x-request-id',
    'request-id',
    'openai-request-id',
    'cf-ray'
  ];
  for (const name of headerNames) {
    const value = toPlainText(safeHeaders[name]).trim();
    if (value) return value;
  }
  return '';
}

function buildAccountRetryFailureLogEntry(input = {}) {
  const policy = input.policy || {};
  const account = input.account || {};
  const upstreamBody = stringifyDiagnosticValue(input.upstreamBody);
  const upstreamError = stringifyDiagnosticValue(input.upstreamError);
  const detail = stringifyDiagnosticValue(policy.detail || policy.failureReason || upstreamError || upstreamBody);
  const requestId = input.requestId || (input.requestMeta && input.requestMeta.requestId);
  const route = input.route || input.routeKey;
  const durationMs = input.durationMs != null
    ? Number(input.durationMs || 0)
    : Date.now() - Number(input.requestStartedAt || Date.now());
  const upstreamHeaders = safeHeaderEntries(input.upstreamHeaders);
  return {
    at: new Date().toISOString(),
    kind: 'account_retry_failure',
    requestId: requestId || undefined,
    upstreamRequestId: extractUpstreamRequestId(detail || upstreamBody || upstreamError, upstreamHeaders) || undefined,
    route: route || undefined,
    provider: input.provider || (input.requestMeta && input.requestMeta.provider) || undefined,
    accountId: account.id || undefined,
    accountEmail: account.email || undefined,
    accountAuthType: account.authType || (account.apiKeyMode ? 'api-key' : undefined),
    accountPlanType: account.planType || undefined,
    attempt: Number.isFinite(Number(input.attempt)) ? Number(input.attempt) : undefined,
    maxAttempts: Number.isFinite(Number(input.maxAttempts)) ? Number(input.maxAttempts) : undefined,
    status: input.status || policy.clientStatusCode || 502,
    error: policy.failureReason || policy.kind || 'upstream_failed',
    policyKind: policy.kind || undefined,
    retryable: policy.retryable !== false,
    cooldownMs: Number(policy.cooldownMs || 0),
    failureThreshold: Number(policy.failureThreshold || 0),
    requestedModel: input.requestedModel || undefined,
    effectiveModel: input.effectiveModel || undefined,
    streamRequested: input.streamRequested,
    streamTransport: input.streamTransport || undefined,
    upstreamUrl: input.upstreamUrl || undefined,
    upstreamStatus: input.upstreamStatus || input.status || undefined,
    upstreamHeaders,
    upstreamBody,
    upstreamError,
    durationMs
  };
}

function appendAccountRetryFailureLog(input = {}) {
  const { options, appendProxyRequestLog } = input;
  if (!options || !options.logRequests || typeof appendProxyRequestLog !== 'function') return;
  appendProxyRequestLog(buildAccountRetryFailureLogEntry(input));
}

module.exports = {
  appendAccountRetryFailureLog,
  buildAccountRetryFailureLogEntry,
  extractUpstreamRequestId,
  safeHeaderEntries,
  stringifyDiagnosticValue
};

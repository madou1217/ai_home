'use strict';

const {
  sanitizeDiagnosticCode,
  sanitizeDiagnosticText
} = require('../server/chat-runtime/canonical-diagnostic-sanitizer');
const { REQUEST_CONTEXT_KIND } = require('../server/model-usage-request-context');

function toTimestampMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function toNonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function normalizeText(value, maxLength = 512) {
  return String(value || '').trim().slice(0, maxLength);
}

function normalizeEndpoint(value) {
  return normalizeText(value, 512).replace(/^[A-Z]+\s+/u, '');
}

function isGatewayEndpoint(value) {
  const endpoint = normalizeEndpoint(value);
  return endpoint === '/v1'
    || endpoint.startsWith('/v1/')
    || endpoint.startsWith('/v1beta/')
    || endpoint.startsWith('/anthropic/');
}

function requestTypeFromEntry(entry) {
  const explicit = normalizeText(entry && entry.requestType, 16).toLowerCase();
  if (explicit === 'stream' || explicit === 'sync') return explicit;
  if (entry && entry.streamRequested === true) return 'stream';
  if (entry && entry.streamRequested === false) return 'sync';
  if (normalizeText(entry && entry.streamTransport, 64)) return 'stream';
  const method = normalizeText(entry && entry.method, 16).toUpperCase();
  if (method === 'GET' || method === 'HEAD') return 'sync';
  return '';
}

function errorMessageFromEntry(entry) {
  const source = entry && (
    entry.upstreamBody
    || entry.upstreamError
    || entry.detail
    || entry.error
  );
  return sanitizeDiagnosticText(source, 320);
}

function errorCodeFromEntry(entry, statusCode) {
  const fallback = statusCode > 0 ? `http_${statusCode}` : 'request_failed';
  const candidate = normalizeText(
    entry && (entry.policyKind || entry.failureReason || entry.error),
    96
  );
  if (!candidate) return fallback;
  const sanitized = sanitizeDiagnosticText(candidate, 96);
  if (sanitized !== candidate) return fallback;
  return sanitizeDiagnosticCode(candidate, fallback);
}

function createEmptyLogRecord(requestId) {
  return {
    requestId,
    provider: '',
    model: '',
    reasoningEffort: '',
    endpoint: '',
    clientIp: '',
    requestType: '',
    durationMs: 0,
    timestampMs: 0,
    statusCode: 0,
    errorCode: '',
    errorMessage: ''
  };
}

function mergeLogEntry(record, entry) {
  const endpoint = normalizeEndpoint(entry.endpoint || entry.path || entry.route);
  const timestampMs = toTimestampMs(entry.at);
  const statusCode = Math.max(0, Math.round(Number(entry.status) || 0));
  const requestType = requestTypeFromEntry(entry);

  if (normalizeText(entry.provider, 32)) record.provider = normalizeText(entry.provider, 32).toLowerCase();
  if (normalizeText(entry.effectiveModel || entry.requestedModel || entry.model, 256)) {
    record.model = normalizeText(entry.effectiveModel || entry.requestedModel || entry.model, 256);
  }
  if (normalizeText(entry.reasoningEffort, 32)) {
    record.reasoningEffort = normalizeText(entry.reasoningEffort, 32);
  }
  if (endpoint) record.endpoint = endpoint;
  if (normalizeText(entry.clientIp, 128)) record.clientIp = normalizeText(entry.clientIp, 128);
  if (requestType) record.requestType = requestType;
  if (entry.durationMs !== undefined) record.durationMs = toNonNegativeNumber(entry.durationMs);
  if (timestampMs) record.timestampMs = Math.max(record.timestampMs, timestampMs);
  if (statusCode) record.statusCode = statusCode;

  if (statusCode >= 400 || entry.kind === 'account_retry_failure' || entry.kind === 'request_safety_rejected') {
    if (entry.policyKind || entry.failureReason || entry.error || !record.errorCode) {
      record.errorCode = errorCodeFromEntry(entry, statusCode || record.statusCode);
    }
    const errorMessage = errorMessageFromEntry(entry);
    if (errorMessage) record.errorMessage = errorMessage;
  }
}

function projectRequestLogText(text) {
  const records = new Map();
  String(text || '').split(/\r?\n/u).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch (_error) {
      return;
    }
    if (!entry || typeof entry !== 'object') return;
    const requestId = normalizeText(entry.requestId, 160);
    if (!requestId) return;
    const endpoint = normalizeEndpoint(entry.endpoint || entry.path || entry.route);
    const existing = records.get(requestId);
    if (!existing && endpoint && !isGatewayEndpoint(endpoint) && entry.kind !== REQUEST_CONTEXT_KIND) return;
    const record = existing || createEmptyLogRecord(requestId);
    mergeLogEntry(record, entry);
    records.set(requestId, record);
  });
  return records;
}

function createRequestLogReader(options = {}) {
  const fs = options.fs || require('node:fs');
  const logFile = normalizeText(options.logFile, 4096);
  let cachedSignature = '';
  let cachedRecords = new Map();

  return {
    read() {
      if (!logFile) return cachedRecords;
      let stats;
      try {
        stats = fs.statSync(logFile);
      } catch (_error) {
        cachedSignature = '';
        cachedRecords = new Map();
        return cachedRecords;
      }
      const signature = `${Number(stats.size) || 0}:${Number(stats.mtimeMs) || 0}`;
      if (signature === cachedSignature) return cachedRecords;
      try {
        cachedRecords = projectRequestLogText(fs.readFileSync(logFile, 'utf8'));
        cachedSignature = signature;
      } catch (_error) {
        cachedRecords = new Map();
        cachedSignature = '';
      }
      return cachedRecords;
    }
  };
}

function buildUsageRequestRow(row, logRecord) {
  const telemetry = logRecord || createEmptyLogRecord(String(row.requestId || ''));
  return {
    requestId: String(row.requestId || ''),
    provider: String(row.provider || telemetry.provider || ''),
    model: String(row.model || telemetry.model || ''),
    reasoningEffort: telemetry.reasoningEffort,
    endpoint: telemetry.endpoint,
    clientIp: telemetry.clientIp,
    requestType: telemetry.requestType,
    billingMode: 'token',
    inputTokens: Number(row.inputTokens) || 0,
    outputTokens: Number(row.outputTokens) || 0,
    cacheReadInputTokens: Number(row.cacheReadInputTokens) || 0,
    cacheCreationInputTokens: Number(row.cacheCreationInputTokens) || 0,
    reasoningOutputTokens: Number(row.reasoningOutputTokens) || 0,
    totalTokens: Number(row.totalTokens) || 0,
    costUsd: Number(row.costUsd) || 0,
    durationMs: telemetry.durationMs,
    timestampMs: Number(row.timestampMs) || telemetry.timestampMs,
    statusCode: telemetry.statusCode || 200,
    errorCode: '',
    errorMessage: ''
  };
}

function buildErrorRequestRow(record) {
  return {
    requestId: record.requestId,
    provider: record.provider,
    model: record.model,
    reasoningEffort: record.reasoningEffort,
    endpoint: record.endpoint,
    clientIp: record.clientIp,
    requestType: record.requestType,
    billingMode: '',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    durationMs: record.durationMs,
    timestampMs: record.timestampMs,
    statusCode: record.statusCode,
    errorCode: record.errorCode || errorCodeFromEntry({}, record.statusCode),
    errorMessage: record.errorMessage || `HTTP ${record.statusCode}`
  };
}

function matchesQuery(record, query) {
  const timestampMs = Number(record.timestampMs) || 0;
  if (timestampMs < query.fromMs || timestampMs > query.toMs) return false;
  if (query.provider && record.provider !== query.provider) return false;
  if (query.model && record.model !== query.model) return false;
  return true;
}

function buildRequestDetails(usageRows, logRecords, query) {
  const usage = (Array.isArray(usageRows) ? usageRows : [])
    .map((row) => buildUsageRequestRow(row, logRecords.get(String(row.requestId || ''))));
  const errors = Array.from(logRecords.values())
    .filter((record) => record.statusCode >= 400 && isGatewayEndpoint(record.endpoint))
    .filter((record) => matchesQuery(record, query))
    .sort((left, right) => right.timestampMs - left.timestampMs)
    .slice(0, query.limit)
    .map(buildErrorRequestRow);
  return { usage, errors };
}

module.exports = {
  REQUEST_CONTEXT_KIND,
  buildRequestDetails,
  createRequestLogReader,
  projectRequestLogText,
  __private: {
    isGatewayEndpoint,
    normalizeEndpoint,
    requestTypeFromEntry
  }
};

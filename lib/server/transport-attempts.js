'use strict';

// 统一的 upstream transport attempt 日志模型。
//
// 背景：HTTP 策略与 CLI 策略如果各写一套字段（qoderHttp* / 只靠最终 route
// 日志里的 durationMs），后期统计就只能按策略分别写解析器，而且 CLI 的
// 上游与延迟无法与 HTTP 对齐。这里定义一个 **同构** 的 attempt 记录，所有
// 策略都往 attempt.annotations.transportAttempts 追加同一种对象：
//
//   {
//     transport: 'qoder_http' | 'qoder_cli' | ...
//     outcome: 'success' | 'failure'
//     durationMs: 930                 // 策略自己从进入到结束的耗时
//     upstream: 'https://...'         // HTTP endpoint / 'qoder-cli'
//     provider: 'qodercn'
//     accountRef: 'acct_...'
//     model: 'Qwen3.8-Flash'
//     stream: true|false
//     firstTokenMs?: 527              // 拿得到首字节时才有
//     errorCode?: 'qoder_http_failed'
//     usage?: {                       // 拿得到 token 计数时才有
//       source: 'exact'|'estimated',
//       promptTokens, completionTokens, totalTokens,
//       cachedTokens, reasoningTokens,
//       credits, originalCredits, billable
//     }
//     details?: { ... }               // 策略专有事实，只允许标量
//   }
//
// 两条策略的**统计口径字段完全一致**；HTTP 的 endpointSource / egress /
// clientVersion 等放进 details，CLI 的 warm / sessionId 也放进 details。
// `durationMs` 与 `upstream` 是必看字段，不再依赖最终 route 日志推断。

const { annotateAttempt } = require('./attempt-annotations');

const TRANSPORT_ATTEMPTS_KEY = 'transportAttempts';
const MAX_ATTEMPTS = 8;
const USAGE_INT_FIELDS = Object.freeze([
  'promptTokens',
  'completionTokens',
  'totalTokens',
  'cachedTokens',
  'reasoningTokens',
  'cacheCreationTokens'
]);
const USAGE_DECIMAL_FIELDS = Object.freeze(['credits', 'originalCredits']);

function normalizeString(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function readNonNegativeNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const record = {};
  if (usage.source === 'exact' || usage.source === 'estimated') {
    record.source = usage.source;
  }
  for (const key of USAGE_INT_FIELDS) {
    const numeric = readNonNegativeNumber(usage[key]);
    if (numeric !== null) record[key] = Math.round(numeric);
  }
  for (const key of USAGE_DECIMAL_FIELDS) {
    const numeric = readNonNegativeNumber(usage[key]);
    if (numeric !== null) record[key] = numeric;
  }
  if (usage.billable === true || usage.billable === false) record.billable = usage.billable;
  return Object.keys(record).length ? record : null;
}

// details 只收标量：避免把 body / 签名串 / 整个 upstream 对象写进日志。
function normalizeDetails(details) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
  const record = {};
  for (const [rawKey, rawValue] of Object.entries(details)) {
    const key = normalizeString(rawKey);
    if (!key) continue;
    if (typeof rawValue === 'string') {
      const value = rawValue.trim();
      if (value) record[key] = value;
    } else if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
      record[key] = rawValue;
    } else if (typeof rawValue === 'boolean') {
      record[key] = rawValue;
    }
  }
  return Object.keys(record).length ? record : null;
}

function normalizeTransportAttempt(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const transport = normalizeString(entry.transport);
  const outcome = entry.outcome === 'success' || entry.outcome === 'failure' ? entry.outcome : '';
  if (!transport || !outcome) return null;
  const record = {
    transport,
    outcome,
    durationMs: Math.max(0, Math.round(readNonNegativeNumber(entry.durationMs) ?? 0))
  };
  const upstream = normalizeString(entry.upstream);
  if (upstream) record.upstream = upstream;
  const provider = normalizeString(entry.provider);
  if (provider) record.provider = provider;
  const accountRef = normalizeString(entry.accountRef);
  if (accountRef) record.accountRef = accountRef;
  const model = normalizeString(entry.model);
  if (model) record.model = model;
  if (entry.stream === true || entry.stream === false) record.stream = entry.stream;
  const firstTokenMs = readNonNegativeNumber(entry.firstTokenMs);
  if (firstTokenMs !== null) record.firstTokenMs = Math.round(firstTokenMs);
  const errorCode = normalizeString(entry.errorCode);
  if (errorCode) record.errorCode = errorCode;
  const usage = normalizeUsage(entry.usage);
  if (usage) record.usage = usage;
  const details = normalizeDetails(entry.details);
  if (details) record.details = details;
  return record;
}

/**
 * 追加一条 transport attempt 记录。非法记录静默丢弃：日志观测不能影响请求。
 * 返回写入后的记录，便于测试断言；未写入返回 null。
 */
function recordTransportAttempt(attempt, entry) {
  const normalized = normalizeTransportAttempt(entry);
  if (!normalized || !attempt || typeof attempt !== 'object') return null;
  const current = Array.isArray(attempt.annotations && attempt.annotations[TRANSPORT_ATTEMPTS_KEY])
    ? attempt.annotations[TRANSPORT_ATTEMPTS_KEY]
    : [];
  const next = [...current, normalized];
  if (next.length > MAX_ATTEMPTS) next.splice(0, next.length - MAX_ATTEMPTS);
  annotateAttempt(attempt, TRANSPORT_ATTEMPTS_KEY, next);
  return normalized;
}

function listTransportAttempts(attempt) {
  const current = attempt && attempt.annotations && attempt.annotations[TRANSPORT_ATTEMPTS_KEY];
  return Array.isArray(current) ? current.slice() : [];
}

module.exports = {
  TRANSPORT_ATTEMPTS_KEY,
  MAX_ATTEMPTS,
  normalizeTransportAttempt,
  normalizeUsage,
  normalizeDetails,
  recordTransportAttempt,
  listTransportAttempts
};

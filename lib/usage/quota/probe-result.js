'use strict';

// `quota.probe` 的标准结果。
//
// 现有 provider 探针各自返回 `{ snapshot }` / `{ notApplicable, reason }` /
// `{ error, auth }`，字段命名与失败语义并不统一。这个模块只做**归一**：宿主策略链
// 仍然是唯一执行者（`runQuotaStrategies`），探针不写账号状态、不持久化、不决定路由。
//
// 三条状态必须互斥且可观察：
//   * `ok`             —— 有快照；来源/捕获时间缺失时只降级为 warning，不伪造数据；
//   * `not_applicable` —— 来源明确回答「这个账号没有可消耗的额度池」，不是失败；
//   * `unavailable`    —— 没有快照；`error` 必须保留，不能伪装成 0% 或空快照。
//
// `source` 支持两种历史形态：快照里的字符串 source（provider 内部常量）与标准
// SourceRef 对象。归一后统一给 `{ id, kind, ... }`，UI 与诊断只读这一份。

const QUOTA_PROBE_SCHEMA_VERSION = 1;
const QUOTA_PROBE_KIND = 'quota.probe';

function normalizeText(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function normalizeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeAttempts(attempts) {
  return (Array.isArray(attempts) ? attempts : []).map((attempt) => ({
    strategyId: normalizeText(attempt && attempt.strategyId),
    error: normalizeText(attempt && attempt.error),
    auth: Boolean(attempt && attempt.auth),
    notApplicable: Boolean(attempt && attempt.notApplicable)
  }));
}

function normalizeSource(snapshot) {
  const raw = snapshot && snapshot.source;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return {
      id: normalizeText(raw.id) || 'unknown',
      kind: normalizeText(raw.kind) || 'provider',
      authority: normalizeNumber(raw.authority),
      confidence: normalizeNumber(raw.confidence),
      url: normalizeText(raw.url),
      fetchedAt: normalizeText(raw.fetchedAt),
      expiresAt: normalizeText(raw.expiresAt)
    };
  }
  return {
    id: normalizeText(raw) || 'unknown',
    kind: 'provider',
    authority: null,
    confidence: null,
    url: '',
    fetchedAt: '',
    expiresAt: ''
  };
}

function readCapturedAt(snapshot) {
  const value = normalizeNumber(snapshot && snapshot.capturedAt);
  return value && value > 0 ? value : null;
}

/**
 * @param {{
 *   provider: string,
 *   accountRef?: string,
 *   result?: object,
 *   now?: number|string,
 *   maxAgeMs?: number
 * }} input
 * @returns {{
 *   schemaVersion: number,
 *   kind: string,
 *   provider: string,
 *   accountRef: string,
 *   status: 'ok'|'not_applicable'|'unavailable',
 *   notApplicable: boolean,
 *   strategyId: string,
 *   snapshot: object|null,
 *   source: object,
 *   capturedAt: number|null,
 *   stale: boolean|null,
 *   attempts: Array<object>,
 *   error: string,
 *   reason: string,
 *   auth: boolean,
 *   warnings: Array<{code: string, detail?: string}>
 * }}
 */
function normalizeQuotaProbeResult(input = {}) {
  const raw = input.result && typeof input.result === 'object' ? input.result : {};
  const snapshot = raw.snapshot && typeof raw.snapshot === 'object' && !Array.isArray(raw.snapshot)
    ? raw.snapshot
    : null;
  const notApplicable = raw.notApplicable === true;
  const error = normalizeText(raw.error);
  const reason = normalizeText(raw.reason) || (notApplicable ? 'not_applicable' : '');
  const status = notApplicable ? 'not_applicable' : (snapshot ? 'ok' : 'unavailable');
  const source = normalizeSource(snapshot);
  const capturedAt = readCapturedAt(snapshot);
  const now = normalizeNumber(input.now) || Date.now();
  const maxAgeMs = input.maxAgeMs === null || input.maxAgeMs === undefined || input.maxAgeMs === ''
    ? null
    : normalizeNumber(input.maxAgeMs);
  const warnings = [];

  if (snapshot && source.id === 'unknown') {
    warnings.push({ code: 'quota_source_missing' });
  }
  if (snapshot && !capturedAt) {
    warnings.push({ code: 'quota_captured_at_missing' });
  }
  if (!snapshot && !notApplicable && !error) {
    warnings.push({ code: 'quota_unavailable_without_error' });
  }

  let stale = null;
  if (snapshot && maxAgeMs !== null && maxAgeMs >= 0) {
    stale = !capturedAt || (now - capturedAt) > maxAgeMs;
  } else if (source.expiresAt) {
    const expiresAt = Date.parse(source.expiresAt);
    stale = Number.isFinite(expiresAt) ? now > expiresAt : null;
  }

  const attempts = normalizeAttempts(raw.attempts);
  return {
    schemaVersion: QUOTA_PROBE_SCHEMA_VERSION,
    kind: QUOTA_PROBE_KIND,
    provider: normalizeText(input.provider).toLowerCase(),
    accountRef: normalizeText(input.accountRef),
    status,
    notApplicable,
    strategyId: normalizeText(raw.strategyId),
    snapshot,
    source,
    capturedAt,
    stale,
    attempts,
    error: status === 'unavailable' ? (error || 'probe_failed') : '',
    reason: status === 'not_applicable' ? reason : '',
    // 顶层 auth 可能缺失（直接归一策略结果时）；attempts 里的 auth 是同一事实。
    auth: Boolean(raw.auth) || attempts.some((attempt) => attempt.auth),
    warnings
  };
}

/**
 * 从快照自身构造 `provenance`（不依赖某次探针结果）：
 * 原生 handler（codex/claude/agy/gemini）的快照只有字符串 `source` 与 `capturedAt`，
 * 同样需要来源/年龄/stale 展示；缓存层因此可以统一补齐，而不是让 UI 猜。
 */
function buildQuotaSnapshotProvenance(snapshot, options = {}) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const source = normalizeSource(snapshot);
  // `provenance` 可能已由探针写入（带 authority / confidence / url）；补齐时只
  // 重新计算年龄与 stale，不能把更完整的来源信息退回成字符串 source。
  const existing = snapshot.provenance && typeof snapshot.provenance === 'object'
    && !Array.isArray(snapshot.provenance)
    ? snapshot.provenance
    : {};
  const capturedAt = readCapturedAt(snapshot) || normalizeNumber(existing.capturedAt);
  const now = normalizeNumber(options.now) || Date.now();
  const maxAgeMs = options.maxAgeMs === null || options.maxAgeMs === undefined || options.maxAgeMs === ''
    ? null
    : normalizeNumber(options.maxAgeMs);
  const expiresAt = normalizeText(existing.expiresAt) || source.expiresAt;
  let stale = null;
  if (existing.stale === true || options.stale === true) stale = true;
  else if (maxAgeMs !== null && maxAgeMs >= 0) stale = !capturedAt || (now - capturedAt) > maxAgeMs;
  else if (expiresAt) {
    const expiresAtMs = Date.parse(expiresAt);
    stale = Number.isFinite(expiresAtMs) ? now > expiresAtMs : null;
  } else if (typeof existing.stale === 'boolean') stale = existing.stale;
  const existingId = normalizeText(existing.id);
  const existingKind = normalizeText(existing.kind);
  return {
    schemaVersion: QUOTA_PROBE_SCHEMA_VERSION,
    id: existingId && existingId !== 'unknown' ? existingId : source.id,
    kind: existingKind && existingKind !== 'unknown' ? existingKind : source.kind,
    authority: normalizeNumber(existing.authority) ?? source.authority,
    confidence: normalizeNumber(existing.confidence) ?? source.confidence,
    url: normalizeText(existing.url) || source.url,
    fetchedAt: normalizeText(existing.fetchedAt) || source.fetchedAt,
    expiresAt,
    capturedAt,
    stale
  };
}

/**
 * 把归一后的来源附加到快照上，供 UI 展示来源/年龄/stale。
 *
 * `snapshot.source` 是既有缓存与恢复判定使用的**字符串身份**
 * （`codex_app_server` / `kimi_oauth` …），不能被对象覆盖；因此来源信息
 * 放在独立的 `provenance` 字段里，保持旧字段逐字节不变。
 */
function attachQuotaProbeProvenance(snapshot, result) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  const probe = result && typeof result === 'object' ? result : {};
  const source = probe.source && typeof probe.source === 'object' ? probe.source : null;
  const capturedAt = readCapturedAt(snapshot) || normalizeNumber(probe.capturedAt);
  return {
    ...snapshot,
    provenance: {
      schemaVersion: QUOTA_PROBE_SCHEMA_VERSION,
      id: source && source.id ? source.id : 'unknown',
      kind: source && source.kind ? source.kind : 'provider',
      authority: source ? normalizeNumber(source.authority) : null,
      confidence: source ? normalizeNumber(source.confidence) : null,
      url: source ? normalizeText(source.url) : '',
      fetchedAt: source ? normalizeText(source.fetchedAt) : '',
      expiresAt: source ? normalizeText(source.expiresAt) : '',
      capturedAt,
      stale: probe.stale === true
    }
  };
}

/** UI/CLI 只需要的紧凑来源行；没有来源时明确显示 unknown。 */
function formatQuotaProbeProvenance(result) {
  if (!result || result.status === 'unavailable') return '';
  const source = result.source && result.source.id ? result.source.id : 'unknown';
  const capturedAt = result.capturedAt ? new Date(result.capturedAt).toISOString() : 'unknown';
  return `quota: ${source} captured_at=${capturedAt}${result.stale === true ? ' stale=true' : ''}`;
}

module.exports = {
  QUOTA_PROBE_SCHEMA_VERSION,
  QUOTA_PROBE_KIND,
  normalizeQuotaProbeResult,
  buildQuotaSnapshotProvenance,
  attachQuotaProbeProvenance,
  formatQuotaProbeProvenance,
  __private: { normalizeSource, normalizeAttempts, readCapturedAt }
};

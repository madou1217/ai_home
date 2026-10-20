'use strict';

// `usage.scan` 的标准结果。
//
// 本地会话扫描是**宿主能力**：插件/扫描器只回答「我读到了哪些用量记录」，
// 计价、归属、持久化和路由仍由宿主决定。这个模块把现有
// `scanModelUsageSources()` 的计数结果归一成可观察的形状，避免调用方
// 把「没有记录」误当成「扫描成功但没有用量」或「扫描失败」。
//
// 三态互斥：
//   * `ok`          —— 至少一个 provider 读到了记录；
//   * `empty`       —— 扫描真的跑过（读到了文件），但没有任何记录；
//   * `unavailable` —— 没有 provider 能扫描（没有本地客户端 / 目录不存在 /
//                     扫描器明确声明不支持）。
//
// 来源固定是 `local-sessions`：它不是厂商额度接口，不能用 authority 去和
// 价格来源比较；`fetchedAt` 是本次扫描完成的时刻，`stale` 恒为 false
// （扫描结果就是当下读到的内容；不完整用 warnings 表达，不伪装成过期）。

const USAGE_SCAN_SCHEMA_VERSION = 1;
const USAGE_SCAN_KIND = 'usage.scan';
const USAGE_SCAN_SOURCE_ID = 'local-sessions';
const USAGE_SCAN_STATUS = Object.freeze({
  OK: 'ok',
  EMPTY: 'empty',
  UNAVAILABLE: 'unavailable'
});

function normalizeText(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function toCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function normalizeProviderName(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeProviderNames(values) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map(normalizeProviderName)
    .filter(Boolean)))
    .sort();
}

function normalizeTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.round(value);
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function readErrorCount(entry) {
  return toCount(entry.errors)
    || toCount(entry.discoveryErrors)
    || toCount(entry.sourceErrors)
    || toCount(entry.ambiguousSessions);
}

/**
 * 单个 provider 的扫描结果：保留原字段（调用方仍可读 `files/records/...`），
 * 额外补 `status` / `reason` / `errors`，让「为什么没有记录」可解释。
 */
function normalizeUsageScanProviderResult(entry) {
  const raw = entry && typeof entry === 'object' ? entry : {};
  const files = toCount(raw.files);
  const records = toCount(raw.records);
  const prompts = toCount(raw.prompts);
  const skipped = toCount(raw.skipped);
  const filesDeferred = toCount(raw.filesDeferred);
  const reindexRequired = toCount(raw.reindexRequired);
  const errors = readErrorCount(raw);
  const reason = normalizeText(raw.reason);
  const status = records > 0
    ? USAGE_SCAN_STATUS.OK
    : (reason || (files === 0 && errors > 0) ? USAGE_SCAN_STATUS.UNAVAILABLE : USAGE_SCAN_STATUS.EMPTY);
  return {
    ...raw,
    files,
    records,
    prompts,
    skipped,
    filesDeferred,
    reindexRequired,
    errors,
    reason,
    status
  };
}

function normalizeProviderMap(providers) {
  const out = {};
  for (const [name, entry] of Object.entries(providers && typeof providers === 'object' ? providers : {})) {
    const key = normalizeProviderName(name);
    if (!key) continue;
    out[key] = normalizeUsageScanProviderResult(entry);
  }
  return out;
}

function sumCounts(providers) {
  const totals = { files: 0, records: 0, prompts: 0, skipped: 0, filesDeferred: 0, reindexRequired: 0 };
  for (const entry of Object.values(providers)) {
    for (const field of Object.keys(totals)) totals[field] += toCount(entry[field]);
  }
  return totals;
}

function resolveStatus(providers, requested) {
  const entries = requested.length > 0
    ? requested.map((provider) => providers[provider]).filter(Boolean)
    : Object.values(providers);
  if (entries.some((entry) => entry.status === USAGE_SCAN_STATUS.OK)) return USAGE_SCAN_STATUS.OK;
  if (entries.some((entry) => entry.status === USAGE_SCAN_STATUS.EMPTY)) return USAGE_SCAN_STATUS.EMPTY;
  return USAGE_SCAN_STATUS.UNAVAILABLE;
}

function buildWarnings(status, providers, requested) {
  const warnings = [];
  const entries = requested.length > 0
    ? requested.map((provider) => ({ provider, entry: providers[provider] }))
    : Object.entries(providers).map(([provider, entry]) => ({ provider, entry }));
  for (const { provider, entry } of entries) {
    if (!entry) {
      warnings.push({ code: 'usage_scan_provider_missing', provider });
      continue;
    }
    if (entry.status === USAGE_SCAN_STATUS.UNAVAILABLE && entry.reason) {
      warnings.push({ code: 'usage_scan_provider_unavailable', provider, detail: entry.reason });
    }
    if (entry.filesDeferred > 0) {
      warnings.push({ code: 'usage_scan_files_deferred', provider, count: entry.filesDeferred });
    }
    if (entry.skipped > 0) {
      warnings.push({ code: 'usage_scan_files_skipped', provider, count: entry.skipped });
    }
  }
  if (status === USAGE_SCAN_STATUS.EMPTY) warnings.push({ code: 'usage_scan_empty' });
  if (status === USAGE_SCAN_STATUS.UNAVAILABLE) warnings.push({ code: 'usage_scan_unavailable' });
  return warnings;
}

/**
 * 把扫描摘要归一成 `usage.scan` 结果。
 *
 * @param {{
 *   result?: object,
 *   providers?: string[],
 *   now?: number|string,
 *   sourceId?: string
 * }} input
 */
function createUsageScanResult(input = {}) {
  const raw = input.result && typeof input.result === 'object' ? input.result : {};
  const providers = normalizeProviderMap(raw.providers);
  const requested = normalizeProviderNames(input.providers || raw.requestedProviders);
  const status = resolveStatus(providers, requested);
  const counts = sumCounts(providers);
  const scannedAt = normalizeTimestamp(input.now) || Date.now();
  const sourceId = normalizeText(input.sourceId) || USAGE_SCAN_SOURCE_ID;
  const scannedAtIso = new Date(scannedAt).toISOString();
  return {
    ...raw,
    schemaVersion: USAGE_SCAN_SCHEMA_VERSION,
    kind: USAGE_SCAN_KIND,
    status,
    source: {
      id: sourceId,
      kind: 'local-sessions',
      authority: null,
      confidence: null,
      fetchedAt: scannedAtIso,
      stale: false
    },
    scannedAt,
    scannedAtIso,
    stale: false,
    requestedProviders: requested,
    providers,
    counts,
    // 兼容既有调用方：顶层计数与 provider 明细保持一致。
    files: counts.files,
    records: counts.records,
    prompts: counts.prompts,
    skipped: counts.skipped,
    filesDeferred: counts.filesDeferred,
    reindexRequired: counts.reindexRequired,
    attempts: (requested.length > 0 ? requested : Object.keys(providers)).map((provider) => {
      const entry = providers[provider];
      return {
        provider,
        status: entry ? entry.status : USAGE_SCAN_STATUS.UNAVAILABLE,
        reason: entry ? entry.reason : 'provider_not_scanned'
      };
    }),
    warnings: buildWarnings(status, providers, requested)
  };
}

/** 标准请求：只声明要扫哪些 provider；空 = 宿主默认集合。 */
function createUsageScanRequest(input = {}) {
  const providers = normalizeProviderNames(input.providers || (input.provider ? [input.provider] : []));
  return {
    schemaVersion: USAGE_SCAN_SCHEMA_VERSION,
    kind: USAGE_SCAN_KIND,
    providers
  };
}

/** 紧凑来源行（`aih server status` / 诊断日志使用）。 */
function formatUsageScanProvenance(result) {
  if (!result || typeof result !== 'object') return '';
  const source = result.source && result.source.id ? result.source.id : USAGE_SCAN_SOURCE_ID;
  const status = normalizeText(result.status) || 'unknown';
  const records = toCount(result.records);
  const providers = Array.isArray(result.requestedProviders) && result.requestedProviders.length > 0
    ? result.requestedProviders.join(',')
    : Object.keys(result.providers || {}).sort().join(',');
  return `usage scan: ${source} status=${status} records=${records} providers=${providers || 'none'}`;
}

/**
 * 内置 `usage.scan` 贡献项：只暴露扫描入口，不决定计价/入库。
 * 外部插件可以声明同 capability 的贡献，宿主按 collect 汇总。
 */
function createLocalUsageScanContribution(options = {}) {
  const scan = options.scan;
  if (typeof scan !== 'function') throw new TypeError('usage_scan_contribution_scan_required');
  return {
    id: normalizeText(options.id) || USAGE_SCAN_SOURCE_ID,
    capability: USAGE_SCAN_KIND,
    scan
  };
}

module.exports = {
  USAGE_SCAN_SCHEMA_VERSION,
  USAGE_SCAN_KIND,
  USAGE_SCAN_SOURCE_ID,
  USAGE_SCAN_STATUS,
  createUsageScanRequest,
  createUsageScanResult,
  normalizeUsageScanProviderResult,
  formatUsageScanProvenance,
  createLocalUsageScanContribution,
  // 语义别名：调用方按 normalize / create 两种习惯都能找到入口。
  normalizeUsageScanResult: createUsageScanResult
};

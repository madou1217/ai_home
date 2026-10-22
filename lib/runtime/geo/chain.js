'use strict';

// 本地 IP → 归属地 查询的**策略链执行器**（Node 侧）。
//
// 语义（与 lib/usage/quota/strategies.js 同一套思路，便于全仓一致）：
//   - provider 按注册表顺序尝试；**不可用**（数据文件缺失 / 打不开）直接跳过，记 attempts；
//   - 查不到（IP 不在库里）也切下一个 —— 不同库的覆盖范围不同；
//   - **字段级合并**：国家/省州/城市取第一个给出结果的 provider；ASN 单独补齐
//     （GeoLite2-ASN 这类库只提供 ASN，不提供国家，必须能与 Country 库拼起来）；
//   - 每次尝试都记进 attempts（providerId / error / 命中字段），所以「切过、为什么切」可观察。

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 一个查询结果是否算「命中」：至少要给出国家或 ASN 之一。 */
function hasAnyField(result) {
  return Boolean(result && (normalizeString(result.country) || normalizeString(result.asn)));
}

/**
 * 逐字段合并：先到的非空值优先（第一个 provider 的国家胜过后面 provider 的）。
 * ASN 与 org 独立补齐，所以 Country 库 + ASN 库能拼成完整结果。
 */
function mergeFields(target, source) {
  if (!source) return target;
  for (const field of ['country', 'region', 'city', 'asn', 'org', 'ip']) {
    if (!normalizeString(target[field]) && normalizeString(source[field])) {
      target[field] = normalizeString(source[field]);
    }
  }
  return target;
}

/**
 * 还缺哪些关键字段（缺就继续问后面的 provider）。
 *
 * 只把「国家」和「ASN」当关键字段 —— 城市/省州是加分项，不为它们多问一个库
 * （实测：多问一个库约 100-230μs；2w 节点全量查询时这是秒级差异）。
 * 所以有 City 库时通常只问 City（给国家）+ ASN 两个库，不问 Country 库。
 */
function missingImportantFields(merged) {
  return !normalizeString(merged.country) || !normalizeString(merged.asn);
}

/**
 * 这个 provider 还能补上关键字段吗（不能就跳过它，省一次查询）。
 * capabilities 声明它提供哪些字段；没声明 capabilities 时保守地认为能补。
 */
function canContribute(provider, merged) {
  const caps = provider && provider.capabilities;
  if (!caps) return true;
  if (!normalizeString(merged.country) && caps.country === true) return true;
  if (!normalizeString(merged.asn) && caps.asn === true) return true;
  return false;
}

class GeoLookupChain {
  /**
   * @param {object} options
   * @param {Array} options.providers  已按优先级排好的 provider 列表（见 providers/index.js）
   * @param {number} [options.maxAttempts] 最多问几个 provider（默认全部）
   */
  constructor(options = {}) {
    this.providers = (Array.isArray(options.providers) ? options.providers : [])
      .filter((provider) => provider && typeof provider.lookup === 'function');
    this.maxAttempts = Number(options.maxAttempts) > 0 ? Number(options.maxAttempts) : this.providers.length;
  }

  /** 当前有哪些 provider 可用（数据文件在位、能打开）。 */
  availability() {
    return this.providers.map((provider) => {
      let available = false;
      let error = '';
      try {
        available = typeof provider.available === 'function' ? provider.available() === true : true;
      } catch (lookupError) {
        error = normalizeString(lookupError && lookupError.message) || 'availability_failed';
      }
      return {
        id: provider.id,
        name: provider.name || provider.id,
        capabilities: { ...(provider.capabilities || {}) },
        available,
        error
      };
    });
  }

  /**
   * 查一个 IP 的归属地。永不抛：任何 provider 抛错都记进 attempts 并切下一个。
   * @returns {{ ok: true, geo: object, providers: string[], attempts: Array } | { ok: false, error: string, attempts: Array }}
   */
  lookup(ip) {
    const address = normalizeString(ip);
    if (!address) return { ok: false, error: 'invalid_ip', attempts: [] };
    const attempts = [];
    const merged = {};
    const used = [];
    for (const provider of this.providers.slice(0, this.maxAttempts)) {
      // 已经拿全关键字段（国家 + ASN）就不必再问后面的库。
      if (used.length && !missingImportantFields(merged)) break;
      // 这个库补不上还缺的字段（例如已有国家、它只有国家）→ 跳过，省一次查询。
      if (used.length && !canContribute(provider, merged)) {
        attempts.push({ providerId: provider.id, error: 'not_needed' });
        continue;
      }
      let result = null;
      try {
        if (typeof provider.available === 'function' && provider.available() !== true) {
          attempts.push({ providerId: provider.id, error: 'unavailable' });
          continue;
        }
        result = provider.lookup(address);
      } catch (error) {
        attempts.push({ providerId: provider.id, error: normalizeString(error && error.message) || 'lookup_failed' });
        continue;
      }
      if (!hasAnyField(result)) {
        attempts.push({ providerId: provider.id, error: 'not_found' });
        continue;
      }
      mergeFields(merged, result);
      used.push(provider.id);
      attempts.push({ providerId: provider.id, hit: Object.keys(result).filter((key) => normalizeString(result[key])) });
    }
    if (!hasAnyField(merged)) return { ok: false, error: 'geo_not_found', attempts };
    return { ok: true, geo: { ...merged, at: Date.now() }, providers: used, attempts };
  }
}

module.exports = {
  GeoLookupChain,
  canContribute,
  hasAnyField,
  mergeFields,
  missingImportantFields
};

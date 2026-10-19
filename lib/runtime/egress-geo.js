'use strict';

// 出口的真实位置：经某个出口（代理地址 / 出口池节点 / 直连）查询出口 IP 的归属
// （国家 / 省州 / 城市 / ASN / IP）。地区规则匹配的是这里的结果，不是节点名 ——
// 实测（2026-10-19）名为「剩余流量：50 GB」的节点出口在 US，名字不可信。
//
// 两个中性查询服务按顺序尝试（都不需要凭据、不涉及任何 provider 接口）；都失败时返回
// { ok:false, error }，调用方把它当「位置未知」（地区规则据此不命中，交给实测兜底）。
// IP 库在城市粒度有误差：城市规则只负责缩小候选范围，结论仍由实测确认。

const GEO_LOOKUP_TIMEOUT_MS = 8000;

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseAsn(text) {
  const match = /\bAS(\d{1,10})\b/i.exec(String(text || ''));
  return match ? `AS${match[1]}` : '';
}

// 查询服务表（数据）：url + 把响应翻译成统一形状的函数。
const GEO_SOURCES = Object.freeze([
  Object.freeze({
    id: 'ipinfo',
    url: 'https://ipinfo.io/json',
    parse: (doc) => ({
      ip: normalizeString(doc.ip),
      country: normalizeString(doc.country).toUpperCase(),
      region: normalizeString(doc.region),
      city: normalizeString(doc.city),
      asn: parseAsn(doc.org),
      org: normalizeString(doc.org).replace(/^AS\d+\s*/i, '')
    })
  }),
  Object.freeze({
    id: 'ip-api',
    url: 'http://ip-api.com/json/?fields=status,countryCode,regionName,city,as,isp,query',
    parse: (doc) => (doc.status === 'success' ? {
      ip: normalizeString(doc.query),
      country: normalizeString(doc.countryCode).toUpperCase(),
      region: normalizeString(doc.regionName),
      city: normalizeString(doc.city),
      asn: parseAsn(doc.as),
      org: normalizeString(doc.isp)
    } : null)
  })
]);

/**
 * 查询出口位置。
 * @param {object} options
 * @param {(url: string, init: object) => Promise<Response>} options.fetch  已绑定出口的 fetch（经代理 / 直连）
 * @returns {Promise<{ok:true, geo:object, source:string} | {ok:false, error:string}>}
 */
async function lookupExitGeo(options = {}) {
  const fetchImpl = typeof options.fetch === 'function' ? options.fetch : fetch;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : GEO_LOOKUP_TIMEOUT_MS;
  const errors = [];
  for (const source of GEO_SOURCES) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await fetchImpl(source.url, {
        headers: { accept: 'application/json', connection: 'close' },
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!res || !res.ok) {
        errors.push(`${source.id}:http_${res ? res.status : 0}`);
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const geo = source.parse(JSON.parse(await res.text()) || {});
      if (geo && geo.country) return { ok: true, geo: { ...geo, at: Date.now() }, source: source.id };
      errors.push(`${source.id}:no_country`);
    } catch (error) {
      errors.push(`${source.id}:${normalizeString(error && (error.cause && error.cause.code || error.name)) || 'error'}`);
    }
  }
  return { ok: false, error: errors.join(',') || 'geo_lookup_failed' };
}

/** 人读的位置：「🇺🇸 US · California · Los Angeles · AS13335」。 */
function describeGeo(geo) {
  if (!geo || !geo.country) return '';
  const flag = String.fromCodePoint(...[...geo.country].map((char) => 0x1f1a5 + char.charCodeAt(0)));
  return [`${flag} ${geo.country}`, geo.region, geo.city, geo.asn].filter(Boolean).join(' · ');
}

module.exports = {
  GEO_SOURCES,
  describeGeo,
  lookupExitGeo
};

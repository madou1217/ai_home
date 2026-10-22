'use strict';

// 拿「当前出口的真实 IP」—— 位置查询的**第一段**（第二段是本地库查归属地，见 ./index.js）。
//
// 为什么必须出网：只有经这个出口发一次请求，才知道它对外的 IP 是什么。
// 节点名与 server 地址都不可信（实测名为「剩余流量：50 GB」的节点出口在 US）。
//
// 与旧实现（lib/runtime/egress-geo.js）的差别：
//   - 旧：直接请求 ipinfo/ip-api，让**在线服务**既给 IP 又给归属地 —— 慢、有速率限制、不稳定；
//   - 新：只问一个**极简端点**要 IP（响应几十字节），归属地交给本地 mmdb 库。
// 端点也做成列表，前一个失败自动切下一个（与 provider 链同一思路）。

const IP_ENDPOINTS = Object.freeze([
  { id: 'ipify', url: 'https://api.ipify.org?format=json', parse: (text) => parseJsonField(text, 'ip') },
  { id: 'ifconfig', url: 'https://ifconfig.me/ip', parse: (text) => normalizeIp(text) },
  { id: 'ipinfo-ip', url: 'https://ipinfo.io/ip', parse: (text) => normalizeIp(text) },
  { id: 'cloudflare', url: 'https://www.cloudflare.com/cdn-cgi/trace', parse: (text) => parseTraceField(text, 'ip') }
]);

// 拿 IP 是轻量请求：3.5 秒足够（旧实现给 8 秒是因为要等在线库算归属地）。
const IP_LOOKUP_TIMEOUT_MS = 3500;

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 只接受合法 IP 字面量（端点返回 HTML/错误页时不要把它当 IP）。 */
function normalizeIp(value) {
  const text = normalizeString(value);
  if (!text || text.length > 45 || /[\s<>]/.test(text)) return '';
  return /^[0-9a-fA-F:.]+$/.test(text) && (text.includes('.') || text.includes(':')) ? text : '';
}

function parseJsonField(text, field) {
  try {
    const doc = JSON.parse(String(text || ''));
    return normalizeIp(doc && doc[field]);
  } catch (_error) {
    return '';
  }
}

/** cloudflare trace 是 key=value 逐行文本。 */
function parseTraceField(text, field) {
  for (const line of String(text || '').split('\n')) {
    const index = line.indexOf('=');
    if (index > 0 && line.slice(0, index) === field) return normalizeIp(line.slice(index + 1));
  }
  return '';
}

/**
 * 经给定出口拿出口 IP。
 * @param {object} options
 * @param {(url:string, init:object)=>Promise<Response>} options.fetch 已绑定出口的 fetch
 * @returns {Promise<{ok:true, ip:string, endpoint:string} | {ok:false, error:string}>}
 */
async function lookupExitIp(options = {}) {
  const fetchImpl = typeof options.fetch === 'function' ? options.fetch : null;
  if (!fetchImpl) return { ok: false, error: 'fetch_required' };
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : IP_LOOKUP_TIMEOUT_MS;
  const errors = [];
  for (const endpoint of IP_ENDPOINTS) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const response = await fetchImpl(endpoint.url, {
        headers: { accept: 'application/json, text/plain', connection: 'close' },
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!response || !response.ok) {
        errors.push(`${endpoint.id}:http_${response ? response.status : 0}`);
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const ip = endpoint.parse(await response.text());
      if (ip) return { ok: true, ip, endpoint: endpoint.id };
      errors.push(`${endpoint.id}:no_ip`);
    } catch (error) {
      errors.push(`${endpoint.id}:${normalizeString(error && (error.cause && error.cause.code || error.name)) || 'error'}`);
    }
  }
  return { ok: false, error: errors.join(',') || 'exit_ip_lookup_failed' };
}

module.exports = {
  IP_ENDPOINTS,
  IP_LOOKUP_TIMEOUT_MS,
  lookupExitIp,
  normalizeIp,
  parseTraceField
};

'use strict';

// 渲染上下文：订阅自身的公开地址、由 AIH 转换的规则集地址、建议刷新间隔。
// Surge 的 #!MANAGED-CONFIG、Loon / QX 的远程规则都需要可被客户端直接访问的绝对地址，
// 地址来源是客户端（或 WebUI）请求这台服务时用的 origin。

const HOST_PATTERN = /^[A-Za-z0-9.-]+(?::\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](?::\d{1,5})?$/;

function firstHeader(value) {
  const text = Array.isArray(value) ? value[0] : value;
  return String(text || '').split(',')[0].trim();
}

/** 请求方看到的 origin（经反向代理时尊重 X-Forwarded-*）；拿不到合法 Host 时返回 ''。 */
function requestOrigin(req) {
  const headers = (req && req.headers) || {};
  const host = firstHeader(headers['x-forwarded-host']) || firstHeader(headers.host);
  if (!HOST_PATTERN.test(host)) return '';
  const forwardedProto = firstHeader(headers['x-forwarded-proto']).toLowerCase();
  const proto = ['http', 'https'].includes(forwardedProto)
    ? forwardedProto
    : (req && req.socket && req.socket.encrypted ? 'https' : 'http');
  return `${proto}://${host}`;
}

function buildRenderContext({ origin = '', token = '', renderer, profile = {} } = {}) {
  const base = origin && token ? `${origin}/sub/${token}` : '';
  const target = renderer ? renderer.id : '';
  const intervalHours = Number(profile.refreshHours) > 0 ? Number(profile.refreshHours) : 24;
  return Object.freeze({
    subscriptionUrl: base ? `${base}?target=${encodeURIComponent(target)}` : '',
    updateIntervalSeconds: Math.round(intervalHours * 3600),
    ruleSetUrl: (ruleSet) => (base
      ? `${base}/rules/${encodeURIComponent(ruleSet.tag)}?target=${encodeURIComponent(target)}`
      : '')
  });
}

module.exports = {
  buildRenderContext,
  requestOrigin
};

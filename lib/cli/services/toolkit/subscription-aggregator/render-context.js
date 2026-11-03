'use strict';

// 渲染上下文：订阅自身的公开地址、由 AIH 转换的规则集地址、建议刷新间隔，以及识别出的客户端
// （sing-box 内核版本等）与视图（full 完整配置 / nodes 只要节点）。
// Surge 的 #!MANAGED-CONFIG、Loon / QX 的远程规则都需要可被客户端直接访问的绝对地址，
// 地址来源是客户端（或 WebUI）请求这台服务时用的 origin。
//
// relay：本机中转这次给出的「节点 id → 本地入口」。只有渲染器声明了 capabilities.relayFallback
// 时才可能有内容；没在跑（或起不来）就是空表，渲染器于是按原样输出（fail-closed，见 relay/）。

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

const VIEWS = new Set(['full', 'nodes']);

function normalizeView(value) {
  const view = String(value || '').trim().toLowerCase();
  return VIEWS.has(view) ? view : '';
}

function buildRenderContext({
  origin = '', token = '', renderer, profile = {}, client = null, view = '', relay = null, coreProtocols = null
} = {}) {
  const base = origin && token ? `${origin}/sub/${token}` : '';
  const target = renderer ? renderer.id : '';
  const intervalHours = Number(profile.refreshHours) > 0 ? Number(profile.refreshHours) : 24;
  const resolvedView = normalizeView(view) || 'full';
  const viewQuery = resolvedView === 'nodes' ? '&view=nodes' : '';
  return Object.freeze({
    client: Object.freeze({ ...(client || {}) }),
    view: resolvedView,
    subscriptionUrl: base ? `${base}?target=${encodeURIComponent(target)}${viewQuery}` : '',
    updateIntervalSeconds: Math.round(intervalHours * 3600),
    ruleSetUrl: (ruleSet) => (base
      ? `${base}/rules/${encodeURIComponent(ruleSet.tag)}?target=${encodeURIComponent(target)}`
      : ''),
    // 内核不认这些协议（Clash Premium 的经典内核）：只用来判断要不要走本机中转。
    coreProtocols: Array.isArray(coreProtocols) ? Object.freeze([...coreProtocols]) : null,
    relay: relay ? Object.freeze({ ...relay }) : null
  });
}

module.exports = {
  buildRenderContext,
  normalizeView,
  requestOrigin
};

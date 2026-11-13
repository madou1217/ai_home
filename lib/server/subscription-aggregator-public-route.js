'use strict';

// 聚合订阅公开拉取路由（/sub/{token}[/rules/{ruleSet}]）：
// 订阅渲染、客户端识别、本机中转边车、规则集转换全部已迁至 Go（subaggregatorpublicapi）。
// Node 侧只做前置形态校验与向 Go Core 的零回落透传；Go Core 不可用时固定 503 go_core_unavailable。

const PUBLIC_PREFIX = '/sub/';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const RULE_SET_PATH = /^([A-Za-z0-9_-]{16,128})\/rules\/((?:geosite|geoip)-[A-Za-z0-9@._-]{1,128})$/;

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade'
]);

function writePlain(res, status, text, method = 'GET', extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(method === 'HEAD' ? undefined : text);
}

function firstHeader(value) {
  const text = Array.isArray(value) ? value[0] : value;
  return String(text || '').split(',')[0].trim();
}

function readSearch(url, req) {
  if (url && typeof url.search === 'string') return url.search;
  const rawUrl = String((req && req.url) || '');
  const queryIndex = rawUrl.indexOf('?');
  return queryIndex >= 0 ? rawUrl.slice(queryIndex) : '';
}

function buildForwardHeaders(req) {
  const incoming = (req && req.headers) || {};
  const headers = {};
  const userAgent = incoming['user-agent'];
  if (userAgent !== undefined) {
    const ua = Array.isArray(userAgent) ? userAgent[0] : String(userAgent);
    if (ua) headers['user-agent'] = ua;
  }
  const forwardedHost = firstHeader(incoming['x-forwarded-host']);
  const host = firstHeader(incoming.host);
  const effectiveHost = forwardedHost || host;
  if (effectiveHost) {
    headers['x-forwarded-host'] = effectiveHost;
    headers.host = host || effectiveHost;
  }
  const forwardedProto = firstHeader(incoming['x-forwarded-proto']).toLowerCase();
  const proto = (forwardedProto === 'http' || forwardedProto === 'https')
    ? forwardedProto
    : (req && req.socket && req.socket.encrypted ? 'https' : 'http');
  headers['x-forwarded-proto'] = proto;
  // Node 反代与 Go 之间走回环连接；把真实客户端 TCP 对端地址传给 Go，避免远端请求误判成回环本机。
  const remoteAddress = String((req && req.socket && req.socket.remoteAddress) || '').trim();
  headers['x-aih-remote-addr'] = remoteAddress || 'unknown';
  return headers;
}

function readResponseHeaders(rawHeaders) {
  const out = {};
  if (!rawHeaders) return out;
  const entries = typeof rawHeaders.entries === 'function'
    ? rawHeaders.entries()
    : Object.entries(rawHeaders);
  for (const [key, value] of entries) {
    const lower = String(key || '').toLowerCase();
    if (!lower || HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (value !== undefined && value !== null) {
      out[key] = Array.isArray(value) ? value.join(', ') : String(value);
    }
  }
  return out;
}

function resolveEndpointString(value) {
  const raw = typeof value === 'function' ? value() : value;
  const trimmed = String(raw || '').trim().replace(/\/+$/, '').replace("://0.0.0.0:", "://127.0.0.1:");
  return /^https?:\/\/.+$/i.test(trimmed) ? trimmed : '';
}

function resolveGoCoreEndpoint(context = {}) {
  const deps = (context && context.deps) || {};
  const explicitEndpoint = resolveEndpointString(
    context.goCoreEndpoint || context.endpoint || deps.goCoreEndpoint || deps.endpoint
  );
  if (explicitEndpoint) return explicitEndpoint;

  const goHost = context.goCoreHost || deps.goCoreHost || context.goCoreSync || deps.goCoreSync;
  if (goHost && typeof goHost.status === 'function') {
    const status = goHost.status();
    if (!status || status.enabled === false || status.state !== 'ready') return '';
    return resolveEndpointString(status.endpoint);
  }
  return '';
}

async function fetchUpstreamFromGo(context = {}, { method, pathname, search, headers }) {
  const deps = (context && context.deps) || {};
  const goHost = context.goCoreHost || deps.goCoreHost || context.goCoreSync || deps.goCoreSync;
  if (goHost && typeof goHost.forwardPublicSubscription === 'function') {
    return goHost.forwardPublicSubscription({ method, path: `${pathname}${search}`, headers });
  }
  if (goHost && typeof goHost.openPublicStream === 'function') {
    return goHost.openPublicStream({ method, path: pathname, query: search, headers });
  }

  const endpoint = resolveGoCoreEndpoint(context);
  if (!endpoint) return null;
  const fetchImpl = context.fetchImpl || deps.fetchImpl || fetch;
  return fetchImpl(`${endpoint}${pathname}${search}`, {
    method,
    headers,
    redirect: 'manual'
  });
}

/**
 * 聚合订阅的公开拉取入口：GET /sub/<token>[?target=<格式>]；
 * 规则集转换：GET /sub/<token>/rules/<标签>?target=<格式>（Surge / Loon / QX 等用）。
 * Clash/sing-box 等客户端拉订阅不会带 Management Key，凭据就是链接里的随机 token；
 * 未知 token 一律 404，Go Core 不可用时固定 503 go_core_unavailable（零本地回落）。
 */
async function handleAggregatedSubscriptionRequest(context = {}) {
  const { req, res, method, pathname, url } = context;
  if (!pathname || !pathname.startsWith(PUBLIC_PREFIX)) return false;

  const upperMethod = String(method || (req && req.method) || 'GET').toUpperCase();
  if (upperMethod !== 'GET' && upperMethod !== 'HEAD') {
    writePlain(res, 405, 'method not allowed', upperMethod, { Allow: 'GET, HEAD' });
    return true;
  }

  const rest = pathname.slice(PUBLIC_PREFIX.length);
  if (!RULE_SET_PATH.test(rest) && !TOKEN_PATTERN.test(rest)) {
    writePlain(res, 404, 'not found', upperMethod);
    return true;
  }

  const search = readSearch(url, req);
  const headers = buildForwardHeaders(req);
  let upstream;
  try {
    upstream = await fetchUpstreamFromGo(context, { method: upperMethod, pathname, search, headers });
  } catch (_error) {
    upstream = null;
  }

  if (!upstream || !Number.isInteger(upstream.status) || upstream.status <= 0) {
    writePlain(res, 503, 'go_core_unavailable', upperMethod);
    return true;
  }

  const responseHeaders = readResponseHeaders(upstream.headers);
  if (upperMethod === 'HEAD') {
    if (upstream.body && typeof upstream.body.cancel === 'function') {
      try { await upstream.body.cancel(); } catch (_error) {}
    }
    res.writeHead(upstream.status, responseHeaders);
    res.end();
    return true;
  }

  let body;
  try {
    if (typeof upstream.arrayBuffer === 'function') {
      body = Buffer.from(await upstream.arrayBuffer());
    } else if (typeof upstream.text === 'function') {
      body = await upstream.text();
    } else if (upstream.body !== undefined && upstream.body !== null) {
      body = upstream.body;
    }
  } catch (_error) {
    writePlain(res, 503, 'go_core_unavailable', upperMethod);
    return true;
  }

  res.writeHead(upstream.status, responseHeaders);
  res.end(body);
  return true;
}

module.exports = {
  PUBLIC_PREFIX,
  handleAggregatedSubscriptionRequest
};

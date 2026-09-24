'use strict';

const { normalizePathname } = require('./protocol-registry');
const { classifyRoute } = require('./go-core-route-ownership');

// RFC 9110 §7.6.1 hop-by-hop 头；逐跳语义不得穿过代理。
const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade'
]);
// 客户端凭据只用于 Node 边界鉴权，转发时一律替换为 Go 的内部 Client Key。
const CLIENT_CREDENTIAL_HEADERS = new Set(['authorization', 'x-api-key', 'x-goog-api-key']);
const PINNED_ACCOUNT_HEADER = 'x-account-ref';
const REQUEST_ID_HEADER = 'x-aih-request-id';

function parseBearer(value) {
  const match = String(value || '').trim().match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function firstHeader(value) {
  return String(Array.isArray(value) ? value[0] : value || '').trim();
}

/** 与 Node 现行边界一致：HTTP 接受 Bearer 或 x-api-key，WebSocket 只接受 Bearer。 */
function readClientKey(headers = {}, transport) {
  const bearer = parseBearer(firstHeader(headers.authorization));
  if (bearer || transport === 'websocket') return bearer;
  return firstHeader(headers['x-api-key']);
}

function connectionListedHeaders(headers = {}) {
  return new Set(firstHeader(headers.connection).toLowerCase().split(',').map((item) => item.trim()).filter(Boolean));
}

function buildForwardRequestHeaders(incoming = {}, target, requestId, options = {}) {
  const keepUpgrade = options.keepUpgrade === true;
  const listed = connectionListedHeaders(incoming);
  const headers = {};
  for (const [rawName, value] of Object.entries(incoming)) {
    const name = rawName.toLowerCase();
    if (value === undefined || name === 'host' || name === REQUEST_ID_HEADER) continue;
    if (CLIENT_CREDENTIAL_HEADERS.has(name)) continue;
    const upgradeHeader = keepUpgrade && (name === 'connection' || name === 'upgrade');
    if (!upgradeHeader && (HOP_BY_HOP_HEADERS.has(name) || listed.has(name))) continue;
    headers[name] = value;
  }
  headers.host = `${target.host}:${target.port}`;
  headers.authorization = `Bearer ${target.clientKey}`;
  if (requestId) headers[REQUEST_ID_HEADER] = requestId;
  return headers;
}

function buildForwardResponseHeaders(upstreamHeaders = {}) {
  const listed = connectionListedHeaders(upstreamHeaders);
  const headers = {};
  for (const [rawName, value] of Object.entries(upstreamHeaders)) {
    const name = rawName.toLowerCase();
    if (value === undefined || name === REQUEST_ID_HEADER) continue;
    if (HOP_BY_HOP_HEADERS.has(name) || listed.has(name)) continue;
    headers[name] = value;
  }
  return headers;
}

function forwardedPath(rawUrl, pathname) {
  const url = String(rawUrl || '');
  const queryIndex = url.indexOf('?');
  return `${normalizePathname(pathname) || '/'}${queryIndex >= 0 ? url.slice(queryIndex) : ''}`;
}

function serializeUpgradeRequest(method, path, headers) {
  const lines = [`${method} ${path} HTTP/1.1`];
  for (const [name, value] of Object.entries(headers)) {
    for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`);
  }
  return `${lines.join('\r\n')}\r\n\r\n`;
}

function writeRawStatus(socket, statusLine) {
  try { socket.end(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch (_error) {}
  try { socket.destroy(); } catch (_error) {}
}

/**
 * Node 公开宿主到 Go Core 的透明转发（Proxy）。只做鉴权、凭据替换与字节搬运：
 * 不选号、不重试、不重编码协议、不回退 Node 路径——已划给 Go 的路由在 Go 缺席时失败关闭。
 */
function createGoCoreGatewayForwarder(deps = {}) {
  const http = deps.http || require('node:http');
  const net = deps.net || require('node:net');
  const routeTable = deps.routeTable || [];
  const entryIds = deps.entryIds instanceof Set ? deps.entryIds : new Set(deps.entryIds || []);
  const getTarget = typeof deps.getTarget === 'function' ? deps.getTarget : () => null;
  const requiredClientKey = String(deps.requiredClientKey || '').trim();
  const writeJson = deps.writeJson;
  const agent = deps.agent || new http.Agent({ keepAlive: true });

  function ownedEntry(transport, method, pathname) {
    if (entryIds.size === 0) return '';
    const entryId = classifyRoute(routeTable, { transport, method, pathname });
    return entryId && entryIds.has(entryId) ? entryId : '';
  }

  function rejectHttp(req, res, statusCode, body) {
    req.resume();
    writeJson(res, statusCode, { ok: false, ...body });
    return true;
  }

  function tryHandleHttp(req, res, ctx = {}) {
    const method = String(ctx.method || req.method || 'GET').toUpperCase();
    const entryId = ownedEntry('http', method, ctx.pathname);
    if (!entryId) return false;
    if (requiredClientKey && readClientKey(req.headers, 'http') !== requiredClientKey) {
      return rejectHttp(req, res, 401, { error: 'unauthorized_client' });
    }
    if (firstHeader(req.headers[PINNED_ACCOUNT_HEADER])) {
      return rejectHttp(req, res, 501, {
        error: 'go_core_capability_unsupported', capability: 'account_pin', route: entryId
      });
    }
    const target = getTarget();
    if (!target) return rejectHttp(req, res, 503, { error: 'go_core_unavailable', route: entryId });

    const upstreamRequest = http.request({
      host: target.host,
      port: target.port,
      method,
      path: forwardedPath(req.url, ctx.pathname),
      headers: buildForwardRequestHeaders(req.headers, target, ctx.requestId),
      agent
    });
    upstreamRequest.on('response', (upstreamResponse) => {
      res.writeHead(upstreamResponse.statusCode || 502, buildForwardResponseHeaders(upstreamResponse.headers));
      upstreamResponse.on('error', () => res.destroy());
      upstreamResponse.on('aborted', () => res.destroy());
      upstreamResponse.pipe(res);
    });
    upstreamRequest.on('error', () => {
      // 响应头尚未提交才能给出结构化错误；提交后只能断开，绝不重放到其它账号或 Node 路径。
      if (!res.headersSent) {
        req.resume();
        writeJson(res, 503, { ok: false, error: 'go_core_unavailable', route: entryId });
      } else {
        res.destroy();
      }
    });
    res.on('close', () => {
      if (!res.writableFinished) upstreamRequest.destroy();
    });
    req.on('aborted', () => upstreamRequest.destroy());
    req.pipe(upstreamRequest);
    return true;
  }

  function tryHandleUpgrade(req, socket, head, ctx = {}) {
    const entryId = ownedEntry('websocket', req.method, ctx.pathname);
    if (!entryId) return false;
    if (requiredClientKey && readClientKey(req.headers, 'websocket') !== requiredClientKey) {
      writeRawStatus(socket, '401 Unauthorized');
      return true;
    }
    if (firstHeader(req.headers[PINNED_ACCOUNT_HEADER])) {
      writeRawStatus(socket, '501 Not Implemented');
      return true;
    }
    const target = getTarget();
    if (!target) {
      writeRawStatus(socket, '503 Service Unavailable');
      return true;
    }

    let connected = false;
    const upstream = net.connect({ host: target.host, port: target.port });
    const closeBoth = () => {
      try { upstream.destroy(); } catch (_error) {}
      try { socket.destroy(); } catch (_error) {}
    };
    upstream.once('connect', () => {
      connected = true;
      if (typeof upstream.setNoDelay === 'function') upstream.setNoDelay(true);
      if (typeof socket.setNoDelay === 'function') socket.setNoDelay(true);
      const headers = buildForwardRequestHeaders(req.headers, target, ctx.requestId, { keepUpgrade: true });
      upstream.write(serializeUpgradeRequest(
        String(req.method || 'GET').toUpperCase(),
        forwardedPath(req.url, ctx.pathname),
        headers
      ));
      if (head && head.length > 0) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on('error', () => {
      if (!connected) writeRawStatus(socket, '503 Service Unavailable');
      closeBoth();
    });
    upstream.on('close', closeBoth);
    socket.on('error', closeBoth);
    socket.on('close', closeBoth);
    return true;
  }

  return { tryHandleHttp, tryHandleUpgrade };
}

module.exports = {
  buildForwardRequestHeaders,
  buildForwardResponseHeaders,
  createGoCoreGatewayForwarder,
  readClientKey
};

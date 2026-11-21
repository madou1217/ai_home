'use strict';
const { writeCodexRelayError } = require('./codex-relay-errors');

const { normalizePathname } = require('./protocol-registry');
const { classifyRoute } = require('./go-core-route-ownership');
const { ROUTE_OWNER_HEADER } = require('../protocol/route-owner-header');
const {
  reserveRequestBodyBytes,
  releaseRequestBodyBytes,
  holdRequestBodyBudget
} = require('./request-body-budget');

// RFC 9110 §7.6.1 hop-by-hop 头；逐跳语义不得穿过代理。
const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade'
]);
// 客户端凭据只用于 Node 边界鉴权，转发时一律替换为 Go 的内部 Client Key。
const CLIENT_CREDENTIAL_HEADERS = new Set(['authorization', 'x-api-key', 'x-goog-api-key']);
const PINNED_ACCOUNT_HEADER = 'x-account-ref';
const REQUEST_ID_HEADER = 'x-aih-request-id';
const CLAUDE_MESSAGES_ENTRY_ID = 'gateway.anthropic.messages';
// 插件代次固定头只允许内部转发设置；客户端自带的值一律丢弃（Go 网关默认用活跃代次）。
const PLUGIN_GENERATION_HEADER = 'x-aih-plugin-generation';
// Go 用它拼客户端可达的 URL（图片 blob）；只由 Node 设置，客户端自带的值一律丢弃。
const FORWARDED_HOST_HEADER = 'x-forwarded-host';

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
  // x-goog-api-key：Gemini / Vertex 客户端（gemini CLI vertex-ai 认证）的密钥头。
  return firstHeader(headers['x-api-key']) || firstHeader(headers['x-goog-api-key']);
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
    if (value === undefined || name === 'host' || name === REQUEST_ID_HEADER
      || name === FORWARDED_HOST_HEADER || name === PLUGIN_GENERATION_HEADER
      || name === ROUTE_OWNER_HEADER) continue;
    if (CLIENT_CREDENTIAL_HEADERS.has(name)) continue;
    const upgradeHeader = keepUpgrade && (name === 'connection' || name === 'upgrade');
    if (!upgradeHeader && (HOP_BY_HOP_HEADERS.has(name) || listed.has(name))) continue;
    headers[name] = value;
  }
  if (firstHeader(incoming.host)) headers[FORWARDED_HOST_HEADER] = firstHeader(incoming.host);
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

// 请求体在转发前读入缓冲区：Claude 鉴权恢复要用同一份字节重放，路由观测也要读模型。
// 响应仍逐字节透传。
const BUFFERED_BODY_KEY = 'aihBufferedBody';

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let reserved = 0;
    let settled = false;
    const release = () => {
      if (reserved > 0) releaseRequestBodyBytes(reserved);
      reserved = 0;
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      release();
      try { req.resume(); } catch (_resumeError) {}
      reject(error);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      if (!reserveRequestBodyBytes(chunk.length)) {
        fail(Object.assign(new Error('request_body_buffer_budget_exhausted'), { code: 'request_body_buffer_budget_exhausted' }));
        return;
      }
      reserved += chunk.length;
      total += chunk.length;
      if (maxBytes > 0 && total > maxBytes) {
        fail(Object.assign(new Error('request_body_too_large'), { code: 'request_body_too_large' }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const body = Buffer.concat(chunks);
      holdRequestBodyBudget(req, reserved);
      reserved = 0;
      resolve(body);
    });
    req.on('error', fail);
    req.on('aborted', () => {
      fail(Object.assign(new Error('request_aborted'), { code: 'request_aborted' }));
    });
  });
}

function writeRawStatus(socket, statusLine) {
  try { socket.end(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch (_error) {}
  try { socket.destroy(); } catch (_error) {}
}

/**
 * Node 公开宿主到 Go Core 的透明转发（Proxy）。只做鉴权、凭据替换与字节搬运：
 * 不选号、不重试、不重编码协议——推理入口全部归 Go，Go 缺席时失败关闭。
 * Go 侧读取的请求头（x-provider / x-aih-model-namespace / x-aih-model-alias /
 * x-account-ref）原样透传，由 Go 执行语义。
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
  const maxRequestBodyBytes = Number(deps.maxRequestBodyBytes) || 0;
  const recoverClaudeAuth = typeof deps.recoverClaudeAuth === 'function'
    ? deps.recoverClaudeAuth
    : null;
  // 把钉选头里的 Node 账号 id 翻译成 Go 账号 id（历史迁移/同身份合并后两边 id 不同）。
  const mapPinnedAccountRef = typeof deps.mapPinnedAccountRef === 'function' ? deps.mapPinnedAccountRef : null;

  function withGoPinnedAccountRef(headers) {
    const pinned = firstHeader(headers[PINNED_ACCOUNT_HEADER]);
    if (!pinned || !mapPinnedAccountRef) return headers;
    const goRef = mapPinnedAccountRef(pinned);
    return goRef && goRef !== pinned ? { ...headers, [PINNED_ACCOUNT_HEADER]: goRef } : headers;
  }

  function ownedEntry(transport, method, pathname) {
    if (entryIds.size === 0) return '';
    const entryId = classifyRoute(routeTable, { transport, method, pathname });
    return entryId && entryIds.has(entryId) ? entryId : '';
  }

  function rejectHttp(req, res, statusCode, body) {
    if (!req.complete) req.resume();
    writeJson(res, statusCode, { ok: false, ...body });
    return true;
  }

  async function tryHandleHttp(req, res, ctx = {}) {
    const method = String(ctx.method || req.method || 'GET').toUpperCase();
    const entryId = ownedEntry('http', method, ctx.pathname);
    if (!entryId) return false;
    const responsesRequest = method === 'POST' && normalizePathname(ctx.pathname) === '/v1/responses';
    if (requiredClientKey && readClientKey(req.headers, 'http') !== requiredClientKey) {
      if (responsesRequest) {
        req.resume();
        writeCodexRelayError(res, 'unauthorized');
        return true;
      }
      return rejectHttp(req, res, 401, { error: 'unauthorized_client' });
    }
    let bufferedBody = null;
    try {
      bufferedBody = await readBody(req, maxRequestBodyBytes);
    } catch (error) {
      const tooLarge = ['request_body_too_large', 'request_body_buffer_budget_exhausted'].includes(error.code);
      if (responsesRequest) writeCodexRelayError(res, tooLarge ? 'request_too_large' : 'invalid_request_body');
      else writeJson(res, tooLarge ? 413 : 400, { ok: false, error: error.code || 'invalid_request_body' });
      return true;
    }
    const target = getTarget();
    if (!target) return rejectHttp(req, res, 503, { error: 'go_core_unavailable', route: entryId });

    const forwardHeaders = withGoPinnedAccountRef(buildForwardRequestHeaders(req.headers, target, ctx.requestId));
    forwardHeaders['content-length'] = String(bufferedBody.length);
    let activeUpstreamRequest = null;

    const pipeUpstreamResponse = (upstreamResponse, upstreamRequest, resolve) => {
      if (res.destroyed) {
        upstreamResponse.resume();
        resolve(true);
        return;
      }
      upstreamResponse.once('end', () => {
        if (activeUpstreamRequest === upstreamRequest) activeUpstreamRequest = null;
      });
      upstreamResponse.once('aborted', () => {
        if (activeUpstreamRequest === upstreamRequest) activeUpstreamRequest = null;
      });
      // Go 选号后写回服务账号头：交给宿主落「路由观测」，与 Node 路径共用同一个观察者
      // （网关模式的终端标题靠它显示当前账号 / 模型）。观测失败绝不影响转发。
      if (typeof deps.onServed === 'function' && (upstreamResponse.statusCode || 0) < 400) {
        try {
          deps.onServed({
            entryId,
            headers: req.headers,
            body: bufferedBody,
            servedAccountRef: firstHeader(upstreamResponse.headers['x-aih-server-account-ref']),
            servedProvider: firstHeader(upstreamResponse.headers['x-aih-server-provider'])
          });
        } catch (_error) {}
      }
      res.writeHead(upstreamResponse.statusCode || 502, buildForwardResponseHeaders(upstreamResponse.headers));
      upstreamResponse.on('error', () => res.destroy());
      upstreamResponse.on('aborted', () => res.destroy());
      upstreamResponse.pipe(res);
      resolve(true);
    };

    const sendBufferedRequest = (allowClaudeRecovery) => new Promise((resolve) => {
      const upstreamRequest = http.request({
        host: target.host,
        port: target.port,
        method,
        path: forwardedPath(req.url, ctx.pathname),
        headers: forwardHeaders,
        agent
      });
      activeUpstreamRequest = upstreamRequest;
      upstreamRequest.on('response', (upstreamResponse) => {
        const recoverableClaudeResponse = allowClaudeRecovery
          && recoverClaudeAuth
          && entryId === CLAUDE_MESSAGES_ENTRY_ID
          && (upstreamResponse.statusCode === 401 || upstreamResponse.statusCode === 403);
        if (!recoverableClaudeResponse) {
          pipeUpstreamResponse(upstreamResponse, upstreamRequest, resolve);
          return;
        }
        Promise.resolve(recoverClaudeAuth({
          entryId,
          statusCode: upstreamResponse.statusCode,
          accountRef: firstHeader(req.headers[PINNED_ACCOUNT_HEADER]),
          servedAccountRef: firstHeader(upstreamResponse.headers['x-aih-server-account-ref']),
          requestId: ctx.requestId
        })).then((recovered) => {
          if (res.destroyed || req.aborted) {
            upstreamResponse.resume();
            resolve(true);
            return;
          }
          if (!recovered) {
            pipeUpstreamResponse(upstreamResponse, upstreamRequest, resolve);
            return;
          }
          upstreamResponse.resume();
          sendBufferedRequest(false).then(resolve).catch(() => {
            if (!res.headersSent) {
              writeJson(res, 503, { ok: false, error: 'go_core_unavailable', route: entryId });
            } else {
              res.destroy();
            }
            resolve(true);
          });
        }).catch(() => pipeUpstreamResponse(upstreamResponse, upstreamRequest, resolve));
      });
      upstreamRequest.on('error', () => {
        activeUpstreamRequest = null;
        // Go 是唯一推理承接方：连接失败直接给出结构化 503，不把缓冲体交还其它宿主。
        if (!res.headersSent) {
          writeJson(res, 503, { ok: false, error: 'go_core_unavailable', route: entryId });
        } else {
          res.destroy();
        }
        resolve(true);
      });
      upstreamRequest.end(bufferedBody);
    });

    res.on('close', () => {
      if (!res.writableFinished && activeUpstreamRequest) activeUpstreamRequest.destroy();
    });
    req.on('aborted', () => {
      if (activeUpstreamRequest) activeUpstreamRequest.destroy();
    });
    req[BUFFERED_BODY_KEY] = bufferedBody;
    return sendBufferedRequest(true);
  }

  function tryHandleUpgrade(req, socket, head, ctx = {}) {
    const entryId = ownedEntry('websocket', req.method, ctx.pathname);
    if (!entryId) return false;
    if (requiredClientKey && readClientKey(req.headers, 'websocket') !== requiredClientKey) {
      writeRawStatus(socket, '401 Unauthorized');
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
      const headers = withGoPinnedAccountRef(buildForwardRequestHeaders(req.headers, target, ctx.requestId, { keepUpgrade: true }));
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
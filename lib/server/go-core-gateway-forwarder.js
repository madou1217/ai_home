'use strict';
const { writeCodexRelayError } = require('./codex-relay-errors');
const { decodeCodexRequestBody } = require('./codex-http-request-body');

const { normalizePathname } = require('./protocol-registry');
const { classifyRoute } = require('./go-core-route-ownership');
const { DECODE_REJECTED_HEADER, isGoDecodeRejection } = require('./go-core-decode-fallback');
const { goNeverReceivedRequest } = require('./go-core-connect-fallback');

// RFC 9110 §7.6.1 hop-by-hop 头；逐跳语义不得穿过代理。
const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade'
]);
// 客户端凭据只用于 Node 边界鉴权，转发时一律替换为 Go 的内部 Client Key。
const CLIENT_CREDENTIAL_HEADERS = new Set(['authorization', 'x-api-key', 'x-goog-api-key']);
const PINNED_ACCOUNT_HEADER = 'x-account-ref';
const REQUEST_ID_HEADER = 'x-aih-request-id';
// 插件代次只由 Node 设置（Go 的 gateway.request 闸门据此执行）；客户端自带的值一律丢弃。
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
    if (value === undefined || name === 'host' || name === REQUEST_ID_HEADER || name === FORWARDED_HOST_HEADER || name === PLUGIN_GENERATION_HEADER) continue;
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
    if (value === undefined || name === REQUEST_ID_HEADER || name === DECODE_REJECTED_HEADER) continue;
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

// 判定需要模型时（别名交还 Node），在转发前读完请求体；Node 自己也整体缓冲请求体，
// 因此不损失流式（响应仍逐字节透传）。交还 Node 时把已读的体挂在 req 上供其复用。
const BUFFERED_BODY_KEY = 'aihBufferedBody';

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (maxBytes > 0 && total > maxBytes) {
        reject(Object.assign(new Error('request_body_too_large'), { code: 'request_body_too_large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** 模型：Gemini 在路径里（/models/{m}:generateContent），其余协议在 JSON 体的 model 字段。 */
function readRequestModel(pathname, body) {
  const gemini = String(pathname || '').match(/\/models\/([^/:]+):(?:stream)?[gG]enerateContent$/);
  if (gemini) {
    try { return decodeURIComponent(gemini[1]); } catch (_error) { return gemini[1]; }
  }
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    return parsed && typeof parsed.model === 'string' ? parsed.model.trim() : '';
  } catch (_error) {
    return '';
  }
}

function writeRawStatus(socket, statusLine) {
  try { socket.end(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch (_error) {}
  try { socket.destroy(); } catch (_error) {}
}

/**
 * Node 公开宿主到 Go Core 的透明转发（Proxy）。只做鉴权、凭据替换与字节搬运：
 * 不选号、不重试、不重编码协议——已划给 Go 的路由在 Go 缺席时失败关闭。
 * 唯一的回退是 Go 显式标记的协议解码拒收（尚未选号、未请求上游），此时把已缓冲的
 * 请求体交还 Node 路径，见 go-core-decode-fallback。
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
  // 宿主提供的「交还 Node」判定：钉选不可用（Node 负责回落 / 403 / 404）、Fabric 远端网关
  // 在线（Fabric 路由只存在于 Node v1 路由里）等情况下，请求不转发，按 Node 现行语义处理。
  const deferToNode = typeof deps.deferToNode === 'function' ? deps.deferToNode : null;
  const needsRequestModel = typeof deps.needsRequestModel === 'function' ? deps.needsRequestModel : () => false;
  const maxRequestBodyBytes = Number(deps.maxRequestBodyBytes) || 0;
  // 把钉选头里的 Node 账号 id 翻译成 Go 账号 id（迁移 rekey / 同身份合并后两边 id 不同）。
  const mapPinnedAccountRef = typeof deps.mapPinnedAccountRef === 'function' ? deps.mapPinnedAccountRef : null;

  function withGoPinnedAccountRef(headers) {
    const pinned = firstHeader(headers[PINNED_ACCOUNT_HEADER]);
    if (!pinned || !mapPinnedAccountRef) return headers;
    const goRef = mapPinnedAccountRef(pinned);
    return goRef && goRef !== pinned ? { ...headers, [PINNED_ACCOUNT_HEADER]: goRef } : headers;
  }

  async function shouldDefer(entryId, headers, transport, model, pathname) {
    if (!deferToNode) return false;
    return Boolean(await deferToNode({
      entryId, transport, model, pathname, pinnedAccountRef: firstHeader(headers[PINNED_ACCOUNT_HEADER])
    }));
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
    if (deferToNode && needsRequestModel(entryId)) {
      try {
        bufferedBody = await readBody(req, maxRequestBodyBytes);
      } catch (error) {
        writeJson(res, error.code === 'request_body_too_large' ? 413 : 400, { ok: false, error: error.code || 'invalid_request_body' });
        return true;
      }
    }
    let modelBody = bufferedBody;
    if (responsesRequest && bufferedBody) {
      try {
        modelBody = decodeCodexRequestBody(bufferedBody, req.headers, maxRequestBodyBytes);
      } catch (_) {
        writeCodexRelayError(res, 'invalid_request_body');
        return true;
      }
    }
    const model = modelBody ? readRequestModel(ctx.pathname, modelBody) : '';
    if (await shouldDefer(entryId, req.headers, 'http', model, ctx.pathname)) {
      if (bufferedBody) req[BUFFERED_BODY_KEY] = bufferedBody;
      return false;
    }
    // 没有宿主判定时无法确认钉选可用，失败关闭；有判定时可用钉选原样交给 Go 独占路由。
    if (!deferToNode && firstHeader(req.headers[PINNED_ACCOUNT_HEADER])) {
      return rejectHttp(req, res, 501, {
        error: 'go_core_capability_unsupported', capability: 'account_pin', route: entryId
      });
    }
    const target = getTarget();
    if (!target) return rejectHttp(req, res, 503, { error: 'go_core_unavailable', route: entryId });

    const forwardHeaders = withGoPinnedAccountRef(buildForwardRequestHeaders(req.headers, target, ctx.requestId));
    if (bufferedBody) forwardHeaders['content-length'] = String(bufferedBody.length);
    // 插件：Node 固定代次（租约持有到响应结束），Go 按代次头执行 gateway.request；Go 未确认该代次时交回 Node。
    const plugin = typeof deps.pluginForwarding === 'function' ? deps.pluginForwarding({ entryId }) : null;
    if (plugin && plugin.defer) {
      if (bufferedBody) req[BUFFERED_BODY_KEY] = bufferedBody;
      return false;
    }
    if (plugin) {
      forwardHeaders[PLUGIN_GENERATION_HEADER] = String(plugin.generation);
      res.once('close', () => plugin.release());
    }
    const upstreamRequest = http.request({
      host: target.host,
      port: target.port,
      method,
      path: forwardedPath(req.url, ctx.pathname),
      headers: forwardHeaders,
      agent
    });
    // 有缓冲体时等 Go 响应头再定归属：只有这时才可能把请求原样交还 Node。
    const handled = new Promise((resolve) => {
      upstreamRequest.on('response', (upstreamResponse) => {
        if (bufferedBody && isGoDecodeRejection(upstreamResponse)) {
          upstreamResponse.resume();
          req[BUFFERED_BODY_KEY] = bufferedBody;
          if (typeof deps.onDecodeFallback === 'function') deps.onDecodeFallback({ entryId, requestId: ctx.requestId });
          resolve(false);
          return;
        }
        res.writeHead(upstreamResponse.statusCode || 502, buildForwardResponseHeaders(upstreamResponse.headers));
        upstreamResponse.on('error', () => res.destroy());
        upstreamResponse.on('aborted', () => res.destroy());
        upstreamResponse.pipe(res);
        resolve(true);
      });
      upstreamRequest.on('error', (error) => {
        // 连接没建立（Go 重启窗口里的旧端口）：Go 什么都没收到，缓冲体原样交还 Node，不是重放。
        if (bufferedBody && !res.headersSent && goNeverReceivedRequest(error)) {
          req[BUFFERED_BODY_KEY] = bufferedBody;
          if (typeof deps.onUnavailableFallback === 'function') {
            deps.onUnavailableFallback({ entryId, requestId: ctx.requestId, code: error.code });
          }
          resolve(false);
          return;
        }
        // 响应头尚未提交才能给出结构化错误；提交后只能断开，绝不重放到其它账号或 Node 路径。
        if (!res.headersSent) {
          req.resume();
          writeJson(res, 503, { ok: false, error: 'go_core_unavailable', route: entryId });
        } else {
          res.destroy();
        }
        resolve(true);
      });
    });
    res.on('close', () => {
      if (!res.writableFinished) upstreamRequest.destroy();
    });
    req.on('aborted', () => upstreamRequest.destroy());
    if (bufferedBody) {
      upstreamRequest.end(bufferedBody);
      return handled;
    }
    req.pipe(upstreamRequest);
    return true;
  }

  function tryHandleUpgrade(req, socket, head, ctx = {}) {
    const entryId = ownedEntry('websocket', req.method, ctx.pathname);
    if (!entryId) return false;
    // 升级请求没有可读的模型（模型在后续帧里），判定只看钉选，必须同步完成。
    if (deferToNode && deferToNode({
      entryId, transport: 'websocket', model: '', pinnedAccountRef: firstHeader(req.headers[PINNED_ACCOUNT_HEADER])
    }) === true) return false;
    if (requiredClientKey && readClientKey(req.headers, 'websocket') !== requiredClientKey) {
      writeRawStatus(socket, '401 Unauthorized');
      return true;
    }
    if (!deferToNode && firstHeader(req.headers[PINNED_ACCOUNT_HEADER])) {
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

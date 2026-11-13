'use strict';

// 本机入口转发管理（nginx / caddy / frp）的 WebUI 路由：
// 探测、方案生成、备份写入、校验重载与互斥锁全部已迁移至 Go（webuitoolkitextapi + internal/runtime/edgeproxy）。
// Node 侧仅提取 AIH 实际监听端口并零回落代理到 /v1/management/webui/toolkit/edge*。

const { readRequestBody, writeJson: sharedWriteJson } = require('./http-utils');
const { proxyWebuiGo } = require('./webui-go-proxy');

const ROUTE_PREFIX = '/v0/webui/toolkit/edge';
const GO_PREFIX = '/v1/management/webui/toolkit/edge';
const MAX_JSON_BODY_BYTES = 64 * 1024;
const EDGE_PASS_STATUSES = [400, 403, 404, 409, 413, 422, 429];

function resolveAihPort(ctx = {}, req = null) {
  const deps = ctx.deps || {};
  const options = deps.options || {};
  const candidates = [
    req && req.socket && req.socket.localPort,
    options.port,
    options.proxyPort,
    deps.port,
    deps.aihPort,
    deps.runtimeStatus && deps.runtimeStatus.listenPort,
    process.env.AIH_PORT
  ];
  for (const raw of candidates) {
    const num = Number(raw);
    if (Number.isInteger(num) && num > 0 && num <= 65535) return num;
  }
  const hostHeader = String((req && req.headers && req.headers.host) || '');
  const hostMatch = hostHeader.match(/:(\d+)$/);
  if (hostMatch) {
    const port = Number(hostMatch[1]);
    if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
  }
  return 3000;
}

async function readJsonBody(req, ctx = {}, maxBytes = MAX_JSON_BODY_BYTES) {
  const read = ctx.readRequestBody || readRequestBody;
  const buffer = await read(req, { maxBytes });
  const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer || '');
  if (!text.trim()) return {};
  return JSON.parse(text);
}

function isBodyTooLargeError(error) {
  const code = String((error && (error.code || error.message)) || '');
  return code === 'request_body_too_large' || code === 'Body too large';
}

function buildProxyContext(req, res, method, ctx) {
  return {
    ...ctx,
    req,
    res,
    method,
    writeJson: ctx.writeJson || sharedWriteJson
  };
}

/**
 * Routes handler for /v0/webui/toolkit/edge/*
 */
async function handleWebUiEdgeProxyRoutes(req, res, method, pathname, ctx = {}) {
  if (pathname !== ROUTE_PREFIX && !pathname.startsWith(`${ROUTE_PREFIX}/`)) return false;
  const write = ctx.writeJson || sharedWriteJson;
  const proxyCtx = buildProxyContext(req, res, method, ctx);
  const aihPort = resolveAihPort(ctx, req);

  if (method === 'GET' && pathname === ROUTE_PREFIX) {
    return proxyWebuiGo(proxyCtx, {
      method: 'GET',
      path: GO_PREFIX,
      query: new URLSearchParams({ aihPort: String(aihPort) }).toString(),
      passStatuses: EDGE_PASS_STATUSES,
      useFullBody: true,
      message: 'Go Core 未就绪，边缘转发状态不可用'
    });
  }

  if (method === 'GET' && pathname === `${ROUTE_PREFIX}/plan`) {
    const url = new URL(req.url || pathname, 'http://localhost');
    if (!url.searchParams.get('aihPort') && aihPort) {
      url.searchParams.set('aihPort', String(aihPort));
    }
    return proxyWebuiGo(proxyCtx, {
      method: 'GET',
      path: `${GO_PREFIX}/plan`,
      query: url.searchParams.toString(),
      passStatuses: EDGE_PASS_STATUSES,
      useFullBody: true,
      message: 'Go Core 未就绪，边缘转发计划生成不可用'
    });
  }

  if (method === 'POST' && pathname === `${ROUTE_PREFIX}/apply`) {
    let body;
    try {
      body = await readJsonBody(req, ctx);
    } catch (error) {
      if (isBodyTooLargeError(error)) {
        write(res, 413, { ok: false, error: 'request_body_too_large' });
        return true;
      }
      write(res, 400, { ok: false, error: 'invalid_json_body' });
      return true;
    }
    const payload = body && typeof body === 'object' && !Array.isArray(body) ? { ...body } : {};
    if (!payload.aihPort && aihPort) {
      payload.aihPort = aihPort;
    }
    return proxyWebuiGo(proxyCtx, {
      method: 'POST',
      path: `${GO_PREFIX}/apply`,
      body: payload,
      passStatuses: EDGE_PASS_STATUSES,
      useFullBody: true,
      message: 'Go Core 未就绪，边缘转发应用不可用'
    });
  }

  return false;
}

module.exports = {
  handleWebUiEdgeProxyRoutes,
  ROUTE_PREFIX
};

'use strict';

// WebUI 出口池面板路由 —— 全部快照计算、分页、ETag 协商、探测与节点/策略控制已迁至 Go Core（零回落）。
//   GET  /v0/webui/egress-pool                         -> GET  /v1/management/webui/egress-pool
//   GET  /v0/webui/egress-pool-groups                  -> GET  /v1/management/webui/egress-pool-groups
//   GET  /v0/webui/egress-pools                        -> GET  /v1/management/webui/egress-pools
//   GET  /v0/webui/egress-pools/:poolId                -> GET  /v1/management/webui/egress-pools/:poolId
//   GET  /v0/webui/egress-nodes/:nodeId                -> GET  /v1/management/webui/egress-nodes/:nodeId
//   GET  /v0/webui/egress-evidence                     -> GET  /v1/management/webui/egress-evidence
//   POST /v0/webui/egress-pool/probe                   -> POST /v1/management/webui/egress-pool/probe
//   GET|POST /v0/webui/egress-pool/node-policy         -> GET|POST /v1/management/webui/egress-pool/node-policy
//   POST /v0/webui/egress-pool/node-policy/clear-disabled -> POST /v1/management/webui/egress-pool/node-policy/clear-disabled
//   POST /v0/webui/egress-pool/nodes/:name/:action     -> POST /v1/management/webui/egress-pool/nodes/:name/:action

const { proxyWebuiGo, resolveGoHost, writeGoFailure } = require('./webui-go-proxy');

const ROOT_PATH = '/v0/webui/egress-pool';
const RESOURCE_GROUPS_PATH = '/v0/webui/egress-pool-groups';
const RESOURCE_POOLS_PATH = '/v0/webui/egress-pools';
const RESOURCE_POOL_PATTERN = /^\/v0\/webui\/egress-pools\/([^/]+)$/;
const RESOURCE_NODE_PATTERN = /^\/v0\/webui\/egress-nodes\/([^/]+)$/;
const RESOURCE_EVIDENCE_PATH = '/v0/webui/egress-evidence';
const NODE_ACTION_PATTERN = /^\/v0\/webui\/egress-pool\/nodes\/([^/]+)\/(select|clear-cooldown|block|unblock)$/;
const POLICY_PATH = `${ROOT_PATH}/node-policy`;
const POLICY_CLEAR_PATH = `${ROOT_PATH}/node-policy/clear-disabled`;

const GO_PREFIX = '/v1/management/webui';

function matchEgressPoolRoute(method, pathname) {
  const verb = String(method || '').toUpperCase();
  const path = String(pathname || '');
  if (verb === 'GET' && path === ROOT_PATH) return true;
  if (verb === 'GET' && path === POLICY_PATH) return true;
  if (verb === 'GET' && (path === RESOURCE_GROUPS_PATH || path === RESOURCE_POOLS_PATH
    || RESOURCE_POOL_PATTERN.test(path) || RESOURCE_NODE_PATTERN.test(path) || path === RESOURCE_EVIDENCE_PATH)) return true;
  if (verb === 'POST' && path === `${ROOT_PATH}/probe`) return true;
  if (verb === 'POST' && (path === POLICY_PATH || path === POLICY_CLEAR_PATH)) return true;
  return verb === 'POST' && NODE_ACTION_PATTERN.test(path);
}

function readQueryString(ctx) {
  if (ctx && ctx.url && ctx.url.searchParams) {
    return ctx.url.searchParams.toString();
  }
  const rawUrl = String((ctx && ctx.req && ctx.req.url) || '');
  const qIndex = rawUrl.indexOf('?');
  return qIndex >= 0 ? rawUrl.slice(qIndex + 1) : '';
}

function readIfNoneMatch(ctx) {
  const headers = (ctx && ctx.req && ctx.req.headers) || {};
  return String(headers['if-none-match'] || '').trim();
}

function hasPageQuery(ctx) {
  try {
    if (ctx && ctx.url && ctx.url.searchParams) {
      return ctx.url.searchParams.has('page');
    }
    const raw = String((ctx && ctx.req && ctx.req.url) || '');
    return new URL(raw, 'http://localhost').searchParams.has('page');
  } catch (_error) {
    return false;
  }
}

async function readJsonBody(ctx) {
  try {
    const body = typeof ctx.readRequestBody === 'function'
      ? await ctx.readRequestBody(ctx.req, { maxBytes: 8 * 1024 })
      : null;
    const parsed = body && body.length ? JSON.parse(body.toString('utf8')) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_error) {
    return null;
  }
}

function decodeSegment(raw) {
  try {
    return decodeURIComponent(raw).trim();
  } catch (_error) {
    return '';
  }
}

async function handlePoolGetWithEtag(ctx, query) {
  const goHost = resolveGoHost(ctx);
  const ifNoneMatch = readIfNoneMatch(ctx);
  if ((hasPageQuery(ctx) || ifNoneMatch) && goHost && typeof goHost.openWebuiStream === 'function') {
    let upstream = null;
    try {
      upstream = await goHost.openWebuiStream({
        method: 'GET',
        path: `${GO_PREFIX}/egress-pool`,
        query,
        accept: 'application/json',
        headers: ifNoneMatch ? { 'if-none-match': ifNoneMatch } : undefined
      });
    } catch (_error) {
      upstream = null;
    }
    if (!upstream) {
      ctx.writeJson(ctx.res, 503, { ok: false, error: 'go_core_unavailable', message: 'Go Core 未就绪，无法读取出口池' });
      return true;
    }
    const etag = upstream.headers && typeof upstream.headers.get === 'function'
      ? String(upstream.headers.get('etag') || '').trim()
      : '';
    if (upstream.status === 304) {
      if (ctx.res && typeof ctx.res.writeHead === 'function') {
        ctx.res.writeHead(304, etag ? { ETag: etag } : {});
        ctx.res.end();
      } else {
        ctx.writeJson(ctx.res, 304, null);
      }
      return true;
    }
    const text = typeof upstream.text === 'function' ? await upstream.text().catch(() => '') : '';
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_error) { data = null; }
    if (upstream.ok && data) {
      if (etag && ctx.res && typeof ctx.res.writeHead === 'function') {
        ctx.res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ETag: etag });
        ctx.res.end(JSON.stringify(data));
        return true;
      }
      ctx.writeJson(ctx.res, 200, data);
      return true;
    }
    return writeGoFailure(ctx, { status: upstream.status, data }, {
      message: 'Go Core 未就绪，无法读取出口池'
    });
  }

  return proxyWebuiGo(ctx, {
    method: 'GET',
    path: `${GO_PREFIX}/egress-pool`,
    query,
    message: 'Go Core 未就绪，无法读取出口池'
  });
}

async function handleEgressPoolRequest(ctx = {}) {
  const { writeJson, res, req } = ctx;
  const method = String(ctx.method || (req && req.method) || '').toUpperCase();
  const pathname = String(ctx.pathname || '');
  const query = readQueryString(ctx);

  if (method === 'GET') {
    if (pathname === ROOT_PATH) {
      return handlePoolGetWithEtag(ctx, query);
    }
    if (pathname === POLICY_PATH) {
      return proxyWebuiGo(ctx, {
        method: 'GET',
        path: `${GO_PREFIX}/egress-pool/node-policy`,
        message: 'Go Core 未就绪，无法读取节点策略'
      });
    }
    if (pathname === RESOURCE_GROUPS_PATH) {
      return proxyWebuiGo(ctx, {
        method: 'GET',
        path: `${GO_PREFIX}/egress-pool-groups`,
        message: 'Go Core 未就绪，无法读取节点池组'
      });
    }
    if (pathname === RESOURCE_POOLS_PATH) {
      return proxyWebuiGo(ctx, {
        method: 'GET',
        path: `${GO_PREFIX}/egress-pools`,
        message: 'Go Core 未就绪，无法读取代理池列表'
      });
    }
    if (pathname === RESOURCE_EVIDENCE_PATH) {
      return proxyWebuiGo(ctx, {
        method: 'GET',
        path: `${GO_PREFIX}/egress-evidence`,
        query,
        message: 'Go Core 未就绪，无法读取实测诊断'
      });
    }
    const poolMatch = RESOURCE_POOL_PATTERN.exec(pathname);
    if (poolMatch) {
      const poolId = decodeSegment(poolMatch[1]);
      if (!poolId) {
        writeJson(res, 400, { ok: false, error: 'invalid_pool_id' });
        return true;
      }
      return proxyWebuiGo(ctx, {
        method: 'GET',
        path: `${GO_PREFIX}/egress-pools/${encodeURIComponent(poolId)}`,
        message: 'Go Core 未就绪，无法读取代理池详情'
      });
    }
    const nodeMatch = RESOURCE_NODE_PATTERN.exec(pathname);
    if (nodeMatch) {
      const nodeId = decodeSegment(nodeMatch[1]);
      if (!nodeId) {
        writeJson(res, 400, { ok: false, error: 'invalid_node_id' });
        return true;
      }
      return proxyWebuiGo(ctx, {
        method: 'GET',
        path: `${GO_PREFIX}/egress-nodes/${encodeURIComponent(nodeId)}`,
        message: 'Go Core 未就绪，无法读取节点详情'
      });
    }
    return false;
  }

  if (pathname === `${ROOT_PATH}/probe`) {
    const body = await readJsonBody(ctx);
    if (!body) {
      writeJson(res, 400, { ok: false, error: 'invalid_json_body' });
      return true;
    }
    return proxyWebuiGo(ctx, {
      method: 'POST',
      path: `${GO_PREFIX}/egress-pool/probe`,
      body,
      message: 'Go Core 未就绪，无法探测出口池节点'
    });
  }

  if (pathname === POLICY_PATH) {
    const body = await readJsonBody(ctx);
    if (!body) {
      writeJson(res, 400, { ok: false, error: 'invalid_json_body' });
      return true;
    }
    return proxyWebuiGo(ctx, {
      method: 'POST',
      path: `${GO_PREFIX}/egress-pool/node-policy`,
      body,
      message: 'Go Core 未就绪，无法更新节点拦截策略'
    });
  }

  if (pathname === POLICY_CLEAR_PATH) {
    return proxyWebuiGo(ctx, {
      method: 'POST',
      path: `${GO_PREFIX}/egress-pool/node-policy/clear-disabled`,
      body: {},
      message: 'Go Core 未就绪，无法清空禁用节点'
    });
  }

  const match = NODE_ACTION_PATTERN.exec(pathname);
  if (!match) return false;
  const nodeName = decodeSegment(match[1]);
  if (!nodeName) {
    writeJson(res, 400, { ok: false, error: 'invalid_node_name' });
    return true;
  }
  const action = match[2];
  let body = {};
  if (action === 'block' || action === 'unblock') {
    const parsed = await readJsonBody(ctx);
    if (!parsed) {
      writeJson(res, 400, { ok: false, error: 'invalid_json_body' });
      return true;
    }
    body = { reason: parsed.reason || 'manual', ...parsed };
  }
  return proxyWebuiGo(ctx, {
    method: 'POST',
    path: `${GO_PREFIX}/egress-pool/nodes/${encodeURIComponent(nodeName)}/${action}`,
    body,
    message: 'Go Core 未就绪，无法执行节点控制操作'
  });
}

module.exports = {
  handleEgressPoolRequest,
  matchEgressPoolRoute
};

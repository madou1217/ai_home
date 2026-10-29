'use strict';

// WebUI 出口池面板的数据面：
//   GET  /v0/webui/egress-pool                       服务状态 + 节点账本（统计 / 冷却 / 拦截 / 探测 / 账号）+ 事件流 + 绑定了池的账号
//   POST /v0/webui/egress-pool/probe                 立即探测（body.node 为空 = 全部节点）
//   POST /v0/webui/egress-pool/nodes/:name/select    切到指定节点
//   POST /v0/webui/egress-pool/nodes/:name/clear-cooldown  人工解除冷却
//   POST /v0/webui/egress-pool/nodes/:name/block     手动关闭一个节点（不参与轮换）
//   POST /v0/webui/egress-pool/nodes/:name/unblock   放行
//   POST /v0/webui/egress-pool/node-policy           改拦截策略（延迟阈值开关 / 连不上开关）
//   POST /v0/webui/egress-pool/node-policy/clear-disabled  放行全部手动关闭的节点
// 鉴权由 webui-auth-gate 统一负责（Management Key）。节点凭据从不出现在响应里：账本只存
// 出口身份（协议 / 服务器 / 端口）与展示名。

const { describeEgressPool, runEgressPoolAction, runEgressPoolPolicy } = require('../runtime/egress-pool-registry');
const { listEgressPoolBoundAccounts } = require('../account/zcode-egress-binding-store');
const {
  countByFilter,
  filterNodes,
  nodesVersion,
  paginateNodes,
  sortNodes
} = require('../runtime/egress-pool-node-view');
const { createDefaultEgressResourceService } = require('./egress-resource-service');

const ROOT_PATH = '/v0/webui/egress-pool';
const RESOURCE_GROUPS_PATH = '/v0/webui/egress-pool-groups';
const RESOURCE_POOLS_PATH = '/v0/webui/egress-pools';
const RESOURCE_POOL_PATTERN = /^\/v0\/webui\/egress-pools\/([^/]+)$/;
const RESOURCE_NODE_PATTERN = /^\/v0\/webui\/egress-nodes\/([^/]+)$/;
const RESOURCE_EVIDENCE_PATH = '/v0/webui/egress-evidence';
const NODE_ACTION_PATTERN = /^\/v0\/webui\/egress-pool\/nodes\/([^/]+)\/(select|clear-cooldown|block|unblock)$/;
const POLICY_PATH = `${ROOT_PATH}/node-policy`;
const POLICY_CLEAR_PATH = `${ROOT_PATH}/node-policy/clear-disabled`;

/** 读分页参数；没给 page 时返回 null（= 全量旧行为）。 */
function readQuery(ctx) {
  let params = null;
  try {
    params = new URL(String((ctx.req && ctx.req.url) || ctx.pathname || ''), 'http://localhost').searchParams;
  } catch (_error) {
    params = null;
  }
  if (!params || !params.has('page')) return { page: null, pageSize: null, filter: 'all', query: '' };
  return {
    page: Number(params.get('page')) || 1,
    pageSize: Number(params.get('pageSize')) || 50,
    filter: String(params.get('filter') || 'all'),
    query: String(params.get('query') || '')
  };
}

function readIfNoneMatch(ctx) {
  const headers = (ctx.req && ctx.req.headers) || {};
  return String(headers['if-none-match'] || '').trim();
}

function matchEgressPoolRoute(method, pathname) {
  const verb = String(method || '').toUpperCase();
  const path = String(pathname || '');
  if (verb === 'GET' && path === ROOT_PATH) return true;
  if (verb === 'GET' && (path === RESOURCE_GROUPS_PATH || path === RESOURCE_POOLS_PATH
    || RESOURCE_POOL_PATTERN.test(path) || RESOURCE_NODE_PATTERN.test(path) || path === RESOURCE_EVIDENCE_PATH)) return true;
  if (verb === 'POST' && path === `${ROOT_PATH}/probe`) return true;
  if (verb === 'POST' && (path === POLICY_PATH || path === POLICY_CLEAR_PATH)) return true;
  return verb === 'POST' && NODE_ACTION_PATTERN.test(path);
}

function resolveResourceService(ctx) {
  const supplied = ctx && ctx.deps && ctx.deps.egressResourceService;
  if (supplied && typeof supplied === 'object') return supplied;
  const factory = ctx && ctx.deps && ctx.deps.createEgressResourceService;
  if (typeof factory === 'function') {
    try {
      const service = factory(ctx);
      if (service && typeof service === 'object') return service;
    } catch (_error) {}
  }
  if (ctx && ctx.__egressResourceService) return ctx.__egressResourceService;
  const service = createDefaultEgressResourceService(ctx);
  if (ctx) ctx.__egressResourceService = service;
  return service;
}

function readSearchParams(ctx) {
  try {
    if (ctx && ctx.url && typeof ctx.url.searchParams?.get === 'function') return ctx.url.searchParams;
    const raw = (ctx && ctx.req && ctx.req.url) || '';
    return new URL(String(raw), 'http://localhost').searchParams;
  } catch (_error) {
    return new URLSearchParams();
  }
}

function decodePathId(raw) {
  try { return decodeURIComponent(raw).trim(); } catch (_error) { return ''; }
}

async function handleResourceRequest(ctx) {
  const { writeJson } = ctx;
  const pathname = String(ctx.pathname || '');
  const service = resolveResourceService(ctx);
  if (!service) {
    writeJson(ctx.res, 503, { ok: false, error: 'egress_resource_unavailable' });
    return true;
  }
  if (pathname === RESOURCE_GROUPS_PATH) {
    const groups = typeof service.buildResourceTreeView === 'function'
      ? service.buildResourceTreeView()
      : (typeof service.listPoolGroups === 'function' ? service.listPoolGroups() : []);
    writeJson(ctx.res, 200, { ok: true, groups: Array.isArray(groups) ? groups : [] });
    return true;
  }
  if (pathname === RESOURCE_POOLS_PATH) {
    const pools = typeof service.listPools === 'function' ? service.listPools()
      : (typeof service.buildResourceTreeView === 'function'
        ? service.buildResourceTreeView().flatMap((group) => group.pools || []) : []);
    writeJson(ctx.res, 200, { ok: true, pools: Array.isArray(pools) ? pools : [] });
    return true;
  }
  if (pathname === RESOURCE_EVIDENCE_PATH) {
    const params = readSearchParams(ctx);
    const query = {
      provider: String(params.get('provider') || '').trim(),
      accountRef: String(params.get('accountRef') || '').trim(),
      upstreamId: String(params.get('upstreamId') || '').trim(),
      nodeId: String(params.get('nodeId') || '').trim()
    };
    if (!query.provider && !query.accountRef && !query.upstreamId && !query.nodeId) {
      writeJson(ctx.res, 400, { ok: false, error: 'diagnostic_scope_required' });
      return true;
    }
    const diagnostic = typeof service.buildAccountDiagnosticView === 'function'
      ? service.buildAccountDiagnosticView(query) : { scope: 'account_diagnostic', query, evidence: [], summary: { total: 0, denied: 0, allowed: 0 }, globalBlocking: false };
    writeJson(ctx.res, 200, { ok: true, ...diagnostic });
    return true;
  }
  const poolMatch = RESOURCE_POOL_PATTERN.exec(pathname);
  if (poolMatch) {
    const poolId = decodePathId(poolMatch[1]);
    const pool = typeof service.getPool === 'function' ? service.getPool(poolId) : null;
    if (!pool) {
      writeJson(ctx.res, 404, { ok: false, error: 'egress_pool_not_found' });
      return true;
    }
    writeJson(ctx.res, 200, { ok: true, pool });
    return true;
  }
  const nodeMatch = RESOURCE_NODE_PATTERN.exec(pathname);
  if (nodeMatch) {
    const nodeId = decodePathId(nodeMatch[1]);
    const node = typeof service.getNode === 'function' ? service.getNode(nodeId) : null;
    if (!node) {
      writeJson(ctx.res, 404, { ok: false, error: 'egress_node_not_found' });
      return true;
    }
    writeJson(ctx.res, 200, { ok: true, node });
    return true;
  }
  return false;
}

function resolveDependency(ctx, name, fallback) {
  const injected = ctx && ctx.deps && ctx.deps[name];
  return typeof injected === 'function' ? injected : fallback;
}

function resolveAiHomeDir(ctx) {
  return String((ctx && ctx.aiHomeDir) || (ctx && ctx.deps && ctx.deps.aiHomeDir) || '').trim();
}

async function readJsonBody(ctx) {
  try {
    const body = typeof ctx.readRequestBody === 'function'
      ? await ctx.readRequestBody(ctx.req, { maxBytes: 4 * 1024 })
      : null;
    const parsed = body ? JSON.parse(body.toString('utf8')) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return null;
  }
}

async function handleEgressPoolRequest(ctx) {
  const { writeJson } = ctx;
  // 需要带响应头（ETag）时用原生 writeHead；ctx.writeJson 在测试里是替身，没有头参数。
  const writeJsonWithHeaders = (status, payload, headers) => {
    if (headers && ctx.res && typeof ctx.res.writeHead === 'function') {
      ctx.res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
      ctx.res.end(JSON.stringify(payload));
      return;
    }
    writeJson(ctx.res, status, payload);
  };
  const method = String(ctx.method || (ctx.req && ctx.req.method) || '').toUpperCase();
  const pathname = String(ctx.pathname || '');
  const describe = resolveDependency(ctx, 'describeEgressPool', describeEgressPool);
  const runAction = resolveDependency(ctx, 'runEgressPoolAction', runEgressPoolAction);

  if (method === 'GET') {
    if (pathname !== ROOT_PATH && (pathname === RESOURCE_GROUPS_PATH || pathname === RESOURCE_POOLS_PATH
      || pathname === RESOURCE_EVIDENCE_PATH || RESOURCE_POOL_PATTERN.test(pathname) || RESOURCE_NODE_PATTERN.test(pathname))) {
      return handleResourceRequest(ctx);
    }
    const view = describe();
    let boundAccounts = [];
    const listBound = resolveDependency(ctx, 'listEgressPoolBoundAccounts', listEgressPoolBoundAccounts);
    try {
      const aiHomeDir = resolveAiHomeDir(ctx);
      boundAccounts = aiHomeDir ? listBound(ctx.fs, aiHomeDir) : [];
    } catch {
      boundAccounts = [];
    }
    const query = readQuery(ctx);
    const allNodes = Array.isArray(view.nodes) ? view.nodes : [];
    const version = nodesVersion(allNodes);
    // ETag：节点状态没变就不重传整个节点表（2w 节点时那是十几 MB）。
    // 客户端带上 if-none-match 时回 304，前端沿用上一份数据。
    const etag = `W/"${version}"`;
    if (query.page !== null && readIfNoneMatch(ctx) === etag) {
      ctx.res.writeHead(304, { ETag: etag });
      ctx.res.end();
      return true;
    }
    if (query.page === null) {
      // 不带分页参数：保持旧行为（全量），避免破坏既有调用方与测试。
      writeJson(ctx.res, 200, { ok: true, ...view, boundAccounts, serverTime: Date.now(), version });
      return true;
    }
    const matched = sortNodes(filterNodes(allNodes, query.filter, query.query), (view.status && view.status.activeNode) || '');
    const paged = paginateNodes(matched, { page: query.page, pageSize: query.pageSize });
    writeJsonWithHeaders(200, {
      ...view,
      nodes: paged.nodes,
      nodeCounts: countByFilter(allNodes),
      pagination: { page: paged.page, pageSize: paged.pageSize, total: paged.total, pageCount: paged.pageCount },
      boundAccounts,
      serverTime: Date.now(),
      version
    }, { ETag: etag });
    return true;
  }

  if (pathname === `${ROOT_PATH}/probe`) {
    const body = await readJsonBody(ctx);
    if (!body) {
      writeJson(ctx.res, 400, { ok: false, error: 'invalid_json_body' });
      return true;
    }
    const result = await runAction('probe', String(body.node || '').trim());
    writeJson(ctx.res, result.ok ? 200 : 409, result);
    return true;
  }

  if (pathname === POLICY_PATH || pathname === POLICY_CLEAR_PATH) {
    const body = pathname === POLICY_CLEAR_PATH ? {} : await readJsonBody(ctx);
    if (!body) {
      writeJson(ctx.res, 400, { ok: false, error: 'invalid_json_body' });
      return true;
    }
    const runPolicy = resolveDependency(ctx, 'runEgressPoolPolicy', runEgressPoolPolicy);
    const result = pathname === POLICY_CLEAR_PATH
      ? runPolicy('clear-disabled', {})
      : runPolicy('update', body);
    writeJson(ctx.res, result.ok ? 200 : 409, result);
    return true;
  }

  const match = NODE_ACTION_PATTERN.exec(pathname);
  let node = '';
  try {
    node = decodeURIComponent(match[1]).trim();
  } catch {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_node_name' });
    return true;
  }
  const result = await runAction(match[2], node, { reason: 'manual' });
  writeJson(ctx.res, result.ok ? 200 : 409, result);
  return true;
}

module.exports = {
  handleEgressPoolRequest,
  matchEgressPoolRoute
};

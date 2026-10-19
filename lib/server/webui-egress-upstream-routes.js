'use strict';

// WebUI「上游」地区策略的数据面（docs/plans/2026-10-19-account-egress-upstream-policy.md）：
//   GET  /v0/webui/egress-upstreams[?accountRef=]          上游视图（账号 / 规则 / 提示 / 节点判定 / 实测 / 当前网络）
//   PUT  /v0/webui/egress-upstreams/:id                    改规则 / 实测有效期 / 带凭据探测开关
//   POST /v0/webui/egress-upstreams/:id/probe              立即测试节点（body.nodes 为空 = 该上游范围内全部节点）
//   POST /v0/webui/egress-upstreams/:id/evidence/reset     重置实测（body.exitKeys 为空 = 全部）
//   POST /v0/webui/egress-upstreams/network/refresh        重新查询本机当前出口位置
// 鉴权由 webui-auth-gate 统一负责（Management Key）。写入后立即：失效网关守卫缓存 + 重排车道。

const { buildEgressUpstreamView } = require('./egress-upstream-view');
const {
  normalizeUpstreamId,
  readUpstreamPolicy,
  resetUpstreamEvidence,
  writeUpstreamPolicy
} = require('./egress-region-policy');
const { invalidateGatewayNetworkGuard } = require('./egress-network-guard-gateway');
const { probeUpstreamViaNode } = require('./egress-upstream-probe');
const { listUpstreams } = require('./egress-upstream');
const { getExitGeo } = require('../runtime/egress-network-guard');
const { getEgressPoolService } = require('../runtime/egress-pool-registry');

const ROOT = '/v0/webui/egress-upstreams';
const ITEM = /^\/v0\/webui\/egress-upstreams\/([^/]+)$/;
const ACTION = /^\/v0\/webui\/egress-upstreams\/([^/]+)\/(probe|evidence\/reset)$/;
// 同步测试的上限：每个节点约 1-3s（位置查询 + 中性探测 + 上游探测），更多的转后台。
const SYNC_PROBE_LIMIT = 12;
const MAX_PROBE_NODES = 200;

let backgroundProbe = null;

function matchEgressUpstreamRoute(method, pathname) {
  const verb = String(method || '').toUpperCase();
  const path = String(pathname || '');
  if (verb === 'GET' && path === ROOT) return true;
  if (verb === 'POST' && path === `${ROOT}/network/refresh`) return true;
  if (verb === 'PUT' && ITEM.test(path)) return true;
  return verb === 'POST' && ACTION.test(path);
}

async function readJsonBody(ctx) {
  try {
    const body = typeof ctx.readRequestBody === 'function'
      ? await ctx.readRequestBody(ctx.req, { maxBytes: 64 * 1024 })
      : null;
    const parsed = body ? JSON.parse(body.toString('utf8')) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return null;
  }
}

function aiHomeOf(ctx) {
  return String((ctx && ctx.aiHomeDir) || (ctx && ctx.deps && ctx.deps.aiHomeDir) || '').trim();
}

function plannerOf(ctx) {
  return ctx && ctx.state && ctx.state.egressPoolPlanner;
}

function afterPolicyChange(ctx) {
  invalidateGatewayNetworkGuard();
  const planner = plannerOf(ctx);
  if (planner && typeof planner.reconcile === 'function') planner.reconcile({ force: true });
}

function viewFor(ctx, accountRef) {
  return buildEgressUpstreamView({
    fs: ctx.fs,
    aiHomeDir: aiHomeOf(ctx),
    pools: (ctx.state && ctx.state.accounts) || {},
    serverOptions: ctx.options || {},
    planner: plannerOf(ctx),
    service: getEgressPoolService(),
    accountRef
  });
}

function decodeId(raw) {
  try {
    return normalizeUpstreamId(decodeURIComponent(raw));
  } catch {
    return '';
  }
}

async function runProbes(ctx, upstream, names) {
  const service = getEgressPoolService();
  const runtime = service && service.ready ? service.runtime : null;
  if (!runtime) return { ok: false, error: 'egress_pool_not_ready' };
  const results = [];
  for (const name of names) {
    // eslint-disable-next-line no-await-in-loop
    const geo = await runtime.lookupNodeGeo(name);
    // eslint-disable-next-line no-await-in-loop
    const probe = await probeUpstreamViaNode({ runtime, upstream, node: name, fs: ctx.fs, aiHomeDir: aiHomeOf(ctx) });
    results.push({ ...probe, geo: geo && geo.ok ? geo.geo : null });
  }
  afterPolicyChange(ctx);
  return { ok: true, results };
}

async function handleEgressUpstreamRequest(ctx) {
  const { writeJson } = ctx;
  const method = String(ctx.method || (ctx.req && ctx.req.method) || '').toUpperCase();
  const pathname = String(ctx.pathname || '');
  const aiHomeDir = aiHomeOf(ctx);
  if (!aiHomeDir) {
    writeJson(ctx.res, 503, { ok: false, error: 'ai_home_unavailable' });
    return true;
  }

  if (method === 'GET') {
    const accountRef = String((ctx.url && ctx.url.searchParams && ctx.url.searchParams.get('accountRef')) || '').trim();
    writeJson(ctx.res, 200, { ok: true, ...viewFor(ctx, accountRef), probing: Boolean(backgroundProbe) });
    return true;
  }

  if (pathname === `${ROOT}/network/refresh`) {
    const entry = await getExitGeo({ fs: ctx.fs, aiHomeDir, proxyUrl: '', ttlMs: 1, coldWaitMs: 10000 });
    invalidateGatewayNetworkGuard();
    writeJson(ctx.res, entry ? 200 : 502, entry ? { ok: true, geo: entry.geo, at: entry.at } : { ok: false, error: 'geo_lookup_failed' });
    return true;
  }

  const body = await readJsonBody(ctx);
  if (!body) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_json_body' });
    return true;
  }

  if (method === 'PUT') {
    const id = decodeId(ITEM.exec(pathname)[1]);
    if (!id) {
      writeJson(ctx.res, 400, { ok: false, error: 'invalid_upstream_id' });
      return true;
    }
    const current = readUpstreamPolicy(ctx.fs, aiHomeDir, id);
    const next = {
      rules: Array.isArray(body.rules) ? body.rules : current.rules,
      evidenceTtlMs: body.evidenceTtlMs !== undefined ? body.evidenceTtlMs : current.evidenceTtlMs,
      credentialedProbe: body.credentialedProbe !== undefined ? body.credentialedProbe === true : current.credentialedProbe
    };
    try {
      const policy = writeUpstreamPolicy(ctx.fs, aiHomeDir, id, next);
      afterPolicyChange(ctx);
      writeJson(ctx.res, 200, { ok: true, policy });
    } catch (error) {
      writeJson(ctx.res, 500, { ok: false, error: String((error && error.message) || 'upstream_policy_write_failed') });
    }
    return true;
  }

  const match = ACTION.exec(pathname);
  const id = decodeId(match[1]);
  const upstream = listUpstreams(ctx.options || {}, (ctx.state && ctx.state.accounts) || {}).find((item) => item.id === id);
  if (!id || !upstream) {
    writeJson(ctx.res, 404, { ok: false, error: 'upstream_not_found' });
    return true;
  }

  if (match[2] === 'evidence/reset') {
    const removed = resetUpstreamEvidence(ctx.fs, aiHomeDir, id, Array.isArray(body.exitKeys) ? body.exitKeys : undefined);
    afterPolicyChange(ctx);
    writeJson(ctx.res, 200, { ok: true, removed });
    return true;
  }

  // probe
  const service = getEgressPoolService();
  const runtime = service && service.ready ? service.runtime : null;
  if (!runtime) {
    writeJson(ctx.res, 409, { ok: false, error: 'egress_pool_not_ready' });
    return true;
  }
  const requested = Array.isArray(body.nodes) ? body.nodes.map((name) => String(name || '').trim()).filter(Boolean) : [];
  const names = (requested.length ? requested : runtime.nodeNames)
    .filter((name) => runtime.nodeNames.includes(name)).slice(0, MAX_PROBE_NODES);
  if (names.length === 0) {
    writeJson(ctx.res, 400, { ok: false, error: 'no_nodes_to_probe' });
    return true;
  }
  if (names.length <= SYNC_PROBE_LIMIT) {
    const result = await runProbes(ctx, upstream, names);
    writeJson(ctx.res, result.ok ? 200 : 409, result);
    return true;
  }
  if (backgroundProbe) {
    writeJson(ctx.res, 202, { ok: true, background: true, alreadyRunning: true, count: names.length });
    return true;
  }
  backgroundProbe = runProbes(ctx, upstream, names).catch(() => null).finally(() => { backgroundProbe = null; });
  writeJson(ctx.res, 202, { ok: true, background: true, count: names.length });
  return true;
}

module.exports = {
  handleEgressUpstreamRequest,
  matchEgressUpstreamRoute
};

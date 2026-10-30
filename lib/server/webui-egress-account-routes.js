'use strict';

const { resolveAccountRef } = require('./account-ref-store');
const { isAccountRef } = require('../account/public-account-ref');
const {
  normalizeAccountEgressAssignment
} = require('./egress-domain-contract');
const {
  readAccountEgressBinding,
  writeAccountEgressBinding
} = require('../account/zcode-egress-binding-store');

const ASSIGNMENT_ROUTE = /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/egress-assignment$/;
const RUNTIME_ROUTE = /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/egress-runtime$/;

function parse(pattern, pathname) {
  const match = pattern.exec(String(pathname || ''));
  if (!match) return null;
  try {
    return {
      provider: decodeURIComponent(match[1]).trim().toLowerCase(),
      accountRef: decodeURIComponent(match[2]).trim()
    };
  } catch (_error) { return null; }
}

function matchAccountEgressRoute(method, pathname) {
  const verb = String(method || '').toUpperCase();
  return (verb === 'GET' && RUNTIME_ROUTE.test(String(pathname || '')))
    || (verb === 'PUT' && ASSIGNMENT_ROUTE.test(String(pathname || '')));
}

function aiHomeOf(ctx) {
  return String((ctx && ctx.aiHomeDir) || (ctx && ctx.state && ctx.state.aiHomeDir) || '').trim();
}

function resolveAccount(ctx, provider, accountRef) {
  if (!isAccountRef(accountRef)) return null;
  if (ctx && ctx.deps && typeof ctx.deps.resolveEgressAccount === 'function') {
    try { return ctx.deps.resolveEgressAccount(provider, accountRef, ctx); } catch (_error) { return null; }
  }
  try { return resolveAccountRef(ctx.fs, aiHomeOf(ctx), accountRef, { bestEffort: true }); } catch (_error) { return null; }
}

function validate(ctx, parsed) {
  if (!parsed || !parsed.provider || !isAccountRef(parsed.accountRef)) return { status: 400, error: 'invalid_account_path' };
  const account = resolveAccount(ctx, parsed.provider, parsed.accountRef);
  if (!account) return { status: 404, error: 'account_not_found' };
  if (String(account.provider || '').trim().toLowerCase() !== parsed.provider) return { status: 409, error: 'account_provider_mismatch' };
  return { account: { ...account, accountRef: parsed.accountRef, provider: parsed.provider } };
}

function assignmentService(ctx) {
  return (ctx.deps && ctx.deps.egressAssignmentService) || (ctx.state && ctx.state.egressAssignmentService) || null;
}

function runtimeOf(ctx) {
  return (ctx.deps && ctx.deps.egressPoolRuntime) || (ctx.state && ctx.state.egressPoolRuntime) || null;
}

function buildRuntimeView(ctx, account, assignment) {
  const runtime = runtimeOf(ctx);
  const lane = runtime && typeof runtime.laneOf === 'function' ? runtime.laneOf(account.accountRef) : null;
  const node = runtime && typeof runtime.laneActiveNodeInfo === 'function'
    ? runtime.laneActiveNodeInfo(account.accountRef) : null;
  const nodeId = String((node && node.nodeId) || (lane && lane.nodeId) || '').trim();
  const evidenceStore = (ctx.deps && ctx.deps.egressEvidenceStore) || (ctx.state && ctx.state.egressEvidenceStore);
  const evidence = evidenceStore && typeof evidenceStore.listEvidence === 'function'
    ? evidenceStore.listEvidence({ accountRef: account.accountRef, provider: account.provider, includeLegacy: false }) : [];
  const latest = evidence.length ? evidence[evidence.length - 1] : null;
  return {
    accountRef: account.accountRef,
    assignment: assignment || null,
    lane: lane ? { ...lane, accountRef: account.accountRef, nodeId } : null,
    node: node ? { ...node, nodeId, runtimeName: node.runtimeName || '' } : null,
    nodeId,
    runtimeName: String((node && node.runtimeName) || (lane && lane.active) || '').trim(),
    proxyUrl: runtime && typeof runtime.laneProxyUrl === 'function' ? runtime.laneProxyUrl(account.accountRef) || '' : '',
    exitIp: String((lane && lane.exitIp) || '').trim(),
    evidence,
    verdict: latest ? { status: latest.status === 'blocked' ? 'denied' : latest.status === 'ok' ? 'allowed' : 'unknown', evidence: latest } : null
  };
}

async function readBody(ctx) {
  try {
    const raw = await ctx.readRequestBody(ctx.req, { maxBytes: 32 * 1024 });
    const value = raw ? JSON.parse(raw.toString('utf8')) : null;
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch (_error) { return null; }
}

async function handleWebUiEgressAccountRequest(ctx) {
  const method = String(ctx.method || (ctx.req && ctx.req.method) || '').toUpperCase();
  const pathname = String(ctx.pathname || '');
  const parsed = method === 'PUT' ? parse(ASSIGNMENT_ROUTE, pathname) : parse(RUNTIME_ROUTE, pathname);
  const { writeJson } = ctx;
  const checked = validate(ctx, parsed);
  if (checked.error) { writeJson(ctx.res, checked.status, { ok: false, error: checked.error }); return true; }
  const { account } = checked;
  const service = assignmentService(ctx);
  if (method === 'GET') {
    const assignment = service && typeof service.getAssignment === 'function' ? service.getAssignment(account.accountRef) : null;
    writeJson(ctx.res, 200, { ok: true, account, ...buildRuntimeView(ctx, account, assignment) });
    return true;
  }
  const body = await readBody(ctx);
  if (!body) { writeJson(ctx.res, 400, { ok: false, error: 'invalid_json_body' }); return true; }
  let assignment;
  try { assignment = normalizeAccountEgressAssignment({ ...(body.assignment || body), accountRef: account.accountRef }); }
  catch (error) { writeJson(ctx.res, 400, { ok: false, error: String(error.code || error.message || 'invalid_assignment') }); return true; }
  const home = aiHomeOf(ctx);
  try {
    writeAccountEgressBinding(ctx.fs, home, account.accountRef, { mode: 'pool', scope: assignment.scope, strategy: assignment.strategy });
    const planner = ctx.state && ctx.state.egressPoolPlanner;
    if (planner && typeof planner.reconcileAndApply === 'function') await planner.reconcileAndApply({ force: true });
    const current = service && typeof service.getAssignment === 'function' ? service.getAssignment(account.accountRef) : assignment;
    writeJson(ctx.res, 200, { ok: true, assignment: current || assignment, runtime: buildRuntimeView(ctx, account, current || assignment), apply: { ok: true, applied: true, status: 'applied' } });
  } catch (error) {
    writeJson(ctx.res, 409, { ok: false, error: String(error.code || error.message || 'egress_assignment_write_failed') });
  }
  return true;
}

module.exports = { handleWebUiEgressAccountRequest, matchAccountEgressRoute };

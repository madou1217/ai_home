'use strict';

// /v0/management/internal/account-host-cleanup：Go 删除事务回调 Node 的宿主清理入口。
//
// 鉴权与 /v0/plugins/internal/* 同一套边界：
//   * 对端必须是回环（管理密钥不能被远端用它来杀本机会话）；
//   * 凭据接受 Node 的 Management Key，或 Go Core 的引导密钥
//     （AIH_SERVER_MANAGEMENT_KEY，随监督器注入，与 Server 的 Key 不是同一把）。
// 只做「校验 + 分派」：真正的清理语义在 account-host-cleanup.js，那里可以用
// temp HOME 与假 tmux 完整覆盖。

const {
  authorizeManagementKey,
  credentialsEqual,
  isLoopbackPeer,
  parseBearerCredential
} = require('./management-key-auth');
const { createAccountHostCleanupService } = require('./account-host-cleanup');

const PATHNAME = '/v0/management/internal/account-host-cleanup';
const MAX_BODY_BYTES = 64 * 1024;
const PHASES = new Set(['verify', 'cleanup']);

async function readJsonBody(req, deps) {
  if (typeof deps.readRequestBody !== 'function') return { error: 'invalid_request_body' };
  const document = await deps.readRequestBody(req, { maxBytes: MAX_BODY_BYTES }).catch(() => null);
  if (!document) return { error: 'invalid_request_body' };
  try {
    const payload = JSON.parse(document.toString('utf8'));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { error: 'invalid_request_body' };
    }
    return { payload };
  } catch (_error) {
    return { error: 'invalid_json' };
  }
}

function resolveGoCoreKey(deps) {
  const source = deps && deps.goCoreManagementKey;
  const value = typeof source === 'function' ? source() : source;
  return String(value || '').trim();
}

async function handleAccountHostCleanupRequest(ctx) {
  const pathname = String((ctx && ctx.pathname) || '');
  if (pathname !== PATHNAME) return false;

  const req = ctx.req || {};
  const res = ctx.res || {};
  const deps = ctx.deps || {};
  const writeJson = ctx.writeJson || deps.writeJson;
  const method = String(ctx.method || req.method || 'GET').toUpperCase();

  if (method !== 'POST') {
    res.setHeader && res.setHeader('Allow', 'POST');
    writeJson(res, 405, { ok: false, error: 'method_not_allowed' });
    return true;
  }
  // 回环先于凭据判定：远端即使拿到两把密钥之一，也不能让本机杀会话。
  if (!isLoopbackPeer(req)) {
    writeJson(res, 403, { ok: false, error: 'account_host_cleanup_loopback_required' });
    return true;
  }

  const authorization = authorizeManagementKey({
    req,
    requiredManagementKey: String(ctx.requiredManagementKey || '').trim()
  });
  if (!authorization.ok) {
    const goCoreKey = resolveGoCoreKey(deps);
    const viaGoCore = goCoreKey
      && credentialsEqual(parseBearerCredential(req), goCoreKey);
    if (!viaGoCore) {
      writeJson(res, authorization.statusCode || 401, {
        ok: false,
        error: authorization.error || 'unauthorized_management'
      });
      return true;
    }
  }

  const body = await readJsonBody(req, deps);
  if (body.error) {
    writeJson(res, 400, { ok: false, error: body.error });
    return true;
  }
  const phase = String(body.payload.phase || '').trim();
  if (!PHASES.has(phase)) {
    writeJson(res, 400, { ok: false, error: 'invalid_phase' });
    return true;
  }

  let service = deps.accountHostCleanupService;
  if (!service) {
    const aiHomeDir = String(ctx.aiHomeDir || deps.aiHomeDir || '').trim();
    if (!aiHomeDir) {
      writeJson(res, 503, { ok: false, error: 'account_host_cleanup_unavailable' });
      return true;
    }
    service = createAccountHostCleanupService({
      fs: deps.fs,
      aiHomeDir,
      spawnSync: deps.spawnSync
    });
  }

  try {
    const result = phase === 'verify'
      ? service.verify(body.payload.provider, body.payload.accountRef)
      : service.cleanup(body.payload.provider, body.payload.accountRef);
    if (phase === 'verify' && result.ok !== true) {
      writeJson(res, 409, {
        ok: false,
        error: 'account_runtime_active',
        message: '账号仍有活跃的宿主写入者，不能删除',
        blockers: result.blockers
      });
      return true;
    }
    // cleanup 的 ok=false 只表示「这次没收干净」，账号事实已经不存在：
    // 用 200 + degraded 如实上报，让调用方记录并原样重试，而不是当成删除失败。
    writeJson(res, 200, {
      ok: true,
      phase,
      provider: result.provider,
      accountRef: result.accountRef,
      ...(phase === 'verify'
        ? { reaped: result.reaped, sockets: result.sockets }
        : { degraded: result.ok !== true, results: result.results, ...(result.registryError ? { registryError: result.registryError } : {}) })
    });
    return true;
  } catch (error) {
    const code = String((error && error.code) || '');
    if (code === 'account_host_state_unknown') {
      writeJson(res, 503, { ok: false, error: code, message: String(error.message || '') });
      return true;
    }
    if (code === 'account_host_cleanup_invalid_target') {
      writeJson(res, 400, { ok: false, error: 'invalid_target' });
      return true;
    }
    writeJson(res, 503, { ok: false, error: 'account_host_cleanup_unavailable' });
    return true;
  }
}

module.exports = {
  handleAccountHostCleanupRequest,
  ACCOUNT_HOST_CLEANUP_PATH: PATHNAME
};

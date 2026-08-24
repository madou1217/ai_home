'use strict';

// WebUI 数据面：zcode 账号的出口绑定读写。
//
// 为什么不复用既有的 /update 路由：那条路由对非 API-key 账号直接返回
// oauth_config_edit_unsupported（见 webui-account-routes.js 的 detectStoredApiKeyMode 分支），
// 而 zcode 账号是 oauth-browser，永远进不去。出口绑定与凭据编辑也不是一回事，
// 单独一条路由语义更干净。
//
// 本文件只做「HTTP 边界」：解析路径、校验入参、调 store、回 JSON。
// 出口解析与协议中立节点仓交互在 zcode-egress-service.js，持久化在
// zcode-egress-binding-store.js；本路由不依赖任何具体代理核心。

const {
  EGRESS_MODE_GROUP,
  EGRESS_MODE_NODE,
  EGRESS_MODE_SYSTEM,
  EGRESS_MODE_TUN,
  EGRESS_MODE_URL,
  readAccountEgressBinding,
  writeAccountEgressBinding
} = require('../account/zcode-egress-binding-store');
const { resolveAccountRef } = require('./account-ref-store');
const { createWebUiAccountAppLauncher } = require('./webui-account-app-launcher');
const {
  applyStoredAccountEgress,
  getAccountEgressRuntimeStatus,
  isEgressSupportedProvider,
  rotateStoredAccountEgress
} = require('./zcode-egress-service');
const { normalizeProxyUrl } = require('./zcode-egress-resolver');

const EGRESS_ROUTE_PATTERN = /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/egress$/;
const EGRESS_ROTATE_ROUTE_PATTERN = /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/egress\/rotate$/;

function parseRouteWithPattern(pathname, pattern) {
  const match = pattern.exec(String(pathname || ''));
  if (!match) return null;
  try {
    return {
      provider: decodeURIComponent(match[1]).trim().toLowerCase(),
      accountRef: decodeURIComponent(match[2]).trim()
    };
  } catch {
    return null;
  }
}

function parseEgressRoute(pathname) {
  return parseRouteWithPattern(pathname, EGRESS_ROUTE_PATTERN);
}

function parseEgressRotateRoute(pathname) {
  return parseRouteWithPattern(pathname, EGRESS_ROTATE_ROUTE_PATTERN);
}

function resolveAiHomeDir(ctx) {
  const processObj = (ctx && ctx.processObj) || process;
  const env = processObj.env || {};
  return String(
    (ctx && ctx.aiHomeDir)
    || (ctx && ctx.state && ctx.state.aiHomeDir)
    || env.AI_HOME_DIR
    || env.AIH_HOME
    || ''
  ).trim();
}

function matchEgressRoute(method, pathname) {
  const verb = String(method || '').toUpperCase();
  if (EGRESS_ROUTE_PATTERN.test(String(pathname || ''))) {
    return verb === 'GET' || verb === 'POST';
  }
  return EGRESS_ROTATE_ROUTE_PATTERN.test(String(pathname || '')) && verb === 'POST';
}

function resolveRouteDependency(ctx, name, fallback) {
  const injected = ctx && ctx.deps && ctx.deps[name];
  return typeof injected === 'function' ? injected : fallback;
}

async function readRuntimePresentation(ctx, input) {
  const getRuntimeStatus = resolveRouteDependency(
    ctx,
    'getAccountEgressRuntimeStatus',
    getAccountEgressRuntimeStatus
  );
  let launcher = input.launcher || null;
  if (!launcher) {
    const createLauncher = resolveRouteDependency(
      ctx,
      'createWebUiAccountAppLauncher',
      createWebUiAccountAppLauncher
    );
    try {
      launcher = createLauncher(ctx, input.provider, input.accountRef, 'inspect');
    } catch {
      launcher = null;
    }
  }
  try {
    const result = await getRuntimeStatus({
      ...input,
      ...(launcher ? { launcher } : {})
    });
    return result?.ok
      ? { runtime: result.runtime || null }
      : { runtime: null, runtimeError: String(result?.error || 'sidecar_status_unavailable') };
  } catch {
    return { runtime: null, runtimeError: 'sidecar_status_unavailable' };
  }
}

function rotateHttpStatus(result) {
  if (result?.ok) return 200;
  const conflictErrors = new Set([
    'zcode_egress_rotate_requires_group',
    'zcode_egress_not_running',
    'zcode_egress_rotate_no_candidate',
    'zcode_egress_state_mismatch'
  ]);
  if (conflictErrors.has(String(result?.error || ''))) return 409;
  if (String(result?.error || '') === 'egress_binding_read_failed') return 500;
  return 502;
}

/**
 * GET  /v0/webui/accounts/:provider/:accountRef/egress  读当前绑定
 * POST /v0/webui/accounts/:provider/:accountRef/egress  写入或清除绑定
 *
 * POST body: { mode: 'system' | 'tun' | 'url' | 'node' | 'group',
 *   proxyUrl?: string, nodeId?: string, groupId?: string }
 *   —— body 为空对象、或 mode 对应的字段为空，均视为解绑。
 *
 * @returns {Promise<boolean>} 是否已处理该请求
 */
async function handleZcodeEgressRequest(ctx) {
  const { pathname, writeJson } = ctx;
  const rotateRoute = parseEgressRotateRoute(pathname);
  const parsed = rotateRoute || parseEgressRoute(pathname);
  if (!parsed) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_account_path' });
    return true;
  }
  const { provider, accountRef } = parsed;
  if (!isEgressSupportedProvider(provider)) {
    writeJson(ctx.res, 400, { ok: false, error: 'egress_unsupported_provider' });
    return true;
  }
  const aiHomeDir = resolveAiHomeDir(ctx);
  if (!aiHomeDir) {
    writeJson(ctx.res, 503, { ok: false, error: 'ai_home_dir_unavailable' });
    return true;
  }

  let account = null;
  try {
    account = resolveAccountRef(ctx.fs, aiHomeDir, accountRef, { bestEffort: true });
  } catch {
    account = null;
  }
  if (!account) {
    writeJson(ctx.res, 404, { ok: false, error: 'account_not_found' });
    return true;
  }
  if (String(account.provider || '').trim().toLowerCase() !== provider) {
    writeJson(ctx.res, 409, { ok: false, error: 'account_provider_mismatch' });
    return true;
  }

  const method = String(ctx.req && ctx.req.method || '').toUpperCase();
  const readBinding = resolveRouteDependency(
    ctx,
    'readAccountEgressBinding',
    readAccountEgressBinding
  );
  const writeBinding = resolveRouteDependency(
    ctx,
    'writeAccountEgressBinding',
    writeAccountEgressBinding
  );

  const serviceInput = {
    fs: ctx.fs,
    aiHomeDir,
    provider,
    accountRef,
    processObj: ctx.processObj || process,
    deps: ctx.deps || {}
  };

  if (rotateRoute) {
    const rotateBinding = resolveRouteDependency(
      ctx,
      'rotateStoredAccountEgress',
      rotateStoredAccountEgress
    );
    let rotation;
    try {
      rotation = await rotateBinding(serviceInput);
    } catch {
      rotation = { ok: false, applied: false, error: 'zcode_egress_rotate_failed' };
    }
    let binding = null;
    try { binding = readBinding(ctx.fs, aiHomeDir, accountRef); } catch {}
    const presentation = await readRuntimePresentation(ctx, { ...serviceInput, binding });
    writeJson(ctx.res, rotateHttpStatus(rotation), {
      ...rotation,
      binding,
      ...presentation
    });
    return true;
  }

  if (method === 'GET') {
    let binding;
    try {
      binding = readBinding(ctx.fs, aiHomeDir, accountRef);
    } catch {
      writeJson(ctx.res, 500, { ok: false, error: 'egress_binding_read_failed' });
      return true;
    }
    const presentation = await readRuntimePresentation(ctx, { ...serviceInput, binding });
    writeJson(ctx.res, 200, { ok: true, binding, ...presentation });
    return true;
  }

  let payload;
  try {
    const body = await ctx.readRequestBody(ctx.req, { maxBytes: 16 * 1024 });
    payload = body ? JSON.parse(body.toString('utf8')) : {};
  } catch {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_json_body' });
    return true;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_request_body' });
    return true;
  }

  const mode = String(payload && payload.mode || '').trim().toLowerCase();
  const proxyUrl = String(payload && payload.proxyUrl || '').trim();
  const nodeId = String(payload && payload.nodeId || '').trim();
  const groupId = String(payload && payload.groupId || '').trim();

  // 显式模式下先校验，避免存进一条启动时才发现无效的绑定。
  if (mode === EGRESS_MODE_URL && proxyUrl && !normalizeProxyUrl(proxyUrl)) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_proxy_url' });
    return true;
  }
  const supportedModes = new Set([
    EGRESS_MODE_SYSTEM,
    EGRESS_MODE_TUN,
    EGRESS_MODE_URL,
    EGRESS_MODE_NODE,
    EGRESS_MODE_GROUP
  ]);
  if (mode && !supportedModes.has(mode)) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_egress_mode' });
    return true;
  }
  if (
    (mode === EGRESS_MODE_NODE && !nodeId)
    || (mode === EGRESS_MODE_GROUP && !groupId)
  ) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_egress_binding' });
    return true;
  }
  const shouldClear = !mode
    || (mode === EGRESS_MODE_URL && !proxyUrl);

  let previousBinding;
  try {
    previousBinding = readBinding(ctx.fs, aiHomeDir, accountRef);
  } catch {
    writeJson(ctx.res, 500, { ok: false, error: 'egress_binding_read_failed' });
    return true;
  }

  try {
    writeBinding(
      ctx.fs,
      aiHomeDir,
      accountRef,
      shouldClear ? null : { mode, proxyUrl, nodeId, groupId }
    );
  } catch {
    writeJson(ctx.res, 500, { ok: false, error: 'egress_binding_write_failed' });
    return true;
  }

  let binding;
  try {
    binding = readBinding(ctx.fs, aiHomeDir, accountRef);
  } catch {
    writeJson(ctx.res, 500, { ok: false, error: 'egress_binding_read_failed' });
    return true;
  }
  const applyBinding = resolveRouteDependency(
    ctx,
    'applyStoredAccountEgress',
    applyStoredAccountEgress
  );
  const createLauncher = resolveRouteDependency(
    ctx,
    'createWebUiAccountAppLauncher',
    createWebUiAccountAppLauncher
  );
  let launcher = null;
  try {
    launcher = createLauncher(ctx, provider, accountRef, 'open');
  } catch {}
  let apply;
  const applyInput = {
    ...serviceInput,
    preserveAccountEndpointOnFailure: true,
    ...(launcher ? { launcher } : {})
  };
  try {
    apply = await applyBinding(applyInput);
  } catch {
    apply = { ok: false, applied: false, error: 'egress_apply_failed' };
  }
  if (apply?.ok === false) {
    try {
      writeBinding(ctx.fs, aiHomeDir, accountRef, previousBinding);
      binding = readBinding(ctx.fs, aiHomeDir, accountRef);
      const rollback = await applyBinding(applyInput);
      apply = rollback?.ok
        ? { ...apply, rolledBack: true }
        : {
            ...apply,
            rolledBack: false,
            rollbackError: String(rollback?.error || 'egress_binding_rollback_failed')
          };
    } catch {
      apply = {
        ...apply,
        rolledBack: false,
        rollbackError: 'egress_binding_rollback_failed'
      };
    }
  }
  const presentation = await readRuntimePresentation(ctx, {
    ...serviceInput,
    binding,
    ...(launcher ? { launcher } : {})
  });
  writeJson(ctx.res, 200, { ok: true, binding, apply, ...presentation });
  return true;
}

module.exports = {
  EGRESS_ROUTE_PATTERN,
  EGRESS_ROTATE_ROUTE_PATTERN,
  handleZcodeEgressRequest,
  matchEgressRoute,
  parseEgressRoute,
  parseEgressRotateRoute,
  rotateHttpStatus
};

'use strict';

// WebUI 数据面：账号 × 模型的**上下文窗口**查看与设置。
//
// 用户要求（2026-10-23）：
//   - 能自动获取就自动获取（上游 /models 声明的窗口）；拿不到就支持手设；
//   - 值必须有可靠数据支撑，不能凭感觉写死；
//   - 维度是**账号 × 模型**（同 provider 下中转/OAuth/API Key 的真实窗口不同）；
//   - 设置时若同 provider 下有**同类型账号**，提示是否一并设置，且账号可选。
//
// 本路由只做「读 + 写 + 列出同类型账号」，窗口的三级解析归
// lib/server/model-context-overrides.js（单一真相源）。

const {
  MAX_CONTEXT_TOKENS,
  MIN_CONTEXT_TOKENS,
  listAccountOverrides,
  resolveContextWindow,
  setContextOverride,
  setContextOverridesForAccounts
} = require('./model-context-overrides');
const { resolveAccountRef } = require('./account-ref-store');
const { inferIdentityKind } = require('../account/account-identity');

// 单账号读写：/v0/webui/accounts/:provider/:accountRef/model-context
const ACCOUNT_ROUTE_PATTERN = /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/model-context$/;
// 批量写入：/v0/webui/accounts/:provider/model-context/bulk
const BULK_ROUTE_PATTERN = /^\/v0\/webui\/accounts\/([^/]+)\/model-context\/bulk$/;

function decodeSegment(value) {
  try {
    return decodeURIComponent(value).trim();
  } catch (_error) {
    return '';
  }
}

function resolveAiHomeDir(ctx) {
  const processObj = (ctx && ctx.processObj) || process;
  const env = processObj.env || {};
  return String(
    (ctx && ctx.aiHomeDir)
    || (ctx && ctx.state && ctx.state.aiHomeDir)
    || env.AI_HOME_DIR
    || env.AIH_HOME_DIR
    || ''
  ).trim();
}

function listProviderAccounts(ctx, aiHomeDir, provider) {
  const load = typeof ctx.loadServerRuntimeAccounts === 'function'
    ? ctx.loadServerRuntimeAccounts
    : require('./accounts').loadServerRuntimeAccounts;
  let byProvider = {};
  try {
    // loadServerRuntimeAccounts 是单参函数（收 deps 袋子）；routeCtx 已把 fs/aiHomeDir/
    // hostHomeDir 平铺在 ctx 上，直接透传即可 —— 传错袋子会静默返回空池，
    // 表现为「账号存在但同类型账号列表为空」。
    byProvider = load({
      fs: ctx.fs,
      aiHomeDir,
      hostHomeDir: ctx.hostHomeDir || ctx.hostHomeDirPath,
      accountStateIndex: ctx.accountStateIndex,
      accountStateService: ctx.accountStateService
    }) || {};
  } catch (_error) {
    return [];
  }
  return (Array.isArray(byProvider[provider]) ? byProvider[provider] : [])
    .map((account) => ({
      accountRef: String(account && account.accountRef || '').trim(),
      provider,
      // 类型判定走账号身份的单一来源：oauth / api-key / auth-token。
      credentialType: inferIdentityKind(account),
      displayName: String(account && (account.displayName || account.email || '') || '').trim(),
      disabled: account && account.disabled === true
    }))
    .filter((account) => account.accountRef);
}

/** 账号当前的窗口一览：每个已知模型的手动值、生效值与来源。 */
function presentAccountContext(deps, account, models) {
  const overrides = listAccountOverrides(deps, account.accountRef);
  const rows = (Array.isArray(models) ? models : []).map((modelId) => {
    const resolved = resolveContextWindow(deps, {
      accountRef: account.accountRef,
      model: modelId,
      provider: account.provider
    });
    return {
      model: modelId,
      tokens: resolved.tokens,
      source: resolved.source,
      override: Number(overrides[modelId]) || 0
    };
  });
  return { accountRef: account.accountRef, provider: account.provider, models: rows };
}

async function readJsonBody(ctx) {
  if (typeof ctx.readRequestBody === 'function') {
    const raw = await ctx.readRequestBody(ctx.req);
    try {
      return JSON.parse(String(raw || '').trim() || '{}');
    } catch (_error) {
      return null;
    }
  }
  return {};
}

/**
 * GET  /v0/webui/accounts/:provider/:accountRef/model-context?models=a,b
 * POST /v0/webui/accounts/:provider/:accountRef/model-context  { model, tokens }
 * POST /v0/webui/accounts/:provider/model-context/bulk         { model, tokens, accountRefs: [...] }
 *
 * GET 还会返回同 provider 下的**同类型账号**（供前端提示「是否一并设置」），
 * 以及窗口的合法范围，前端不必自己写死这些常量。
 */
async function handleModelContextRequest(ctx) {
  const { pathname, writeJson } = ctx;
  const method = String(ctx.method || '').toUpperCase();
  const bulkMatch = BULK_ROUTE_PATTERN.exec(String(pathname || ''));
  const accountMatch = bulkMatch ? null : ACCOUNT_ROUTE_PATTERN.exec(String(pathname || ''));
  if (!bulkMatch && !accountMatch) return false;
  if (method !== 'GET' && method !== 'POST') return false;

  const aiHomeDir = resolveAiHomeDir(ctx);
  if (!aiHomeDir) {
    writeJson(ctx.res, 503, { ok: false, error: 'ai_home_dir_unavailable' });
    return true;
  }
  const deps = { fs: ctx.fs, aiHomeDir };
  const provider = decodeSegment((bulkMatch || accountMatch)[1]);
  if (!provider) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_account_path' });
    return true;
  }

  if (bulkMatch) {
    if (method !== 'POST') {
      writeJson(ctx.res, 405, { ok: false, error: 'method_not_allowed' });
      return true;
    }
    const body = await readJsonBody(ctx);
    if (!body) {
      writeJson(ctx.res, 400, { ok: false, error: 'invalid_json_body' });
      return true;
    }
    const result = setContextOverridesForAccounts(deps, {
      model: body.model,
      tokens: body.tokens,
      accountRefs: body.accountRefs
    });
    if (!result.ok) {
      writeJson(ctx.res, 400, { ok: false, error: result.error });
      return true;
    }
    writeJson(ctx.res, 200, { ok: true, overrides: result.overrides });
    return true;
  }

  const accountRef = decodeSegment(accountMatch[2]);
  let account = null;
  try {
    account = resolveAccountRef(ctx.fs, aiHomeDir, accountRef, { bestEffort: true });
  } catch (_error) {
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

  if (method === 'GET') {
    const requested = String(ctx.query && ctx.query.models || '').split(',').map((item) => item.trim()).filter(Boolean);
    const models = requested.length > 0 ? requested : Object.keys(listAccountOverrides(deps, accountRef));
    const payload = presentAccountContext(deps, { accountRef, provider }, models);
    const siblings = listProviderAccounts(ctx, aiHomeDir, provider)
      .filter((candidate) => candidate.accountRef !== accountRef);
    const selfType = listProviderAccounts(ctx, aiHomeDir, provider)
      .find((candidate) => candidate.accountRef === accountRef);
    writeJson(ctx.res, 200, {
      ok: true,
      ...payload,
      limits: { min: MIN_CONTEXT_TOKENS, max: MAX_CONTEXT_TOKENS },
      // 同类型账号：前端据此提示「要不要一并设置」，并让用户勾选具体哪些。
      sameTypeAccounts: selfType
        ? siblings.filter((candidate) => candidate.credentialType === selfType.credentialType)
        : [],
      credentialType: selfType ? selfType.credentialType : ''
    });
    return true;
  }

  const body = await readJsonBody(ctx);
  if (!body) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_json_body' });
    return true;
  }
  const result = setContextOverride(deps, {
    accountRef,
    model: body.model,
    tokens: body.tokens
  });
  if (!result.ok) {
    writeJson(ctx.res, 400, { ok: false, error: result.error });
    return true;
  }
  const resolved = resolveContextWindow(deps, { accountRef, model: body.model, provider });
  writeJson(ctx.res, 200, { ok: true, overrides: result.overrides, resolved });
  return true;
}

module.exports = {
  ACCOUNT_ROUTE_PATTERN,
  BULK_ROUTE_PATTERN,
  handleModelContextRequest,
  presentAccountContext
};

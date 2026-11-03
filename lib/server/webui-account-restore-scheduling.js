'use strict';

// 账号级「强制恢复调度」—— 人工覆盖，按账号把运行态整体归零。
//
// 为什么需要它：探测只能推翻「凭据/连通性」类的阻塞（见 account-runtime-gate 的
// observeProbeSuccess），而余额不足、权限受限、额度耗尽这类阻塞必须等外部条件恢复后由
// 人来确认。此前唯一的账号级入口是「编辑调度规则」弹窗里的复选框，那个入口现在只对
// 第三方/自建上游的 API Key 账号开放，所以这里给所有账号一个语义独立的恢复动作
// （与仪表盘的全局清空同语义，只是作用域收窄到单个账号）。
//
// 状态变更本身交给统一门禁（evidence = manual_admin_clear），本模块只负责路由、
// 存在性校验与响应组装。

const { SUPPORTED_SERVER_PROVIDERS } = require('./providers');
const { accountExists, parseAccountRoute } = require('./webui-account-routes-utils');
const { refreshLiveAccountRecord } = require('./webui-account-live');

function findRuntimeAccount(ctx, provider, accountRef) {
  const accounts = ctx && ctx.state && ctx.state.accounts && ctx.state.accounts[provider];
  if (!Array.isArray(accounts)) return null;
  return accounts.find((account) => String(account && account.accountRef || '') === accountRef) || null;
}

function resolveGate(ctx) {
  const gate = ctx && ctx.deps && ctx.deps.accountRuntimeGate;
  if (gate && typeof gate.forceRecover === 'function') return gate;
  return null;
}

async function handleRestoreAccountSchedulingRequest(ctx) {
  const parsed = parseAccountRoute(ctx.pathname, /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/restore-scheduling$/);
  if (!parsed || !SUPPORTED_SERVER_PROVIDERS.includes(parsed.provider)) {
    ctx.writeJson(ctx.res, 400, { ok: false, error: parsed ? 'unsupported_provider' : 'invalid_account_path' });
    return true;
  }
  const { provider, accountRef } = parsed;
  if (!accountExists(ctx, provider, accountRef)) {
    ctx.writeJson(ctx.res, 404, { ok: false, error: 'account_not_found' });
    return true;
  }
  const gate = resolveGate(ctx);
  if (!gate) {
    ctx.writeJson(ctx.res, 503, { ok: false, error: 'runtime_gate_unavailable' });
    return true;
  }
  const account = findRuntimeAccount(ctx, provider, accountRef);
  if (!account) {
    ctx.writeJson(ctx.res, 409, { ok: false, error: 'account_not_in_runtime_pool' });
    return true;
  }
  gate.forceRecover({ account, provider, source: 'server.account.restore_scheduling' });
  try { ctx.deps.reloadRuntimeAccountsIfNeeded && ctx.deps.reloadRuntimeAccountsIfNeeded(ctx, provider); } catch (_error) {}
  const refreshed = await refreshLiveAccountRecord(ctx, provider, accountRef, {
    skipUsageRefresh: true,
    skipRuntimeReload: true
  });
  ctx.writeJson(ctx.res, 200, { ok: true, account: refreshed || account });
  return true;
}

module.exports = { handleRestoreAccountSchedulingRequest };

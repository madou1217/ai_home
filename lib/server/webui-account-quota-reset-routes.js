'use strict';

const { proxyGo } = require('./webui-go-proxy');

const RESET_EVENTS_PATTERN = /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/(?:quota-reset-events|reset-history)$/;

function writeNoStoreHeaders(res) {
  if (!res || typeof res.setHeader !== 'function') return;
  res.setHeader('cache-control', 'no-store');
  res.setHeader('pragma', 'no-cache');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-content-type-options', 'nosniff');
}

function decodePathValue(value) {
  try {
    return decodeURIComponent(String(value || '')).trim();
  } catch (_error) {
    return '';
  }
}

async function handleWebUiAccountQuotaResetRoutes(ctx) {
  const match = String(ctx.pathname || '').match(RESET_EVENTS_PATTERN);
  if (!match) return false;

  writeNoStoreHeaders(ctx.res);

  if (ctx.method !== 'GET') {
    ctx.writeJson(ctx.res, 405, {
      ok: false,
      error: 'method_not_allowed',
      message: 'Method not allowed'
    });
    return true;
  }

  const provider = decodePathValue(match[1]).toLowerCase();
  const accountRef = decodePathValue(match[2]);

  if (!provider || !accountRef) {
    ctx.writeJson(ctx.res, 400, {
      ok: false,
      error: 'invalid_quota_reset_events_path',
      message: '无效的账号重置历史路径'
    });
    return true;
  }

  const limitParam = ctx.url && ctx.url.searchParams ? ctx.url.searchParams.get('limit') : null;
  const beforeIdParam = ctx.url && ctx.url.searchParams ? ctx.url.searchParams.get('beforeId') : null;
  const limit = Math.max(1, Math.min(200, Number(limitParam) || 50));
  const beforeId = Number(beforeIdParam) || 0;

  // 读模型固定由 Go 承接：Go 直接读 app-state.db 的 account_quota_reset_events，
  // 并用同一份库的 account_refs 校验账号归属（Node 的 Go 账号投影可能缺已停用账号）。
  // Go 不可用即 503，没有本地回退：两份读模型只会让页面与真实数据分叉。
  // 只有 400/404 是 Go 的领域结论（路径非法 / 账号不存在），原样透传；其它失败一律 503。
  return proxyGo(ctx, {
    method: 'getAccountQuotaResetEvents',
    args: [provider, accountRef, { limit, beforeId }],
    message: 'Go Core 未就绪，重置历史不可读',
    passStatuses: [400, 404]
  });
}

module.exports = {
  handleWebUiAccountQuotaResetRoutes
};
